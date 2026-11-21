/*
 * tiny reader — synthesis worker.
 *
 * Module worker (Firefox 114+) that owns the tiny-voca model. By default it
 * loads the 8 MB quantized GGUF bundled with the extension; a "load" message
 * can instead hand it any tiny-voca-compatible GGUF — under a custom name
 * with the bytes inline, or as a URL to download — which is how
 * higher-quality community models and non-English models (the phonemizer is
 * embedded in the GGUF) get used. Files without tiny-voca model and
 * phonemizer data are rejected with a clean error. It phonemizes each text
 * block into sentence-sized utterances (vendored text.js), reports the plan,
 * then synthesizes on demand under flow control: the background page tells
 * it how far ahead it may go ("advance"), so hours of text never sit in
 * memory.
 *
 * Protocol (postMessage):
 *   in  { type: "load", name?, buffer?: ArrayBuffer, url?: string }
 *                                            // absent → bundled default GGUF
 *   in  { type: "job", jobId, blocks: [{ id, text }], voice, speed }
 *   in  { type: "replay", jobId, from, voice, speed }   // reuse plan, seek
 *   in  { type: "advance", jobId, to }                  // synthesize up to `to`
 *   in  { type: "cancel" }
 *   out { type: "ready", name, sampleRate, maxTokens, voices }
 *   out { type: "plan", jobId, total, blockOf }
 *   out { type: "chunk", jobId, index, blockId, audio } // Float32Array, transferred
 *   out { type: "error", stage, message }
 */

import { readGGUF, TinyVoca } from "../vendor/tiny-voca.js";
import { fromGGUF } from "../vendor/dizione/engine.js";
import { utterancesOf } from "../vendor/text.js";

const BUNDLED = { name: "tiny-voca", url: new URL("../assets/tiny-voca.gguf", import.meta.url) };

let voca = null;
let phonemizer = null;
let limit = 0;
let activeJob = 0;

// Plan of the current job: utterance phoneme/stress arrays and which text
// block each came from. Kept until the next job so seeks can replay.
let plan = null;
let options = { voice: "M2", speed: 1 };
let cursor = 0;
let target = 0;

const post = (message, transfer) => self.postMessage(message, transfer || []);

/* Load requests are stamped with a generation so a quick A→B switch can
 * never let the slower, older load commit after the newer one. */
let loadToken = 0;

/* Bytes for a load request: caller-supplied buffer (typed-array views are
 * copied so readGGUF always sees a whole file), a URL to download, or the
 * bundled GGUF when neither is given. */
async function modelBytes(request) {
  const { buffer, url } = request;
  if (buffer != null) {
    if (buffer instanceof ArrayBuffer) return buffer;
    if (ArrayBuffer.isView(buffer)) return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    throw new Error("model buffer must be an ArrayBuffer");
  }
  if (url != null) {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(`cannot download model from ${url}: ${String((error && error.message) || error)}`);
    }
    if (!response.ok) throw new Error(`cannot download model from ${url} (${response.status})`);
    return response.arrayBuffer();
  }
  const response = await fetch(BUNDLED.url);
  if (!response.ok) throw new Error(`cannot fetch model (${response.status})`);
  return response.arrayBuffer();
}

/* Parses and validates one load request end to end: read the GGUF, build the
 * synthesis model, build the phonemizer embedded in the same file (a plain
 * GGUF without tiny-voca model or phonemizer data is rejected here). The
 * loaded model is committed only after everything built, so a failed switch
 * keeps the previously loaded model serving. */
