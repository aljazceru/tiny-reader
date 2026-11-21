/* Unit tests for global + per-site preference helpers. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Prefs = require("../logic/prefs.js");

test("hostFromUrl accepts only http(s) hosts", () => {
  assert.equal(Prefs.hostFromUrl("https://Example.COM/a?b=1"), "example.com");
  assert.equal(Prefs.hostFromUrl("http://localhost:8123/article"), "localhost");
  assert.equal(Prefs.hostFromUrl("moz-extension://uuid/reader/reader.html"), null);
  assert.equal(Prefs.hostFromUrl("not a url"), null);
  assert.equal(Prefs.hostFromUrl(null), null);
});

test("mergePrefs applies partial site overrides without mutating defaults", () => {
  const defaults = { voice: "M2", speed: 1 };
  assert.deepEqual(Prefs.mergePrefs(defaults, { speed: 1.5 }), { voice: "M2", speed: 1.5 });
  assert.deepEqual(Prefs.mergePrefs(defaults, { voice: "F2" }), { voice: "F2", speed: 1 });
  assert.deepEqual(defaults, { voice: "M2", speed: 1 });
});

test("normalizePatch keeps valid values and repairs malformed ones", () => {
  assert.deepEqual(Prefs.normalizePatch({ voice: " F2 ", speed: "1.25" }, { voice: "M2", speed: 1 }), { voice: "F2", speed: 1.25 });
  assert.deepEqual(Prefs.normalizePatch({ voice: "  ", speed: -2 }, { voice: "M2", speed: 1 }), { voice: "M2", speed: 1 });
  assert.deepEqual(Prefs.normalizePatch(null, { voice: "M2", speed: 1 }), {});
});
