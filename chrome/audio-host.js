/*
 * tiny reader — Chrome audio host page.
 *
 * Chrome service workers have no DOM and no AudioContext, so the
 * synthesis Worker and the gapless player live in this offscreen
 * document (created with the AUDIO_PLAYBACK reason, which also lets the
 * context suspend and resume without user activation). Everything rides
 * one runtime port ("tv-audio-host") —
 * commands down, replies up. Ports are ordered and bidirectional, so
 * neither side can miss the initial model load; the port reconnects when
 * the service worker restarts.
 *
 *   down  {scope: "tv-host",  message: {kind, ...}}
 *   up    {scope: "tv-engine", message}      — worker replies
 *          {scope: "tv-player", kind, ...}   — sentence ends
 */

"use strict";

/* global VocaPlayer */

(() => {
  let worker = null;
  const player = new VocaPlayer();

  let port = null;
  const uplink = (message) => {
    try {
      if (port) port.postMessage(message);
    } catch (error) { /* port gone; reconnect pending */ }
  };

  function engineReply(message) {
    /* Extension ports demote typed arrays to empty plain objects; send
     * chunk samples as plain number arrays (rebuilt downstream). */
    if (message && message.type === "chunk" && message.audio instanceof Float32Array) {
      message = { ...message, audio: Array.from(message.audio) };
    }
    uplink({ scope: "tv-engine", message });
  }

  function spawnWorker(model) {
    if (worker) worker.terminate();
    worker = new Worker(chrome.runtime.getURL("engine/engine-worker.mjs"), { type: "module" });
    worker.onmessage = (event) => engineReply(event.data);
    worker.onerror = (event) => {
      uplink({ scope: "tv-engine", error: event.message || "worker failed" });
    };
    /* Model bytes arrive as a plain number array (extension messaging
     * demotes ArrayBuffers); rebuild them for the worker's load contract. */
    worker.postMessage(model
      ? { type: "load", name: model.name, buffer: new Uint8Array(model.bytes).buffer }
      : { type: "load" });
  }

  const commands = [];

  /* Sentence ends flow up to the service worker through the port. */
  let endedCount = 0;
  const forwardEnded = (tag) => {
    endedCount++;
    uplink({
      scope: "tv-player",
      kind: "ended",
      tag,
      lastChunk: player.lastChunk,
    });
  };
  player.onEnded = forwardEnded;

  const onCommand = (message) => {
    if (!message || message.scope !== "tv-host") return;
    const job = message.message || {};
    commands.push(job.kind + ":" + (job.message && job.message.type || ""));
    try {
      if (job.kind === "engine") {
        const data = job.message || {};
        if (data.type === "load") spawnWorker(data.model);
        else if (worker) worker.postMessage(data);
      } else if (job.kind === "terminate-engine") {
        if (worker) { worker.terminate(); worker = null; }
      } else if (job.kind === "enqueue") {
        /* Plain numbers arrive over the port (typed arrays demote). */
        player.enqueue(Float32Array.from(job.samples || []), job.rate, job.tag);
      } else if (job.kind === "enqueue-encoded") {
        player.enqueueEncoded(new Uint8Array(job.audio || []).buffer, job.tag);
      } else if (job.kind === "pause") {
        player.pause();
      } else if (job.kind === "resume") {
        player.resume();
      } else if (job.kind === "stop-sources") {
        player.stopSources();
      }
    } catch (error) {
      commands.push("ERROR:" + String((error && error.message) || error).slice(0, 200)
        + " samples=" + Object.prototype.toString.call(job.samples) + " rate=" + typeof job.rate);
    }
  };

  /* The service worker owns the port and connects on demand; this
   * document only ever listens. (A document-side reconnect loop would
   * wake-race the worker and burn CPU while it restarts.) */
  chrome.runtime.onConnect.addListener((incoming) => {
    if (incoming.name !== "tv-audio-host") return;
    port = incoming;
    incoming.onMessage.addListener(onCommand);
    incoming.onDisconnect.addListener(() => {
      if (port === incoming) port = null;
    });
  });
  /* Tell the service worker this document is listening; a port opened
   * before this lands would find nobody to deliver to. */
  chrome.runtime.sendMessage({ scope: "tv-host-hello" }).catch(() => {});

  /* Diagnostic handle: audio state for debugging and the Chrome E2E. */
  globalThis.__tinyReaderAudioHost = {
    get context() { return player.ctx; },
    get sources() { return player.sources.size; },
    get workerAlive() { return Boolean(worker); },
    get portOpen() { return Boolean(port); },
    get endedCount() { return endedCount; },
    get commands() { return commands; },
    emitEnded(tag) { forwardEnded(tag); },
  };
})();
