/*
 * tiny reader — workspace API + browser parser E2E (real Firefox).
 *
 * Firefox forbids WebDriver script/element access to privileged extension
 * pages, so this harness verifies the two halves separately:
 *   1. the real background runtime APIs (readBlocks, setModel,
 *      getState) driven from the normal article page through a test-only
 *      content-script relay patched into the test xpi;
 *   2. the actual reader/extract.js, reader/pdf.js and reader/epub.js modules
 *      executed in a normal browser page (DOMParser and the real PDF.js
 *      worker), served from the extension directory over localhost.
 *
 * Prerequisites: same as tools/e2e.mjs, the fixture server on :8123, and the
 * extension directory served on :8124 (python3 -m http.server 8124).
 * Usage: node tools/reader-e2e.mjs
 */

import { appendFileSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const FIREFOX = process.env.FIREFOX_BIN || "/tmp/e2e/firefox/firefox";
const XPI = process.env.XPI_PATH || "/tmp/e2e/tiny-reader.xpi";
const GECKO = process.env.GECKODRIVER_BIN || "/tmp/e2e/node_modules/geckodriver/bin/geckodriver.js";
const ARTICLE = process.env.ARTICLE_URL || "http://127.0.0.1:8123/article.html";
const MODULE_ORIGIN = process.env.MODULE_ORIGIN || "http://127.0.0.1:8124";
const PORT = Number(process.env.GECKO_PORT || 5000 + Math.floor(Math.random() * 500));
const DISPLAY = process.env.DISPLAY_TEST || ":0";
const XAUTHORITY = process.env.XAUTHORITY_TEST || "/run/user/1000/.mutter-Xwaylandauth.4XULY3";

if (!existsSync(FIREFOX)) throw new Error(`firefox not found at ${FIREFOX}`);
if (!existsSync(XPI)) throw new Error(`xpi not found at ${XPI}`);
function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
  console.log(`  ok — ${message}`);
}

/* Test-only relay appended to the content script (never shipped): dispatch a
 * CustomEvent("tinyvoca-e2e") whose detail is a runtime message; the reply is
 * written to document.title as "tv-e2e result <json>", and a light poll keeps
 * "tv-e2e state <json>" flowing afterwards. */
const RELAY = `
if (!window.__tinyVocaE2eRelay) {
  let holdUntil = 0;
  const observer = new MutationObserver(() => {
    const detail = document.documentElement.getAttribute("data-tinyvoca-e2e");
    if (!detail) return;
    const message = JSON.parse(detail);
    const nonce = message._n;
    delete message._n;
    holdUntil = Date.now() + 1500;
    browser.runtime.sendMessage(message).then(
      (value) => { document.title = "tv-e2e result " + nonce + " " + JSON.stringify(value === undefined ? null : value); },
      (error) => { document.title = "tv-e2e error " + nonce + " " + String(error && error.message || error); }
    );
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-tinyvoca-e2e"] });
  const slim = (state) => state && JSON.stringify({
    status: state.status, index: state.index, total: state.total,
    title: state.page && state.page.title, source: state.source,
    model: state.model && state.model.name, voices: state.model && state.model.voices,
    error: state.error,
    speed: state.prefs && state.prefs.speed,
  });
  setInterval(() => {
    if (Date.now() < holdUntil) return;
    if (document.title.startsWith("tv-selftest ")) return;
    browser.runtime.sendMessage({ type: "getState" }).then((state) => {
      document.title = "tv-e2e state " + slim(state);
    }).catch(() => {});
  }, 1000);
}
`;

