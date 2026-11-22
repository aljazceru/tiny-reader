/*
 * tiny reader — background event page.
 *
 * Owns playback end to end: injects the content script on demand (activeTab),
 * sends the extracted text blocks to the synthesis worker, schedules the
 * returned sentence audio on the gapless player, highlights the paragraph
 * being read in the page, and drives the popup / context menu / keyboard
 * shortcut. Flow control keeps the worker at most LOOKAHEAD sentences ahead
 * of playback so long pages never pile up in memory.
 *
 * Web pages (selection / whole page) and direct inputs from the reader
 * workspace (paste, url, pdf, epub, txt) share one job path; direct
 * inputs own their sender tab and never require a content script or
 * highlighting. Nothing that is read is stored. The active model is persisted through the ModelStore global and
 * swapped by validating candidates in a fresh worker; a persisted model is
 * loaded eagerly at startup so its name and voices can drive the UI, while
 * the bundled default stays lazy. Voice/speed preferences are global
 * defaults with optional per-site overrides for http(s) page reads
 * (logic/prefs.js helpers).
 *
 * The event page is kept alive while reading by a runtime port that the
 * content script of the reading tab (or the reader workspace) holds open
 * (Firefox keeps an event page loaded while message ports are open).
 */

"use strict";

/* global VocaPlayer, VocaPrefs, ModelStore, RemoteTts, EngineHost */

const DEFAULT_PREFS = { voice: "M2", speed: 1 };
const LOOKAHEAD = 12;
const MAX_CHARS = 500000; // hard cap for direct input
const PAGE_SOURCES = ["selection", "page"];
const DIRECT_SOURCES = ["paste", "url", "pdf", "epub", "txt"];
const BUNDLED_MODEL = { name: "tiny-voca (bundled)", voices: ["M2", "F2"] };
const WORKER_LOAD_TIMEOUT = 120000; // custom GGUF validation can take a while

const S = {
  status: "idle", // idle | loading | planning | playing | paused | done | error
  error: null,
  tabId: null,
  page: null, // { title, url }
  source: null, // "selection" | "page" | paste | url | pdf | epub | txt
  total: 0,
  blockOf: [], // block id per utterance index
  blockTexts: [], // block text per block id, for the popup preview
  playingIndex: -1,
  hasSelection: false,
  lastRms: null,
  model: { name: BUNDLED_MODEL.name, voices: [] }, // confirmed by worker ready
};

let jobId = 0;
let worker = null;
let player = null;
let keepalive = null;
let sampleRate = 24000;
let remotePlan = null; // { texts, blockOf } while a remote endpoint job runs
let remoteCursor = 0;
let remoteTarget = 0;
let remotePumping = false;
let resumeAt = null; // sentence to land on when a lost Chrome host restarts the job
let textChunks = null; // cached splitter (logic/chunks.js)
let globalPrefs = null; // { voice, speed } from storage
let sitePrefs = {}; // host -> { voice?, speed? }
let prefsCache = null; // effective prefs for the active context
let activeModel = null; // persisted descriptor { name, buffer } | { name, remote }; null = bundled

/* ---------------------------------------------------------------- prefs */

async function ensurePrefs() {
  if (globalPrefs) return;
  const stored = await browser.storage.local.get(DEFAULT_PREFS);
  globalPrefs = {
    voice: typeof stored.voice === "string" && stored.voice ? stored.voice : DEFAULT_PREFS.voice,
    speed: Number(stored.speed) || DEFAULT_PREFS.speed,
  };
  const sites = await browser.storage.local.get({ sitePrefs: {} });
  sitePrefs = sites.sitePrefs && typeof sites.sitePrefs === "object" ? sites.sitePrefs : {};
}

/* Effective prefs: global defaults, with the current page's site override
 * merged on top while a page read is active. */
function effectivePrefs(host) {
  return VocaPrefs.mergePrefs(globalPrefs || DEFAULT_PREFS, host ? sitePrefs[host] : null);
}

