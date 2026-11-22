/*
 * Chrome background flow: the service worker drives the engine inside an
 * offscreen audio host through EngineHost. When the host port disconnects
 * mid-job (the document was reaped or crashed — posts into it evaporate
 * before the event lands), the in-flight read must restart on a fresh
 * document instead of hanging at "planning" forever.
 *
 * Same script list and fake `browser` as test/background-extract.test.js,
 * plus the fake `chrome` (offscreen + runtime port) that EngineHost needs.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const SCRIPTS = [
  "compat/compat.js",
  "logic/chunks.js",
  "logic/remote.js",
  "logic/model-store.js",
  "logic/prefs.js",
  "background/engine-host.js",
  "background/player.js",
  "background/background.js",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for " + what);
}

function loadBackgroundChrome() {
  const calls = { sendMessage: [], menus: [], tabsCreate: [] };
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); } });
  const store = {};
  const browser = {
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    commands: { onCommand: on("command") },
    menus: { create: (info) => calls.menus.push(info), onClicked: on("menuClick") },
    runtime: {
      getURL: (path) => `chrome-extension://fake/${path}`,
      onConnect: on("connect"),
      onInstalled: on("installed"),
      onMessage: on("message"),
    },
    scripting: { executeScript: () => Promise.resolve() },
    storage: {
      local: {
        get: (keys) => {
          const defaults = keys && typeof keys === "object" && !Array.isArray(keys) ? keys : {};
          const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(defaults);
          const result = { ...defaults };
          for (const key of wanted) if (key in store) result[key] = store[key];
          return Promise.resolve(result);
        },
        set: (entries) => { Object.assign(store, entries); return Promise.resolve(); },
        remove: (keys) => { for (const key of [].concat(keys)) delete store[key]; return Promise.resolve(); },
      },
    },
    tabs: {
      create: (details) => { calls.tabsCreate.push(details); return Promise.resolve({ id: 1 }); },
      onRemoved: on("tabRemoved"),
      query: () => Promise.resolve([]),
      sendMessage: (...args) => {
        calls.sendMessage.push(args);
        return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
      },
    },
  };

  /* EngineHost's chrome surface: an offscreen document factory and a
   * runtime port per connect. The port's onMessage listener is the
   * host's route(); the fake records what was posted down and can
   * deliver replies up. */
  const ports = [];
  const helloListeners = [];
  const offscreenCreated = [];
  const offscreenClosed = [];
  let contexts = [];
  const makePort = () => {
    const port = {
      sent: [],
      route: null,
      disconnectListeners: [],
      onMessage: { addListener: (fn) => { port.route = fn; } },
      onDisconnect: { addListener: (fn) => port.disconnectListeners.push(fn) },
      postMessage: (message) => port.sent.push(message),
    };
    ports.push(port);
    return port;
  };
  const chrome = {
    offscreen: {
      createDocument: (options) => { offscreenCreated.push(options); return Promise.resolve(); },
      closeDocument: () => { offscreenClosed.push(true); return Promise.resolve(); },
    },
    runtime: {
      getURL: (path) => "chrome-extension://fake/" + path,
      getContexts: () => Promise.resolve(contexts),
      connect: () => makePort(),
      onMessage: { addListener: (fn) => helloListeners.push(fn) },
    },
  };
  const sandbox = {
    browser,
    chrome,
    console,
    navigator: { userAgent: "Chrome" },
    setTimeout,
    clearTimeout,
    URL,
    fetch: () => Promise.reject(new Error("no network in tests")),
  };
  vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    vm.runInContext(readFileSync(join(root, file), "utf8"), sandbox, { filename: file });
  }
  return {
    sandbox,
    ports,
    offscreenCreated,
    offscreenClosed,
    /* Top-level const/let (S, jobId) live in the context's lexical
     * scope, not on the sandbox object — evaluate to read them. */
    evalIn: (expression) => vm.runInContext(expression, sandbox),
    hello: () => { for (const fn of helloListeners) fn({ scope: "tv-host-hello" }); },
    disconnect: (port) => { for (const fn of port.disconnectListeners) fn(); },
    enginePosts: () => ports.flatMap((port) => port.sent)
      .filter((entry) => entry.message && entry.message.kind === "engine")
      .map((entry) => entry.message.message),
  };
}

test("a host disconnect mid-job restarts the read on a fresh document", async () => {
  const h = loadBackgroundChrome();
  h.hello();
  const jobs = () => h.enginePosts().filter((m) => m && m.type === "job");
  await h.sandbox.readBlocks({ source: "paste", blocks: ["One sentence here. And another one."] }, null);
  await until(() => jobs().length === 1, "job posted to the host");
  assert.equal(h.evalIn("S.status"), "planning");

  /* The engine answers; then the document dies — the disconnect event
   * lands whenever Chrome delivers it. Any post in that window is lost. */
  const firstJob = jobs()[0];
  h.ports[0].route({
    scope: "tv-engine",
    message: { type: "plan", jobId: firstJob.jobId, total: 2, blockOf: [0, 0] },
  });
  h.disconnect(h.ports[0]);

  /* The in-flight read restarts on a fresh document: a new offscreen
   * document is created and the job is reposted with a new jobId. */
  await until(() => h.offscreenCreated.length === 2, "replacement document created");
  h.hello();
  await until(() => jobs().length === 2, "job reposted to the fresh host");
  assert.notEqual(jobs()[1].jobId, firstJob.jobId);
});
