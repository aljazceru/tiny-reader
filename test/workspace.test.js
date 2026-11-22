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
    "pasteText", "readPaste", "urlInput", "readUrl", "fileInput",
    "playPause", "stop", "prev", "next", "voice", "speed", "status", "progress", "preview",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `reader.html missing #${id}`);
  }
  assert.ok(html.includes('id="models"'), "reader.html missing #models mount");
});

test("reader page wires the real module contracts", () => {
  assert.match(html, /type="module"\s+src="reader\.js"/);
  for (const module of ["./pdf.js", "./epub.js", "./models.js"]) {
    assert.ok(reader.includes(module), `reader.js does not import ${module}`);
  }
  for (const file of ["reader/pdf.js", "reader/epub.js", "reader/models.js", "reader/extract.js", "reader/reader.css"]) {
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

test("reader page defines the speed label helper it calls", () => {
  /* reader.js once called speedLabel() without defining it (it only lived in
   * popup.js): the slider label froze and every state render threw. */
  assert.ok(reader.includes("speedLabel("), "reader.js no longer renders the speed label");
  assert.match(reader, /(const|function)\s+speedLabel\b/, "reader.js calls speedLabel() but never defines it");
});

test("no saved-article library: nothing read is kept in storage", () => {
  const background = readFileSync(join(root, "background/background.js"), "utf8");
  for (const file of ["reader/library.js", "logic/library.js"]) {
    assert.ok(!existsSync(join(root, file)), `${file} should be gone`);
  }
  assert.ok(!html.includes('id="library"') && !html.includes('id="saveCurrent"'), "reader.html still has library UI");
  assert.doesNotMatch(background, /librarySave|libraryItems: \[\]|queueIds: \[\]/, "background still persists a library or queue");
  assert.doesNotMatch(content, /data-role="queue"/, "mini-player still shows a queue chip");
});

test("reader, popup and welcome scripts declare every constant they use", () => {
  /* 68e793e dropped `const NOTICE_MS` but kept its use: every status notice
   * threw, so opening a file (ePub, PDF, …) never started reading. */
  for (const file of ["reader/reader.js", "popup/popup.js", "welcome/welcome.js"]) {
    const source = readFileSync(join(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "") // comments
      .replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""'); // strings
    const used = new Set(source.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[A-Z]{3,}\b/g) || []);
    for (const name of used) {
      assert.match(source, new RegExp(`(?:const|let|var|function|import\\s*\\{[^}]*)\\s*\\b${name}\\b`), `${file} uses ${name} but never declares it`);
    }
  }
});
