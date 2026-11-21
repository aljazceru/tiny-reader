# Vendored third-party code

| Path | Source | License |
| --- | --- | --- |
| `tiny-voca.js`, `text.js`, `dizione/` | [n4ze3m/tiny-voca](https://github.com/n4ze3m/tiny-voca) `js/` directory, upstream revision `15a36ab` | Apache-2.0 (see `LICENSE-tiny-voca`) |
| `readability.js` | [mozilla/readability](https://github.com/mozilla/readability) `@mozilla/readability@0.6.0`, single-file build | Apache-2.0 (header in file) |
| `pdf.mjs`, `pdf.worker.mjs` | [mozilla/pdf.js](https://github.com/mozilla/pdf.js), `pdfjs-dist@6.5.438` from unpkg, unmodified | Apache-2.0 (headers in files) |
| `fflate.js` | [101arrowz/fflate](https://github.com/101arrowz/fflate) 0.8.2 ESM browser build, unmodified | MIT (header in file) |

`../assets/tiny-voca.gguf` is the upstream `gguf/tiny-voca-js.gguf`
([Hugging Face](https://huggingface.co/n4ze3m/tiny-voca)): the Q8_0-quantized
model plus the phonemizer dictionary and tables, one file.
