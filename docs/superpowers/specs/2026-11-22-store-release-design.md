# tiny reader: store release (Chrome Web Store + Firefox Add-ons)

Date: 2026-11-22. Status: approved by owner 2026-11-22.

## Intent

Publish tiny reader so that strangers find it in the Chrome Web Store and on
addons.mozilla.org (AMO), install it, and have it feel good from the first
minute. "Make it nice" is the bar: the install prompt should not scare
anyone, the first read should work without setup, and nothing odd (a
mysterious pinned tab, a dead shortcut, an error banner) should show up.

## Goals

1. Both store packages build from this one tree with one command, pass
   store validation (`web-ext lint`; Chrome Web Store upload rules), and are
   submitted.
2. Install asks for as little as possible. No "read and change all your data
   on all websites" warning at install time.
3. Chrome plays audio from an offscreen document, not a pinned tab.
4. First install opens a short welcome page that gets the user to their
   first spoken sentence.
5. The keyboard shortcut works by default in both browsers.
6. A release cannot ship the class of bug that broke 68e793e (a page that
   throws on load): the release command runs a real-browser smoke check.
7. Store listings, screenshots, permission justifications and a privacy
   policy exist and match what the code does.

## Non-goals

- New reading features, new voices, translations of the UI, Firefox for
  Android, a project website. (Option C; revisit after launch.)
- Changing the TTS engine, the model, or the vendored libraries.
- Automating store uploads (API publishing). Uploads are manual for now.

## Anti-goals

- Asking for broad site access "just in case". If a feature needs it, ask at
  the moment the user uses that feature.
- Any telemetry, analytics or account, even "anonymous".
- A welcome page that nags (multiple screens, sign-up, review begging).
- Store text that over-promises: the bundled voice is English-only and has
  documented pronunciation limits; the listing says so.

## Constraints

- One source tree; Firefox MV3 event page and Chrome MV3 service worker as
  today (`tools/build-chrome.mjs` produces the Chrome variant).
- Firefox add-on ID is permanent after the first AMO upload.
- Chrome Web Store rejects a `key` field in the uploaded manifest and needs a
  128 px icon.
- AMO reviewers diff vendored third-party files against their official
  releases; vendored files stay unmodified (CONTRIBUTING.md rule).
- Chrome offscreen documents get only `chrome.runtime`; an `AUDIO_PLAYBACK`
  document is closed by Chrome after ~30 s without audio.
- Store accounts (Chrome developer registration, one-time USD 5; AMO account)
  and the actual submit clicks belong to the owner.

## Approaches considered

- **A. Pass review, change little.** Blockers only (strip `key`, 128 px
  icon, ID, privacy policy, listing). Keeps `<all_urls>` and the pinned tab.
  Fastest, but every installer sees the all-sites warning, Chrome review is
  slower, and Chrome users get a pinned tab on every read.
- **B. Store-ready and right-sized. (Chosen.)** A plus offscreen audio,
  on-demand injection, permissions requested at point of use, welcome page,
  working shortcut, one release command with smoke check.
- **C. B plus growth extras** (site, UI translations, Android, localized
  listings). Deferred: the model is English-only, so translated UI would
  over-promise; better driven by real users after launch.

The owner picked **B** because strangers are the audience and first
impressions decide installs.

## Design

### 1. Permissions: nothing broad at install

Current: `host_permissions: ["<all_urls>"]` plus a content script declared
on `<all_urls>` in both manifests.

New:

- Remove the `content_scripts` entry from both manifests.
- Move `<all_urls>` from `host_permissions` to `optional_host_permissions`.
- Keep `activeTab`, `scripting`, `storage`, `menus`/`contextMenus`. Add
  `offscreen` on Chrome; remove `tabs` on Chrome (only the pinned tab needed
  it; verify nothing else does).
- Page reads (popup, context menu, shortcut) rely on the `activeTab` grant
  those gestures give. `extract()` already falls back to
  `scripting.executeScript`; it becomes the main path. Fix it to inject
  `compat/compat.js` first on Chrome (it is missing today, so the injected
  copy throws on `browser.*`).
- Features that fetch arbitrary origins ask at the moment of use, from the
  click handler (permission requests need a user gesture):
  - Reader workspace "Read page" (URL): request the URL's origin only
    (`https://host/*`), not `<all_urls>`.
  - "Use this model" with an HTTPS URL: request that origin (and the known
    redirect CDN for Hugging Face if the download redirects; builder to
    confirm the exact host list by testing).
  - "Use this endpoint": request the endpoint's origin.
  - If the user declines, show a plain message saying what was not allowed
    and why it is needed; nothing else breaks.
