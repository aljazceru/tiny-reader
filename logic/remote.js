/*
 * tiny reader — remote TTS endpoint helpers.
 *
 * A remote endpoint is an OpenAI-compatible text-to-speech URL (POST
 * {model, input, voice, speed, response_format} → audio bytes), so it works
 * with api.openai.com, Groq, and self-hosted servers (openedai-speech,
 * Kokoro-FastAPI, …). Pure logic: validation and request shaping only, no
 * fetch here. Loaded as a classic script by the background event page and
 * via require() by the Node tests.
 */

"use strict";

const RemoteTts = (() => {
  const DEFAULT_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

  /* Normalizes endpoint input from the reader UI / setModel message into
   * {name, url, apiKey, model, voices}. Throws on anything unusable. */
  function normalize(input) {
    const data = input && typeof input === "object" ? input : {};
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) throw new Error("The endpoint needs a name.");

    let target;
    try {
      target = new URL(String(data.url || ""));
    } catch (error) {
      throw new Error("The endpoint URL is not valid.");
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error("Only http(s) endpoint URLs are supported.");
    }

    const apiKey = typeof data.apiKey === "string" ? data.apiKey.trim() : "";
    const model = typeof data.model === "string" ? data.model.trim() : "";

    const voices = Array.isArray(data.voices)
      ? data.voices.map((voice) => String(voice).trim()).filter(Boolean)
      : DEFAULT_VOICES.slice();
    if (!voices.length) throw new Error("The endpoint needs at least one voice name.");

    return { name, url: target.href, apiKey, model, voices: [...new Set(voices)] };
  }

  /* fetch() arguments for one utterance. `speed` clamps to the OpenAI
   * speech API range (0.25–4.0) so stored prefs never break a request. */
  function speechRequest(config, { text, voice, speed = 1 }) {
    const settings = normalize(config);
    const input = String(text || "").trim();
    if (!input) throw new Error("Nothing to synthesize — the text is empty.");
    const chosen = settings.voices.includes(voice) ? voice : settings.voices[0];
    const rate = Math.min(Math.max(Number(speed) || 1, 0.25), 4);

    const body = { input, voice: chosen, speed: rate, response_format: "wav" };
    if (settings.model) body.model = settings.model;
    else if (settings.url.includes("openai.com")) body.model = "gpt-4o-mini-tts";
    else body.model = "tts-1";

    const headers = { "content-type": "application/json" };
    if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
    return { url: settings.url, init: { method: "POST", headers, body: JSON.stringify(body) } };
  }

  /* A speech response is audio when the content type says so, or — some
   * servers send application/octet-stream — when the body is non-empty. */
  function isSpeechResponse(response) {
    const type = String(response.headers && response.headers.get && response.headers.get("content-type") || "");
    if (type.startsWith("audio/")) return true;
    if (type.startsWith("application/json")) return false; // an API error payload
    return true;
  }

  return { normalize, speechRequest, isSpeechResponse, DEFAULT_VOICES };
})();

if (typeof module === "object") module.exports = RemoteTts;
if (typeof self === "object") self.RemoteTts = RemoteTts;
else if (typeof globalThis === "object") globalThis.RemoteTts = RemoteTts;