function readActive() {
  return ["loading", "planning", "playing", "paused"].includes(S.status);
}

/* Host of the page being read — only active http(s) page reads carry
 * overrides; idle, done, and direct reader inputs use global defaults. */
function currentPageHost() {
  if (!readActive() || !PAGE_SOURCES.includes(S.source) || !S.page) return null;
  return VocaPrefs.hostFromUrl(S.page.url);
}

async function prefsForContext(host) {
  await ensurePrefs();
  return effectivePrefs(host);
}

async function setPrefs(patch) {
  await ensurePrefs();
  const host = currentPageHost();
  const clean = VocaPrefs.normalizePatch(patch, effectivePrefs(host));
  if (clean.voice !== undefined || clean.speed !== undefined) {
    if (host) {
      /* Changes during a page read persist under that page's host. */
      sitePrefs = { ...sitePrefs, [host]: { ...(sitePrefs[host] || {}), ...clean } };
      await browser.storage.local.set({ sitePrefs });
    } else {
      /* Idle and direct reader inputs (paste/url/pdf/epub/txt)
       * change the global defaults. */
      globalPrefs = { ...globalPrefs, ...clean };
      await browser.storage.local.set({ voice: globalPrefs.voice, speed: globalPrefs.speed });
    }
  }
  prefsCache = effectivePrefs(currentPageHost());
  if (S.status === "playing" || S.status === "paused") seek(Math.max(0, S.playingIndex));
  return prefsCache;
}

/* A stored voice the freshly loaded model does not know would break every
 * job; remap stored choices to the model's first voice. */
function fixVoiceForModel(voices) {
  const fallback = voices[0];
  if (prefsCache && prefsCache.voice && !voices.includes(prefsCache.voice)) {
    prefsCache = { ...prefsCache, voice: fallback };
  }
  (async () => {
    await ensurePrefs();
    let changed = false;
    if (!voices.includes(globalPrefs.voice)) {
      globalPrefs = { ...globalPrefs, voice: fallback };
      changed = true;
    }
    for (const [host, override] of Object.entries(sitePrefs)) {
      if (override.voice !== undefined && !voices.includes(override.voice)) {
        sitePrefs = { ...sitePrefs, [host]: { ...override, voice: fallback } };
        changed = true;
      }
    }
    if (changed) {
      const stored = { voice: globalPrefs.voice, speed: globalPrefs.speed };
      if (Object.keys(sitePrefs).length) stored.sitePrefs = sitePrefs;
      await browser.storage.local.set(stored);
    }
    prefsCache = effectivePrefs(currentPageHost());
  })().catch(() => {});
}

/* ---------------------------------------------------------------- badge */

function badge() {
  const text = S.status === "playing" ? "▶" : S.status === "paused" ? "❚❚" : S.status === "error" ? "!" : "";
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color: S.status === "error" ? "#b3261e" : "#14804a" });
}

/* --------------------------------------------------------------- worker */

/* Spawns the synthesis worker: in the background page directly (Firefox),
 * or in the offscreen audio host (Chrome). */
function spawnWorker(model) {
  return EngineHost.spawnWorker(browser.runtime.getURL("engine/engine-worker.mjs"), model);
}

/* One-shot ready/error await for a candidate worker (model validation);
 * detaches after the first terminal message so later job traffic flows
 * through the normal handlers only. */
function workerReady(instance, timeout = WORKER_LOAD_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = event.data || {};
      if (message.type === "ready") done(null, message);
      else if (message.type === "error") done(new Error(`${message.stage || "model"}: ${message.message || "model rejected"}`));
    };
    const onError = (event) => done(new Error(event.message || "worker failed to start"));
    const timer = setTimeout(() => done(new Error("Model load timed out.")), timeout);
    function done(error, message) {
      clearTimeout(timer);
      instance.onmessage = null;
      instance.onerror = null;
      if (error) reject(error);
      else resolve(message);
    }
    instance.onmessage = onMessage;
    instance.onerror = onError;
  });
}

