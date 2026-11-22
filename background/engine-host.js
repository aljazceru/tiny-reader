/*
 * tiny reader — engine and player host.
 *
 * Firefox event page: the synthesis Worker and the VocaPlayer run directly
 * in the background page — this factory just wraps their construction.
 *
 * Chrome service worker: no DOM and no AudioContext, so both run in an
 * offscreen document (chrome/audio-host.html). All traffic rides one
 * runtime port ("tv-audio-host"): commands down (queued until the document
 * connects), replies up. The proxies implement the exact surface
 * background.js touches: worker {postMessage, terminate, onmessage,
 * onerror}, player {enqueue, enqueueEncoded, pause, resume, stopSources,
 * onEnded, lastChunk}.
 */

"use strict";

/* global VocaPlayer */

const EngineHost = (() => {
  const HOST_URL = "chrome/audio-host.html";
  /* Firefox event pages run the engine in-page; Chrome service workers
   * (no DOM, no AudioContext) delegate to an offscreen audio host. */
  const useAudioHost = typeof navigator === "object" && !/Firefox/.test(navigator.userAgent);

  const sinks = new Set();
  let commandPort = null;
  let hostDocument = false;
  let hadDocument = false; // a document existed at least once

  const route = (event) => {
    const data = event || {};
    for (const sink of sinks) sink(data);
  };

  /* The host document announces itself ("tv-host-hello"); commands wait
   * for it so a port is never opened into an unloaded page. */
  let hostAlive = false;
  let helloWaiters = [];
  if (useAudioHost) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.scope !== "tv-host-hello") return undefined;
      hostAlive = true;
      const waiters = helloWaiters;
      helloWaiters = [];
      for (const resolve of waiters) resolve();
      return undefined;
    });
  }

  const hostReady = (timeout = 8000) =>
    hostAlive ? Promise.resolve() : new Promise((resolve) => {
      helloWaiters.push(resolve);
      setTimeout(resolve, timeout);
    });

  /* The service worker owns the port and connects on demand; the host page
   * only listens. A fresh connect per command batch cannot wake-race. */
  function connectPort() {
    if (commandPort) return commandPort;
    const port = chrome.runtime.connect({ name: "tv-audio-host" });
    port.onMessage.addListener(route);
    port.onDisconnect.addListener(() => {
      if (commandPort === port) commandPort = null;
      /* The document went away (closed or reaped); the next command
       * recreates it and waits for a fresh hello. */
      hostDocument = false;
      hostAlive = false;
    });
    commandPort = port;
    return port;
  }

  async function post(message) {
    if (!useAudioHost) return;
    await ensureDocument();
    await hostReady();
    try {
      connectPort().postMessage({ scope: "tv-host", message });
    } catch (error) {
      commandPort = null; /* dead port; the next command reconnects */
    }
  }


  async function ensureDocument() {
    if (!useAudioHost || hostDocument) return;
    /* Claim it first: a concurrent caller waits on the hello instead of
     * racing a second createDocument (only one may exist). */
    hostDocument = true;
    try {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(HOST_URL)],
      });
      if (!existing.length) {
        await chrome.offscreen.createDocument({
          url: HOST_URL,
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Plays synthesized speech",
        });
      }
      hadDocument = true;
    } catch (error) {
      hostDocument = false;
      throw error;
    }
  }

  async function closeDocument() {
    if (!useAudioHost || !hostDocument) return;
    hostDocument = false;
    hostAlive = false;
    try {
      await chrome.offscreen.closeDocument();
    } catch (error) { /* already gone */ }
  }

  /* True on Chrome when a document existed but is now gone (closed by us
   * or reaped by Chrome — the port disconnect marks it). Whatever ran in
   * it (worker, plan, scheduled audio) went away with it. */
  function hostLost() {
    return useAudioHost && hadDocument && !hostDocument;
  }

  /* Worker stand-in: forwards postMessage to the host-tab engine and
   * surfaces its port replies through the onmessage/onerror properties. */
  class HostWorker {
    constructor(model) {
      this.onmessage = null;
      this.onerror = null;
      this.sink = (data) => {
        if (!data || data.scope !== "tv-engine") return;
        if (data.error && this.onerror) this.onerror({ message: data.error });
        else if (this.onmessage) this.onmessage({ data: data.message });
      };
      sinks.add(this.sink);
      /* ArrayBuffers die on the JSON port; bytes cross as a plain number
       * array and the host document rebuilds them. */
      post({
        kind: "engine",
        message: {
          type: "load",
          model: model ? { name: model.name, bytes: Array.from(new Uint8Array(model.buffer)) } : undefined,
        },
      });
    }

    postMessage(message) { post({ kind: "engine", message }); }

    terminate() {
      sinks.delete(this.sink);
      post({ kind: "terminate-engine" });
    }
  }

  /* Player stand-in: every call forwards to the host player; sentence
   * ends come back over the port and drive the onEnded callback. */
  class HostPlayer {
    constructor() {
      this.onEnded = null;
      this.lastChunk = null;
      this.sink = (data) => {
        if (!data || data.scope !== "tv-player") return;
        if (data.kind === "ended" && this.onEnded) {
          this.lastChunk = data.lastChunk || null;
          this.onEnded(data.tag);
        }
      };
      sinks.add(this.sink);
    }

    /* Extension ports demote typed arrays to plain objects; plain arrays of
     * numbers survive. The host page rebuilds the typed arrays. */
    enqueue(samples, rate, tag) { post({ kind: "enqueue", samples: Array.from(samples), rate, tag }); return 0; }
    enqueueEncoded(audio, tag) { return post({ kind: "enqueue-encoded", audio: Array.from(new Uint8Array(audio)), tag }); }
    async pause() { await post({ kind: "pause" }); }
    async resume() { await post({ kind: "resume" }); }
    stopSources() { post({ kind: "stop-sources" }); }
  }

  async function spawnWorker(url, model) {
    if (!useAudioHost) return new LocalWorker(url, model);
    await ensureDocument();
    await hostReady();
    return new HostWorker(model);
  }

  function createPlayer() {
    return useAudioHost ? new HostPlayer() : new VocaPlayer();
  }

  /* Local Worker with the same onmessage-property contract as the proxy. */
  class LocalWorker {
    constructor(url, model) {
      const instance = new Worker(url, { type: "module" });
      this.onmessage = null;
      this.onerror = null;
      instance.onmessage = (event) => { if (this.onmessage) this.onmessage(event); };
      instance.onerror = (event) => { if (this.onerror) this.onerror(event); };
      instance.postMessage(Object.assign({ type: "load" }, model || {}));
      this.postMessage = (message) => instance.postMessage(message);
      this.terminate = () => instance.terminate();
    }
  }

  return { useAudioHost, hostLost, ensureDocument, closeDocument, spawnWorker, createPlayer, LocalWorker };
})();

if (typeof module === "object") module.exports = EngineHost;
if (typeof self === "object") self.EngineHost = EngineHost;
else if (typeof globalThis === "object") globalThis.EngineHost = EngineHost;