- When a request would succeed without the permission (CORS-enabled sites),
  it still asks once per origin for consistency. (Builder may simplify to
  "try, and ask only on a network/CORS failure" if that proves reliable in
  both browsers; either is acceptable.)
- Update `test/manifest.test.js`, README "Permissions", and CONTRIBUTING.

Effect on behavior: the mini-player, highlighting and keepalive arrive with
the injected content script exactly as today, since they only matter after
Read is pressed. Nothing depends on the script being present earlier (the
popup's selection check uses `executeScript`, which `activeTab` covers).

### 2. Chrome audio: offscreen document instead of a pinned tab

- **Spike first.** `chrome/audio-host.js` says offscreen documents "proved
  unreliable for script execution under automation"; nobody recorded what
  failed. Before converting, prove in a real (headed) Chrome that an
  offscreen document can run the engine Worker and play audio. If it
  cannot, stop and bring it back to the owner; do not silently keep the
  pinned tab. If it only misbehaves under automation, the smoke check
  (section 6) runs headed under Xvfb instead of headless.
- `background/engine-host.js`: replace `ensureDocument`/`closeDocument`
  (tab create/query/remove) with `chrome.offscreen.createDocument({ url:
  "chrome/audio-host.html", reasons: ["AUDIO_PLAYBACK"], justification:
  "Plays synthesized speech" })`, guarded by `chrome.runtime.getContexts`
  so only one exists. Rename the misleading `offscreen` flag (it currently
  means "use the host tab") to something like `useAudioHost`.
- `chrome/audio-host.*` stays the host page; drop tab-only UI text. Keep the
  hello + `tv-audio-host` port protocol.
- Re-evaluate pause/resume: in an offscreen document the AudioContext may be
  suspendable/resumable, which would let Chrome pause mid-sentence like
  Firefox. If it works, use it; if not, keep today's "resume replays the
  sentence" behavior.
- The ~30 s idle close is fine: `chrome-sw.js` already closes the host when
  idle, and a new read recreates it.
- Fix the Chrome custom-model path found during recon (to be confirmed with a
  failing test first): `HostWorker` sends the model `ArrayBuffer` over a
  JSON-serialized port, so it arrives as `{}`, and `spawnWorker` never
  posts `load` to the worker. Transfer the bytes in a port-safe form and
  forward the load message.
- README "Chrome / Chromium" section and `tools/chrome-e2e.mjs` comments
  updated.

### 3. First-run welcome page

- On `runtime.onInstalled` with `reason === "install"` (not on update), open
  `welcome/welcome.html` in a new tab.
- One screen, same visual language as the reader workspace (shared palette,
  light/dark). Content:
  1. A "Hear it" button that reads one sample sentence with the bundled
     voice (proves audio works; doubles as the first model load).
  2. Three ways to read: select text and right-click; toolbar button; the
     shortcut (showing the real binding read from `commands.getAll()`, with
     a link to the browser's shortcut settings).
  3. A pointer to the reader workspace for PDFs, ePubs, pasted text and URLs.
  4. One line on privacy: everything runs locally unless you add a remote
     endpoint.
- No sign-up, no review prompt, no further screens.

```
 ┌─────────────────────────────────────────────┐
 │  [icon] tiny reader                          │
 │  Read the web aloud, on your own machine.    │
 │                                              │
 │  [ ▶ Hear it ]   "Hello! This is tiny reader."│
 │                                              │
 │  Three ways to read                          │
 │   • Select text → right-click → Read …       │
 │   • Click the toolbar button                 │
 │   • Press Alt+Shift+R   (change shortcut)    │
 │                                              │
 │  PDFs, ePubs, pasted text → Open workspace   │
 │  Runs locally. No account, no tracking.      │
 └─────────────────────────────────────────────┘
```

### 4. Shortcut that works

- Default `Alt+Shift+R` in both manifests (Chrome already uses it; Firefox
  currently suggests `Ctrl+Alt+R`, which Linux Firefox reserves for Reader
  View). Builder verifies it is free in Firefox on Linux, Windows and macOS
  (on macOS it becomes Option+Shift+R); if it collides, pick another and
  record why.
- README and welcome page show the binding the browser actually assigned.

### 5. Packaging and release command

- `tools/build-chrome.mjs`:
  - Clean `dist/chrome` before copying.
  - Read `version` from `manifest.json` (single source of truth) instead of
    the hard-coded copy.
  - Keep the `key` field for local/e2e builds only; the store package omits
    it.
  - Add the 128 px icon (renderer already supports any size).
- New `tools/release.mjs` (one command, `node tools/release.mjs`):
  1. `node --test`
  2. `npx web-ext lint` on the Firefox tree
  3. build Chrome
  4. smoke check (section 6)
  5. write `dist/tiny-reader-firefox-<version>.zip` (exact path list as in
     the README checklist, plus `welcome/`) and
     `dist/tiny-reader-chrome-<version>.zip` (from `dist/chrome`, without
     `key`, without `manifest.firefox.json`)
  6. write `dist/tiny-reader-source-<version>.zip` for AMO's source upload
     (vendored files are unminified upstream releases, so this is mostly a
     courtesy; include `vendor/README.md` with exact versions).
  7. Fail loudly at the first failing step.

### 6. Smoke check (stops 68e793e-class bugs)

- Built on the raw-CDP approach `tools/chrome-e2e.mjs` already uses, against
  a system Chromium (`CHROME_BIN`), with the built Chrome package loaded as
  an extension. No Playwright, no `package.json`, no install step: the
  project keeps CONTRIBUTING's "no build step and no install step" promise.
  Headless if offscreen audio works headless; otherwise headed under Xvfb.
  The check: open the popup, the reader workspace and the welcome
  page; fail on any uncaught page error or console error; open a sample
  ePub, PDF and pasted text and assert a `readBlocks` round-trip starts
  playback state (status leaves `idle`); move the speed slider and assert
  the label changes.
- Firefox coverage stays with `web-ext lint` plus the existing geckodriver
  e2e suites (headed; run manually before a release, as documented).

### 7. Firefox specifics

- Add-on ID: `tiny-reader@disobey.dev` (permanent after first upload; owner's
  domain, so it cannot collide). Update `test/manifest.test.js`.
- `author`: "Aljaz Ceru" in both manifests.
- `data_collection_permissions`: keep `required: ["none"]`; declare the
  remote-endpoint transfer as user-initiated in the AMO review notes and
  privacy policy. If AMO asks, add `websiteContent` under `optional`.
- Reviewer notes file (`docs/store/amo-review-notes.md`): where each vendored
  file comes from (npm tarball + version), how to build, how to test the
  remote endpoint (mock server in `tools/chrome-e2e.mjs`).

### 8. Store listing material (in `docs/store/`)

- `listing.md`: name, one-line summary (≤132 chars for Chrome), full
  description, category (Chrome: Accessibility; AMO: Accessibility /
  Language Support), honest limits (English voice; remote endpoints for
  other languages/voices).
- `permissions.md`: one-sentence justification per permission, matching
  Chrome's dashboard fields (single purpose statement included).
- `PRIVACY.md` at the repository root, linked from both listings by its
  GitHub URL. The developer collects, receives and processes no data: no
  servers, no analytics, no accounts. Everything runs in the user's
  browser. Settings and imported models are stored locally in the browser.
  The only data that leaves the browser is what the user explicitly asks
  for: fetching a URL they enter, downloading a model URL they enter, and,
  only if they configure one, sending text and their API key straight from
  their browser to the TTS endpoint they chose (that service's own policy
  applies; it never passes through the developer).
- Support: GitHub issues (`https://github.com/aljazceru/tiny-reader/issues`)
  on both listings.
- Screenshots: 1280×800 PNGs (Chrome needs 1–5; AMO accepts the same):
  reading a page with the mini-player, the popup, the reader workspace, the
  welcome page. Chrome small promo tile 440×280. Produced by a script on the
  same CDP harness so they can be regenerated after UI changes.
- Store icon 128 px from `icons/icon.svg`.

### 9. Cleanups the recon found that ride along

- `content/content.js` header says "no manifest content_scripts"; after this
  change it becomes true again; keep it accurate.
- `tools/e2e.mjs` patches `<all_urls>` into the test xpi; keep that (the real
  manifest no longer grants it at install).
- `tools/chrome-e2e.mjs` stale "offscreen" comments become accurate.

## Decided by the owner

- Audience: strangers finding it in the stores; polish matters.
- Approach B.
- Firefox ID `tiny-reader@disobey.dev` (owner's domain).
- Publisher shown as "Aljaz Ceru"; support via GitHub issues.
- Privacy policy lives in the repo and states that no data is collected or
  processed by the developer.

## Calls made while writing this (check these)

- Offscreen audio gets a spike first; failure comes back to the owner.
- Smoke check and screenshots use the existing raw-CDP harness and a system
  Chromium, keeping the no-install promise, instead of Playwright.
- Repository must be public by launch so the privacy policy URL resolves.

## Left to the builder

- Exact Playwright setup and how the smoke check loads each browser.
- Ask-up-front vs ask-on-failure for optional origins (section 1).
- Whether offscreen pause can suspend instead of replay (section 2).
- File layout for `welcome/`, copy wording within the constraints above.
- Order of work, as long as each step keeps `node --test` green.