function wireWorker(instance) {
  instance.onmessage = (event) => onWorkerMessage(event.data);
  instance.onerror = (event) => fail(`worker: ${event.message || "failed to start"}`);
}

function terminateWorker(instance) {
  if (!instance) return;
  instance.onmessage = null;
  instance.onerror = null;
  instance.terminate();
}

async function ensureWorker() {
  if (worker) return worker;
  worker = await spawnWorker(activeModel ? { name: activeModel.name, buffer: activeModel.buffer } : undefined);
  wireWorker(worker);
  return worker;
}

function onWorkerMessage(message) {
  if (message.type === "ready") {
    sampleRate = message.sampleRate;
    applyModel(message);
  } else if (message.type === "plan") {
    if (message.jobId !== jobId) return;
    S.blockOf = message.blockOf;
    S.total = message.total;
    if (!S.total) { resumeAt = null; return fail("Nothing to pronounce here."); }
    if (resumeAt !== null) {
      /* Resume into a re-created host: land on the paused sentence (the
       * plan is deterministic for the same blocks/voice/speed). */
      const at = resumeAt;
      resumeAt = null;
      return seek(at);
    }
    worker.postMessage({ type: "advance", jobId, to: LOOKAHEAD });
  } else if (message.type === "chunk") {
    if (message.jobId !== jobId || !player) return;
    player.enqueue(message.audio, sampleRate, message.index);
    if (S.status === "loading" || S.status === "planning") {
      S.status = "playing";
      S.playingIndex = message.index;
      highlightBlock(message.blockId);
      badge();
    }
  } else if (message.type === "error") {
    fail(`voice model (${message.stage}): ${message.message}`);
  }
}

/* ------------------------------------------------------------ remote tts */

function isRemoteModel() {
  return Boolean(activeModel && activeModel.remote);
}

/* logic/chunks.js is a classic script on every background script list. */
function loadTextChunks() {
  return Promise.resolve(TextChunks.of);
}

/* Plan + pump for a remote endpoint job — the mirror of the worker
 * contract: sentences are synthesized one at a time up to `remoteTarget`;
 * sentence-end widens the target exactly like the worker's "advance".
 * Every await re-checks jobId, so stop/seek cancel in-flight requests. */
function remotePump() {
  if (remotePumping || !remotePlan) return;
  remotePumping = true;
(async () => {
    const config = activeModel && activeModel.remote;
    while (config && remotePlan && remoteCursor < remotePlan.texts.length && remoteCursor < remoteTarget) {
      const job = jobId;
      const index = remoteCursor;
      const request = RemoteTts.speechRequest(config, {
        text: remotePlan.texts[index],
        voice: prefsCache ? prefsCache.voice : config.voices[0],
        speed: prefsCache ? prefsCache.speed : 1,
      });
      let response;
      try {
        response = await fetch(request.url, request.init);
      } catch (error) {
        if (jobId === job) fail(`voice endpoint: ${String((error && error.message) || error)}`);
        return;
      }
      if (jobId !== job) return;
      if (!response.ok || !RemoteTts.isSpeechResponse(response)) {
        let detail = "";
        try { detail = (await response.text()).slice(0, 160); } catch (error) { /* body unreadable */ }
        if (jobId === job) fail(`voice endpoint: request failed (${response.status}${detail ? `: ${detail}` : ""}).`);
        return;
      }
      const audio = await response.arrayBuffer();
      if (jobId !== job) return;
      try {
        await player.enqueueEncoded(audio, index);
      } catch (error) {
        if (jobId === job) fail(`voice endpoint: ${String((error && error.message) || error)}`);
        return;
      }
      if (S.status === "loading" || S.status === "planning") {
        S.status = "playing";
        S.playingIndex = index;
        highlightBlock(remotePlan.blockOf[index]);
        badge();
      }
      remoteCursor++;
    }
  })().finally(() => {
    remotePumping = false;
    if (remotePlan && remoteTarget > remoteCursor) remotePump();
  });
}

