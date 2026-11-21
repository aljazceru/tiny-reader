/*
 * Unit tests for background/player.js against a stub Web Audio graph.
 *
 * The stub implements only the AudioContext surface the player touches, but
 * it enforces the part of the Web Audio contract that once broke silently:
 * a BufferSource that is never connected to the destination produces no
 * output at all — the context clock still runs and onended still fires, so
 * playback *looks* alive while being inaudible.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.Resample = require("../logic/resample.js");
const VocaPlayer = require("../background/player.js");

class StubContext {
  constructor({ sampleRate = 48000, now = 10 } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = now;
    this.state = "running";
    this.destination = { name: "destination" };
    this.buffers = [];
    this.sources = [];
  }

  createBuffer(channels, length, rate) {
    const buffer = {
      channels, length, rate, duration: length / rate,
      copied: null,
      copyToChannel(data, channel) { this.copied = { data, channel }; },
    };
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource() {
    const ctx = this;
    const source = {
      buffer: null,
      connected: [],
      startedAt: null,
      onended: null,
      connect(node) { this.connected.push(node); },
      start(when) { this.startedAt = when; },
      stop() { (ctx.stopped ||= []).push(this); },
    };
    this.sources.push(source);
    return source;
  }

  async resume() { this.resumed = true; }
  async suspend() { this.suspended = true; }
}

test("every scheduled sentence is connected to the destination", () => {
  const ctx = new StubContext();
  const player = new VocaPlayer();
  player.ensureContext = () => (player.ctx = ctx);
  player.enqueue(new Float32Array(4800).fill(0.2), 48000, 0);
  player.enqueue(new Float32Array(2400).fill(-0.2), 24000, 1);
  assert.equal(ctx.sources.length, 2);
  for (const source of ctx.sources) {
    assert.deepEqual(source.connected, [ctx.destination], "source must reach the destination");
  }
});

test("sentences are scheduled gapless from now + 50 ms, resampling to the context rate", () => {
  const ctx = new StubContext({ sampleRate: 48000, now: 10 });
  const player = new VocaPlayer();
  player.ensureContext = () => (player.ctx = ctx);
  const first = player.enqueue(new Float32Array(2400), 24000, 0); // 0.05 s at model rate
  const second = player.enqueue(new Float32Array(4800), 24000, 1); // 0.1 s, same resample
  assert.equal(first, 10.05); // earliest possible start
  assert.equal(second, first + 0.1); // starts exactly when the first ends
  assert.equal(ctx.buffers[0].rate, 48000);
  assert.equal(ctx.buffers[1].length, 9600); // 0.2 s at 48 kHz after resample
});

test("onended reports order; stopSources stops the rest silently", () => {
  const ctx = new StubContext();
  const player = new VocaPlayer();
  player.ensureContext = () => (player.ctx = ctx);
  const ended = [];
  player.onEnded = (tag) => ended.push(tag);
  player.enqueue(new Float32Array(1000), 48000, 7);
  player.enqueue(new Float32Array(1000), 48000, 8);
  ctx.sources[0].onended();
  player.stopSources(); // sentence 8 still queued: dropped, no onended
  assert.deepEqual(ended, [7]);
  assert.deepEqual(ctx.stopped, [ctx.sources[1]]);
  assert.equal(player.sources.size, 0);
  assert.equal(player.cursor, 0);
});
