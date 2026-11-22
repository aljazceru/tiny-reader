/* The Chrome build rasterizes icons/icon.svg to PNG; every size must show
 * the whole icon, not a scaled-up corner of it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const root = new URL("..", import.meta.url);

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
  execFileSync(process.execPath, [new URL("tools/build-chrome.mjs", root).pathname]);
  const manifest = JSON.parse(readFileSync(new URL("dist/chrome/manifest.json", root), "utf8"));
  for (const [size, file] of Object.entries(manifest.action.default_icon)) {
    const image = decode(readFileSync(new URL(`dist/chrome/${file}`, root)));
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
  execFileSync(process.execPath, [new URL("tools/build-chrome.mjs", root).pathname]);
  const firefox = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  const chrome = JSON.parse(readFileSync(new URL("dist/chrome/manifest.json", root), "utf8"));
  assert.equal(chrome.author, "Aljaz Ceru");
  assert.equal(chrome.version, firefox.version);
  assert.equal(chrome.commands["toggle-read"].suggested_key.default, "Alt+Shift+S");
});
