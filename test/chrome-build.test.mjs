/* The Chrome build rasterizes icons/icon.svg to PNG; every size must show
 * the whole icon, not a scaled-up corner of it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const root = new URL("..", import.meta.url);
const build = new URL("tools/build-chrome.mjs", root).pathname;

/* node --test runs files in parallel; each build gets its own output dir
 * so concurrent tests can not observe each other's half-written tree. */
function buildChrome(...args) {
  const out = mkdtempSync(join(tmpdir(), "tiny-reader-chrome-"));
  execFileSync(process.execPath, [build, "--out", out, ...args]);
  return out;
}

/* Minimal decoder for the build's own PNGs: RGBA, 8-bit, filter 0 rows. */
function decode(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, at: (x, y) => [...raw.subarray(y * (1 + width * 4) + 1 + x * 4, y * (1 + width * 4) + 5 + x * 4)] };
}

test("chrome build renders the full speaker icon at every size", () => {
  const out = buildChrome();
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  for (const [size, file] of Object.entries(manifest.action.default_icon)) {
    const image = decode(readFileSync(join(out, file)));
    assert.equal(image.width, Number(size), `${file} width`);
    // Speaker body centre (viewBox 35,48) is blue #7aabff.
    const [r, g, b] = image.at(Math.floor((35 / 96) * image.width), Math.floor((48 / 96) * image.height));
    assert.ok(b > 200 && r < 160, `${file}: speaker missing at its centre (got ${r},${g},${b})`);
  }
  assert.ok("16" in manifest.action.default_icon && "32" in manifest.action.default_icon, "toolbar sizes 16/32 missing");
  assert.ok(manifest.permissions.includes("offscreen"), "offscreen permission missing");
  assert.ok(!manifest.permissions.includes("tabs"), "tabs permission still present");
});

test("chrome manifest takes author, version and the shortcut from the Firefox manifest", () => {
  const out = buildChrome();
  const firefox = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  const chrome = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(chrome.author, "Aljaz Ceru");
  assert.equal(chrome.version, firefox.version);
  assert.equal(chrome.commands["toggle-read"].suggested_key.default, "Alt+Shift+S");
  /* chrome.runtime.getContexts needs 116; older versions must not install. */
  assert.equal(chrome.minimum_chrome_version, "116");
});

test("the store build drops the key, ships a 128 px icon and no Firefox manifest", () => {
  const out = buildChrome("--store");
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.key, undefined, "key leaked into the store manifest");
  assert.equal(manifest.icons["128"], "icons/icon128.png");
  assert.ok(existsSync(join(out, "icons", "icon128.png")), "icon128.png missing");
  assert.ok(!existsSync(join(out, "manifest.firefox.json")), "manifest.firefox.json leaked into the store build");
});

test("the chrome build cleans its output directory", () => {
  const out = buildChrome();
  writeFileSync(join(out, "stale.txt"), "stale");
  execFileSync(process.execPath, [build, "--out", out]);
  assert.ok(!existsSync(join(out, "stale.txt")), "stale file survived the build");
});
