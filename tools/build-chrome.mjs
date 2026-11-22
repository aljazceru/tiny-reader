/*
 * tiny reader — Chrome build.
 *
 * Produces dist/chrome: the shared tree plus a Chrome MV3 manifest
 * (service worker instead of event page) and PNG icons rendered from
 * icons/icon.svg (Chrome does not accept SVG for action icons).
 *
 *   node tools/build-chrome.mjs
 *   chromium --load-extension=dist/chrome …
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "chrome");

/* ---- PNG encoding (RGBA raster → PNG, no dependencies) ---- */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    pixels.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---- icon.svg rendered as raster (subset: rects, paths, arcs) ---- */

const VIEW = 96;

function inside(path, x, y) {
  // Even-odd ray casting over the flattened polygon approximation.
  let insideOdd = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const [xi, yi] = path[i];
    const [xj, yj] = path[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) insideOdd = !insideOdd;
  }
  return insideOdd;
}

function sampleArc(cx, cy, r, from, to, steps) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const angle = from + ((to - from) * i) / steps;
    points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return points;
}

/* The speaker: rect body + triangle cone, as one polygon (matching icon.svg). */
const SPEAKER = [
  [40, 35], [28, 35], [23, 40], [23, 56], [28, 61], [40, 61],
  [53, 72], [58.7, 69.3], [58.7, 26.7], [53, 24],
];

function renderIcon(size) {
  const scale = size / VIEW;
  const pixels = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const at = (y * size + x) * 4;
    const alpha = a / 255;
    const before = pixels.slice(at, at + 4);
    pixels[at] = Math.round(before[0] * (1 - alpha) + r * alpha);
    pixels[at + 1] = Math.round(before[1] * (1 - alpha) + g * alpha);
    pixels[at + 2] = Math.round(before[2] * (1 - alpha) + b * alpha);
    pixels[at + 3] = Math.max(before[3], a);
  };
  // 2x2 supersampling, mapping each pixel back into the 96-unit viewBox.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const px = (x + dx) / scale;
        const py = (y + dy) / scale;
        // Rounded-square backdrop.
        const radius = 20;
        const corner = Math.min(px, py, VIEW - px, VIEW - py);
        const inCorner = Math.hypot(
          Math.max(0, radius - Math.min(px, VIEW - px)),
          Math.max(0, radius - Math.min(py, VIEW - py)),
        );
        if (corner >= radius || inCorner <= radius) put(x, y, [0x1e, 0x20, 0x23, 255]);
      }
    }
  }
  const BLUE = [0x7a, 0xab, 0xff, 255];
  const WHITE = [0xe8, 0xea, 0xed, 255];
  const strokes = [
    { cx: 64, cy: 48, r: 10, from: -Math.PI / 2, to: Math.PI / 2, width: 5, color: WHITE, alpha: 1 },
    { cx: 72, cy: 48, r: 20, from: -Math.PI / 2.35, to: Math.PI / 2.35, width: 5, color: WHITE, alpha: 0.65 },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const px = (x + dx) / scale;
        const py = (y + dy) / scale;
        if (inside(SPEAKER, px, py)) put(x, y, BLUE);
        for (const arc of strokes) {
          const distance = Math.hypot(px - arc.cx, py - arc.cy);
          const angle = Math.atan2(py - arc.cy, px - arc.cx);
          const half = arc.width / 2;
          if (Math.abs(distance - arc.r) <= half && angle >= arc.from && angle <= arc.to) {
            put(x, y, [...arc.color.slice(0, 3), Math.round(255 * arc.alpha)]);
          }
        }
      }
    }
  }
  return encodePng(pixels, size, size);
}

/* ---- tree copy ---- */

const SHARED = [
  "background", "chrome", "compat", "content", "engine", "icons", "logic",
  "popup", "reader", "vendor", "assets", "LICENSE", "NOTICE",
];

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (statSync(source).isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

const MANIFEST = {
  /* Fixed public key → stable extension id for automation and the e2e. */
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr6kyJQD6hQ3Ft9jkbCFbAFytxaBw07OVE3BtK8EnV/APs0QeUXwZcvuCgMHIZovbXhxMvQZHyDnR6x3vVT0cTCYjrBqfy0moO6KE+6vpCBjzMPhdlLUXQ/tXFBdCEEPmC8OoqG3IJXndTFjBFft5pPZuO4dcrFooYNVq4Qd+VqWX7C0yuK4R2UGIi/Ri/gZwe+7keliZwHh09P3+SrE/X3q0i/wKL1zFFIH7CC/qxRA9jR3COke7UORIJnb+veaLCzqMQ5V8Sd3TPo5tIwUGODKwb/fk/XiXSpWNsxd/+LjBmPpTuLw0YWCWCmm0D7MDy2WAUaxIQBW0MYpe3T6nDQIDAQAB",
  manifest_version: 3,
  name: "tiny reader",
  version: "1.0.0",
  description:
    "tiny reader reads selected text, pages, pasted text, URLs, PDFs and ePubs aloud with a local voice model or your own TTS endpoint. No account.",
  author: "tiny reader contributors",
  icons: { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "96": "icons/icon96.png" },
  permissions: ["storage", "contextMenus", "scripting", "activeTab", "offscreen"],
  optional_host_permissions: ["<all_urls>"],
  background: { service_worker: "background/chrome-sw.js" },
  action: {
    default_title: "tiny reader",
    default_popup: "popup/popup.html",
    default_icon: { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "96": "icons/icon96.png" },
  },
  commands: {
    "toggle-read": {
      suggested_key: { default: "Alt+Shift+R" }, // Chrome rejects Ctrl+Alt+<letter>
      description: "Read the selection (or the page) aloud / pause",
    },
  },
  homepage_url: "https://github.com/aljazceru/tiny-reader",
};

for (const entry of SHARED) {
  const source = join(root, entry);
  if (statSync(source).isDirectory()) copyTree(source, join(out, entry));
  else copyFileSync(source, join(out, entry));
}

// Chrome-only bootstrap; Firefox files that reference it stay unused.
copyFileSync(join(root, "manifest.json"), join(out, "manifest.firefox.json"));
writeFileSync(join(out, "manifest.json"), JSON.stringify(MANIFEST, null, 2) + "\n");
for (const size of [16, 32, 48, 96]) writeFileSync(join(out, "icons", `icon${size}.png`), renderIcon(size));

// The popup and reader pages need the shim before their own scripts.
for (const page of ["popup/popup.html", "reader/reader.html"]) {
  const path = join(out, page);
  let html = readFileSync(path, "utf8");
  html = html.replace(/<script src="\.\.\/vendor\/readability\.js">/,
    '<script src="../compat/compat.js"></script>\n  <script src="../vendor/readability.js">');
  html = html.replace(/<script src="popup\.js">/, '<script src="../compat/compat.js"></script>\n  <script src="popup.js">');
  html = html.replace(/<script src="reader\.css" noop>/, ""); // no-op guard
  html = html.replace(/<script type="module" src="reader\.js">/,
    '<script src="../compat/compat.js"></script>\n  <script type="module" src="reader.js">');
  writeFileSync(path, html);
}

console.log(`chrome build: ${out}`);
