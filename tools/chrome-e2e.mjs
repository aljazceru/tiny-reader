/*
 * tiny reader — Chrome/Chromium end-to-end test (raw CDP, no test hooks).
 *
 * Verifies the dist/chrome build against a real Chromium:
 *   1. bundled-model read of pasted text through the reader UI — sentence
 *      advancement proves the offscreen AudioContext actually runs (onended
 *      drives it) and that the offscreen document is alive
 *   2. the speed slider applies (prefs.speed) and playback continues
 *   3. pause and resume via the transport button
 *   4. a remote OpenAI-compatible TTS endpoint (built-in mock) — model
 *      switch through the models form, sentences synthesized by the
 *      endpoint with well-formed requests and voice/speed pass-through
 *
 * Environment:
 *   CHROME_BIN    Chromium binary (default /usr/bin/chromium-browser)
 *   CHROME_EXT    the built extension (default dist/chrome; build with
 *                 `node tools/build-chrome.mjs` first)
 *   CHROME_PORT   debugging port (default 9333)
 * Node 22+ (global WebSocket).
 */

import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { wav } from "../vendor/text.js";
import { launchChromium, connect } from "./cdp.mjs";

const DIST = process.env.CHROME_EXT || join(import.meta.dirname, "..", "dist", "chrome");
const PORT = Number(process.env.CHROME_PORT || 9391);
const PROFILE = join(homedir(), "tiny-reader-chrome-e2e");

/* ---- built-in OpenAI-compatible /audio/speech mock ---- */

const RATE = 24000;
const TONE = new Float32Array(Math.round(RATE * 0.6));
for (let i = 0; i < TONE.length; i++) TONE[i] = 0.4 * Math.sin((2 * Math.PI * 330 * i) / RATE);
const WAV = new Uint8Array(wav(Array.from(TONE), RATE));

const requests = [];
const speechRequests = [];
function startMock(port = 8130) {
  // One server per run; every reply is the same short sine WAV.
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
        requests.push({ method: req.method, body });
        speechRequests.push(body);
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        };
        if (req.method === "OPTIONS") {
          res.writeHead(204, cors);
          res.end();
          return;
        }
        res.writeHead(200, { ...cors, "content-type": "audio/wav", "content-length": WAV.length });
        res.end(WAV);
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

/* Headed is the default for realism; --headless=new also advances the
 * AudioContext clock on Chromium 157+ (verified by the offscreen spike). */
const HEADLESS = process.env.CHROME_HEADLESS === "1";
const { list, close: cleanup } = await launchChromium({
  ext: DIST, port: PORT, headless: HEADLESS, profile: PROFILE,
});

const assert = (condition, message) => {
  if (!condition) throw new Error("assert failed: " + message);
  console.log("  ok — " + message);
};

const mock = await startMock();

