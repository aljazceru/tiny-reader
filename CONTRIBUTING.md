# Contributing to tiny reader

Thanks for contributing! This file covers the local setup and the
expectations for patches. The product is **tiny reader**; the bundled speech
model stays named tiny-voca.

## Local development

No build step and no install step: the extension is plain HTML/JS/CSS plus
vendored libraries and the bundled model. Node.js (18+) is needed for the
test suites and tools.

```bash
git clone <your fork>
cd tiny-reader
node --test        # unit tests (extraction, PDF/ePub, prefs, player, remote TTS, model)
npx web-ext lint   # manifest + addon-linter checks
node tools/build-chrome.mjs   # optional: dist/chrome build for Chromium
```

To try it by hand: `about:debugging#/runtime/this-firefox` → *Load Temporary
Add-on…* → pick `manifest.json`. See the README's Install section for
details.

## Browser end-to-end tests

`tools/e2e.mjs` and `tools/reader-e2e.mjs` drive a real Firefox through
geckodriver. Prerequisites:

- a Firefox binary (default `/tmp/e2e/firefox/firefox`, override with
  `FIREFOX_BIN`),
- geckodriver (e.g. `npm i --prefix /tmp/e2e geckodriver`,
  `GECKODRIVER_BIN` to override),
- a packaged extension (`XPI_PATH`), built with:
  `zip -qr /tmp/e2e/tiny-reader.xpi manifest.json background engine vendor content popup reader logic icons assets`,
- `python3 -m http.server 8123` run from `test/fixtures` (article fixture),
- additionally for `tools/reader-e2e.mjs`: the extension directory served on
  port 8124 (`python3 -m http.server 8124` from the checkout root).

Each script's header comment documents its environment variables and the
test-only xpi patches it applies (never shipped).

## Pull requests

- Add or extend tests for changed logic in `logic/`, `background/`,
  `engine/`, `reader/`, or `content/`; `node --test` must stay green, and
  `npx web-ext lint` must pass.
- Keep permissions minimal: do not add permissions or host permissions
  beyond what a feature strictly needs (`test/manifest.test.js` enforces
  this).
- Never modify vendored files (`vendor/`, `assets/tiny-voca.gguf`). If an
  upgrade is genuinely needed, propose it separately and update
  `vendor/README.md`, `NOTICE`, and the README attribution together.
- Keep reads local by default: no telemetry, no third-party requests beyond
  user-requested URL/model fetches and the remote TTS endpoint the user
  explicitly configures.
