/*
 * tiny reader — end-to-end test through a real Firefox (geckodriver).
 *
 * Automation here cannot click the physical toolbar button, so activeTab can
 * never be granted, and neither WebDriver nor BiDi may execute inside
 * moz-extension pages. The test therefore builds its own xpi from the
 * packaged one with two documented, test-only patches (never shipped):
 *
 *   1. host_permissions <all_urls> — stands in for the activeTab grant a
 *      real toolbar click provides; every code path after it is identical;
 *   2. a bridge in background.js that (a) maps URL-hash navigations
 *      (#e2e-play, #e2e-pause, #e2e-resume, #e2e-stop, #e2e-next) to the
 *      exact functions the popup's runtime-message handlers call, and
 *      (b) mirrors status into the article tab's document.title, with a
 *      3 s heartbeat counter proving the event page is alive.
 *
 * Navigating to a URL is a real user action; assertions read the real page:
 * the paragraph highlight only moves when its sentences have actually
 * finished sounding, so a moving highlight proves real audio.
 *
 * Flow:
 *   1. whole-page read: #e2e-play → highlight appears, advances through 3+
 *      paragraphs over 85 s (audio + event-page keepalive past the 30 s
 *      idle threshold), pause freezes it, resume moves it, stop clears it;
 *   2. selection read: a real selection is made on one paragraph; #e2e-play
 *      reads exactly that paragraph;
 *   3. shortcut registration is covered by the manifest unit test.
 *
 * Prerequisites (see README):
 *   /tmp/e2e/tiny-reader.xpi   zip of the shipped extension
 *   /tmp/e2e/node_modules           npm i geckodriver
 *   python3 -m http.server 8123     from test/fixtures
 *
 * Usage: node tools/e2e.mjs  (env: FIREFOX_BIN, XPI_PATH, ARTICLE_URL,
 *                             GECKODRIVER_BIN, GECKO_PORT, DISPLAY_TEST,
 *                             XAUTHORITY_TEST)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";


const FIREFOX = process.env.FIREFOX_BIN || "/tmp/e2e/firefox/firefox";
const XPI = process.env.XPI_PATH || "/tmp/e2e/tiny-reader.xpi";
const GECKO = process.env.GECKODRIVER_BIN || "/tmp/e2e/node_modules/geckodriver/bin/geckodriver.js";
const ARTICLE = process.env.ARTICLE_URL || "http://127.0.0.1:8123/article.html";
const PORT = Number(process.env.GECKO_PORT || 4400 + Math.floor(Math.random() * 500));
const DISPLAY = process.env.DISPLAY_TEST || ":0";
const XAUTHORITY = process.env.XAUTHORITY_TEST || "/run/user/1000/.mutter-Xwaylandauth.4XULY3";

if (!existsSync(FIREFOX)) throw new Error(`firefox not found at ${FIREFOX} (see README)`);
if (!existsSync(XPI)) throw new Error(`xpi not found at ${XPI} (zip the extension first)`);

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
  console.log(`  ok — ${message}`);
}

/* ---- build the test xpi (host permissions + automation bridge) ---- */

