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

test("a paused read stays paused when the host is reaped; resume restarts it", async () => {
  const h = loadBackgroundChrome();
  h.hello();
  const jobs = () => h.enginePosts().filter((m) => m && m.type === "job");
  const replays = () => h.enginePosts().filter((m) => m && m.type === "replay");

  await h.sandbox.readBlocks({ source: "paste", blocks: ["One. Two. Three."] }, null);
  await until(() => jobs().length === 1, "job posted to the host");
  const firstJob = jobs()[0];
  h.ports[0].route({
    scope: "tv-engine",
    message: { type: "plan", jobId: firstJob.jobId, total: 3, blockOf: [0, 0, 0] },
  });
  /* A chunk flips planning to playing and anchors the position. */
  h.ports[0].route({
    scope: "tv-engine",
    message: { type: "chunk", jobId: firstJob.jobId, index: 1, blockId: 0, audio: [0, 0] },
  });
  assert.equal(h.evalIn("S.status"), "playing");
  assert.equal(h.evalIn("S.playingIndex"), 1);

  await h.evalIn("pause()");
  assert.equal(h.evalIn("S.status"), "paused");

  /* Chrome reaps the offscreen document ~30 s into a pause (no audio is
   * playing to keep it alive). The loss must NOT restart the job — a
   * paused read must not start speaking on its own. */
  h.disconnect(h.ports[0]);
  await sleep(50); // a (wrong) restart would have created the document by now
  assert.equal(h.evalIn("S.status"), "paused");
  assert.equal(h.offscreenCreated.length, 1);
  assert.equal(jobs().length, 1);

  /* The user's resume does the restart instead: fresh document, fresh
   * job, and the plan lands on the paused sentence via resumeAt. */
  await h.evalIn("resume()");
  await until(() => h.offscreenCreated.length === 2, "replacement document created");
  h.hello();
  await until(() => jobs().length === 2, "job reposted to the fresh host");
  const secondJob = jobs()[1];
  h.ports[1].route({
    scope: "tv-engine",
    message: { type: "plan", jobId: secondJob.jobId, total: 3, blockOf: [0, 0, 0] },
  });
  await until(() => replays().length === 1, "replay posted for the resume point");
  assert.equal(replays()[0].from, 1);
  assert.equal(h.evalIn("S.status"), "playing");
});

/* I1: pause longer than the offscreen reap (~30 s), then press "next".
 * The lost host took the worker and its plan, so the seek restarts the
 * job on a fresh document and lands on the requested sentence — not an
 * "audio host connection lost" error. */
test("a reaped host during pause: next restarts the read instead of erroring", async () => {
  const h = loadBackgroundChrome();
  h.hello();
  const jobs = () => h.enginePosts().filter((m) => m && m.type === "job");
  const replays = () => h.enginePosts().filter((m) => m && m.type === "replay");

  await h.sandbox.readBlocks({ source: "paste", blocks: ["One. Two. Three."] }, null);
  await until(() => jobs().length === 1, "job posted to the host");
  const firstJob = jobs()[0];
  h.ports[0].route({
    scope: "tv-engine",
    message: { type: "plan", jobId: firstJob.jobId, total: 3, blockOf: [0, 0, 0] },
  });
  h.ports[0].route({
    scope: "tv-engine",
    message: { type: "chunk", jobId: firstJob.jobId, index: 1, blockId: 0, audio: [0, 0] },
  });
  await h.evalIn("pause()");
  assert.equal(h.evalIn("S.status"), "paused");

  /* Chrome reaps the host mid-pause; the read stays paused (pinned). */
  h.disconnect(h.ports[0]);
  await sleep(50);
  assert.equal(h.evalIn("S.status"), "paused");

  /* "next" while paused: fresh document, fresh job, replay at index+1. */
  h.evalIn("seek(S.playingIndex + 1)");
  await until(() => h.offscreenCreated.length === 2, "replacement document created");
  h.hello();
  await until(() => jobs().length === 2, "job reposted to the fresh host");
  const secondJob = jobs()[1];
  h.ports[1].route({
    scope: "tv-engine",
    message: { type: "plan", jobId: secondJob.jobId, total: 3, blockOf: [0, 0, 0] },
  });
  await until(() => replays().length === 1, "replay posted for the next sentence");
  assert.equal(replays()[0].from, 2);
  assert.equal(h.evalIn("S.status"), "playing");
  assert.equal(h.evalIn("S.error"), null);
});

/* I2: a custom model validates in a worker inside the offscreen document
 * while the status is idle — exactly when Chrome reaps the document.
 * The pending validation must reject fast instead of waiting out the
 * 120 s model-load timeout. */