/* Remote branch of beginJob: split blocks to endpoint-sized text chunks,
 * then synthesize the first look-ahead window. */
async function startRemoteJob(blocks) {
  const split = await loadTextChunks();
  const texts = [];
  const blockOf = [];
  blocks.forEach((text, id) => {
    for (const chunk of split(text)) {
      texts.push(chunk);
      blockOf.push(id);
    }
  });
  remotePlan = { texts, blockOf };
  remoteCursor = 0;
  remoteTarget = 0;
  S.blockOf = blockOf;
  S.total = texts.length;
  if (!S.total) return fail("Nothing to pronounce here.");
  remoteTarget = LOOKAHEAD;
  remotePump();
}

function stopRemoteJob() {
  remotePlan = null;
  remoteCursor = 0;
  remoteTarget = 0;
}
/* Adopt a confirmed model (worker "ready"): its name and voices drive the
 * popup and reader UI selects. */
function applyModel(ready) {
  const voices = Array.isArray(ready.voices) ? ready.voices.map(String).filter(Boolean) : [];
  const name = typeof ready.name === "string" && ready.name
    ? ready.name
    : (activeModel ? activeModel.name : BUNDLED_MODEL.name);
  S.model = { name, voices: voices.length ? voices : S.model.voices };
  if (voices.length) fixVoiceForModel(S.model.voices);
}

/* ---------------------------------------------------------------- model */

function modelStore() {
  const store = typeof ModelStore === "undefined" ? null : ModelStore;
  return store && typeof store.loadActive === "function" ? store : null;
}

/* Active model persistence; any store trouble falls back to the bundled
 * model. */
async function loadStoredModel() {
  const store = modelStore();
  if (!store) return null;
  try {
    const active = await store.loadActive();
    if (!active || typeof active.name !== "string" || !active.name.trim()) return null;
    if (active.remote && typeof active.remote === "object") {
      const config = RemoteTts.normalize(active.remote);
      return { name: active.name.trim(), remote: config };
    }
    if (!(active.buffer instanceof ArrayBuffer) || !active.buffer.byteLength) return null;
    return { name: active.name.trim(), buffer: active.buffer };
  } catch (error) {
    return null;
  }
}

async function persistModel(descriptor) {
  const store = modelStore();
  if (!store || typeof store.saveActive !== "function") return;
  if (descriptor.remote) await store.saveActive({ name: descriptor.name, remote: descriptor.remote });
  else await store.saveActive({ name: descriptor.name, buffer: descriptor.buffer });
}

async function clearStoredModel() {
  const store = modelStore();
  if (store && typeof store.clear === "function") await store.clear();
}

async function downloadModel(url) {
  let target;
  try {
    target = new URL(url);
  } catch (error) {
    throw new Error("That model URL is not valid.");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Only http(s) model URLs can be downloaded.");
  }
  let response;
  try {
    response = await fetch(target.href);
  } catch (error) {
    throw new Error(`Model download failed: ${String((error && error.message) || error)}`);
  }
  if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error("The model download was empty.");
  return buffer;
}

function swapWorker(candidate, ready) {
  const previous = worker;
  worker = candidate;
  wireWorker(candidate);
  terminateWorker(previous);
  stopRemoteJob(); // a local model takes over from any remote endpoint
  if (ready) onWorkerMessage(ready); // sampleRate + model name/voices
}

/* Adopts a confirmed remote endpoint: no worker runs while it is active. */
function applyRemoteModel(descriptor) {
  terminateWorker(worker);
  worker = null;
  stopRemoteJob();
  activeModel = descriptor;
  S.model = { name: descriptor.name, voices: descriptor.remote.voices.slice() };
  fixVoiceForModel(S.model.voices);
}

