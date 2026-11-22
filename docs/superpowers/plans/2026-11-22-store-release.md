# Store Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship tiny reader to the Chrome Web Store and addons.mozilla.org with no install-time all-sites warning, offscreen audio on Chrome, a welcome page, a working shortcut, one release command with a real-browser smoke check, and complete store material.

**Architecture:** One source tree; Firefox MV3 event page as-is, Chrome variant produced by `tools/build-chrome.mjs`. Content scripts become on-demand (`activeTab` + `scripting`); arbitrary-origin fetches request a single origin at the click. Chrome's audio host page moves from a pinned tab into a `chrome.offscreen` document using the existing hello + `tv-audio-host` port protocol. Release tooling is plain Node + raw CDP against system Chromium (no npm install).

**Tech Stack:** WebExtensions MV3 (Firefox 140+, Chromium), plain JS (classic scripts in background, ES modules in pages), `node:test`, raw CDP over Node 24's global `WebSocket`, vendored `fflate` for zips.

**Spec:** `docs/superpowers/specs/2026-11-22-store-release-design.md`

## Global Constraints

- No `package.json`, no npm install; tools run with `node` only (CONTRIBUTING promise).
- Vendored files (`vendor/`, `assets/tiny-voca.gguf`) are never modified.
- Firefox add-on ID: `tiny-reader@disobey.dev`. `author`: `Aljaz Ceru` (both manifests).
- Version has one source of truth: `manifest.json` `version`.
- Default shortcut `Alt+Shift+R` in both manifests.
- No telemetry, analytics or accounts; privacy policy states the developer collects nothing.
- Support URL: `https://github.com/aljazceru/tiny-reader/issues`. Privacy URL: `https://github.com/aljazceru/tiny-reader/blob/main/PRIVACY.md`.
- Smoke check and screenshots use `CHROME_BIN` defaulting to `/usr/bin/chromium-browser` (branded Google Chrome ignores `--load-extension`).
- `node --test` stays green after every task. Commit messages carry no Co-Authored-By line.
- Offscreen audio: if the Task 2 spike fails in real Chromium, stop and report to the owner; do not keep the pinned tab silently.

## Review Focus

1. **User declines a permission prompt** (URL read, model URL, endpoint) → a plain message naming what was not allowed and why; the form stays usable and a retry asks again. Tests in Task 5.
2. **Endpoint or URL with a port or path** (`http://localhost:8880/v1/audio/speech`) → the requested pattern is `http://localhost/*` (match patterns cannot carry ports), and the fetch then works. Test in Task 5.
3. **Read pressed on a page that cannot be injected** (Chrome Web Store, `about:`/`chrome:` pages, the browser PDF viewer, tabs opened before install) → a specific error, never "The page did not answer." Tests in Task 4.
4. **Extension update** (not first install) → no welcome tab opens; old `libraryItems`/`queueIds` keys are still removed. Test in Task 7.
5. **Paused for longer than Chrome's ~30 s offscreen idle limit** → resume recreates the document if it was closed and continues from the current sentence instead of hanging. Test in Task 3.

---

### Task 0: Land pending fixes and ignore tool output

**Files:**
- Modify: `.gitignore`
- Commit (already in working tree): `README.md`, `reader/models.js`, `reader/reader.css`, `reader/reader.js`, `test/workspace.test.js`, `tools/build-chrome.mjs`, `test/chrome-build.test.mjs`

- [ ] **Step 1:** Add `.playwright-mcp/` under "# Test tooling" in `.gitignore`.
- [ ] **Step 2:** Run `node --test test/*.test.*` → `ℹ fail 0`.
- [ ] **Step 3:** Commit: `git add -A && git commit -m "reader: restore NOTICE_MS (file reads), fix Chrome icon scaling, README cleanup"`.

---

### Task 1: Shared CDP launcher for tools

**Files:**
- Create: `tools/cdp.mjs`
- Modify: `tools/chrome-e2e.mjs` (replace its inline launch + CDP client with imports)

