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
 * chrome.tabs is intentionally absent: the host must never touch it.
 * Each connect() gets its own fake port so a stale port's late
 * onDisconnect can be delivered separately from a live one. */
function harness() {
  const created = [];
  const closed = [];
  const posted = [];
  const helloListeners = [];
  const ports = [];
  let contexts = [];
  let closeImpl = () => Promise.resolve();
  const makePort = () => {
    const port = {
      dead: false, // when true, postMessage throws like a disconnected port
      disconnectListeners: [],
      onMessage: { addListener() {} },
      onDisconnect: { addListener: (fn) => port.disconnectListeners.push(fn) },
      postMessage: (message) => {
        if (port.dead) throw new Error("Attempting to use a disconnected port object.");
        posted.push(message);
      },
    };
    ports.push(port);
    return port;
  };
  const chrome = {
    offscreen: {
      createDocument: (options) => { created.push(options); return Promise.resolve(); },
      closeDocument: () => { closed.push(true); return closeImpl(); },
    },
    runtime: {
      getURL: (path) => "chrome-extension://fake/" + path,
      getContexts: () => Promise.resolve(contexts),
      connect: () => makePort(),
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
    ports,
    hello: () => { for (const fn of helloListeners) fn({ scope: "tv-host-hello" }); },
    disconnect: (port) => { for (const fn of port.disconnectListeners) fn(); },
    deferClose: (fn) => { closeImpl = () => new Promise(fn); },
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
  h.disconnect(h.ports[0]);
  assert.equal(h.EngineHost.hostLost(), true);
});

test("a worker proxy from a dead document cannot post into its replacement", async () => {
  const h = harness();
  h.hello();
  const oldWorker = await h.EngineHost.spawnWorker(undefined);
  await until(() => h.posted.length === 1, "load message on the port");
  h.disconnect(h.ports[0]);            // document reaped, proxy orphaned
  await h.EngineHost.ensureDocument(); // a fresh document takes its place
  h.hello();
  await h.EngineHost.spawnWorker(undefined);
  await until(() => h.posted.length === 2, "fresh worker's load message");
  oldWorker.postMessage({ type: "job", jobId: 1 });
  await sleep(30);
  assert.equal(h.posted.length, 2); // the stale proxy dropped it
});

/* The bug behind the Chrome "planning, total: 0" stall: a document is
 * closed (idle interval, or a reaped host) and a new read claims its
 * replacement before the OLD port's onDisconnect event is delivered.
 * That late event must not tear down the new claim — otherwise the fresh
 * worker proxy's job post is silently dropped and the read hangs. */
test("a late disconnect from the dead document does not tear down its replacement", async () => {
  const h = harness();
  h.hello();
  await h.EngineHost.spawnWorker(undefined);
  await until(() => h.posted.length === 1, "load message on the port");
  const oldPort = h.ports[0];
  await h.EngineHost.closeDocument();
  /* The new read claims a fresh document before the old port's
   * disconnect event arrives. */
  await h.EngineHost.ensureDocument();
  h.hello();
  const worker = await h.EngineHost.spawnWorker(undefined);
  await until(() => h.posted.length === 2, "fresh load on the port");
  let lost = 0;
  h.EngineHost.onHostLost(() => { lost++; });
  h.disconnect(oldPort); // the dead document's late disconnect event
  assert.equal(h.EngineHost.hostLost(), false);
  assert.equal(lost, 0); // a stale port's disconnect is not a loss
  worker.postMessage({ type: "job", jobId: 7 });
  await until(() => h.posted.length === 3, "job post delivered to the port");
});

/* The real stall: the document dies and the job post evaporates on the
 * port before the disconnect event lands. When the event does arrive,
 * the host-lost listener must fire — background.js uses it to restart
 * the in-flight job on a fresh document. */
test("a live document's disconnect notifies the host-lost listener once", async () => {
  const h = harness();
  h.hello();
  await h.EngineHost.spawnWorker(undefined);
  await until(() => h.posted.length === 1, "load message on the port");
  let lost = 0;
  h.EngineHost.onHostLost(() => { lost++; });
  h.disconnect(h.ports[0]);
  assert.equal(lost, 1);
  h.disconnect(h.ports[0]); // a repeated event does not notify again
  assert.equal(lost, 1);
});

/* A claim issued while a close is in flight must wait for the teardown
 * to finish; adopting the document getContexts still lists mid-close
 * means adopting a document that is about to die. */
test("a claim waits for an in-flight close instead of adopting a torn-down document", async () => {
  const h = harness();
  await h.EngineHost.ensureDocument();
  h.hello();
  h.contexts = [{ contextType: "OFFSCREEN_DOCUMENT" }]; // still listed while closing
  let resolveClose;
  h.deferClose((resolve) => { resolveClose = resolve; });
  const closing = h.EngineHost.closeDocument();
  const claim = h.EngineHost.ensureDocument();
  await sleep(0); // let the queued close op reach chrome.offscreen
  resolveClose();
  h.contexts = []; // teardown finished; nothing left to adopt
  await Promise.all([closing, claim]);
  assert.equal(h.created.length, 2); // fresh document, not a mid-close adoption
});

/* A post can still find the port dead (the disconnect event has not been
 * delivered yet). Dropping a job silently there would hang the read at
 * "planning"; it must surface through the worker error contract. */
test("a job lost to a dead port surfaces as a worker error", async () => {
  const h = harness();
  h.hello();
  const worker = await h.EngineHost.spawnWorker(undefined);
  await until(() => h.posted.length === 1, "load message on the port");
  let error = null;
  worker.onerror = (event) => { error = event.message; };
  h.ports[0].dead = true;
  worker.postMessage({ type: "job", jobId: 3 });
  await sleep(30);
  assert.ok(error, "the dropped job must surface as a worker error");
});

/* Same for the proxy gate: the current worker's post finding its
 * document gone must fail visibly, not silently. */
test("a proxy post into a gone document surfaces through onerror", async () => {
  const h = harness();
  h.hello();
  const worker = await h.EngineHost.spawnWorker(undefined);
  await until(() => h.posted.length === 1, "load message on the port");
  await h.EngineHost.closeDocument();
  let error = null;
  worker.onerror = (event) => { error = event.message; };
  worker.postMessage({ type: "job", jobId: 9 });
  assert.equal(error, "audio host connection lost");
});
