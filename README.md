# tiny reader

tiny reader is a browser extension for Firefox and Chrome that reads
selected text, whole pages, pasted text, URLs, PDFs and ePubs aloud.
Speech is synthesized on your machine by the bundled tiny-voca model, or
by any OpenAI-compatible TTS endpoint you configure. No account, no
telemetry, and no network after install except for content, models, or
endpoints you explicitly fetch.

The bundled [tiny-voca](https://github.com/n4ze3m/tiny-voca) model is 8 MB
(Q8_0 GGUF, 4.5M parameters). The model and its dizione phonemizer run in
plain JavaScript — no ONNX, no WASM, no cloud runtime.

## Features

- **Selection or whole page**: select text and choose *Read selection*, or
  read the extracted article with Mozilla Readability. The current paragraph
  is highlighted and scrolled into view.
- **Floating mini-player**: every web-page read opens a draggable,
  collapsible Shadow-DOM player with previous/pause/next/stop, sentence
  progress and the current paragraph preview.
- **Reader workspace**: paste text, load TXT/HTML/PDF/ePub files, or enter
  an http(s) URL. Ctrl+Enter reads the pasted text; file selection starts
  immediately.
- **Per-site preferences**: voice and speed changes made during a web-page
  read are remembered for that hostname; direct reader inputs use the global
  defaults.
- **Speed control everywhere**: 0.5×–2.5× in 0.25 steps from the popup and
  reader workspace sliders and the mini-player's −/+ buttons, applied to the
  sentence being synthesized next.
- **Custom GGUF models**: the workspace's model section accepts a local GGUF
  or an http(s) model URL for other voices, languages, or fine-tunes. Models
  must be tiny-voca GGUFs with the embedded phonemizer; arbitrary GGUFs are
  rejected without replacing the working model. The active model and its
  speakers are validated in a fresh worker, persisted in IndexedDB, and
  restored across sessions.
- **Remote TTS endpoints**: instead of a local model, point the workspace's
  model section at an OpenAI-compatible `/audio/speech` endpoint
  (api.openai.com, Groq, openedai-speech, Kokoro-FastAPI, …). The endpoint
  is validated with one short request, voices and speed pass through, and
  the API key stays in local browser storage. Endpoints without CORS
  headers need the extension's site-access permission granted.

The bundled English model provides M2 (male) and F2 (female), at 24 kHz;
speed is adjustable from 0.5× to 2.5× (remote endpoints accept their own
wider range). tiny-voca's English pronunciation has the limits documented
upstream, including guesses for foreign names and unusual spellings.

## Install

1. Open `about:debugging#/runtime/this-firefox`
2. Click *Load Temporary Add-on…* and select the extension's `manifest.json`

The add-on stays loaded until Firefox restarts. A permanent install needs a
signed package (see the release checklist); release Firefox refuses
unsigned add-ons.

First install opens a short welcome page with a "Hear it" button and the
three ways to read.

## Chrome / Chromium

The same tree builds for Chrome MV3, where the background is a service
worker and audio plays through an offscreen document (Chrome has no event
pages, and service workers have no Web Audio):

```bash
node tools/build-chrome.mjs           # → dist/chrome
chromium --load-extension=dist/chrome # or load unpacked via chrome://extensions
```

Everything except the audio/engine host is shared verbatim; `compat/compat.js`
maps `browser` to `chrome` for Chrome pages. One Chrome-specific behavior:
the synthesis worker and audio player run in an offscreen document created
with the `AUDIO_PLAYBACK` reason, so pause/resume suspend and resume the
AudioContext exactly like on Firefox, and no tab ever appears.


## Usage

- **Toolbar popup** — selection-first page reading, transport controls,
  voice/speed, and *Open reader workspace*.
- **Right-click** — *Read selection with tiny reader* / *Read whole page
  with tiny reader*.
- **Keyboard** — `Alt+Shift+S` toggles *Read the selection (or the page)
  aloud / pause*. Rebind it under `about:addons` → gear icon → *Manage
  Extension Shortcuts* (Firefox) or `chrome://extensions/shortcuts` (Chrome).

Playback starts after the first sentence is synthesized, so long inputs
don't wait for the whole text.

## Privacy

Local reads stay local: text you read and your preferences never leave the
machine. The extension makes network requests only when you ask it to: fetching an http(s) URL you paste into the workspace, downloading
a custom model URL you provide, or — if you configure a remote TTS
endpoint — sending each sentence to that endpoint (with your API key).
There is no analytics, no telemetry, and no background upload. The full
policy is in [PRIVACY.md](PRIVACY.md).

## Architecture

```
manifest.json            MV3, non-persistent event page, Firefox 140+
background/background.js shared job path, runtime APIs, models,
                         site preferences, popup/menu/command routing,
                         remote-endpoint synthesis pump
background/player.js     gapless Web Audio player (pause = context suspend)
background/engine-host.js worker+player in the page (Firefox) or in the
                         Chrome offscreen document, behind one interface
background/chrome-sw.js  Chrome service worker bootstrap (importScripts)
engine/engine-worker.mjs module worker: model loading/validation, sentence
                         planning, flow-controlled synthesis
content/content.js       selection/page extraction, highlight, keepalive,
                         floating mini-player
reader/                  full-page workspace, URL/HTML/PDF/ePub extraction,
                         model management
logic/                   pure resampling, remote-TTS helpers, model
                         store, preference helpers
chrome/audio-host.*    Chrome offscreen audio document (engine worker + player)
compat/compat.js         `browser` ← `chrome` shim for Chrome pages
vendor/                  tiny-voca engine, Readability, PDF.js, fflate
assets/tiny-voca.gguf    bundled model + phonemizer data
popup/                   toolbar controller and workspace entry
test/                    node:test suites and PDF/ePub/article fixtures
tools/e2e.mjs            page/selection/mini-player browser E2E
tools/reader-e2e.mjs     workspace/model browser E2E
tools/build-chrome.mjs   dist/chrome build (Chrome manifest + PNG icons)
tools/fetch-model.mjs    re-download the bundled GGUF
```

The worker posts each sentence as a `Float32Array` at 24 kHz (remote
endpoints: audio decoded from what the server returns). The player
resamples to the device rate, schedules buffers back-to-back, and reports
true completion through `onended`. Progress, paragraph highlighting, the
look-ahead window and end of reading follow actual audio, not synthesis.

Firefox unloads idle MV3 event pages but keeps them loaded while message
ports are open. The reading tab (content script or reader workspace) holds a
`tv-keepalive` port; closing or navigating the tab stops playback cleanly.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the page you explicitly activate through the toolbar, context menu or shortcut. |
| `scripting` | Inject the extractor if it is not already present. |
| `menus` / `contextMenus` | Selection and page context-menu entries. |
| `storage` | Global and per-site voice/speed preferences, endpoint settings. |
| `offscreen` (Chrome only) | Play audio from an offscreen document; Chrome service workers have no Web Audio. |
| `optional_host_permissions: <all_urls>` | No site access at install. When a feature fetches another site — a page URL you enter, a model URL you download, a remote endpoint — the extension asks for just that site at that moment. |

Model bytes are stored locally in IndexedDB. Text you read is never
stored. Firefox **140 or newer** is required by the bundled PDF.js runtime.

## Development and tests

Unit tests and lint (no install step; plain `node --test` covers both the
CommonJS `.js` and ESM `.mjs` suites):

```bash
node --test        # extraction, PDF/ePub, preferences, player, real model synthesis
npx web-ext lint   # manifest + addon-linter checks
```

Browser end-to-end suites (each script's header lists its prerequisites and
environment variables):

- `tools/e2e.mjs` — page reading, selection, highlight, keepalive and the
  mini-player in a real Firefox.
- `tools/reader-e2e.mjs` — reader workspace paste, URL, PDF, ePub, custom
  model import and invalid-model rejection in a real Firefox.
- `tools/chrome-e2e.mjs` — the Chrome build over CDP, including a remote
  TTS endpoint against a built-in mock server.
- `tools/smoke.mjs` — release smoke check: the built Chrome extension in
  headless Chromium, failing on any page error while the reader's inputs
  are exercised.

## Release checklist

1. Update the version in `manifest.json`.
2. Run the release pipeline — unit tests, `web-ext lint`, both Chrome
   builds, the real-browser smoke check, and packaging; it stops at the
   first failing step:

   ```bash
   node tools/release.mjs
   ```

   It leaves `tiny-reader-firefox-<version>.zip`,
   `tiny-reader-chrome-<version>.zip` (the store build) and
   `tiny-reader-source-<version>.zip` in `dist/`.
3. Tag the release, e.g. `git tag -a v1.0.0 -m "tiny reader 1.0.0"`.
4. Upload `tiny-reader-firefox-<version>.zip` to
   [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing
   (listed or self-distributed); the signed file installs permanently.
5. Upload `tiny-reader-chrome-<version>.zip` to the
   [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole),
   attaching `tiny-reader-source-<version>.zip` if review asks for sources.

## Attribution

- [tiny-voca](https://github.com/n4ze3m/tiny-voca) by n4ze3m — Apache License
  2.0. The upstream `js/` engine and phonemizer are vendored unchanged;
  `assets/tiny-voca.gguf` is the upstream `gguf/tiny-voca-js.gguf`
  ([weights](https://huggingface.co/n4ze3m/tiny-voca) on Hugging Face).
  Re-download with `node tools/fetch-model.mjs`.
- [Readability](https://github.com/mozilla/readability) by Mozilla/Arc90 —
  Apache License 2.0, `vendor/readability.js` unchanged.
- [PDF.js](https://github.com/mozilla/pdf.js) by Mozilla — Apache License
  2.0, `vendor/pdf.mjs` and `vendor/pdf.worker.mjs` from pdfjs-dist 6.5.438.
- [fflate](https://github.com/101arrowz/fflate) by 101arrowz — MIT,
  `vendor/fflate.js` unchanged.

See `NOTICE`, `vendor/README.md` for exact versions and sources, and
`CONTRIBUTING.md` for the rules on touching vendored files.