**Interfaces:**
- Produces:
  - `launchChromium({ ext: string, port?: number = 9391, headless?: boolean = false, profile?: string }) → Promise<{ list(): Promise<Target[]>, close(): void }>` — spawns `CHROME_BIN || "/usr/bin/chromium-browser"` with the flags `chrome-e2e.mjs` uses today, waits for `/json/version`.
  - `connect(wsUrl: string) → Promise<{ send(method: string, params?: object): Promise<any>, on(event: string, fn): void, close(): void }>` — the client now inline in `chrome-e2e.mjs`.
  - `waitForTarget(browser, predicate: (t: Target) => boolean, timeoutMs = 15000) → Promise<Target>`.

- [ ] **Step 1:** Move the launch and CDP client code from `tools/chrome-e2e.mjs` into `tools/cdp.mjs` with the signatures above; `chrome-e2e.mjs` imports them. Behavior unchanged.
- [ ] **Step 2:** Verify: `node tools/build-chrome.mjs && xvfb-run -a node tools/chrome-e2e.mjs` → same pass output as before the move (run once before the change to record the baseline).
- [ ] **Step 3:** Commit `tools: extract CDP launcher for reuse`.

---

### Task 2: Spike — offscreen document runs the engine (throwaway, decision gate)

**Files:** scratch branch only; nothing merged.

- [ ] **Step 1:** In a scratch copy of `dist/chrome`, add `"offscreen"` to permissions and make `EngineHost.ensureDocument` call `chrome.offscreen.createDocument({ url: "chrome/audio-host.html", reasons: ["AUDIO_PLAYBACK"], justification: "Plays synthesized speech" })`.
- [ ] **Step 2:** Using `tools/cdp.mjs`, headed (`xvfb-run -a`), paste text in the reader workspace and confirm: the offscreen target appears in `/json/list` with type `other`/`offscreen`, `index` advances past 2 (audio clock runs), no target errors.
- [ ] **Step 3:** Repeat headless (`headless: true`). Record whether `index` advances.
- [ ] **Step 4:** Write the result (works headed? headless?) as a short note at the top of Task 3 in this plan and in the commit message of Task 3. **If headed fails: stop and report to the owner.**

---

### Task 3: Chrome audio in an offscreen document; custom models on Chrome

**Files:**
- Modify: `background/engine-host.js` (flag rename, `ensureDocument`/`closeDocument`, `HostWorker` load payload)
- Modify: `chrome/audio-host.js` (`spawnWorker` posts load; rebuild model bytes), `chrome/audio-host.html` (drop tab text), `background/chrome-sw.js` (comments; idle close via `closeDocument`)
- Modify: `tools/build-chrome.mjs` (permissions: add `"offscreen"`, remove `"tabs"`)
- Modify: `README.md` (Chrome section), `tools/chrome-e2e.mjs` (comments)
- Test: `test/engine-host.test.js` (new)

**Interfaces:**
- Produces: `EngineHost.useAudioHost: boolean` (renamed from `offscreen`); `EngineHost.ensureDocument(): Promise<void>`; `EngineHost.closeDocument(): Promise<void>`. Port command `{kind:"engine", message:{type:"load", model:{name, bytes:number[]}|undefined}}`.

- [ ] **Step 1: Write failing tests** in `test/engine-host.test.js`. Load `background/engine-host.js` in `node:vm` with a fake `chrome` (records `offscreen.createDocument`, `runtime.getContexts` returning `[]` then one context, `runtime.connect` returning a fake port that records `postMessage`) and `navigator.userAgent = "Chrome"`:
  - `test("chrome audio host is an offscreen document, never a tab")`: `await EngineHost.ensureDocument()` → `createDocument` called once with `reasons` deep-equal `["AUDIO_PLAYBACK"]` and `url` `"chrome/audio-host.html"`; a second call with `getContexts` returning one context does not call it again; `chrome.tabs` is undefined in the sandbox and nothing throws.
  - `test("custom model bytes survive the port")`: after the host hello, `await EngineHost.spawnWorker(undefined, { name: "m", buffer: new Uint8Array([1,2,3]).buffer })` → the recorded port message is `{scope:"tv-host", message:{kind:"engine", message:{type:"load", model:{name:"m", bytes:[1,2,3]}}}}`.
  - `test("commands after the offscreen document closed recreate it")`: after `await EngineHost.closeDocument()` (and `getContexts` returning `[]`), `await EngineHost.createPlayer().resume()` calls `createDocument` again, then posts `{kind:"resume"}` after a fresh hello.