/* setModel: download if needed, validate in a fresh worker, then swap and
 * persist. Invalid input rejects and leaves the previous model untouched. */
async function setModel(data) {
  await ensureModelLoaded();
  const input = data && typeof data === "object" ? data : {};

  if (input.reset) {
    /* Back to the bundled model. */
    await clearStoredModel().catch(() => {});
    activeModel = null;
    const candidate = await spawnWorker(undefined);
    const ready = await workerReady(candidate).catch((error) => {
      terminateWorker(candidate);
      throw error;
    });
    swapWorker(candidate, ready);
    await restartJobIfReading();
    return { name: S.model.name, voices: S.model.voices };
  }
  if (input.remote) {
    /* Validate the endpoint with one short request that must return audio;
     * only then does it replace the current model. */
    const config = RemoteTts.normalize(input.remote);
    const probe = RemoteTts.speechRequest(config, { text: "Ready.", voice: config.voices[0], speed: 1 });
    let response;
    try {
      response = await fetch(probe.url, probe.init);
    } catch (error) {
      throw new Error(`Endpoint unreachable: ${String((error && error.message) || error)}`);
    }
    if (!response.ok || !RemoteTts.isSpeechResponse(response)) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 160); } catch (error) { /* body unreadable */ }
      throw new Error(`The endpoint did not return audio (${response.status}${detail ? `: ${detail}` : ""}).`);
    }
    await response.arrayBuffer().catch(() => {}); // drain the probe body
    applyRemoteModel({ name: config.name, remote: config });
    try {
      await persistModel(activeModel);
    } catch (error) { /* stays active for this session even if saving failed */ }
    await restartJobIfReading();
    return { name: S.model.name, voices: S.model.voices };
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("The model needs a name.");
  let buffer = input.buffer instanceof ArrayBuffer && input.buffer.byteLength ? input.buffer : null;
  if (!buffer) {
    if (typeof input.url === "string" && input.url.trim()) buffer = await downloadModel(input.url.trim());
    else throw new Error("Provide model bytes (GGUF) or an http(s) URL to download.");
  }

  /* Validate in a fresh worker: the current worker keeps playing until the
   * new model has proven it loads. */
  const candidate = await spawnWorker({ name, buffer });
  let ready;
  try {
    ready = await workerReady(candidate);
  } catch (error) {
    terminateWorker(candidate); // invalid model: previous model stays active
    throw error;
  }
  swapWorker(candidate, ready);
  activeModel = { name, buffer };
  try {
    await persistModel(activeModel);
  } catch (error) { /* stays active for this session even if saving failed */ }
  await restartJobIfReading();
  return { name: S.model.name, voices: S.model.voices };
}

/* A model swap replaces the worker, so the plan is gone; restart the current
 * item through the shared job path (from its first sentence). */
async function restartJobIfReading() {
  if (!readActive() || !S.blockTexts.length) return;
  const wasPaused = S.status === "paused";
  beginJob({
    title: S.page ? S.page.title : "",
    url: S.page ? S.page.url : "",
    blocks: S.blockTexts,
    source: S.source,
    tabId: S.tabId,
  });
  if (wasPaused) await pause();
}

/* ---------------------------------------------------------------- state */

function fail(message) {
  S.status = "error";
  S.error = message;
  badge();
}

function snapshot() {
  const blockId = S.playingIndex >= 0 ? S.blockOf[S.playingIndex] : -1;
  const preview = blockId >= 0 ? S.blockTexts[blockId] || "" : "";
  return {
    status: S.status,
    error: S.error,
    page: S.page,
    source: S.source,
    total: S.total,
    index: S.playingIndex,
    preview,
    hasSelection: S.hasSelection,
    lastRms: player ? player.lastChunk : null,
    prefs: prefsCache,
    model: S.model,
  };
}

