/*
 * tiny reader — store listing screenshots + promo tile.
 *
 * Drives the dist/chrome build in Chromium over CDP and writes:
 *   docs/store/screenshots/1-page-reading.png  article mid-read: mini-player,
 *                                              highlighted paragraph (1280×800)
 *   docs/store/screenshots/2-popup.png         popup floating on a neutral
 *                                              background (1280×800)
 *   docs/store/screenshots/3-workspace.png     reader workspace reading pasted
 *                                              text (1280×800)
 *   docs/store/screenshots/4-welcome.png       first-run welcome page (1280×800)
 *   docs/store/screenshots/promo-440x280.png   promo tile (440×280)
 *
 * The page-reading shot needs script injection on the fixture article; like
 * tools/chrome-e2e.mjs it loads a patched copy of the build that already
 * holds the fixture origin (the shipped build asks per-site at click time,
 * which a scripted run cannot click). The read itself is the real one:
 * read(tab, "page") in the service worker, the same call the context menu
 * and toolbar use.
 *
 *   xvfb-run -a node tools/screenshots.mjs     (headed)
 *   node tools/screenshots.mjs                 (headless=new; audio runs)
 *
 * Environment:
 *   CHROME_BIN        Chromium binary (default /usr/bin/chromium-browser)
 *   CHROME_EXT        the built extension (default dist/chrome)
 *   CHROME_PORT       debugging port (default 9393)
 *   CHROME_HEADLESS   "0" forces a headed run
 * Node 22+ (global WebSocket).
 */

import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { launchChromium, connect, waitForTarget } from "./cdp.mjs";

const ROOT = join(import.meta.dirname, "..");
const DIST = process.env.CHROME_EXT || join(ROOT, "dist", "chrome");
const PORT = Number(process.env.CHROME_PORT || 9393);
const HTTP_PORT = 8140;
const OUT = join(ROOT, "docs", "store", "screenshots");
const VIEW = { width: 1280, height: 800 };

const WORKSPACE_TEXT =
  "Reading aloud is the oldest way to share a text. Long before screens, a voice carried " +
  "the story from one person to the next, and the listener followed along. tiny reader " +
  "brings that habit back to the modern web: pick any page, press a key, and the words " +
  "begin to speak in a calm local voice.";

/* Like tools/chrome-e2e.mjs: a copy of the build that already holds the
 * fixture origin, so content-script injection needs no click. */
const TEST_DIST = mkdtempSync(join(tmpdir(), "tiny-reader-shots-"));
cpSync(DIST, TEST_DIST, { recursive: true });
const testManifest = JSON.parse(readFileSync(join(TEST_DIST, "manifest.json"), "utf8"));
testManifest.host_permissions = ["http://127.0.0.1/*"];
writeFileSync(join(TEST_DIST, "manifest.json"), JSON.stringify(testManifest, null, 2) + "\n");

/* The fixture article over plain HTTP (extension pages can't be read). */
const article = readFileSync(join(ROOT, "test", "fixtures", "article.html"));
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(article);
});
await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));

const browser = await launchChromium({
  ext: TEST_DIST, port: PORT, headless: process.env.CHROME_HEADLESS !== "0",
});
const tabs = [];

/* A new tab pinned to the shot size and the store's light color scheme. */
async function newTab({ width, height } = VIEW) {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const tab = await connect(target.webSocketDebuggerUrl);
  tabs.push(tab);
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await tab.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  return tab;
}

async function navigate(tab, url, marker, what) {
  await tab.send("Page.navigate", { url });
  for (let i = 0; i < 30; i++) {
    await delay(1000);
    const loaded = await tab.evaluate(`!!document.querySelector(${JSON.stringify(marker)})`).catch(() => false);
    if (loaded) return;
    if (i % 5 === 4) await tab.send("Page.navigate", { url }).catch(() => {});
  }
  throw new Error(`${what} did not load (${marker} at ${url})`);
}

async function waitFor(fn, what, timeoutMs = 60000, interval = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await delay(interval);
  }
}

async function shot(tab, name) {
  const { data } = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const png = Buffer.from(data, "base64");
  writeFileSync(join(OUT, name), png);
  console.log(`  wrote ${name} (${png.readUInt32BE(16)}×${png.readUInt32BE(20)})`);
}

const ext = (path) => `chrome-extension://${EXTENSION_ID}/${path}`;

