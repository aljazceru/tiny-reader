/*
 * tiny reader — gapless Web Audio player.
 *
 * Runs in the background event page. Sentences arrive as Float32 samples at
 * the model rate (24 kHz) and are scheduled back-to-back on one AudioContext:
 * each buffer starts at max(previous end, now + 50 ms). Pausing suspends the
 * context, which freezes currentTime, so scheduling stays consistent across
 * pause/resume without re-anchoring. onEnded(tag) fires when a sentence has
 * actually finished sounding — in play order, since starts are sequential.
 *
 * Loaded as a classic script; expects logic/resample.js first.
 */

"use strict";

/* global Resample */

const VocaPlayer = (() => {
  class VocaPlayer {
    constructor() {
      this.ctx = null;
      this.sources = new Set();
      this.cursor = 0;
      this.onEnded = null;
      this.lastChunk = null; // { tag, rms } for the most recent sentence
    }

    ensureContext() {
      if (this.ctx) return this.ctx;
      this.ctx = new AudioContext();
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    /* Schedules one sentence; returns the AudioContext time it starts at. */
    enqueue(samples, rate, tag) {
      const ctx = this.ensureContext();
      const data = rate === ctx.sampleRate ? samples : Resample.linear(samples, rate, ctx.sampleRate);
      const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buffer.copyToChannel(data, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination); // unconnected sources run silently
      const start = Math.max(this.cursor, ctx.currentTime + 0.05);
      source.start(start);
      this.cursor = start + buffer.duration;
      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        if (this.onEnded) this.onEnded(tag);
      };
      let energy = 0;
      for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
      this.lastChunk = { tag, rms: Math.sqrt(energy / Math.max(1, samples.length)) };
      return start;
    }

    async pause() {
      if (this.ctx && this.ctx.state === "running") await this.ctx.suspend();
    }

    async resume() {
      if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
    }

    /* Drops everything scheduled but keeps the context alive (seek / restart). */
    stopSources() {
      for (const source of this.sources) {
        source.onended = null;
        try { source.stop(); } catch (error) { /* already ended */ }
      }
      this.sources.clear();
      this.cursor = 0;
    }

    get state() {
      return this.ctx ? this.ctx.state : "closed";
    }
  }

  return VocaPlayer;
})();

if (typeof module === "object") module.exports = VocaPlayer;