const HOOK = [
  "",
  "// ---- test-only automation bridge; never shipped ----",
  "const E2E_COMMANDS = {",
  '  "e2e-play": () => activeTab().then((tab) => read(tab, "auto")).catch((e) => fail("play: " + e)),',
  '  "e2e-pause": () => pause(),',
  '  "e2e-resume": () => resume(),',
  '  "e2e-stop": () => stopPlayback(),',
  '  "e2e-next": () => seek(S.playingIndex + 1),',
  '  "e2e-speed": () => setPrefs({ speed: 1.25 }),',
  "};",
  "let e2eLastHash = null;",
  "browser.tabs.onUpdated.addListener((tabId, info, tab) => {",
  '  const hash = tab.url && tab.url.includes("#e2e-") ? tab.url.split("#")[1] : null;',
  "  if (!hash || !(hash in E2E_COMMANDS) || hash === e2eLastHash) return;",
  "  e2eLastHash = hash;",
  "  E2E_COMMANDS[hash]();",
  "});",
  "let e2eTab = null;",
  "const e2eTitle = (text) => {",
  "  if (S.tabId !== null) e2eTab = S.tabId;",
  "  if (e2eTab === null) return;",
  "  browser.scripting.executeScript({",
  "    target: { tabId: e2eTab },",
  "    func: (status) => { document.title = status; },",
  '    args: [text],',
  "  }).catch(() => {});",
  "};",
  "const e2eBadge = badge;",
  "let e2eBeat = 0;",
  "badge = function () {",
  "  e2eBadge();",
  '  e2eTitle("tv-e2e " + S.status + " " + (S.playingIndex + 1) + "/" + (S.total || 0) + (S.error ? " E: " + S.error : "") + " S" + (prefsCache ? prefsCache.speed : "") + " B" + e2eBeat);',
  "};",
  "const E2EWorker = Worker;",
  "window.Worker = class extends E2EWorker {",
  "  constructor(url, options) {",
  "    super(url, options);",
  '    this.addEventListener("error", (e) => e2eTitle("tv-e2e werr " + String(e.message || "").slice(0, 100) + " B" + e2eBeat));',
  '    this.addEventListener("messageerror", () => e2eTitle("tv-e2e wmsgerr B" + e2eBeat));',
  "  }",
  "};",
  "const e2eEnsureWorker = ensureWorker;",
  "ensureWorker = async function () {",
  "  const w = await e2eEnsureWorker();",
  "  const prev = w.onmessage;",
  "  w.onmessage = (e) => {",
  "    if (prev) prev(e);",
  '    if (e.data && e.data.type && ["loading", "planning"].includes(S.status)) e2eTitle("tv-e2e w:" + e.data.type + " B" + e2eBeat);',
  "  };",
  "  return w;",
  "};",
  "setInterval(() => { e2eBeat++; badge(); }, 3000);",
].join("\n");
const TEST_DIR = execSync(`mktemp -d`, { encoding: "utf8" }).trim();
const TEST_XPI = `${TEST_DIR}/test.xpi`;
execSync(`cd ${TEST_DIR} && unzip -q ${XPI} -d src`);
const manifest = JSON.parse(readFileSync(`${TEST_DIR}/src/manifest.json`, "utf8"));
manifest.host_permissions = ["<all_urls>"];
writeFileSync(`${TEST_DIR}/src/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
appendFileSync(`${TEST_DIR}/src/background/background.js`, HOOK + "\n");
execSync(`cd ${TEST_DIR}/src && zip -qr ${TEST_XPI} .`);

/* ---- session ---- */

try { execSync("pkill -f geckodriver || true"); await delay(1500); } catch (error) { /* none running */ }
const gecko = spawn(process.execPath, [GECKO, "--port", String(PORT)], {
  env: { ...process.env, DISPLAY, XAUTHORITY },
  stdio: ["ignore", "ignore", "ignore"],
});
const cleanup = () => gecko.kill("SIGKILL");
process.on("exit", cleanup);
for (let i = 0; i < 30; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/status`); break; } catch (error) { await delay(500); }
}

const http = (method, path, body) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
    return payload.value !== undefined ? payload.value : payload;
  });