const TEST_DIR = execSync("mktemp -d", { encoding: "utf8" }).trim();
const TEST_XPI = `${TEST_DIR}/reader-test.xpi`;
execSync(`cd ${TEST_DIR} && unzip -q ${XPI} -d src`);
appendFileSync(`${TEST_DIR}/src/content/content.js`, RELAY + "\n");
appendFileSync(`${TEST_DIR}/src/background/background.js`, `
browser.runtime.onInstalled.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("reader/reader.html?e2e=1") });
});
browser.runtime.onMessage.addListener((message) => {
  if (message.type !== "e2eSelftest") return undefined;
  browser.tabs.query({}).then((tabs) => {
    const tab = tabs.find((candidate) => candidate.url && candidate.url.startsWith("http://127.0.0.1:8123/"));
    if (!tab) return;
    browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: (status) => { document.title = status; },
      args: ["tv-selftest " + JSON.stringify(message.result)],
    }).catch(() => {});
  });
  return undefined;
});
`);
appendFileSync(`${TEST_DIR}/src/reader/reader.js`, `
if (new URLSearchParams(location.search).get("e2e") === "1") {
  (async () => {
    const out = {};
    const attempt = async (key, work) => {
      try { out[key] = await work; } catch (error) { out[key] = { error: String(error && error.message || error) }; }
    };
    await attempt("pdf", fetch(${JSON.stringify(`${MODULE_ORIGIN}/test/fixtures/sample.pdf`)}).then((r) => r.arrayBuffer()).then(extractPdf));
    await attempt("epub", fetch(${JSON.stringify(`${MODULE_ORIGIN}/test/fixtures/sample.epub`)}).then((r) => r.arrayBuffer()).then(extractEpub));
    await attempt("url", extractUrl(${JSON.stringify(ARTICLE)}));
    const slim = {
      pdf: out.pdf && { title: out.pdf.title, pages: out.pdf.pages, text: (out.pdf.blocks || []).join(" ").slice(0, 120), error: out.pdf.error },
      epub: out.epub && { title: out.epub.title, chapters: out.epub.chapters && out.epub.chapters.length, text: (out.epub.blocks || []).join(" ").slice(0, 160), error: out.epub.error },
      url: out.url && { title: out.url.title, count: (out.url.blocks || []).length, text: (out.url.blocks || [])[0], error: out.url.error },
    };
    document.title = "tv-selftest " + JSON.stringify(slim);
    browser.runtime.sendMessage({ type: "e2eSelftest", result: slim }).catch(() => {});
  })();
}
`);
execSync(`cd ${TEST_DIR}/src && zip -qr ${TEST_XPI} .`);

