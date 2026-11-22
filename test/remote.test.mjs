/*
 * Unit tests for the remote TTS endpoint path: config normalization and
 * request shaping (logic/remote.js), text chunking for endpoints
 * (vendor/text.js textChunks), and remote records in the model store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import TextChunks from "../logic/chunks.js";

const require = createRequire(import.meta.url);
const RemoteTts = require("../logic/remote.js");
const { ModelStore } = require("../logic/model-store.js");

test("normalize validates name, URL scheme, and voices", () => {
  const config = RemoteTts.normalize({ name: "my tts", url: "https://tts.example/v1/audio/speech", apiKey: " k ", voices: ["nova", "nova", ""] });
  assert.deepEqual(config, { name: "my tts", url: "https://tts.example/v1/audio/speech", apiKey: "k", model: "", voices: ["nova"] });
  assert.throws(() => RemoteTts.normalize({ url: "https://x.example" }), /needs a name/);
  assert.throws(() => RemoteTts.normalize({ name: "x", url: "file:///etc" }), /http\(s\)/);
  assert.throws(() => RemoteTts.normalize({ name: "x", url: "https://x.example", voices: ["  "] }), /at least one voice/);
});

test("speechRequest builds an authorized wav POST with sane defaults", () => {
  const config = RemoteTts.normalize({ name: "x", url: "https://tts.example/v1/audio/speech", apiKey: "secret" });
  const request = RemoteTts.speechRequest(config, { text: "Hello there.", voice: "missing", speed: 99 });
  assert.equal(request.url, config.url);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  const body = JSON.parse(request.init.body);
  assert.equal(body.input, "Hello there.");
  assert.equal(body.voice, "alloy"); // unknown voice falls back to the first
  assert.equal(body.speed, 4); // clamped to the OpenAI range
  assert.equal(body.response_format, "wav");
  assert.ok(body.model); // a default model id is always set
  assert.throws(() => RemoteTts.speechRequest(config, { text: "  " }), /nothing to synthesize/i);
});

test("isSpeechResponse accepts audio and octet-stream, rejects JSON errors", () => {
  const headers = (type) => ({ get: () => type });
  assert.equal(RemoteTts.isSpeechResponse({ headers: headers("audio/wav") }), true);
  assert.equal(RemoteTts.isSpeechResponse({ headers: headers("application/octet-stream") }), true);
  assert.equal(RemoteTts.isSpeechResponse({ headers: headers("application/json") }), false);
});

test("textChunks packs sentences and hard-splits overlong ones", () => {
  const one = TextChunks.of("One. Two words. Three word sentence ends.", 800);
  assert.equal(one.length, 1);
  assert.equal(one[0], "One. Two words. Three word sentence ends.");

  const packed = TextChunks.of(`${"a ".repeat(60).trim()}. ${"b ".repeat(60).trim()}.`, 60);
  for (const chunk of packed) assert.ok(chunk.length <= 60, `chunk too long: ${chunk.length}`);
  assert.ok(packed.length >= 2, "long sentences were split");

  const giant = `${"word ".repeat(400).trim()}.`;
  const split = TextChunks.of(giant, 80);
  assert.ok(split.length >= 5);
  assert.ok(split.every((chunk) => chunk.length <= 80));
  assert.equal(split.join(" ").split(/\s+/).length, 400);

  assert.deepEqual(TextChunks.of(""), []);
  assert.deepEqual(TextChunks.of("   \n  "), []);
});

test("the model store round-trips remote endpoint records", async () => {
  const remote = RemoteTts.normalize({ name: "relay", url: "http://127.0.0.1:9999/v1/audio/speech", voices: ["a", "b"] });
  const saved = await ModelStore.saveActive({ name: "relay", remote });
  assert.deepEqual(saved, { name: "relay", remote });
  const loaded = await ModelStore.loadActive();
  assert.deepEqual(loaded, { name: "relay", remote });
  await ModelStore.saveActive({ name: "local", buffer: new ArrayBuffer(8).buffer || new ArrayBuffer(8) });
  await ModelStore.clear();
  assert.equal(await ModelStore.loadActive(), null);
  await assert.rejects(() => ModelStore.saveActive({ name: "bad" }), TypeError);
});
