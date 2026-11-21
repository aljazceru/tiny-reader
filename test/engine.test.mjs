/*
 * Integration test for the vendored tiny-voca engine with the bundled
 * weights — the exact code path the synthesis worker uses (vendor modules
 * + assets/tiny-voca.gguf). Proves, without a browser:
 *
 *   - the GGUF parses, model and phonemizer build,
 *   - sentences of a block plan in order with block ids preserved,
 *   - both voices synthesize finite speech with a sane rate,
 *   - speed changes duration, voices differ,
 *   - wav() writes a canonical 16-bit PCM header.
 *
 * Slow-ish by unit-test standards (the model is real); takes a few seconds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readGGUF, TinyVoca } from "../vendor/tiny-voca.js";
import { fromGGUF } from "../vendor/dizione/engine.js";
import { utterancesOf, limited, wav } from "../vendor/text.js";

const raw = readFileSync(new URL("../assets/tiny-voca.gguf", import.meta.url));
const file = readGGUF(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const voca = new TinyVoca(file);
const phonemizer = await fromGGUF(file);
const rate = voca.config.sample_rate;
const limit = voca.config.max_tokens - 12;

test("the bundled model loads with two voices at 24 kHz", () => {
  assert.equal(rate, 24000);
  assert.deepEqual([...voca.voices].sort(), ["F2", "M2"]);
});

test("phonemizer turns English text into phoneme ids", () => {
  const { ids, stress } = phonemizer.phonemize("Hello! This is tiny voca.");
  assert.ok(ids.length > 5);
  assert.equal(ids.length, stress.length);
  assert.ok(ids.every((id) => Number.isInteger(id) && id >= 0 && id < voca.symbols.length));
});

test("blocks plan into ordered utterances with block ids (worker flow)", () => {
  // Mirrors engine-worker.mjs buildPlan(): one utterancesOf per block.
  const blocks = [
    { id: 0, text: "The quick brown fox jumps over the lazy dog. It lands softly." },
    { id: 1, text: "No English text here! Second block still reads." },
  ];
  const blockOf = [];
  for (const block of blocks) {
    for (const fit of utterancesOf(block.text, phonemizer, limit)) blockOf.push(block.id);
  }
  assert.ok(blockOf.length >= 4); // two sentences per block at least
  assert.deepEqual(blockOf.slice(0, 2), [0, 0]);
  assert.deepEqual(blockOf.slice(2, 4), [1, 1]);
});

test("both voices synthesize finite, audible speech", () => {
  const { ids, stress } = phonemizer.phonemize("The small model speaks clearly in your browser.");
  const m2 = voca.synthesize(ids, stress, { voice: "M2", seed: 0 }).audio;
  const f2 = voca.synthesize(ids, stress, { voice: "F2", seed: 0 }).audio;
  const rms = (audio) => {
    let energy = 0;
    for (const sample of audio) energy += sample * sample;
    return Math.sqrt(energy / audio.length);
  };
  for (const audio of [m2, f2]) {
    assert.ok(audio.length > rate * 0.8, `audio too short: ${audio.length}`);
    assert.ok(audio.every((sample) => Number.isFinite(sample)));
    assert.ok(Math.max(...audio) <= 1.0);
    assert.ok(rms(audio) > 0.01, "audio is silent");
  }
  assert.notDeepEqual([...m2.slice(0, 64)], [...f2.slice(0, 64)]);
});

test("speed 1.5 is shorter than speed 1", () => {
  const { ids, stress } = phonemizer.phonemize("Speaking faster should take measurably less time overall.");
  const slow = voca.synthesize(ids, stress, { voice: "M2", speed: 1, seed: 0 }).audio;
  const fast = voca.synthesize(ids, stress, { voice: "M2", speed: 1.5, seed: 0 }).audio;
  assert.ok(fast.length < slow.length * 0.85);
});

test("wav() writes a canonical header", () => {
  const { ids, stress } = phonemizer.phonemize("Wave file.");
  const audio = limited(voca.synthesize(ids, stress, { voice: "M2", seed: 0 }).audio);
  const bytes = new Uint8Array(wav(audio, rate));
  const latin = String.fromCharCode(...bytes.subarray(0, 44));
  assert.ok(latin.startsWith("RIFF") && latin.includes("WAVE"));
  assert.equal(new DataView(wav(audio, rate).slice(0, 44)).getUint32(24, true), rate); // sample rate field
  assert.equal(bytes.length, 44 + 2 * audio.length);
});
