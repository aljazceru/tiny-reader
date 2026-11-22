/*
 * tiny reader — release smoke check on the real Chrome build.
 *
 * Loads dist/chrome in Chromium (--headless=new; on Chromium 157+ the
 * AudioContext clock and offscreen documents run headless, so no display
 * or xvfb is needed) and drives the extension pages over CDP. Any
 * uncaught exception or console error on a page fails the run — the
 * class of bug that once shipped an undefined NOTICE_MS and broke every
 * file read. The reader's inputs are exercised for real: the speed
 * slider, a paste read, and the PDF/ePub paths through #fileInput; the
 * welcome page's "Hear it" too.
 *
 *   node tools/build-chrome.mjs && node tools/smoke.mjs
 *
 * Environment:
 *   CHROME_BIN    Chromium binary (default /usr/bin/chromium-browser)
 *   CHROME_EXT    the built extension (default dist/chrome)
 *   CHROME_PORT   debugging port (default 9392)
 * Node 22+ (global WebSocket).
 */

import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";

import { launchChromium, connect, waitForTarget } from "./cdp.mjs";

const DIST = process.env.CHROME_EXT || join(import.meta.dirname, "..", "dist", "chrome");
const PORT = Number(process.env.CHROME_PORT || 9392);
const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures");

const errors = [];
const tabs = [];

const assert = (condition, message) => {
  if (!condition) throw new Error("assert failed: " + message);
  console.log("  ok — " + message);
};

/* Uncaught exceptions and console errors, tagged with the page name. */
function watch(tab, page) {
  tab.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails;
    errors.push(`${page}: ${(details.exception && details.exception.description) || details.text}`);
  });
  tab.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") {
      errors.push(`${page}: console.error ${params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    }
  });
  tab.on("Log.entryAdded", (params) => {
    if (params.entry.level === "error") errors.push(`${page}: ${params.entry.text}`);
  });
}

function clean(what) {
  if (!errors.length) return;
  const list = errors.splice(0).map((e) => "  - " + e).join("\n");
  throw new Error(`page errors during ${what}:\n${list}`);
}

const browser = await launchChromium({ ext: DIST, port: PORT, headless: true });

/* The extension id is fixed by the manifest key (tools/build-chrome.mjs)
 * but reading it off the service worker target doubles as the proof the
 * extension registered. */
const sw = await waitForTarget(browser,
  (t) => t.type === "service_worker" && t.url.includes("chrome-sw.js"), 30000);
const EXTENSION_ID = new URL(sw.url).host;

const state = (tab) => tab.evaluate("browser.runtime.sendMessage({ type: 'getState' })").catch(() => null);

async function openPage(name, path, marker) {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const tab = await connect(target.webSocketDebuggerUrl);
  tabs.push(tab);
  await tab.send("Runtime.enable");
  await tab.send("Log.enable");
  await tab.send("Page.enable");
  watch(tab, name);
  const url = `chrome-extension://${EXTENSION_ID}/${path}`;
  await tab.send("Page.navigate", { url });
  for (let i = 0; i < 30; i++) {
    await delay(1000);
    const loaded = await tab.evaluate(`!!document.getElementById(${JSON.stringify(marker)})`).catch(() => false);
    if (loaded) return tab;
    /* The extension registers asynchronously; retry the navigation. */
    if (i % 5 === 4) await tab.send("Page.navigate", { url }).catch(() => {});
  }
  throw new Error(`${name} page did not load ${path}`);
}

/* A read counts as started once getState leaves idle; an error status is
 * a failure, not a pass. */
async function waitRead(tab, what) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const s = await state(tab);
    if (s && s.status === "error") throw new Error(`${what}: background reported "${s.error}"`);
    if (s && s.status !== "idle") {
      assert(true, `${what} started (status ${s.status})`);
      return s;
    }
    if (Date.now() > deadline) throw new Error(`${what} did not start (status ${s && s.status})`);
    await delay(250);
  }
}

/* Stop whatever is playing and wait for the background to go idle, so
 * the next read's idle→busy transition is attributable to it. */
async function settle(tab) {
  await tab.evaluate("browser.runtime.sendMessage({ type: 'stop' }).catch(() => {}); true");
  const deadline = Date.now() + 10000;
  for (;;) {
    const s = await state(tab);
    if (s && s.status === "idle") return;
    if (Date.now() > deadline) throw new Error(`did not return to idle (status ${s && s.status})`);
    await delay(250);
  }
}

async function setFile(tab, path) {
  const { root } = await tab.send("DOM.getDocument");
  const { nodeId } = await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#fileInput" });
  assert(nodeId, "#fileInput present");
  await tab.send("DOM.setFileInputFiles", { nodeId, files: [resolve(path)] });
}

const fill = (tab, id, value) => tab.evaluate(
  `document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; true`);
const click = (tab, id) => tab.evaluate(
  `document.getElementById(${JSON.stringify(id)}).click(); true`);

try {
  const popup = await openPage("popup", "popup/popup.html", "readSelection");
  await delay(600); // let the first refresh() poll run
  clean("popup load");
  assert(true, "popup page loaded clean");

  const reader = await openPage("reader", "reader/reader.html", "readPaste");
  await reader.send("DOM.enable");
  await delay(600);
  clean("reader load");
  assert(true, "reader page loaded clean");

  /* speed slider: set 1.75, dispatch input+change like a user; the 400 ms
   * render loop rewrites the label from prefs, so poll until it settles. */
  await reader.evaluate(`const s = document.getElementById("speed");
    s.value = "1.75";
    s.dispatchEvent(new Event("input"));
    s.dispatchEvent(new Event("change")); true`);
  let label = "";
  for (let i = 0; i < 20 && label !== "1.75×"; i++) {
    await delay(250);
    label = await reader.evaluate('document.getElementById("speedValue").textContent');
  }
  assert(label === "1.75×", `speed label shows 1.75× (got "${label}")`);

  await fill(reader, "pasteText", "The smoke check reads this first sentence. A second sentence follows it.");
  await click(reader, "readPaste");
  await waitRead(reader, "paste read");
  await settle(reader);

  await setFile(reader, join(FIXTURES, "sample.epub"));
  await waitRead(reader, "epub read");
  await settle(reader);

  await setFile(reader, join(FIXTURES, "sample.pdf"));
  await waitRead(reader, "pdf read");
  await settle(reader);
  clean("reader interactions");

  /* The install also auto-opens welcome.html in this fresh profile; that
   * tab is left alone — this one is driven and listened to instead. */
  const welcome = await openPage("welcome", "welcome/welcome.html", "hearIt");
  await delay(600);
  await click(welcome, "hearIt");
  await waitRead(welcome, "welcome 'Hear it' read");
  await settle(welcome);
  clean("welcome load and 'Hear it'");
  assert(true, "welcome page loaded clean and read the sample");

  console.log("\nSMOKE PASS");
} catch (error) {
  console.error("\nSMOKE FAIL: " + (error && error.message ? error.message : error));
  process.exitCode = 1;
} finally {
  for (const tab of tabs) tab.close();
  browser.close();
  if (errors.length) console.log("page errors:\n" + errors.map((e) => "  - " + e).join("\n"));
}
