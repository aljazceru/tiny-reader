# tiny reader

tiny reader is a local, open-source answer to [ElevenReader](https://elevenreader.io/):
the reading experience — selected text or whole pages, pasted text, URLs,
PDFs and ePubs — with speech synthesized on your machine by the bundled
tiny-voca model, or by any OpenAI-compatible TTS endpoint you configure.
No account, no telemetry, and no network after install except for content,
models, or endpoints you explicitly fetch.

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
- **Library and queue**: save the current input or browser tab (up to 50
  articles), read/delete saved entries, and queue several for automatic
  sequential playback.
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

### Temporary (for development)

1. Open `about:debugging#/runtime/this-firefox`
2. Click *Load Temporary Add-on…* and select the extension's `manifest.json`

The add-on stays loaded until Firefox restarts.

### Permanent

```bash
npx web-ext build
```

Then in `about:addons`: gear icon → *Install Add-on From File…* and pick the
built `.zip`/`.xpi`. There is no signing or build step; models and libraries
are bundled. See the release checklist below for the exact packaging command.

## Chrome / Chromium

The same tree builds for Chrome MV3, where the background is a service
worker and audio plays through a pinned audio-host tab (Chrome has no event
pages, and service workers have no Web Audio):

```bash
node tools/build-chrome.mjs           # → dist/chrome
chromium --load-extension=dist/chrome # or load unpacked via chrome://extensions
```

Everything except the audio/engine host is shared verbatim; `compat/compat.js`
maps `browser` to `chrome` for Chrome pages. Two Chrome-specific behaviors:
pause stops the current sentence and resume replays it (the audio-host tab
has no user activation, so a suspended AudioContext could not resume), and
the pinned audio-host tab appears while anything is being read — closing it
stops playback.


## Usage

- **Toolbar popup** — selection-first page reading, transport controls,
  voice/speed, and *Open reader workspace*.
- **Right-click** — *Read selection with tiny reader* / *Read whole page
  with tiny reader*.
- **Ctrl+Alt+R** — reads the selection if there is one, else the page;
  pauses and resumes when already reading. Rebind in Firefox's extension
  settings.

Sentence-at-a-time streaming starts playback before a long input is fully
synthesized. A 12-sentence look-ahead keeps memory bounded, and a keepalive
port prevents Firefox from unloading the event page during long reads.

## Privacy

Local reads stay local: text you read, your library, and your preferences
never leave the machine. The extension makes network requests only when you
ask it to: fetching an http(s) URL you paste into the workspace, downloading
a custom model URL you provide, or — if you configure a remote TTS
endpoint — sending each sentence to that endpoint (with your API key).
There is no analytics, no telemetry, and no background upload.

## Architecture

```
manifest.json            MV3, non-persistent event page, Firefox 140+
background/background.js shared job path, runtime APIs, queue, models,
                         site preferences, popup/menu/command routing,
                         remote-endpoint synthesis pump
background/player.js     gapless Web Audio player (pause = context suspend)
background/engine-host.js worker+player in the page (Firefox) or in the
                         Chrome audio-host tab, behind one interface
background/chrome-sw.js  Chrome service worker bootstrap (importScripts)
engine/engine-worker.mjs module worker: model loading/validation, sentence
                         planning, flow-controlled synthesis
content/content.js       selection/page extraction, highlight, keepalive,
                         floating mini-player
reader/                  full-page workspace, URL/HTML/PDF/ePub extraction,
                         library and model management
logic/                   pure resampling, remote-TTS helpers, library,
                         model store, preference helpers
chrome/audio-host.*    Chrome audio-host tab (engine worker + player)
compat/compat.js         `browser` ← `chrome` shim for Chrome pages
vendor/                  tiny-voca engine, Readability, PDF.js, fflate
assets/tiny-voca.gguf    bundled model + phonemizer data
popup/                   toolbar controller and workspace entry
test/                    node:test suites and PDF/ePub/article fixtures
tools/e2e.mjs            page/selection/mini-player browser E2E
tools/reader-e2e.mjs     workspace/library/model browser E2E
tools/build-chrome.mjs   dist/chrome build (Chrome manifest + PNG icons)
tools/fetch-model.mjs    re-download the bundled GGUF
```

The worker posts each sentence as a `Float32Array` at 24 kHz (remote
endpoints: audio decoded from what the server returns). The player
resamples to the device rate, schedules buffers back-to-back, and reports
true completion through `onended`. Progress, paragraph highlighting, the
look-ahead window and queue advancement follow actual audio, not synthesis.

Firefox unloads idle MV3 event pages but keeps them loaded while message
ports are open. The reading tab (content script or reader workspace) holds a
`tv-keepalive` port; closing or navigating the tab stops playback cleanly.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the page you explicitly activate through the toolbar, context menu or shortcut. |
| `scripting` | Inject the extractor if it is not already present. |
| `menus` | Selection and page context-menu entries. |
| `storage` | Library, queue, global and per-site voice/speed preferences. |
| `host_permissions: <all_urls>` | Reader-workspace URL extraction and model downloads you explicitly request; content extraction on the page being read. No analytics or background upload. |

Model bytes are stored locally in IndexedDB. Article text and library data
stay in extension storage. Firefox **140 or newer** is required by the
bundled PDF.js runtime (`strict_min_version: 140.0` in the manifest).

## Development and tests

Unit tests and lint (no install step; plain `node --test` covers both the
CommonJS `.js` and ESM `.mjs` suites):

```bash
node --test        # extraction, PDF/ePub, library, preferences, player, real model synthesis
npx web-ext lint   # manifest + addon-linter checks
```

End-to-end through a real Firefox (geckodriver):

```bash
mkdir -p /tmp/e2e && cd /home/you/tiny-reader   # the extension checkout
zip -qr /tmp/e2e/tiny-reader.xpi manifest.json background engine vendor content popup reader logic icons assets
npm i --prefix /tmp/e2e geckodriver             # /tmp/e2e/node_modules/geckodriver
# a Firefox build reachable as /tmp/e2e/firefox/firefox, or set FIREFOX_BIN
cd test/fixtures && python3 -m http.server 8123 &
cd ../.. && python3 -m http.server 8124 &       # extension dir for module E2E
XPI_PATH=/tmp/e2e/tiny-reader.xpi node tools/e2e.mjs
XPI_PATH=/tmp/e2e/tiny-reader.xpi node tools/reader-e2e.mjs
node tools/build-chrome.mjs && node tools/chrome-e2e.mjs   # Chromium, CDP
```

Prerequisites: a Firefox binary (`FIREFOX_BIN`), geckodriver
(`GECKODRIVER_BIN`), the packaged extension (`XPI_PATH`), the fixture server
on port 8123, and — for `tools/reader-e2e.mjs` — the extension directory
served on port 8124. See the header of each script for the full environment
variables and what is asserted.

`tools/e2e.mjs` covers page reading, selection, follow-along highlight,
keepalive, and the floating mini-player. `tools/reader-e2e.mjs` covers paste,
URL, PDF, ePub, saved-library queue auto-advance, custom model import and
invalid-model rejection. `tools/chrome-e2e.mjs` drives the Chrome build
through raw CDP (bundled model through the audio-host tab, speed
slider, pause/resume, and a remote TTS endpoint against a built-in mock
server; no test hooks, `CHROME_BIN` to override the binary — it runs headed
because headless Chrome freezes the Web Audio clock, so a `DISPLAY` is
needed). The Firefox
harnesses patch the test-only xpi (documented in each script, never
shipped) because automation cannot grant `activeTab` or execute inside
`moz-extension` pages.

## Release checklist

1. Update the version in `manifest.json`.
2. `node --test` and `npx web-ext lint` pass.
3. `node tools/e2e.mjs` and `node tools/reader-e2e.mjs` pass against a real
   Firefox.
4. Tag the release, e.g. `git tag -a v1.0.0 -m "tiny reader 1.0.0"`.
5. Package from the extension root (nothing outside these paths ships):

   ```bash
   zip -r tiny-reader.xpi manifest.json background engine vendor content popup reader logic icons assets
   ```

6. Optional: upload `tiny-reader.xpi` to
   [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing
   and distribution on AMO.

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
