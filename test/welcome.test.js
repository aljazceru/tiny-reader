/* Static checks for the first-run welcome page. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const html = readFileSync(join(root, "welcome/welcome.html"), "utf8");
const script = readFileSync(join(root, "welcome/welcome.js"), "utf8");

test("welcome page exposes its controls", () => {
  for (const id of ["hearIt", "shortcut", "openWorkspace", "changeShortcut"]) {
    assert.ok(html.includes(`id="${id}"`), `welcome.html missing #${id}`);
  }
});

test("welcome page wires the background contracts", () => {
  assert.match(script, /tv-keepalive/, "welcome.js must hold the keepalive port");
  assert.match(script, /commands\.getAll/, "welcome.js must read the shortcut from commands.getAll");
  assert.match(script, /readBlocks/, "welcome.js must send readBlocks");
  assert.match(script, /source:\s*"paste"/, "welcome.js must read the sample as a paste input");
});