/* Only nonempty strings count as blocks; everything else is dropped. */
function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((text) => typeof text === "string" && text.trim().length > 0);
}

/* ------------------------------------------------------- page plumbing */

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function readable(tab) {
  if (!tab || !tab.id) return "No tab to read.";
  const url = tab.url || "";
  if (/^(about|chrome|moz-extension|view-source|data):/i.test(url)) return "This kind of page cannot be read.";
  return null;
}

async function extract(tab, source) {
  const ask = () => browser.tabs.sendMessage(tab.id, { type: "extract", source });
  try {
    return await ask(); // declared content scripts are usually already in place
  } catch (error) { /* not injected yet (grant raced the page load) */ }
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["vendor/readability.js", "content/content.js"],
  });
  const page = await ask();
  if (!page || !Array.isArray(page.blocks)) throw new Error("The page did not answer.");
  if (!page.blocks.length) {
    throw new Error(page.source === "selection"
      ? "No text selected — select the text you want read first."
      : "No readable text found on this page.");
  }
  return page;
}

function toTab(message) {
  if (S.tabId === null) return Promise.resolve(null);
  return browser.tabs.sendMessage(S.tabId, message).catch(() => null);
}

function highlightBlock(blockId) {
  toTab({ type: "highlight", blockId });
}

/* -------------------------------------------------------------- reading */

async function stopPlayback() {
  jobId++;
  if (worker) worker.postMessage({ type: "cancel" });
  stopRemoteJob();
  resumeAt = null;
  if (player) player.stopSources();
  await toTab({ type: "clearHighlight" });
  toTab({ type: "reading", on: false });
  releaseKeepalive();
  S.status = "idle";
  S.error = null;
  S.total = 0;
  S.playingIndex = -1;
  S.tabId = null;
  S.page = null;
  S.source = null;
  S.blockOf = [];
  S.lastRms = null;
  badge();
}

/* Page path: selection or whole page from a normal web tab. */
async function read(tab, source) {
  await ensureModelLoaded();
  const problem = readable(tab);
  if (problem) return fail(problem);
  await stopPlayback();
  S.status = "loading";
  S.error = null;
  S.tabId = tab.id;
  S.page = { title: tab.title || "", url: tab.url || "" };
  badge();

  let page;
  try {
    page = await extract(tab, source);
  } catch (error) {
    return fail(String((error && error.message) || error));
  }
  prefsCache = await prefsForContext(VocaPrefs.hostFromUrl(S.page.url));
  beginJob({
    title: page.title || S.page.title,
    url: S.page.url,
    blocks: page.blocks,
    source: page.source,
    tabId: tab.id,
  });
}

/* One job path for every input: page reads (selection/page), direct reader
 * inputs (paste/url/pdf/epub/txt). The caller has
 * already stopped any previous job and set the effective prefs. */
async function beginJob({ title, url, blocks, source, tabId = null }) {
  S.tabId = typeof tabId === "number" ? tabId : null;
  S.page = { title: title || "", url: url || "" };
  S.source = source;
  S.blockTexts = blocks;
  S.blockOf = [];
  S.total = 0;
  S.playingIndex = -1;
  S.status = "planning";
  S.error = null;
  badge();

  if (!isRemoteModel()) await ensureWorker();
  if (!player) player = EngineHost.createPlayer();
  player.onEnded = onSentenceEnded;
  player.stopSources();
  jobId++;
  stopRemoteJob();
  if (isRemoteModel()) {
    startRemoteJob(blocks);
  } else {
    worker.postMessage({
      type: "job",
      jobId,
      blocks: blocks.map((text, id) => ({ id, text })),
      voice: prefsCache.voice,
      speed: prefsCache.speed,
    });
  }
  toTab({ type: "reading", on: true });
}

/* Direct input from the reader workspace; owns its sender tab and needs no
 * content script, extraction, or highlighting. */