try {
  mkdirSync(OUT, { recursive: true });

  const sw = await waitForTarget(browser,
    (t) => t.type === "service_worker" && t.url.includes("chrome-sw.js"), 30000);
  var EXTENSION_ID = new URL(sw.url).host;

  /* The install auto-opens welcome.html; reuse that tab for shot 4. */

  /* --------------------------------------------------- 1. page reading */
  const article_ = await newTab();
  await navigate(article_, `http://127.0.0.1:${HTTP_PORT}/article.html`, "article p", "article page");

  /* Trigger exactly what the context menu calls: read(tab, "page"). */
  let swTab = await connect(sw.webSocketDebuggerUrl);
  await swTab.evaluate(`(async () => {
    const [tab] = await browser.tabs.query({ url: "http://127.0.0.1:${HTTP_PORT}/*" });
    await browser.tabs.update(tab.id, { active: true });
    await read(tab, "page");
    return tab.id;
  })()`);

  const state = () => swTab.evaluate("JSON.stringify(snapshot())").then((s) => JSON.parse(s)).catch(() => null);
  let playing = await waitFor(async () => {
    const s = await state();
    if (s && s.status === "error") throw new Error(`page read failed: ${s.error}`);
    return s && s.status === "playing" ? s : null;
  }, "page read to reach playing", 90000);
  /* Let a few sentences pass so the highlight sits on a body paragraph. */
  for (let i = 0; i < 60 && playing.index < 2; i++) {
    await delay(1000);
    playing = (await state()) || playing;
  }
  swTab.close();
  swTab = null;
  await waitFor(() => article_.evaluate(
    "!!(document.getElementById('tiny-reader-miniplayer') && document.querySelector('.tiny-reader-reading'))"),
    "mini-player and highlighted paragraph", 15000);
  await delay(1600); // smooth scroll settle + a couple of mini-player polls
  await shot(article_, "1-page-reading.png");

  /* ----------------------------------------------------------- 2. popup */
  /* Still mid-read, so the popup shows its transport with a live preview —
   * rendered as the floating card it is, centered on a neutral backdrop. */
  const popup = await newTab();
  await navigate(popup, ext("popup/popup.html"), "#readSelection", "popup");
  await waitFor(() => popup.evaluate("!document.getElementById('transport').hidden"),
    "popup transport while reading", 15000);
  await popup.evaluate(`(() => {
    document.documentElement.style.background = "#e7ebf0";
    document.documentElement.style.overflow = "hidden";
    const body = document.body;
    body.style.margin = "64px auto 0";
    body.style.border = "1px solid #d3d7dd";
    body.style.borderRadius = "10px";
    body.style.overflow = "hidden";
    body.style.boxShadow = "0 16px 48px rgba(16,24,40,.2)";
    return true;
  })()`);
  await delay(600);
  await shot(popup, "2-popup.png");

  /* ------------------------------------------------------- 3. workspace */
  const reader = await newTab();
  await navigate(reader, ext("reader/reader.html"), "#readPaste", "reader workspace");
  await delay(600);
  await reader.evaluate(
    `document.getElementById("pasteText").value = ${JSON.stringify(WORKSPACE_TEXT)}; true`);
  await reader.evaluate('document.getElementById("readPaste").click(); true');
  /* getState still shows the page read until readBlocks lands; require the
   * paste job itself to be playing and past its first sentence. */
  await waitFor(() => reader.evaluate(
    `browser.runtime.sendMessage({ type: "getState" })
      .then((s) => s && s.source === "paste" && s.status === "playing" && s.index >= 1)`),
    "workspace read to reach playing", 90000);
  await delay(900); // preview line + model name settle
  await shot(reader, "3-workspace.png");
  await reader.evaluate("browser.runtime.sendMessage({ type: 'stop' }).catch(() => {}); true");

  /* -------------------------------------------------------- 4. welcome */
  let welcomeTarget = null;
  try {
    welcomeTarget = await waitForTarget(browser,
      (t) => t.type === "page" && t.url.includes("welcome/welcome.html"), 5000);
  } catch (error) { /* opened below instead */ }
  const welcome = welcomeTarget ? await connect(welcomeTarget.webSocketDebuggerUrl) : await newTab();
  tabs.push(welcome);
  await welcome.send("Page.enable");
  await welcome.send("Runtime.enable");
  await welcome.send("Emulation.setDeviceMetricsOverride", {
    ...VIEW, deviceScaleFactor: 1, mobile: false,
  });
  await welcome.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  if (!welcomeTarget) await navigate(welcome, ext("welcome/welcome.html"), "#hearIt", "welcome page");
  await waitFor(() => welcome.evaluate(
    'document.getElementById("shortcut").textContent.trim() !== "…"'),
    "welcome shortcut binding", 15000);
  await delay(500);
  await shot(welcome, "4-welcome.png");

  /* -------------------------------------------------------- promo tile */
  const promo = await newTab({ width: 440, height: 280 });
  const icon = readFileSync(join(ROOT, "icons", "icon.svg"), "utf8");
  const tile = `<!DOCTYPE html><meta charset="utf-8"><style>
    body { margin: 0; width: 440px; height: 280px; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: #f7f9fc radial-gradient(360px 220px at 50% 34%, rgba(26,104,209,.10), rgba(26,104,209,0));
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .icon { width: 84px; height: 84px; filter: drop-shadow(0 8px 18px rgba(26,104,209,.28)); }
    .icon svg { width: 100%; height: 100%; display: block; }
    h1 { margin: 20px 0 0; font-size: 31px; font-weight: 650; color: #1c1e21; letter-spacing: -.02em; }
    p { margin: 8px 0 0; font-size: 15.5px; color: #4a5058; }
  </style><div class="icon">${icon}</div><h1>tiny reader</h1><p>Read the web aloud, locally.</p>`;
  await promo.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(tile)}` });
  await delay(800);
  await shot(promo, "promo-440x280.png");

  console.log("\nSCREENSHOTS DONE");
} finally {
  for (const tab of tabs) tab.close();
  browser.close();
  server.close();
}