test("a host loss during custom-model validation rejects fast", async () => {
  const h = loadBackgroundChrome();
  h.hello();
  const pending = h.evalIn(
    "setModel({ name: 'custom.gguf', buffer: new ArrayBuffer(16) })" +
    ".then(() => 'resolved', (error) => 'rejected: ' + error.message)");
  await until(() => h.ports.length === 1, "candidate worker load posted");
  h.disconnect(h.ports[0]);
  const outcome = await Promise.race([pending, sleep(5000).then(() => "still pending")]);
  assert.match(outcome, /audio host connection lost/);
});

test("a host loss during reset-to-bundled validation rejects fast", async () => {
  const h = loadBackgroundChrome();
  h.hello();
  const pending = h.evalIn(
    "setModel({ reset: true }).then(() => 'resolved', (error) => 'rejected: ' + error.message)");
  await until(() => h.ports.length === 1, "candidate worker load posted");
  h.disconnect(h.ports[0]);
  const outcome = await Promise.race([pending, sleep(5000).then(() => "still pending")]);
  assert.match(outcome, /audio host connection lost/);
});

/* M1: the restart cap must survive reposted plans — a host that dies
 * after every plan gives up with a visible error instead of restarting
 * forever. */
test("consecutive host losses give up after the restart cap", async () => {
  const h = loadBackgroundChrome();
  h.hello();
  const jobs = () => h.enginePosts().filter((m) => m && m.type === "job");

  await h.sandbox.readBlocks({ source: "paste", blocks: ["One. Two."] }, null);
  await until(() => jobs().length === 1, "job posted to the host");

  /* Every host answers with a plan and then dies (e.g. a chunk that
   * crashes the renderer). A plan must not reset the restart budget:
   * three losses are recovered, the fourth fails the read. */
  for (let loss = 0; loss < 4 && h.evalIn("S.status") !== "error"; loss++) {
    const job = jobs()[jobs().length - 1];
    const port = h.ports[h.ports.length - 1];
    port.route({
      scope: "tv-engine",
      message: { type: "plan", jobId: job.jobId, total: 2, blockOf: [0, 0] },
    });
    const docs = h.offscreenCreated.length;
    h.disconnect(port);
    await until(
      () => h.offscreenCreated.length === docs + 1 || h.evalIn("S.status") === "error",
      "restart or failure after loss " + (loss + 1));
    if (h.evalIn("S.status") === "error") break;
    h.hello();
    await until(() => jobs().length === loss + 2, "job reposted after loss " + (loss + 1));
  }
  assert.equal(h.evalIn("S.status"), "error");
  assert.match(h.evalIn("S.error"), /keeps restarting/);
});

/* M2: a second loss while the restart is still planning must not drop
 * the pending resume point back to the first sentence. */
test("a second loss during a restart keeps the reading position", async () => {
  const h = loadBackgroundChrome();
  h.hello();
  const jobs = () => h.enginePosts().filter((m) => m && m.type === "job");
  const replays = () => h.enginePosts().filter((m) => m && m.type === "replay");

  await h.sandbox.readBlocks({ source: "paste", blocks: ["S0. S1. S2. S3. S4. S5."] }, null);
  await until(() => jobs().length === 1, "job posted to the host");
  const firstJob = jobs()[0];
  h.ports[0].route({
    scope: "tv-engine",
    message: { type: "plan", jobId: firstJob.jobId, total: 6, blockOf: [0, 0, 0, 0, 0, 0] },
  });
  h.ports[0].route({
    scope: "tv-engine",
    message: { type: "chunk", jobId: firstJob.jobId, index: 5, blockId: 0, audio: [0, 0] },
  });
  assert.equal(h.evalIn("S.playingIndex"), 5);

  /* Loss 1 restarts at sentence 5; the fresh document dies again before
   * its plan lands — the restart-in-flight must keep resumeAt = 5. */
  h.disconnect(h.ports[0]);
  await until(() => h.offscreenCreated.length === 2, "first replacement document");
  h.hello();
  await until(() => jobs().length === 2, "job reposted after first loss");
  h.disconnect(h.ports[1]);
  await until(() => h.offscreenCreated.length === 3, "second replacement document");
  h.hello();
  await until(() => jobs().length === 3, "job reposted after second loss");

  const thirdJob = jobs()[2];
  h.ports[2].route({
    scope: "tv-engine",
    message: { type: "plan", jobId: thirdJob.jobId, total: 6, blockOf: [0, 0, 0, 0, 0, 0] },
  });
  await until(() => replays().length === 1, "replay posted for the resume point");
  assert.equal(replays()[0].from, 5);
});
