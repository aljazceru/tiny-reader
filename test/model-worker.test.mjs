/*
 * Integration test for the model-switching worker path. Drives
 * engine/engine-worker.mjs in Node with a mocked worker global (`self` +
 * postMessage) and the bundled GGUF bytes posted as a custom model — the
 * exact flow the background page uses when the user imports a model. Proves:
 *
 *   - a "load" with {name, buffer} builds model + phonemizer and reports
 *     ready with name, sample rate, max tokens and voices from the config,
 *   - job → plan → advance → chunk synthesizes through that custom model,
 *   - invalid buffers reject with a clean load error and the previously
 *     loaded model keeps serving,
 *   - logic/model-store.js round-trips model bytes (in-memory fallback in
 *     Node; IndexedDB in the browser).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readGGUF } from "../vendor/tiny-voca.js";

/* The worker posts through `self.postMessage` and registers `self.onmessage`
 * at import time — mock the global before importing the module. */
const posted = [];
globalThis.self = { postMessage: (message, transfer) => posted.push({ message, transfer: transfer || [] }) };
const worker = globalThis.self;
await import("../engine/engine-worker.mjs");

const dispatch = (message) => worker.onmessage({ data: message });
const findPosted = (type, predicate = () => true) => posted.find((p) => p.message.type === type && predicate(p.message));
const lastPosted = (type) => [...posted].reverse().find((p) => p.message.type === type);

async function until(predicate, what, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const raw = readFileSync(new URL("../assets/tiny-voca.gguf", import.meta.url));
const bundled = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const expected = (() => {
  const settings = JSON.parse(new TextDecoder().decode(readGGUF(bundled.slice(0)).files["config.json"]));
  return { sampleRate: settings.model.sample_rate, maxTokens: settings.model.max_tokens, voices: [...settings.model.speakers].sort() };
})();

const rms = (audio) => Math.sqrt([...audio].reduce((sum, x) => sum + x * x, 0) / audio.length);

test("a custom-named load of the bundled GGUF reports ready from the config", async () => {
  dispatch({ type: "load", name: "my-voca", buffer: bundled.slice(0) });
  await until(() => findPosted("ready"), "ready");
  const ready = lastPosted("ready").message;
  assert.equal(ready.name, "my-voca");
  assert.equal(ready.sampleRate, 24000);
  assert.equal(ready.sampleRate, expected.sampleRate);
  assert.equal(ready.maxTokens, expected.maxTokens);
  assert.deepEqual([...ready.voices].sort(), expected.voices);
  assert.deepEqual([...ready.voices].sort(), ["F2", "M2"]);
  assert.equal(posted.filter((p) => p.message.type === "ready").length, 1);
});

test("jobs plan and synthesize through the custom model", async () => {
  const readies = posted.filter((p) => p.message.type === "ready").length;
  dispatch({
    type: "job",
    jobId: 7,
    blocks: [
      { id: 0, text: "The quick brown fox jumps over the lazy dog." },
      { id: 1, text: "A custom model reads this second block too." },
    ],
    voice: "M2",
    speed: 1,
  });
  await until(() => findPosted("plan", (m) => m.jobId === 7), "plan");
  const plan = lastPosted("plan").message;
  assert.ok(plan.total >= 2, `too few utterances: ${plan.total}`);
  assert.equal(plan.blockOf.length, plan.total);
  assert.equal(plan.blockOf[0], 0);
  assert.equal(plan.blockOf[plan.blockOf.length - 1], 1);

  dispatch({ type: "advance", jobId: 7, to: plan.total });
  await until(() => posted.filter((p) => p.message.type === "chunk").length === plan.total, "all chunks");
  const chunks = posted.filter((p) => p.message.type === "chunk").map((p) => p.message);
  assert.deepEqual(chunks.map((c) => c.index), Array.from({ length: plan.total }, (_, index) => index));
  assert.deepEqual(chunks.map((c) => c.blockId), plan.blockOf);
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.jobId, 7);
    assert.ok(chunk.audio instanceof Float32Array);
    assert.ok(chunk.audio.length > 4800, `chunk ${index} too short: ${chunk.audio.length}`);
    assert.ok([...chunk.audio].every((sample) => Number.isFinite(sample)));
    assert.ok(rms(chunk.audio) > 0.01, `chunk ${index} is silent`);
    const posted_chunk = posted.find((p) => p.message.type === "chunk" && p.message.index === index);
    assert.deepEqual(posted_chunk.transfer, [chunk.audio.buffer]); // audio leaves the worker transferred
  });
  // The job ran on the custom model: no extra "ready" was posted.
  assert.equal(posted.filter((p) => p.message.type === "ready").length, readies);
});

test("invalid buffers reject cleanly and keep the previous model serving", async () => {
  const readies = posted.filter((p) => p.message.type === "ready").length;
  dispatch({ type: "load", name: "broken", buffer: new ArrayBuffer(64) });
  await until(() => findPosted("error", (m) => m.stage === "load"), "load error");
  const failure = lastPosted("error").message;
  assert.match(failure.message, /broken/);
  assert.match(failure.message, /GGUF/i);
  assert.equal(posted.filter((p) => p.message.type === "ready").length, readies);

  dispatch({ type: "load", name: "wrongtype", buffer: "not bytes" });
  await until(() => posted.filter((p) => p.message.type === "error" && p.message.stage === "load").length === 2, "second load error");
  assert.match(lastPosted("error").message.message, /ArrayBuffer/);
  assert.equal(posted.filter((p) => p.message.type === "ready").length, readies);

  // Readiness fell back to the still-loaded model: a fresh job works.
  dispatch({ type: "job", jobId: 8, blocks: [{ id: 0, text: "Still speaking after a bad model import." }], voice: "F2", speed: 1 });
  await until(() => findPosted("plan", (m) => m.jobId === 8), "plan after failed load");
  const plan = lastPosted("plan").message;
  dispatch({ type: "advance", jobId: 8, to: plan.total });
  await until(() => posted.some((p) => p.message.type === "chunk" && p.message.jobId === 8 && p.message.index === plan.total - 1), "chunk after failed load");
});

test("ModelStore round-trips model bytes (Node in-memory fallback)", async () => {
  const { ModelStore } = createRequire(import.meta.url)("../logic/model-store.js");
  assert.equal(await ModelStore.loadActive(), null);
  const buffer = bundled.slice(0, 1024);
  assert.deepEqual(await ModelStore.saveActive({ name: "my-voca", buffer }), { name: "my-voca", buffer });
  const active = await ModelStore.loadActive();
  assert.equal(active.name, "my-voca");
  assert.equal(active.buffer, buffer); // same bytes, no copy
  await ModelStore.clear();
  assert.equal(await ModelStore.loadActive(), null);
  await assert.rejects(() => ModelStore.saveActive({ name: "   ", buffer }), TypeError);
  await assert.rejects(() => ModelStore.saveActive({ name: "x", buffer: 42 }), TypeError);
  await assert.rejects(() => ModelStore.saveActive({ buffer: new ArrayBuffer(1) }), TypeError);
});
