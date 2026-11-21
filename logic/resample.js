/*
 * tiny reader — audio resampler.
 *
 * The model produces 24 kHz mono Float32 samples; the AudioContext usually
 * runs at the device rate (44.1/48 kHz). Linear interpolation is plenty for
 * speech and keeps the hot loop allocation-free.
 *
 * Pure logic: no browser APIs. Loaded as a classic script by the background
 * event page and via require() by the Node tests.
 */

"use strict";

const Resample = (() => {
  function linear(input, fromRate, toRate) {
    if (!(input instanceof Float32Array) || !Number.isFinite(fromRate) || !Number.isFinite(toRate)) {
      throw new TypeError("linear(input: Float32Array, fromRate, toRate)");
    }
    if (fromRate === toRate || input.length === 0) return input;
    const step = fromRate / toRate;
    const length = Math.max(1, Math.round(input.length / step));
    const output = new Float32Array(length);
    const last = input.length - 1;
    for (let i = 0; i < length; i++) {
      const at = Math.min(i * step, last);
      const left = Math.floor(at);
      const right = Math.min(left + 1, last);
      const part = at - left;
      output[i] = input[left] * (1 - part) + input[right] * part;
    }
    return output;
  }

  return { linear };
})();

if (typeof module === "object") module.exports = Resample;
