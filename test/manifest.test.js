/*
 * Sanity checks on the shipped manifest and packaging: every referenced
 * file exists, permissions stay minimal, the shortcut is registered.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

test("manifest is Firefox MV3 with reader permissions and a compatible Firefox floor", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.browser_specific_settings.gecko.id, "tiny-reader@myfirefox.local");
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "menus", "scripting", "storage"]);
});

test("every manifest-referenced file exists", () => {
  const files = [
    ...manifest.background.scripts,
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    manifest.action.default_popup,
    manifest.action.default_icon,
  ];
  for (const file of files) assert.ok(existsSync(join(root, file)), `${file} missing`);
});

test("no manifest declares content scripts — the reader injects on demand", () => {
  assert.equal(manifest.content_scripts, undefined);
  execFileSync(process.execPath, [join(root, "tools", "build-chrome.mjs")]);
  const chrome = JSON.parse(readFileSync(join(root, "dist", "chrome", "manifest.json"), "utf8"));
  assert.equal(chrome.content_scripts, undefined);
});

test("the toggle-read shortcut is registered with a default binding", () => {
  const command = manifest.commands["toggle-read"];
  assert.ok(command, "toggle-read command missing");
  assert.match(command.suggested_key.default, /^(Ctrl|Alt|Shift)\+.*(Ctrl|Alt|Shift|R|r|R)$/);
});

test("the model asset and vendored engine are bundled", () => {
  assert.ok(existsSync(join(root, "assets/tiny-voca.gguf")));
  assert.ok(existsSync(join(root, "vendor/tiny-voca.js")));
  assert.ok(existsSync(join(root, "vendor/readability.js")));
  assert.ok(existsSync(join(root, "vendor/dizione/engine.js")));
  const size = readFileSync(join(root, "assets/tiny-voca.gguf")).length;
  assert.ok(size > 7_000_000 && size < 10_000_000, `gguf has unexpected size ${size}`);
});