- [ ] **Step 2:** Run `node --test test/engine-host.test.js` → 3 failures (tab API used / buffer posted as ArrayBuffer / no recreate).
- [ ] **Step 3:** Implement in `engine-host.js`: `ensureDocument` uses `chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })` then `chrome.offscreen.createDocument(...)`; `closeDocument` uses `chrome.offscreen.closeDocument()` (catch "no document"); `HostWorker` sends `model ? { name: model.name, bytes: Array.from(new Uint8Array(model.buffer)) } : undefined`; every `post` path awaits `ensureDocument()` + `hostReady()` so a closed document is recreated. Reset `hostAlive = false` when the document closes.
- [ ] **Step 4:** Implement in `audio-host.js`: `spawnWorker(model)` creates the Worker then posts `{ type: "load", model: model ? { name: model.name, buffer: new Uint8Array(model.bytes).buffer } : undefined }` (the worker's existing load contract, `engine/engine-worker.mjs`). Keep "resume replays the sentence" unless Task 2 showed `AudioContext.resume()` works in the offscreen document; if it does, make `pause` suspend and `resume` resume and drop the replay in `background.js` `resume()` for Chrome.
- [ ] **Step 5:** Update `build-chrome.mjs` permissions to `["storage", "contextMenus", "scripting", "activeTab", "offscreen"]`; update `test/chrome-build.test.mjs` to assert `"offscreen"` present and `"tabs"` absent.
- [ ] **Step 6:** Run `node --test test/*.test.*` → `fail 0`; `node tools/build-chrome.mjs && xvfb-run -a node tools/chrome-e2e.mjs` → passes; no pinned tab appears (assert in chrome-e2e: no `page` target with `audio-host.html`).
- [ ] **Step 7:** Commit `chrome: play audio from an offscreen document; fix custom model load`.

---

### Task 4: On-demand content script injection

**Files:**
- Modify: `manifest.json` (remove `content_scripts`), `tools/build-chrome.mjs` (remove `content_scripts`)
- Modify: `background/background.js` (`extract`, `readable`, injection file list)
- Modify: `content/content.js` header comment (now accurate), `README.md` packaging list (add `compat`)
- Test: `test/manifest.test.js`, `test/background-extract.test.js` (new)

**Interfaces:**
- Produces: `const INJECT_FILES = ["compat/compat.js", "vendor/readability.js", "content/content.js"]` in `background.js`; `readable(tab) → string|null` extended.

- [ ] **Step 1: Write failing tests.**
  - `test/manifest.test.js`: `assert.equal(manifest.content_scripts, undefined)`; Chrome manifest from a fresh `build-chrome` likewise.
  - `test/background-extract.test.js` (load `background.js` + `logic/*.js` in `node:vm` with a fake `browser` exposing `tabs.sendMessage`, `scripting.executeScript`, `storage.local`, `runtime.onMessage/onConnect/onInstalled`, `menus`, `commands`, `tabs.onRemoved`):
    - `test("extract injects compat first, then asks again")`: first `sendMessage` rejects, second resolves `{blocks:["x"], source:"page"}` → `executeScript` called with `files` deep-equal `INJECT_FILES`.
    - `test("store and browser pages are refused up front")`: `readable({id:1,url})` returns a non-null message for `https://chromewebstore.google.com/detail/x`, `https://addons.mozilla.org/en-US/firefox/`, `chrome://newtab`, `about:reader?url=x`; returns `null` for `https://example.com/`.
    - `test("injection failure gets a specific error")`: both `sendMessage` calls reject and `executeScript` rejects → `extract` throws exactly `"tiny reader can't read this page. Try selecting the text and using the right-click menu, or open it in the reader workspace."` (never "The page did not answer.").
    - `test("update installs do not open the welcome page")` lives in Task 7; this harness is reused there.
- [ ] **Step 2:** Run `node --test test/manifest.test.js test/background-extract.test.js` → failures.
- [ ] **Step 3:** Implement: remove `content_scripts` from both manifests; `extract` uses `INJECT_FILES` (compat.js is a no-op where `browser` exists) and maps an `executeScript` rejection to the message above; `readable` adds the store hosts (`chromewebstore.google.com`, `chrome.google.com/webstore`, `addons.mozilla.org`) which browsers forbid injecting into. Add `compat` to the Firefox zip path list in README (Task 8 uses the same list).
- [ ] **Step 4:** Run `node --test test/*.test.*` → `fail 0`.
- [ ] **Step 5:** Commit `inject the reader on demand; no content scripts at install`.

---

### Task 5: Optional host permissions requested at point of use

**Files:**
- Modify: `manifest.json`, `tools/build-chrome.mjs`: `host_permissions` → `optional_host_permissions: ["<all_urls>"]`
- Create: `reader/permissions.js`
- Modify: `reader/reader.js` (`readUrl`), `reader/models.js` (model URL apply, endpoint apply)
- Modify: `tools/e2e.mjs` comment (its `<all_urls>` patch is now required, not redundant)
- Test: `test/permissions.test.mjs` (new), `test/manifest.test.js`

**Interfaces:**
- Produces (ES module `reader/permissions.js`):
  - `originPattern(url: string) → string` — `"<scheme>://<hostname>/*"`; throws `Error("That does not look like a URL.")` for invalid/non-http(s).
  - `requestOrigin(url: string, purpose: string) → Promise<{ granted: boolean, message?: string }>` — calls `browser.permissions.request({ origins: [originPattern(url)] })`; on denial returns `message: \`Permission for ${hostname} was not given, so tiny reader can't ${purpose}. Try again and choose Allow.\``.

- [ ] **Step 1: Write failing tests** in `test/permissions.test.mjs` with a fake `globalThis.browser.permissions.request`:
  - `originPattern("http://localhost:8880/v1/audio/speech")` → `"http://localhost/*"`; `originPattern("https://huggingface.co/a/b.gguf?download=1")` → `"https://huggingface.co/*"`; `originPattern("ftp://x")` throws.
  - `requestOrigin` with request resolving `false` → `{ granted: false, message: "Permission for example.com was not given, so tiny reader can't read this page. Try again and choose Allow." }` for `("https://example.com/a", "read this page")`; resolving `true` → `{ granted: true }`; a second call after a denial calls `request` again.
  - `test/manifest.test.js`: `host_permissions` undefined; `optional_host_permissions` deep-equal `["<all_urls>"]`; `id` `tiny-reader@disobey.dev` is asserted in Task 6, not here.
- [ ] **Step 2:** Run → failures.
- [ ] **Step 3:** Implement `reader/permissions.js`. Wire it so `permissions.request` is the **first** awaited call inside each click/keydown handler (Firefox drops the user gesture after any earlier `await`): `readUrl` (purpose `"read this page"`), model "Use this model" with a URL (`"download this model"`), "Use this endpoint" (`"use this endpoint"`). On `granted: false` show `message` via the existing `setNotice(..., true)` / `say(..., true)` and return.
- [ ] **Step 4:** Manually verify the Hugging Face redirect: with only `https://huggingface.co/*` granted, `setModel` by URL for `https://huggingface.co/n4ze3m/tiny-voca/resolve/main/gguf/tiny-voca-js.gguf` downloads in Chromium (CDP harness) and Firefox. If the CDN hop fails, request the redirect host too (record which host in the commit message).
- [ ] **Step 5:** Run `node --test test/*.test.*` → `fail 0`; `xvfb-run -a node tools/chrome-e2e.mjs` → remote-endpoint section passes (grant `http://127.0.0.1/*` via the harness before applying the endpoint, using CDP `Browser.grantPermissions` or by clicking Allow).
- [ ] **Step 6:** Commit `ask for site access only when a feature needs it`.

---

### Task 6: Manifest identity and shortcut

**Files:**
- Modify: `manifest.json` (`browser_specific_settings.gecko.id`, `author`, `commands.toggle-read.suggested_key.default`)
- Modify: `tools/build-chrome.mjs` (`author`, `version` read from `manifest.json`)
- Test: `test/manifest.test.js`, `test/chrome-build.test.mjs`

- [ ] **Step 1: Write failing tests:** gecko id `"tiny-reader@disobey.dev"`; `author` `"Aljaz Ceru"` in both manifests; Firefox `suggested_key.default` `"Alt+Shift+R"`; built Chrome `version` equals `manifest.json` `version`.
- [ ] **Step 2:** Run → failures.
- [ ] **Step 3:** Implement the values above; `build-chrome.mjs` reads `version` from `manifest.json`.
- [ ] **Step 4:** Manually confirm `Alt+Shift+R` is assigned (not blank) in Firefox `about:addons` → Manage Extension Shortcuts and in `chrome://extensions/shortcuts` on Linux; check Mozilla/Chrome reserved-shortcut docs for Windows and macOS (Option+Shift+R). If it collides, pick another and note why in the commit.
- [ ] **Step 5:** Run `node --test test/*.test.*` → `fail 0`. Commit `manifest: permanent Firefox id, author, Alt+Shift+R shortcut`.

---

### Task 7: First-run welcome page

**Files:**
- Create: `welcome/welcome.html`, `welcome/welcome.css`, `welcome/welcome.js`
- Modify: `background/background.js` (`onInstalled`), `tools/build-chrome.mjs` (add `welcome` to `SHARED`; add compat shim to `welcome.html` like popup/reader), README packaging list (add `welcome`)
- Test: `test/welcome.test.js` (new), `test/background-extract.test.js` harness reused for onInstalled

**Interfaces:**
- Consumes: runtime messages `readBlocks`, `getState`; keepalive port name `tv-keepalive` (same contract as `reader/reader.js` `setReading`).
- Produces: `onInstalled` handler opens `welcome/welcome.html` only when `details.reason === "install"`.

- [ ] **Step 1: Write failing tests.**
  - onInstalled: `{reason:"install"}` → `browser.tabs.create` called once with `{ url: "welcome/welcome.html" }`; `{reason:"update"}` → not called, and `storage.local.remove` still called with `["libraryItems","queueIds"]`.
  - `test/welcome.test.js` (static, like `workspace.test.js`): `welcome.html` has `id="hearIt"`, `id="shortcut"`, `id="openWorkspace"`, `id="changeShortcut"`; `welcome.js` uses `tv-keepalive`, `commands.getAll`, sends `readBlocks` with `source: "paste"`; and the ALL_CAPS-constant check from `workspace.test.js` covers `welcome/welcome.js` too (extend its file list).
- [ ] **Step 2:** Run → failures.
- [ ] **Step 3:** Implement the page per the spec mockup (spec §3), reusing `reader/reader.css` tokens (copy the `:root` palette; no shared-CSS refactor). Copy, exact:
  - Title "tiny reader", tagline "Read the web aloud, on your own machine."
  - Button "▶ Hear it", sample text `"Hello! This is tiny reader. Select any text on a page and I will read it to you."`
  - "Three ways to read": "Select text, right-click, choose Read selection with tiny reader" / "Click the tiny reader button in the toolbar" / "Press <shortcut>" + link "Change shortcut".
  - "PDFs, ePubs, pasted text and web addresses: Open the reader workspace".
  - "Runs locally. No account, no tracking."
  - Shortcut text from `browser.commands.getAll()` (`toggle-read`), or "not set" when empty. "Change shortcut": Firefox `browser.commands.openShortcutSettings()`; Chrome `browser.tabs.create({ url: "chrome://extensions/shortcuts" })`.
  - "Hear it" holds the keepalive port while `getState().status` is busy, like `reader.js`.
- [ ] **Step 4:** Run `node --test test/*.test.*` → `fail 0`. Commit `welcome page on first install`.

---

### Task 8: Chrome store build and release packages

**Files:**
- Modify: `tools/build-chrome.mjs` (clean output dir, 128 px icon, `--store` flag drops `key`, export nothing new)
- Create: `tools/package.mjs`
- Test: `test/chrome-build.test.mjs`, `test/package.test.mjs` (new)

**Interfaces:**
- Produces:
  - `node tools/build-chrome.mjs [--store]` → `dist/chrome` (with `key`) or `dist/chrome-store` (no `key`, no `manifest.firefox.json`).
  - `FIREFOX_FILES = ["manifest.json","background","engine","vendor","content","popup","reader","welcome","logic","compat","icons","assets","LICENSE","NOTICE"]` exported from `tools/package.mjs`.
  - `node tools/package.mjs` → `dist/tiny-reader-firefox-<v>.zip`, `dist/tiny-reader-chrome-<v>.zip` (from `dist/chrome-store`), `dist/tiny-reader-source-<v>.zip` (git-tracked files via `git ls-files`), using `zipSync` from `vendor/fflate.js`.

- [ ] **Step 1: Write failing tests:** `build-chrome --store` output manifest has no `key`, has `icons["128"]`, and `dist/chrome-store/manifest.firefox.json` does not exist; a stale file placed in `dist/chrome` before a build is gone after it; `package.mjs` run produces the three zips, the Firefox zip contains `manifest.json`, `welcome/welcome.html`, `compat/compat.js` and no `tools/` or `test/` entries; the Chrome zip's `manifest.json` has no `key`.
- [ ] **Step 2:** Run → failures.
- [ ] **Step 3:** Implement (`rmSync(out, {recursive:true, force:true})` before copy; icon sizes `[16, 32, 48, 96, 128]`).
- [ ] **Step 4:** Run `node --test test/*.test.*` → `fail 0`; `npx web-ext lint --source-dir .` → 0 errors (warnings listed in the commit message if any). Commit `build: store packages for Chrome and Firefox`.

---

### Task 9: Smoke check and release command

**Files:**
- Create: `tools/smoke.mjs`, `tools/release.mjs`
- Modify: `README.md` (Development and Release checklist), `CONTRIBUTING.md` (release step)

**Interfaces:**
- Consumes: `launchChromium`, `connect`, `waitForTarget` (Task 1); `dist/chrome` (Task 8, with `key` for a stable extension id).
- Produces: `node tools/smoke.mjs` exits 0/1; `node tools/release.mjs` runs `node --test`, `npx web-ext lint`, `build-chrome`, `build-chrome --store`, `smoke`, `package`, stopping at the first failure with its name.

- [ ] **Step 1:** Implement `tools/smoke.mjs` (headless if Task 2 showed headless works, else requires `DISPLAY`/`xvfb-run`): open `popup/popup.html`, `reader/reader.html`, `welcome/welcome.html` as extension pages; collect `Runtime.exceptionThrown` and console `error` entries — any → fail with the text. In the reader: set `#speed` to 1.75 and assert `#speedValue` is `"1.75×"`; paste text and click Read; set `#fileInput` (CDP `DOM.setFileInputFiles`) to `test/fixtures/sample.epub`, then `sample.pdf`; after each, poll `getState` until `status` is not `"idle"` (10 s). Click "Hear it" on the welcome page; same status check.
- [ ] **Step 2:** Prove it catches the 68e793e class: temporarily delete the `NOTICE_MS` line from `reader/reader.js`, run `node tools/build-chrome.mjs && node tools/smoke.mjs` → exits 1 naming `NOTICE_MS`; restore the line → exits 0.
- [ ] **Step 3:** Implement `tools/release.mjs`. Run it → all steps pass, three zips in `dist/`.
- [ ] **Step 4:** Update README release checklist to `node tools/release.mjs` plus manual uploads; CONTRIBUTING notes the smoke check needs Chromium and a display or `xvfb-run`.
- [ ] **Step 5:** Commit `tools: release command with real-browser smoke check`.

---

### Task 10: Store material and privacy policy

**Files:**
- Create: `PRIVACY.md`, `docs/store/listing.md`, `docs/store/permissions.md`, `docs/store/amo-review-notes.md`
- Modify: `README.md` (Permissions table, Privacy section links `PRIVACY.md`, intro mentions both stores), `manifest.json` / `build-chrome.mjs` `homepage_url` unchanged

- [ ] **Step 1:** `PRIVACY.md`: text per spec §8 (developer collects, receives and processes no data; what stays local; the three user-initiated network cases; remote endpoint's own policy applies; contact via GitHub issues; effective date 2026-11-22).
- [ ] **Step 2:** `docs/store/listing.md`: name "tiny reader"; Chrome summary ≤132 chars: `"Read web pages, selections, PDFs and ePubs aloud with a voice that runs on your computer. No account, no tracking."` (verify length); full description covering features, English-only bundled voice, remote endpoints for other voices/languages, privacy; categories (Chrome: Accessibility; AMO: Accessibility, Language Support); support and privacy URLs from Global Constraints.
- [ ] **Step 3:** `docs/store/permissions.md`: single-purpose statement ("Reads text aloud from web pages and documents the user chooses"); one sentence each for `activeTab`, `scripting`, `storage`, `contextMenus`/`menus`, `offscreen`, optional `<all_urls>`; remote code: "No remote code; models are data files."
- [ ] **Step 4:** `docs/store/amo-review-notes.md`: vendored file → upstream source + version table copied from `vendor/README.md`, with the npm tarball URL for each so reviewers can diff; how to build (`node tools/release.mjs`); how to test a remote endpoint (mock server in `tools/chrome-e2e.mjs`, or any OpenAI-compatible endpoint); data collection: none, remote endpoint is user-configured and user-initiated.
- [ ] **Step 5:** Cross-check every claim in these files against the code (permissions list from both built manifests; no fetches beyond the three cases — grep `fetch(`). Commit `docs: privacy policy and store listing material`.

---

### Task 11: Store screenshots

**Files:**
- Create: `tools/screenshots.mjs`, output `docs/store/screenshots/{1-page-reading,2-popup,3-workspace,4-welcome}.png` (1280×800) and `docs/store/screenshots/promo-440x280.png`

- [ ] **Step 1:** Implement with `tools/cdp.mjs`: set viewport 1280×800 (`Emulation.setDeviceMetricsOverride`); serve `test/fixtures/article.html` from a local `node:http` server; start a page read and capture once the mini-player shows and a paragraph is highlighted; open the popup page in a 1280×800 tab centered on a neutral background; workspace with sample text pasted; welcome page. Promo tile: render a small inline HTML (icon + "tiny reader" + "Read the web aloud, locally") at 440×280.
- [ ] **Step 2:** Run `xvfb-run -a node tools/screenshots.mjs`; open each PNG and check: correct size, no error banners, no developer UI, readable in the store's light background.
- [ ] **Step 3:** Commit `docs: store screenshots`.

---

### Task 12: Final verification and owner handoff

- [ ] **Step 1:** `node tools/release.mjs` → passes; record zip sizes.
- [ ] **Step 2:** Load `dist/tiny-reader-firefox-<v>.zip` in Firefox via `about:debugging` and the Chrome store build via Load unpacked in Chromium; manually: install shows no all-sites warning, welcome opens once, Hear it speaks, right-click read works on a news page, shortcut works, workspace URL read prompts for that site only, PDF/ePub read, remote endpoint prompts for its origin.
- [ ] **Step 3:** Write the handoff for the owner: upload steps for each store (dashboard fields mapped to `docs/store/*`), what each reviewer may ask, and the reminder that the repo must be public before submitting.
