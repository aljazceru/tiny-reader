/*
 * The Chrome audio host runs the synthesis worker inside the offscreen
 * document. A "job" engine message reaching a host whose worker is gone
 * (its load was lost in transit) must surface an error uplink instead of
 * dropping silently — the read would otherwise hang at "planning".
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "..", "chrome", "audio-host.js"), "utf8");

class FakeWorker {
  constructor(url) { this.url = url; this.posts = []; FakeWorker.instances.push(this); }
  postMessage(message) { this.posts.push(message); }
  terminate() { this.terminated = true; }
}
FakeWorker.instances = [];

class FakePlayer {
  constructor() { this.onEnded = null; this.lastChunk = null; this.ctx = null; this.sources = new Set(); }
  enqueue() {}
  enqueueEncoded() {}
  pause() {}
  resume() {}
  stopSources() {}
}

/* Loads audio-host.js in a vm sandbox, then delivers the service worker's
 * port connect. Returns the uplink messages the document sent back, the
 * fake workers it spawned, and a command() sender. */
function harness() {
  FakeWorker.instances = [];
  const sent = [];
  const connectListeners = [];
  const port = {
    name: "tv-audio-host",
    postMessage: (message) => sent.push(message),
    onMessage: { addListener(fn) { port.listener = fn; } },
    onDisconnect: { addListener() {} },
  };
  const chrome = {
    runtime: {
      getURL: (path) => "chrome-extension://fake/" + path,
      onConnect: { addListener: (fn) => connectListeners.push(fn) },
      sendMessage: () => Promise.resolve(),
    },
  };
  const sandbox = { chrome, Worker: FakeWorker, VocaPlayer: FakePlayer, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  for (const fn of connectListeners) fn(port);
  return {
    sent,
    workers: FakeWorker.instances,
    command: (message) => port.listener(message),
  };
}

test("a job reaching a host with no engine surfaces an error uplink", () => {
  const h = harness();
  h.command({ scope: "tv-host", message: { kind: "engine", message: { type: "job", jobId: 1, blocks: [] } } });
  const error = h.sent.find((m) => m.scope === "tv-engine" && m.error);
  assert.ok(error, "a dropped job must surface an error");
});

test("engine messages reach the worker once its load ran", () => {
  const h = harness();
  h.command({ scope: "tv-host", message: { kind: "engine", message: { type: "load" } } });
  h.command({ scope: "tv-host", message: { kind: "engine", message: { type: "job", jobId: 1, blocks: [] } } });
  assert.equal(h.workers.length, 1);
  assert.deepEqual(h.workers[0].posts.map((m) => m.type), ["load", "job"]);
  assert.equal(h.sent.filter((m) => m.error).length, 0);
});