let session = null;
try {
  const created = await http("POST", "/session", {
    capabilities: { alwaysMatch: { "moz:firefoxOptions": { binary: FIREFOX, args: ["--width=1280", "--height=900"] } } },
  });
  session = created.sessionId;
  console.log(`session up (firefox ${created.capabilities.browserVersion})`);
  await http("POST", `/session/${session}/timeouts`, { script: 30000, pageLoad: 30000 });

  const addonId = await http("POST", `/session/${session}/moz/addon/install`, { path: TEST_XPI, temporary: true });
  assert(addonId === "tiny-reader@myfirefox.local", `extension installed as ${addonId}`);

  // Navigate after installing: the declared content script only injects into
  // pages that load with the extension present (as after a real install).
  await http("POST", `/session/${session}/url`, { url: ARTICLE });

  const run = (script) => http("POST", `/session/${session}/execute/sync`, { script, args: [] });
  const navigate = (url) => http("POST", `/session/${session}/url`, { url });
  // Fragment-only navigations can wedge Marionette's load wait; setting
  // location.hash from the page does the same job with no load semantics.
  const command = (name) => run(`location.hash = "${name}"; return document.title;`);
  const title = () => run("return document.title");
  const mark = () => run(
    "const el = document.querySelector('.tiny-reader-reading');" +
    "return el ? el.textContent.replace(/\\s+/g,' ').slice(0,60) : null;");

  assert(await run("return document.querySelectorAll('article p').length") >= 10, "article loaded with its paragraphs");

  const sample = () => {
    try {
      return execSync(`ps -eo pid,pcpu,rss,args --sort=-rss | grep -E "firefox|geckodriver" | grep -v grep | head -4 | awk '{ printf "%s/%s%%/%dMB ", $1, $2, $3/1024 }'`, { encoding: "utf8" }).trim();
    } catch (error) { return "?"; }
  };
  const waitForTitle = async (pattern, label, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = "";
    let printed = "";
    while (Date.now() < deadline) {
      try {
        lastSeen = await title();
      } catch (error) {
        console.log(`   title poll failed: ${String(error.message).slice(0, 80)} | ${sample()}`);
        await delay(3000);
        continue;
      }
      if (lastSeen !== printed) { printed = lastSeen; console.log(`   title: "${lastSeen}" | ${sample()}`); }
      if (pattern.test(lastSeen)) return lastSeen;
      await delay(2000);
    }
    throw new Error(`timeout waiting for ${label}; last title: "${lastSeen}", mark: ${JSON.stringify(await mark().catch(() => null))}`);
  };

  /* ---- whole page ---- */
  const started = Date.now();
  await command("e2e-play");
  const playingTitle = await waitForTitle(/tv-e2e playing/, "reading start", 60000);
  assert(true, `reading started (${playingTitle})`);
  let first = null;
  for (let i = 0; i < 20 && first === null; i++) {
    await delay(2000);
    first = await mark();
  }
  assert(first !== null, `current paragraph highlighted: "${first}"`);

  const miniPlayer = () => run(
    "const host = document.getElementById('tiny-reader-miniplayer');" +
    "if (!host || !host.shadowRoot) return null;" +
    "return { actions: [...host.shadowRoot.querySelectorAll('[data-action]')].map((el) => el.dataset.action)," +
    "preview: host.shadowRoot.querySelector('[data-role=preview]')?.textContent || '' };");
  const mini = await miniPlayer();
  assert(mini && ["prev", "pause", "next", "stop", "close"].every((action) => mini.actions.includes(action)),
    `floating mini-player appeared with working controls (${mini ? mini.actions.join(",") : "missing"})`);

  const marks = new Set([first]);
  while (Date.now() - started < 85000) {
    await delay(5000);
    const current = await mark();
    if (current !== null) marks.add(current);
  }
  assert(marks.size >= 3, `highlight advanced through ${marks.size} paragraphs in 85 s (audio + keepalive past idle)`);
  console.log("   title now:", await title());

  await run("document.getElementById('tiny-reader-miniplayer').shadowRoot.querySelector('[data-action=pause]').click(); return true;");
  await delay(6000);
  const frozenA = await mark();
  await delay(6000);
  const frozenB = await mark();
  assert(frozenA !== null && frozenA === frozenB, `pause froze the voice at "${frozenA}"`);
  assert(/tv-e2e paused/.test(await title()), `status shows paused (${await title()})`);

  await run("document.getElementById('tiny-reader-miniplayer').shadowRoot.querySelector('[data-action=pause]').click(); return true;");
  let resumed = null;
  const resumeDeadline = Date.now() + 90000;
  while (Date.now() < resumeDeadline && resumed === null) {
    await delay(3000);
    const current = await mark();
    if (current !== null && current !== frozenB) resumed = current;
  }
  assert(resumed !== null, `resumed and continued at "${resumed}"`);

  let stopped = false;
  const stopDeadline = Date.now() + 20000;
  while (Date.now() < stopDeadline && !stopped) {
    await command("e2e-stop");
    await delay(1500);
    stopped = /tv-e2e idle/.test(await title());
  }
  assert(stopped, `stop returned to idle (${await title()})`);
  assert(await mark() === null, "highlight cleared after stop");
  assert(await run("return document.getElementById('tiny-reader-miniplayer') === null"), "mini-player closed after stop");

  /* ---- selection ---- */
  await navigate(ARTICLE); // clean reload, no hash, fresh selection state
  await delay(2500);
  const selected = await run(
    "const p = document.querySelectorAll('article p')[3];" +
    "const range = document.createRange(); range.selectNodeContents(p);" +
    "const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);" +
    "return p.textContent.replace(/\\s+/g,' ').slice(0,50);");
  assert(Boolean(selected), `a real selection was made: "${selected}"`);

  await command("e2e-play");
  const selectionTitle = await waitForTitle(/tv-e2e playing/, "selection reading start", 60000);
  assert(true, `selection reading started (${selectionTitle})`);
  let selectionMark = null;
  for (let i = 0; i < 20 && selectionMark === null; i++) {
    await delay(2000);
    selectionMark = await mark();
  }
  assert(selectionMark !== null && selectionMark.startsWith(selected.slice(0, 30)),
    `only the selected paragraph is read, highlighted: "${selectionMark}"`);

  /* Per-site preference: change speed on this host, stop, then read again. */
  await command("e2e-speed");
  await waitForTitle(/S1\.25/, "site speed override saved", 15000);
  await command("e2e-stop");
  await delay(1200);
  await command("e2e-play");
  const sitePrefsTitle = await waitForTitle(/tv-e2e playing .*S1\.25/, "site speed override reused", 60000);
  assert(true, `voice/speed override persisted for this host (${sitePrefsTitle})`);

  await command("e2e-stop");
  await delay(1500);

  console.log("\nE2E PASS");
} finally {
  if (session) { try { await http("DELETE", `/session/${session}`); } catch (error) { /* gone */ } }
  cleanup();
}