async function loadModel(request = {}) {
  const token = ++loadToken;
  const custom = request.buffer != null || request.url != null;
  const name = typeof request.name === "string" && request.name.trim() ? request.name.trim()
    : custom ? "custom" : BUNDLED.name;
  const buffer = await modelBytes(request);
  let file;
  try {
    file = readGGUF(buffer);
  } catch (error) {
    throw new Error(`"${name}" is not a valid GGUF file: ${String((error && error.message) || error)}`);
  }
  let built;
  try {
    built = { voca: new TinyVoca(file), phonemizer: await fromGGUF(file) };
  } catch (error) {
    throw new Error(`"${name}" is not a tiny-voca GGUF with an embedded phonemizer: ${String((error && error.message) || error)}`);
  }
  const { sample_rate: sampleRate, max_tokens: maxTokens } = built.voca.config;
  if (!(sampleRate > 0) || !(maxTokens > 0) || !Array.isArray(built.voca.voices) || !built.voca.voices.length) {
    throw new Error(`"${name}" has an unusable model config (sample_rate, max_tokens, speakers)`);
  }
  if (token !== loadToken) return; // a newer load request superseded this one
  voca = built.voca;
  phonemizer = built.phonemizer;
  limit = maxTokens - 12;
  plan = null; // pending state refers to the previous model; drop it
  cursor = 0;
  target = 0;
  activeJob = 0;
  post({ type: "ready", name, sampleRate, maxTokens, voices: [...voca.voices] });
}

function buildPlan(blocks) {
  const utterances = [];
  const blockOf = [];
  for (const block of blocks) {
    const fits = utterancesOf(block.text, phonemizer, limit);
    for (const fit of fits) {
      utterances.push(fit);
      blockOf.push(block.id);
    }
  }
  return { utterances, blockOf };
}

/* Synthesizes sentences [cursor, target) one at a time, checking for
 * cancellation between sentences. A call may return with work left; the
 * background page widens `target` with "advance" messages. */
function pump() {
  try {
    while (plan && cursor < plan.utterances.length && cursor < target) {
      const utterance = plan.utterances[cursor];
      const { audio } = voca.synthesize(utterance.ids, utterance.stress, {
        voice: options.voice,
        speed: options.speed,
        seed: cursor,
      });
      post(
        { type: "chunk", jobId: activeJob, index: cursor, blockId: plan.blockOf[cursor], audio },
        [audio.buffer]
      );
      cursor++;
    }
  } catch (error) {
    post({ type: "error", stage: "synthesize", message: String((error && error.message) || error) });
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "cancel") { activeJob = 0; target = 0; return; }
  if (message.type === "load") {
    // Explicit (re)load: the bundled default when no model is given. While a
    // switch is in flight, commands wait on it; a failed switch falls back
    // to the previously loaded model instead of poisoning readiness.
    const previous = readyPromise;
    const requested = loadModel(message);
    requested.catch((error) => {
      post({ type: "error", stage: "load", message: String((error && error.message) || error) });
      if (readyPromise === requested) readyPromise = previous || null;
    });
    readyPromise = requested;
    return;
  }
  modelReady()
    .then(() => handle(message))
    .catch((error) => post({ type: "error", stage: "load", message: String((error && error.message) || error) }));
};

/* Model loading takes a moment; the first job can arrive earlier, so every
 * command (and its error reporting) is serialized behind readiness. */
const modelReady = () => (readyPromise || (readyPromise = loadModel()));
let readyPromise = null;

function handle(message) {
  if (message.type === "job") {
    activeJob = message.jobId;
    options = { voice: message.voice, speed: message.speed };
    try {
      plan = buildPlan(message.blocks);
    } catch (error) {
      post({ type: "error", stage: "plan", message: String((error && error.message) || error) });
      return;
    }
    cursor = 0;
    target = 0;
    post({ type: "plan", jobId: activeJob, total: plan.utterances.length, blockOf: plan.blockOf });
    pump();
  } else if (message.type === "replay") {
    if (!plan) return;
    activeJob = message.jobId;
    options = { voice: message.voice, speed: message.speed };
    cursor = Math.max(0, Math.min(message.from, plan.utterances.length));
    target = cursor;
    pump();
  } else if (message.type === "advance") {
    if (message.jobId === activeJob) {
      target = Math.max(target, message.to);
      pump();
    }
  } else if (message.type === "cancel") {
    activeJob = 0;
    target = 0;
  }
}
