# AMO review notes

Notes for the addons.mozilla.org reviewer of `tiny-reader@disobey.dev`.

## Data collection

The extension collects no data; `data_collection_permissions.required`
in `manifest.json` is `["none"]`. Its only network requests are
user-initiated:

- fetching a page URL the user enters in the reader workspace,
- downloading a voice model from a URL the user enters, and
- only if the user configures a remote TTS endpoint (off by default),
  sending each sentence being read — with the user's API key, if one was
  entered — from the user's browser to that endpoint.

The endpoint is configured by and points at a service chosen by the
user; nothing goes to the developer. Access to a site is requested per
origin at the moment of use (`optional_host_permissions`, see
`reader/permissions.js`). GGUF models are data files, not remote code.

## Vendored third-party files

Every file under `vendor/` is an unmodified upstream release
(`vendor/README.md` has the same table); reviewers can diff against the
archives below.

| File(s) | Upstream | Version | Archive to diff against |
| --- | --- | --- | --- |
| `vendor/tiny-voca.js`, `vendor/text.js`, `vendor/dizione/` | [n4ze3m/tiny-voca](https://github.com/n4ze3m/tiny-voca) `js/` | git `15a36ab` | https://github.com/n4ze3m/tiny-voca/archive/15a36ab.tar.gz |
| `vendor/readability.js` | `@mozilla/readability` | 0.6.0 | https://registry.npmjs.org/@mozilla/readability/-/readability-0.6.0.tgz |
| `vendor/pdf.mjs`, `vendor/pdf.worker.mjs` | `pdfjs-dist` | 6.5.438 | https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz |
| `vendor/fflate.js` | `fflate` | 0.8.2 | https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz |

`assets/tiny-voca.gguf` is the upstream `gguf/tiny-voca-js.gguf` from
<https://huggingface.co/n4ze3m/tiny-voca>: model weights plus the
phonemizer tables, a data file.

## How to build

No dependencies and no install step; Node.js only:

    node tools/release.mjs

This runs `node --test`, `npx web-ext lint`, builds the Chrome variant,
runs a real-browser smoke check and writes the packages into `dist/` —
`tiny-reader-firefox-<version>.zip` is the submitted package and
`tiny-reader-source-<version>.zip` the matching source archive
(`node tools/package.mjs` repackages without rerunning the checks).

## Testing

Everything works offline: open the reader workspace (from the toolbar
popup), paste text and press Read — the bundled English voice is in the
package. On a web page, select text and use the right-click menu.

The remote-endpoint feature is optional. To exercise it:

- `tools/chrome-e2e.mjs` has a built-in mock OpenAI-compatible
  `/audio/speech` server on `127.0.0.1:8130`; running the script
  configures it as the remote model and reads through it, or
- in the reader workspace's model section, enter a name, endpoint URL
  and API key for any OpenAI-compatible TTS endpoint (a local
  openedai-speech or Kokoro-FastAPI instance works) and press
  "Use this endpoint".