async function readBlocks(data, sender) {
  const input = data && typeof data === "object" ? data : {};
  const blocks = sanitizeBlocks(input.blocks);
  if (!blocks.length) throw new Error("Nothing to read — no text was provided.");
  const characters = blocks.reduce((sum, text) => sum + text.length, 0);
  if (characters > MAX_CHARS) throw new Error("Too much text — the limit is 500,000 characters.");
  const source = DIRECT_SOURCES.includes(input.source) ? input.source : "paste";
  const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;

  await stopPlayback();
  prefsCache = await prefsForContext(null); // direct inputs use global prefs
  beginJob({
    title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : "Untitled",
    url: typeof input.url === "string" ? input.url : "",
    blocks,
    source,
    tabId,
  });
  return { ok: true, source, blocks: blocks.length, characters };
}

/* Jump to an utterance index, reusing the worker's plan (or the remote
 * endpoint's chunk list); voice and speed changes take effect from the
 * jump point. */
function seek(index) {
  if (!player || !S.total) return;
  if (!isRemoteModel() && !worker) return;
  if (index >= S.total) return finish();
  jobId++;
  player.stopSources();
  S.playingIndex = index;
  S.status = "playing";
  badge();
  if (isRemoteModel()) {
    remoteCursor = index;
    remoteTarget = index + LOOKAHEAD;
    highlightBlock(S.blockOf[index]);
    remotePump();
    return;
  }
  worker.postMessage({ type: "cancel" });
  const settings = prefsCache;
  worker.postMessage({ type: "replay", jobId, from: index, voice: settings.voice, speed: settings.speed });
  worker.postMessage({ type: "advance", jobId, to: index + LOOKAHEAD });
  highlightBlock(S.blockOf[index]);
}

function onSentenceEnded(tag) {
  if (S.status !== "playing") return;
  const next = tag + 1;
  if (next >= S.total) return finish();
  S.playingIndex = next;
  highlightBlock(S.blockOf[next]);
  if (isRemoteModel()) {
    remoteTarget = next + LOOKAHEAD;
    remotePump();
    return;
  }
  worker.postMessage({ type: "advance", jobId, to: next + LOOKAHEAD });
}

async function finish() {
  jobId++;
  if (worker) worker.postMessage({ type: "cancel" });
  stopRemoteJob();
  if (player) player.stopSources();
  S.status = "done";
  badge();
  await toTab({ type: "clearHighlight" });
  toTab({ type: "reading", on: false });
  releaseKeepalive();
}

/* --------------------------------------------------------- pause logic */

async function pause() {
  if (S.status !== "playing" || !player) return;
  await player.pause();
  S.status = "paused";
  badge();
}

async function resume() {
  if (S.status !== "paused" || !player) return;
  if (EngineHost.hostLost()) {
    /* Chrome reaped the offscreen document while paused; the worker and
     * its plan went with it, so there is nothing to resume. Restart the
     * job and land on the paused sentence. */
    if (isRemoteModel()) return seek(Math.max(0, S.playingIndex));
    if (worker) { worker.onmessage = null; worker.onerror = null; worker = null; }
    resumeAt = Math.max(0, S.playingIndex);
    return beginJob({
      title: S.page ? S.page.title : "",
      url: S.page ? S.page.url : "",
      blocks: S.blockTexts,
      source: S.source,
      tabId: S.tabId,
    });
  }
  await player.resume();
  S.status = "playing";
  badge();
}

/* Shortcut / popup toggle: selection if there is one, else the page. */
async function toggle() {
  if (S.status === "playing") return pause();
  if (S.status === "paused") return resume();
  const tab = await activeTab();
  return read(tab, "auto");
}

/* ------------------------------------------------------------ keepalive */

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "tv-keepalive") return;
  keepalive = port;
  port.onDisconnect.addListener(() => {
    if (keepalive === port) keepalive = null;
    if (S.status === "playing" || S.status === "paused") stopPlayback();
  });
});

