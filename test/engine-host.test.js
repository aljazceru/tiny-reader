/*
 * The Chrome engine host lives in an offscreen document, never a tab:
 * created on demand via chrome.offscreen, model bytes cross the port as a
 * plain number array (extension messaging demotes ArrayBuffers), and a
 * command issued after the document closed recreates it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "..", "background", "engine-host.js"), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for " + what);
}

/* Loads engine-host.js in a vm sandbox with a fake Chrome API surface.
 * chrome.tabs is intentionally absent: the host must never touch it. */
function harness() {
  const created = [];
  const closed = [];
  const posted = [];
  const helloListeners = [];
  const disconnectListeners = [];
  let contexts = [];
  const port = {
    onMessage: { addListener() {} },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage: (message) => posted.push(message),
  };
  const chrome = {
    offscreen: {
      createDocument: (options) => { created.push(options); return Promise.resolve(); },
      closeDocument: () => { closed.push(true); return Promise.resolve(); },
    },
    runtime: {
      getURL: (path) => "chrome-extension://fake/" + path,
      getContexts: () => Promise.resolve(contexts),
      connect: () => port,
      onMessage: { addListener: (fn) => helloListeners.push(fn) },
    },
  };
  const sandbox = { chrome, navigator: { userAgent: "Chrome" }, setTimeout, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    EngineHost: sandbox.EngineHost,
    chrome,
    created,
    closed,
    posted,
    hello: () => { for (const fn of helloListeners) fn({ scope: "tv-host-hello" }); },
    disconnect: () => { for (const fn of disconnectListeners) fn(); },
    set contexts(value) { contexts = value; },
  };
}

test("chrome audio host is an offscreen document, never a tab", async () => {
  const h = harness();
  assert.equal(h.chrome.tabs, undefined);
  await h.EngineHost.ensureDocument();
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].url, "chrome/audio-host.html");
  assert.deepEqual([...h.created[0].reasons], ["AUDIO_PLAYBACK"]);
  /* The document already exists: no second createDocument. */
  h.contexts = [{ contextType: "OFFSCREEN_DOCUMENT" }];
  await h.EngineHost.ensureDocument();
  assert.equal(h.created.length, 1);
});

test("custom model bytes survive the port", async () => {
  const h = harness();
  h.hello(); // host announces itself
  await h.EngineHost.spawnWorker(undefined, { name: "m", buffer: new Uint8Array([1, 2, 3]).buffer });
  await until(() => h.posted.length, "load message on the port");
  const load = h.posted.find((entry) => entry.message && entry.message.kind === "engine");
  /* The port message was built inside the vm realm; normalize before
   * comparing across realms. */
  assert.deepEqual(JSON.parse(JSON.stringify(load)), {
    scope: "tv-host",
    message: {
      kind: "engine",
      message: { type: "load", model: { name: "m", bytes: [1, 2, 3] } },
    },
  });
});

test("commands after the offscreen document closed recreate it", async () => {
  const h = harness();
  await h.EngineHost.ensureDocument();
  h.hello();
  await h.EngineHost.closeDocument();
  const player = h.EngineHost.createPlayer();
  const resumed = player.resume();
  await until(() => h.created.length === 2, "document recreation");
  h.hello(); // the fresh document announces itself
  await resumed;
  const resume = h.posted.find((entry) => entry.message && entry.message.kind === "resume");
  /* The port message was built inside the vm realm; normalize before
   * comparing across realms. */
  assert.deepEqual(JSON.parse(JSON.stringify(resume)), { scope: "tv-host", message: { kind: "resume" } });
});

test("hostLost reports a document that was created and is now gone", async () => {
  const h = harness();
  assert.equal(h.EngineHost.hostLost(), false); // nothing was ever created
  await h.EngineHost.ensureDocument();
  assert.equal(h.EngineHost.hostLost(), false);
  await h.EngineHost.closeDocument();
  assert.equal(h.EngineHost.hostLost(), true);
});

test("hostLost flips when the host port disconnects", async () => {
  const h = harness();
  h.hello();
  await h.EngineHost.spawnWorker(undefined); // creates the document and the port
  await until(() => h.posted.length, "load message on the port");
  assert.equal(h.EngineHost.hostLost(), false);
  h.disconnect();
  assert.equal(h.EngineHost.hostLost(), true);
});