let tab = null;
let swTab = null;
try {
  /* Stable id from the fixed manifest key (see tools/build-chrome.mjs);
   * loading the reader page is itself the proof the extension came up. */
  const extensionId = "ilgglpinoppolnkbccdeimaoppphpgfj";

  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
  await delay(1500);
  const page0 = (await list()).find((t) => t.type === "page" && t.url === "about:blank");
  const oldTargetId = page0.id;
  tab = await connect(page0.webSocketDebuggerUrl);
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  await tab.send("Page.navigate", { url: `chrome-extension://${extensionId}/reader/reader.html` });

  /* The extension registers asynchronously after startup; retry the page. */
  let loaded = false;
  for (let i = 0; i < 10 && !loaded; i++) {
    await delay(2000);
    loaded = await tab.evaluate("!!document.getElementById('readPaste')").catch(() => false);
    if (!loaded) await tab.send("Page.navigate", { url: `chrome-extension://${extensionId}/reader/reader.html` }).catch(() => {});
  }
  assert(loaded, "reader workspace loaded (extension is up)");
  let sw = null;
  for (let i = 0; i < 15 && !sw; i++) {
    const targets = await list();
    sw = targets.find((t) => t.type === "service_worker" && t.url.includes("chrome-sw.js"));
    if (!sw) {
      if (i % 5 === 4) {
        console.log("   targets:", targets.map((t) => t.type + ":" + t.url.slice(0, 70)).join(" | "));
        console.log("   page status:", await tab.evaluate("document.getElementById('status').textContent"));
      }
      await delay(2000);
    }
  }
  assert(sw, "extension service worker target present (woken by the reader page)");

  const state = () => tab.evaluate("browser.runtime.sendMessage({ type: 'getState' })").catch(() => null);
  const fill = (id, value) => tab.evaluate(
    `document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`);
  const click = (id) => tab.evaluate(
    `document.getElementById(${JSON.stringify(id)}).click(); true`);


  /* 1. bundled model read */
  await fill("pasteText", "The first sentence plays now. The second sentence follows it. A third sentence closes the test.");
  await click("readPaste");
  let playing = null;
  for (let i = 0; i < 30 && !playing; i++) {
    await delay(2000);
    const s = await state();
    if (s && s.status === "playing") playing = s;
  }
  assert(playing, `bundled model playing (total ${playing && playing.total})`);
  let advanced = -1;
  for (let i = 0; i < 30 && advanced < 1; i++) {
    await delay(2000);
    const s = await state();
    if (s && typeof s.index === "number") advanced = Math.max(advanced, s.index);
  }
  assert(advanced >= 1, `sentence index advanced to ${advanced + 1} (offscreen audio clock runs)`);

  swTab = await connect(sw.webSocketDebuggerUrl);
  const hostContexts = await swTab.evaluate(
    "chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c) => c.length)");
  assert(hostContexts >= 1, `offscreen audio-host document alive (${hostContexts})`);
  swTab.close(); /* a held-open SW debugger session wedges later steps */
  swTab = null;
  const hostPages = (await list()).filter((t) => t.type === "page" && t.url.includes("chrome/audio-host.html"));
  assert(hostPages.length === 0, "no pinned audio-host tab");
  /* 2. speed */
  await tab.evaluate(
    "const s = document.getElementById('speed'); s.value = '1.5'; s.dispatchEvent(new Event('change')); true");
  let speedSeen = null;
  for (let i = 0; i < 10 && !speedSeen; i++) {
    await delay(1000);
    const s = await state();
    if (s && s.prefs && s.prefs.speed === 1.5) speedSeen = s;
  }
  assert(speedSeen, "speed slider applied (prefs.speed = 1.5)");

  /* 3. pause + resume */
  await click("playPause");
  let paused = null;
  for (let i = 0; i < 10 && !paused; i++) {
    await delay(1000);
    const s = await state();
    if (s && s.status === "paused") paused = s;
  }
  assert(paused, "pause reached");
  await tab.evaluate("browser.runtime.sendMessage({ type: 'resume' }); true");
  let resumed = null;
  for (let i = 0; i < 15 && !resumed; i++) {
    await delay(1000);
    const s = await state();
    if (i % 4 === 3) console.log("   resume wait:", s && s.status, "index", s && s.index);
    if (s && s.status === "playing") resumed = s;
  }
  assert(resumed, "resume reached");

  /* 3b. resume after Chrome reaped the offscreen document: pause, close
   * the document from the service worker (simulating the ~30 s idle
   * reaper), resume, and expect playback to continue past the paused
   * sentence — the job is restarted in a fresh document. */
  await click("playPause");
  let pausedAgain = null;
  for (let i = 0; i < 10 && !pausedAgain; i++) {
    await delay(1000);
    const s = await state();
    if (s && s.status === "paused") pausedAgain = s;
  }
  assert(pausedAgain, "second pause reached");
  const pausedIndex = pausedAgain.index;
  const swAgain = (await list()).find((t) => t.type === "service_worker" && t.url.includes("chrome-sw.js"));
  assert(swAgain, "service worker present for closeDocument");
  swTab = await connect(swAgain.webSocketDebuggerUrl);
  await swTab.evaluate("chrome.offscreen.closeDocument()");
  swTab.close(); /* a held-open SW debugger session wedges later steps */
  swTab = null;
  await delay(1000);
  await tab.evaluate("browser.runtime.sendMessage({ type: 'resume' }); true");
  let continued = null;
  for (let i = 0; i < 20 && !continued; i++) {
    await delay(1000);
    const s = await state();
    if (s && ((s.status === "playing" && s.index > pausedIndex) || s.status === "done")) continued = s;
    if (i % 4 === 3) console.log("   resume-after-reap wait:", s && s.status, "index", s && s.index);
  }
  assert(continued, `resume after the offscreen document was closed continues (${continued && continued.status}, index ${continued && continued.index} from ${pausedIndex})`);

  /* 4. remote endpoint through the models form — in a fresh reader tab:
   * the long-lived CDP session wedges around the model swap while the
   * page itself keeps working, so re-open it. */
  tab.close();
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
  await delay(1500);
  const fresh = (await list()).find((t) => t.type === "page" && t.url === "about:blank");
  tab = await connect(fresh.webSocketDebuggerUrl);
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  await tab.send("Page.navigate", { url: `chrome-extension://${extensionId}/reader/reader.html` });
  await delay(2500);
  await click("stop");
  await fill("remoteName", "mock-tts");
  await fill("remoteUrl", "http://127.0.0.1:8130/v1/audio/speech");
  await fill("remoteVoices", "mo, ck");
  await click("applyRemote");
  let remoteModel = null;
  for (let i = 0; i < 20 && !remoteModel; i++) {
    await delay(1500);
    const s = await state();
    if (s && s.model && s.model.name === "mock-tts") remoteModel = s;
    if (i === 19) console.log("   model status:", await tab.evaluate("document.getElementById('modelStatus').textContent"));
  }
  assert(remoteModel, `remote endpoint active (voices: ${remoteModel && remoteModel.model.voices.join(",")})`);
  const before = requests.length;
  await fill("pasteText", "Remote voices read this first sentence. Then the endpoint reads a second sentence aloud. A third sentence finishes the remote test.");
  /* Same runtime message the reader's button sends; avoids a flaky click
   * dispatch in the re-opened tab. */
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await tab.evaluate(
      "browser.runtime.sendMessage({ type: 'readBlocks', blocks: ['Remote voices read this first sentence.', 'Then the endpoint reads a second sentence aloud.', 'A third sentence finishes the remote test.'], source: 'paste', title: 'Chrome e2e remote' }).then((r) => JSON.stringify(r)).catch((e) => 'ERR ' + e.message)");
    console.log("   readBlocks reply:", reply, "| status now:", JSON.stringify(await state()));
    if (!String(reply).startsWith("ERR")) break;
    console.log("   readBlocks retry", attempt + 1, reply);
    await delay(2000);
  }

  /* The 3-sentence read finishes in ~2 s and an idle service worker then
   * restarts with fresh state, so poll fast and judge the playing state
   * plus what the mock server saw. */
  let sawPlaying = null;
  for (let i = 0; i < 40 && !sawPlaying; i++) {
    const s = await state();
    if (s && s.status === "playing") sawPlaying = s;
    else await delay(250);
  }
  assert(sawPlaying, `remote endpoint reading (total ${sawPlaying && sawPlaying.total})`);
  assert(sawPlaying.model && sawPlaying.model.name === "mock-tts", "reading with the remote model");
  for (let i = 0; i < 20 && !(sawPlaying.lastRms && sawPlaying.lastRms.rms > 0.05); i++) {
    await delay(250);
    sawPlaying = (await state()) || sawPlaying;
  }
  assert(sawPlaying.lastRms && sawPlaying.lastRms.rms > 0.05,
    `endpoint audio enqueued (rms ${sawPlaying.lastRms && sawPlaying.lastRms.rms.toFixed(3)})`);
  assert(requests.length - before >= 2, `endpoint served ${requests.length - before} speech requests`);
  assert(speechRequests.slice(1).every((b) => b && b.voice === "mo" && b.response_format === "wav"),
    "endpoint requests well-formed");

  await click("stop");
  console.log("\nCHROME E2E PASS");
} finally {
  if (tab) tab.close();
  if (swTab) swTab.close();
  mock.close();
  cleanup();
}
