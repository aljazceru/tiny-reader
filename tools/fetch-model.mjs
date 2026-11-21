/*
 * Re-downloads the bundled model + phonemizer data from Hugging Face.
 *
 *   node tools/fetch-model.mjs
 *
 * Verifies the file parses by loading it with the vendored engine and
 * phonemizing a sentence (no synthesis, so it stays fast).
 */

import { writeFileSync, readFileSync } from "node:fs";
import { readGGUF, TinyVoca } from "../vendor/tiny-voca.js";
import { fromGGUF } from "../vendor/dizione/engine.js";

const URL_ = "https://huggingface.co/n4ze3m/tiny-voca/resolve/main/gguf/tiny-voca-js.gguf";
const TARGET = new URL("../assets/tiny-voca.gguf", import.meta.url);

const response = await fetch(URL_);
if (!response.ok) throw new Error(`download failed: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
writeFileSync(TARGET, bytes);

const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const file = readGGUF(buffer);
const voca = new TinyVoca(file);
const phonemizer = await fromGGUF(file);
const { ids } = phonemizer.phonemize("Model and phonemizer are working.");

console.log(`${TARGET.pathname}: ${bytes.length} bytes, ${voca.voices.length} voices, sample rate ${voca.config.sample_rate}, check ids ${ids.length}`);
