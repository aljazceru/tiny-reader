/*
 * tiny reader — plain-text utterance chunking.
 *
 * Splits block text into endpoint-sized chunks for remote TTS services
 * (the local model plans utterances through its phonemizer instead).
 * Sentence boundaries follow the same heuristics as the engine's planner;
 * overlong sentences are hard-split at word boundaries. Pure logic: loaded
 * as a classic script by the background page (Firefox and the Chrome
 * service worker bootstrap) and via require() by the Node tests.
 */

"use strict";

const TextChunks = (() => {
  const ABBREVIATIONS = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|inc|ltd|co|e\.g|i\.e|a\.m|p\.m)|\b[A-Z])\.$/i;

  function sentences(text) {
    const parts = [];
    let current = "";
    for (const piece of text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/)) {
      current = current ? current + " " + piece : piece;
      if (!ABBREVIATIONS.test(current)) { parts.push(current); current = ""; }
    }
    if (current) parts.push(current);
    return parts.filter((part) => /[\p{L}\p{N}]/u.test(part));
  }

  function fitChars(sentence, limit) {
    if (sentence.length <= limit) return [sentence];
    const pieces = [];
    let rest = sentence;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(" ", limit);
      if (cut < Math.floor(limit / 2)) cut = limit;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) pieces.push(rest);
    return pieces;
  }

  /* Sentences packed to at most `maxChars` (default 800), overlong ones
   * hard-split at word boundaries. */
  function of(text, maxChars = 800) {
    const limit = Number.isFinite(maxChars) && maxChars >= 40 ? Math.floor(maxChars) : 800;
    const chunks = [];
    let packed = "";
    for (const sentence of sentences(String(text))) {
      for (const piece of fitChars(sentence, limit)) {
        if (packed && packed.length + 1 + piece.length > limit) {
          chunks.push(packed);
          packed = "";
        }
        packed = packed ? `${packed} ${piece}` : piece;
      }
    }
    if (packed) chunks.push(packed);
    return chunks;
  }

  return { of, sentences };
})();

if (typeof module === "object") module.exports = TextChunks;
if (typeof self === "object") self.TextChunks = TextChunks;
else if (typeof globalThis === "object") globalThis.TextChunks = TextChunks;