function releaseKeepalive() {
  if (keepalive) {
    const port = keepalive;
    keepalive = null;
    port.disconnect();
  }
}

/* --------------------------------------------------------------- probes */

/* Cheap selection probe for the popup (runs the page's own selection check;
 * no readability, no extraction). */
async function probeSelection() {
  const tab = await activeTab();
  if (!tab || readable(tab) || S.tabId === tab.id) return;
  try {
    const [result] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const selection = window.getSelection();
        return selection ? selection.toString().trim().length : 0;
      },
    });
    S.hasSelection = Boolean(result && result.result >= 2);
  } catch (error) {
    S.hasSelection = false;
  }
}

/* ------------------------------------------------------------ messenging */

async function refreshState() {
  await ensurePrefs();
  prefsCache = effectivePrefs(currentPageHost());
  return snapshot();
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return undefined;
  switch (message.type) {
    case "getState":
      probeSelection(); // refreshes S.hasSelection for the next poll
      return refreshState();
    case "play":
      activeTab().then((tab) => read(tab, message.source || "auto"));
      return undefined;
    case "pause":
      return pause();
    case "resume":
      return resume();
    case "stop":
      return stopPlayback();
    case "next":
      return Promise.resolve(seek(S.playingIndex + 1));
    case "prev":
      return Promise.resolve(seek(Math.max(0, S.playingIndex - 1)));
    case "setPrefs":
      return setPrefs(message.patch);
    case "openReader":
      return browser.tabs
        .create({ url: browser.runtime.getURL("reader/reader.html") })
        .then((tab) => ({ ok: true, tabId: tab.id }));
    case "readBlocks":
      return ensureModelLoaded().then(() => readBlocks(message, sender));
    case "setModel":
      return setModel(message);
    default:
      return undefined;
  }
});

/* ------------------------------------------------------- entry points */

browser.runtime.onInstalled.addListener(() => {
  /* Older versions kept a saved-article library and queue; drop them. */
  browser.storage.local.remove(["libraryItems", "queueIds"]).catch(() => {});
  /* Firefox exposes both namespaces; Chrome only contextMenus. */
  const menus = browser.menus || browser.contextMenus;
  menus.create({ id: "tv-selection", title: "Read selection with tiny reader", contexts: ["selection"] });
  menus.create({ id: "tv-page", title: "Read whole page with tiny reader", contexts: ["page"] });
});

(browser.menus || browser.contextMenus).onClicked.addListener((info, tab) => {
  read(tab, info.menuItemId === "tv-selection" ? "selection" : "page");
});

browser.commands.onCommand.addListener((command) => {
  if (command === "toggle-read") toggle();
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === S.tabId && (S.status === "playing" || S.status === "paused" || S.status === "planning")) {
    stopPlayback();
  }
});

/* -------------------------------------------------------------- startup */

/* Prefs load lazily on demand; a persisted active model loads
 * eagerly (and starts its worker) so its name and voices can drive the UI
 * without a read first. The bundled default stays lazy, exactly as before. */
const modelStartup = (async () => {
  await ensurePrefs();
  prefsCache = effectivePrefs(currentPageHost());
  activeModel = await loadStoredModel();
  if (activeModel && activeModel.remote) {
    S.model = { name: activeModel.name, voices: activeModel.remote.voices.slice() };
    fixVoiceForModel(S.model.voices);
    return; // no worker while a remote endpoint is active
  }
  S.model = activeModel
    ? { name: activeModel.name, voices: [] }
    : { name: BUNDLED_MODEL.name, voices: BUNDLED_MODEL.voices.slice() };
  if (activeModel) ensureWorker();
})().catch(() => {});

/* Readers wait at most 5 s for the stored-model lookup; afterwards the
 * bundled default is used (the store is purely an enhancement). */
function ensureModelLoaded() {
  return Promise.race([modelStartup, new Promise((resolve) => setTimeout(resolve, 5000))]);
}
