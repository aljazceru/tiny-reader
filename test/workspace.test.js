/* Static checks for the reader workspace and mini-player surfaces. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const html = readFileSync(join(root, "reader/reader.html"), "utf8");
const reader = readFileSync(join(root, "reader/reader.js"), "utf8");
const content = readFileSync(join(root, "content/content.js"), "utf8");

test("reader workspace exposes every input and transport control", () => {
  for (const id of [
    "pasteText", "readPaste", "urlInput", "readUrl", "fileInput", "saveCurrent",
    "playPause", "stop", "prev", "next", "voice", "speed", "status", "progress", "preview",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `reader.html missing #${id}`);
  }
  for (const section of ["library", "models"]) {
    assert.ok(html.includes(`id="${section}"`), `reader.html missing #${section} mount`);
  }
});

test("reader page wires the real module contracts", () => {
  assert.match(html, /type="module"\s+src="reader\.js"/);
  for (const module of ["./pdf.js", "./epub.js", "./library.js", "./models.js"]) {
    assert.ok(reader.includes(module), `reader.js does not import ${module}`);
  }
  for (const file of ["reader/pdf.js", "reader/epub.js", "reader/library.js", "reader/models.js", "reader/extract.js", "reader/reader.css"]) {
    assert.ok(existsSync(join(root, file)), `${file} missing`);
  }
  assert.match(reader, /readBlocks/, "reader.js must send readBlocks");
  assert.match(reader, /tv-keepalive/, "reader.js must hold the keepalive port");
});

test("mini-player exposes the documented control surface", () => {
  assert.ok(content.includes('host.id = "tiny-reader-miniplayer"'), "mini-player host id missing");
  for (const action of ["prev", "pause", "next", "stop", "close", "collapse"]) {
    assert.ok(content.includes(`data-action="${action}"`) || content.includes(`data-action=\\"${action}\\"`) || content.includes(`data-action=${action}`), `mini-player missing ${action}`);
  }
  assert.match(content, /prefers-reduced-motion/, "mini-player must respect reduced motion");
});
