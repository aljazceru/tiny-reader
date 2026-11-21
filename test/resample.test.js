/*
 * Unit tests for logic/resample.js (pure, no model).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Resample = require("../logic/resample.js");

test("resample keeps the signal for identical rates", () => {
  const input = new Float32Array([0, 0.5, -0.5, 1]);
  assert.equal(Resample.linear(input, 24000, 24000), input);
});

test("resample doubles length and interpolates on upsample", () => {
  const input = new Float32Array([0, 1]);
  const output = Resample.linear(input, 24000, 48000);
  assert.equal(output.length, 4);
  assert.deepEqual([...output], [0, 0.5, 1, 1]); // last sample held
});

test("resample halves length on downsample", () => {
  const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 1]);
  const output = Resample.linear(input, 48000, 24000);
  assert.equal(output.length, 3);
  assert.ok(Math.abs(output[0] - 0) < 1e-6);
  assert.ok(Math.abs(output[1] - 0.5) < 1e-6);
});

test("resample handles empty input and rejects bad input", () => {
  assert.equal(Resample.linear(new Float32Array(0), 24000, 48000).length, 0);
  assert.throws(() => Resample.linear([0, 1], 24000, 48000), TypeError);
});