try { execSync("pkill -f geckodriver || true"); await delay(1200); } catch (error) { /* none */ }
const gecko = spawn(process.execPath, [GECKO, "--port", String(PORT)], {
  env: { ...process.env, DISPLAY, XAUTHORITY }, stdio: ["ignore", "ignore", "ignore"],
});
const cleanup = () => gecko.kill("SIGKILL");
process.on("exit", cleanup);
for (let i = 0; i < 30; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/status`); break; } catch (error) { await delay(500); }
}
const http = (method, path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method, headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (response) => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  return payload.value !== undefined ? payload.value : payload;
});

let session = null;
try {
  const created = await http("POST", "/session", { capabilities: { alwaysMatch: {
    "moz:firefoxOptions": { binary: FIREFOX, args: ["--width=1280", "--height=900"] },
  } } });
  session = created.sessionId;
  await http("POST", `/session/${session}/timeouts`, { script: 30000, pageLoad: 30000 });
  const addon = await http("POST", `/session/${session}/moz/addon/install`, { path: TEST_XPI, temporary: true });
  assert(addon === "tiny-reader@myfirefox.local", "extension installed");
  await http("POST", `/session/${session}/url`, { url: ARTICLE });
  await delay(2500);

  const run = (script) => http("POST", `/session/${session}/execute/sync`, { script, args: [] });
  const asyncRun = (script, args = []) => http("POST", `/session/${session}/execute/async`, { script, args });
  const title = () => run("return document.title");
  let earlySelf = null;
  const initialTitle = await title();
  if (initialTitle.startsWith("tv-selftest ")) {
    earlySelf = JSON.parse(initialTitle.replace(/^tv-selftest /, ""));
    await run("document.title = ' '; return true;");
  }

  const send = (message, nonce) => run(
    `document.documentElement.setAttribute("data-tinyvoca-e2e", ${JSON.stringify(JSON.stringify({ ...message, _n: nonce }))}); return true;`);
  const waitFor = async (pattern, label, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      last = await title();
      if (pattern.test(last)) return last;
      await delay(1000);
    }
    throw new Error(`timeout waiting for ${label}; last title=${last}`);
  };
  const resultOf = async (message, label) => {
    const nonce = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    send(message, nonce);
    const deadline = Date.now() + 70000;
    let last = "";
    while (Date.now() < deadline) {
      last = await title();
      if (last.startsWith(`tv-e2e error ${nonce} `)) throw new Error(`${label}: ${last.slice(`tv-e2e error ${nonce} `.length)}`);
      if (last.startsWith(`tv-e2e result ${nonce} `)) return JSON.parse(last.slice(`tv-e2e result ${nonce} `.length));
      await delay(700);
    }
    throw new Error(`timeout waiting for ${label}; last title=${last}`);
  };

  await waitFor(/^tv-e2e state /, "content relay alive");
  assert(true, "content-script relay is talking to the background");

  await resultOf({ type: "readBlocks", title: "DIRECT_ALPHA", blocks: ["DIRECT_ALPHA begins here. This short paragraph has two sentences."], source: "paste" }, "direct alpha");
  await waitFor(/tv-e2e state .*DIRECT_ALPHA/, "direct paste playback");
  assert(true, "pasted text read through the real readBlocks API");
  await resultOf({ type: "stop" }, "stop alpha");

  /* Model import over a real URL, then invalid-model rejection. */
  await resultOf({ type: "setModel", name: "e2e-custom", url: `${MODULE_ORIGIN}/assets/tiny-voca.gguf` }, "custom model download");
  await waitFor(/tv-e2e state .*e2e-custom/, "custom model active", 70000);
  assert(true, "custom GGUF downloaded, validated and activated");
  await resultOf({ type: "readBlocks", title: "DIRECT_ALPHA", blocks: ["DIRECT_ALPHA begins here. This short paragraph has two sentences."], source: "paste" }, "custom model playback start");
  await waitFor(/tv-e2e state .*DIRECT_ALPHA.*e2e-custom/, "custom model playback");
  await resultOf({ type: "stop" }, "stop custom playback");

  let rejected = null;
  try {
    await resultOf({ type: "setModel", name: "broken-model", url: `${MODULE_ORIGIN}/manifest.json` }, "invalid model");
  } catch (error) {
    rejected = error.message;
  }
  assert(Boolean(rejected), `invalid model URL rejected (${rejected && rejected.slice(0, 80)})`);
  const afterReject = await waitFor(/tv-e2e state /, "state after rejection");
  assert(/e2e-custom/.test(afterReject), "previous model survived the rejection");

  /* Real parser modules in the actual extension reader page (self-test tab). */
  const handles = await http("GET", `/session/${session}/window/handles`);
  let articleHandle = null;
  let selfOpened = false;
  for (const handle of handles) {
    await http("POST", `/session/${session}/window`, { handle });
    const current = await http("GET", `/session/${session}/url`);
    if (current.includes("reader/reader.html?e2e=1")) selfOpened = true;
    if (current.startsWith("http://127.0.0.1:8123/")) articleHandle = handle;
  }
  assert(selfOpened, "reader self-test tab opened");
  if (!articleHandle) throw new Error("article tab not found for self-test report");
  await http("POST", `/session/${session}/window`, { handle: articleHandle });
  const selfTitle = earlySelf
    ? `tv-selftest ${JSON.stringify(earlySelf)}`
    : await waitFor(/^tv-selftest /, "reader self-test report", 70000);
  const self = JSON.parse(selfTitle.replace(/^tv-selftest /, ""));
  assert(!self.pdf.error && self.pdf.pages === 2 && self.pdf.text.includes("Reading PDF documents locally"),
    `PDF.js real worker extracted both pages in the extension page (${self.pdf.title})`);
  assert(!self.epub.error && self.epub.chapters === 2 && self.epub.text.includes("Morning Walk"),
    `ePub extraction kept both chapters in the extension page (${self.epub.title})`);
  assert(!self.url.error && self.url.count >= 10 && self.url.title === "Tiny Reader Reading Test",
    `URL fetched and article extracted in the extension page (${self.url.count} blocks)`);

  console.log("\nREADER API + PARSER E2E PASS");
} finally {
  if (session) { try { await http("DELETE", `/session/${session}`); } catch (error) { /* gone */ } }
  cleanup();
}
