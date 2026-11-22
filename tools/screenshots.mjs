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
 * The page-reading shot needs script injection on the article page (an
 * inline public-domain text served over node:http); like
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

/* A nicely typeset public-domain article for the page-reading shot (the
 * test fixture's prose talks about timeouts and testing — wrong mood for a
 * store listing). Opening of The Wind in the Willows, Kenneth Grahame. */
const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>The Wind in the Willows — Chapter I</title>
  <style>
    body { margin: 0; background: #fbfbf8; color: #23231f;
      font: 19px/1.68 Georgia, "Times New Roman", serif; }
    article { max-width: 680px; margin: 0 auto; padding: 56px 28px 80px; }
    h1 { font-size: 30px; line-height: 1.25; margin: 0 0 6px; letter-spacing: -.01em; }
    .byline { margin: 0 0 2.1em; font-style: italic; font-size: 15px; color: #6b6b62; }
    p { margin: 0 0 1.25em; }
  </style>
</head>
<body>
  <article>
    <h1>The Wind in the Willows</h1>
    <p class="byline">Kenneth Grahame — Chapter I: The River Bank</p>
    <p>The Mole had been working very hard all the morning, spring-cleaning his little home.
    First with brooms, then with dusters; then on ladders and steps and chairs, with a brush
    and a pail of whitewash; till he had dust in his throat and eyes, and splashes of
    whitewash all over his black fur, and an aching back and weary arms. Spring was moving
    in the air above and in the earth below and around him, penetrating even his dark and
    lowly little house with its spirit of divine discontent and longing.</p>
    <p>It was small wonder, then, that he suddenly flung down his brush on the floor, said
    &#8216;Bother!&#8217; and &#8216;O blow!&#8217; and also &#8216;Hang spring-cleaning!&#8217;
    and bolted out of the house without even waiting to put on his coat. Something up above
    was calling him imperiously, and he made for the steep little tunnel which answered in
    his case to the gravelled carriage-drive owned by animals whose residences are nearer to
    the sun and air. So he scraped and scratched and scrabbled and scrooged, and then he
    scrooged again and scrabbled and scratched and scraped, working busily with his little
    paws and muttering to himself, &#8216;Up we go! Up we go!&#8217; till at last, pop! his
    snout came out into the sunlight, and he found himself rolling in the warm grass of a
    great meadow.</p>
    <p>&#8216;This is fine!&#8217; he said to himself. &#8216;This is better than
    whitewashing!&#8217; The sunshine struck hot on his fur, soft breezes caressed his heated
    brow, and after the seclusion of the cellarage he had lived in so long the carol of happy
    birds fell on his dulled hearing almost like a shout. Jumping off all his four legs at
    once, in the joy of living and the delight of spring without its cleaning, he pursued his
    way across the meadow till he reached the hedge on the further side.</p>
    <p>&#8216;Hold up!&#8217; said an elderly rabbit at the gap. &#8216;Sixpence for the
    privilege of passing by the private road!&#8217; He was bowled over in an instant by the
    impatient and contemptuous Mole, who trotted along the side of the hedge chaffing the
    other rabbits, which peeped from their holes to see what the row was about.
    &#8216;Onion-sauce! Onion-sauce!&#8217; he remarked jeeringly, and was gone before they
    could think of a thoroughly satisfactory reply. Then they all started grumbling at each
    other. &#8216;How stupid you are! Why didn&#8217;t you tell him &#8212;&#8217;
    &#8216;Well, why didn&#8217;t you say &#8212;&#8217; &#8216;You might have reminded him
    &#8212;&#8217; and so on, in the usual way; but, of course, it was much too late, as it
    always is.</p>
    <p>It all seemed too good to be true. Hither and thither through the meadows he rambled
    busily, along the hedgerows, across the copses, finding everywhere birds building,
    flowers budding, leaves thrusting &#8212; everything happy, and progressive, and
    occupied. And instead of having an uneasy conscience pricking him and whispering
    &#8216;whitewash!&#8217; he somehow could only feel how jolly it was to be the only idle
    dog among all these busy citizens. After all, the best part of a holiday is perhaps not
    so much to be resting yourself, as to see all the other fellows busy working.</p>
    <p>He thought his happiness was complete when, as he meandered aimlessly along, suddenly
    he stood by the edge of a full-fed river. Never in his life had he seen a river before
    &#8212; this sleek, sinuous, full-bodied animal, chasing and chuckling, gripping things
    with a gurgle and leaving them with a laugh, to fling itself on fresh playmates that
    shook themselves free, and were caught and held again. All was a-shake and a-shiver
    &#8212; glints and gleams and sparkles, rustle and swirl, chatter and bubble. The Mole
    was bewitched, entranced, fascinated. By the side of the river he trotted as one trots,
    when very small, by the side of a man who holds one spellbound by exciting stories; and
    when tired at last, he sat on the bank, while the river still chattered on to him, a
    babbling procession of the best stories in the world, sent from the heart of the earth
    to be told at last to the insatiable sea.</p>
  </article>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(ARTICLE_HTML);
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
  const articleTab = await newTab();
  await navigate(articleTab, `http://127.0.0.1:${HTTP_PORT}/article.html`, "article p", "article page");

  /* Trigger exactly what the context menu calls: read(tab, "page"). */
  let swTab = await connect(sw.webSocketDebuggerUrl);
  const articleTabId = await swTab.evaluate(`(async () => {
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
  await waitFor(() => articleTab.evaluate(
    "!!(document.getElementById('tiny-reader-miniplayer') && document.querySelector('.tiny-reader-reading'))"),
    "mini-player and highlighted paragraph", 15000);
  await delay(1600); // smooth scroll settle + a couple of mini-player polls
  await shot(articleTab, "1-page-reading.png");

  /* ----------------------------------------------------------- 2. popup */
  /* Shot mid-read so the popup shows its transport — and with "Read
   * selection" enabled, not the disabled "Nothing selected" fallback.
   * hasSelection survives only while the read's own tab is active
   * (probeSelection early-returns on S.tabId === tab.id); a probe against
   * the popup tab itself always fails — extension pages refuse injected
   * scripts — and resets it to false. So: select a paragraph on the
   * article, stop the read so S.tabId clears and a probe can set the flag,
   * restart the page read, and navigate the popup only after the article
   * is re-activated — every popup poll then early-returns with the primed
   * true. */
  await articleTab.evaluate(`(() => {
    const p = document.querySelectorAll("article p")[2];
    window.getSelection().selectAllChildren(p);
    return window.getSelection().toString().length;
  })()`);
  swTab = await connect(sw.webSocketDebuggerUrl);
  const hasSelection = await swTab.evaluate(`(async () => {
    await stopPlayback();
    await probeSelection();
    const primed = S.hasSelection;
    await read({ id: ${articleTabId}, url: "http://127.0.0.1:${HTTP_PORT}/article.html", title: "" }, "page");
    return primed;
  })()`);
  if (!hasSelection) console.log("  warning: selection probe did not stick");
  playing = await waitFor(async () => {
    const s = await state();
    return s && s.status === "playing" ? s : null;
  }, "second page read to reach playing", 90000);
  const popup = await newTab(); // about:blank becomes the active tab — fix that first
  await swTab.evaluate(`browser.tabs.update(${articleTabId}, { active: true }); true`);
  await navigate(popup, ext("popup/popup.html"), "#readSelection", "popup");
  await waitFor(() => popup.evaluate(
    '!document.getElementById("transport").hidden && !document.getElementById("readSelection").disabled'),
    "popup transport + enabled 'Read selection'", 15000);
  swTab.close();
  swTab = null;
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
  /* getState still shows the page read until readBlocks lands; require the
   * paste job itself to be playing and past its first sentence. */
  let lastState = null;
  async function readPasteAndWait(timeoutMs) {
    await reader.evaluate('document.getElementById("readPaste").click(); true');
    return waitFor(async () => {
      const s = await reader.evaluate(
        'browser.runtime.sendMessage({ type: "getState" }).catch(() => null)');
      if (s) lastState = s;
      if (s && s.status === "error") throw new Error(`workspace read failed: ${s.error}`);
      return s && s.source === "paste" && s.status === "playing" && s.index >= 1 ? s : null;
    }, "workspace read to reach playing", timeoutMs).catch((error) => {
      throw new Error(`${error.message}; last state: ${JSON.stringify(lastState)}`);
    });
  }
  try {
    await readPasteAndWait(60000);
  } catch (firstError) {
    /* Back-to-back stop/start reads can leave the job swallowed by a stale
     * offscreen host (the state then pins at "planning" forever); closing
     * the document makes the next ensureWorker respawn it fresh. */
    console.log("  workspace read stalled; resetting the audio host and retrying");
    const swRetry = await connect(sw.webSocketDebuggerUrl);
    await swRetry.evaluate("(async()=>{ await stopPlayback(); await EngineHost.closeDocument(); return true; })()");
    swRetry.close();
    await delay(1000);
    await readPasteAndWait(120000);
  }
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
