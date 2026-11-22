/*
 * The popup toggles #idle and #transport with the `hidden` attribute, but
 * both sections set `display: grid`, which beats the user-agent
 * `[hidden] { display: none }`. Regression: an error left the idle buttons,
 * the transport row and "Preparing…" all showing at once.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

test("popup CSS keeps hidden sections hidden", () => {
  const css = readFileSync(join(__dirname, "..", "popup", "popup.css"), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});
