/*
 * Integration test for PDF text extraction through reader/pdf.js (the exact
 * module the reader page imports). Runs on Node, where PDF.js automatically
 * uses its fake worker (no real Worker thread) and imports workerSrc — the
 * same file URL the module configures relative to import.meta.url. Proves:
 *
 *   - the vendored build works without any CDN at runtime,
 *   - both fixture pages are extracted, in reading order, with paragraph
 *     and page boundaries respected,
 *   - the document metadata title is used,
 *   - empty and malformed input rejects with a clear error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// PDF.js 6.x requires late-2025 runtimes. It calls, unguarded:
//   - Promise.try (Node 24+, Firefox 134+)
//   - Uint8Array.prototype.toHex (Node 24+, Firefox 133+)
//   - Map/WeakMap getOrInsert/getOrInsertComputed (Firefox 140+)
// Node 22 lacks all of them, so polyfill before the vendored module is
// evaluated — hence the dynamic import — and the fake worker path runs.
if (typeof Promise.try !== "function") {
  Promise.try = (fn, ...args) => Promise.resolve().then(() => fn(...args));
}
if (typeof Uint8Array.prototype.toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value() {
      let hex = "";
      for (const byte of this) hex += byte.toString(16).padStart(2, "0");
      return hex;
    },
  });
}
for (const Ctor of [Map, WeakMap]) {
  if (typeof Ctor.prototype.getOrInsert !== "function") {
    Ctor.prototype.getOrInsert = function (key, value) {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    };
  }
  if (typeof Ctor.prototype.getOrInsertComputed !== "function") {
    Ctor.prototype.getOrInsertComputed = function (key, callback) {
      if (!this.has(key)) this.set(key, callback(key));
      return this.get(key);
    };
  }
}

const { extractPdf } = await import("../reader/pdf.js");

const fixtureBytes = readFileSync(new URL("./fixtures/sample.pdf", import.meta.url));
const fixtureFile = () =>
  new File([fixtureBytes], "sample.pdf", { type: "application/pdf" });

test("extracts both pages in reading order with paragraph boundaries", async () => {
  const { title, blocks, pages } = await extractPdf(fixtureFile());
  assert.equal(title, "Sample PDF Fixture");
  assert.equal(pages, 2);
  assert.deepEqual(blocks, [
    "Reading PDF documents locally keeps private text private. " +
      "Extraction runs in the browser so nothing is uploaded anywhere.",
    "Every page yields text in its natural reading order for speech. " +
      "Paragraph boundaries are preserved for natural pauses.",
    "The second page continues the sample document with more sentences. " +
      "The reader walks each block in order and speaks it aloud.",
    "Validation confirms that both pages are extracted in order.",
  ]);
});

test("extracts the same text from a raw buffer input", async () => {
  const { blocks, pages } = await extractPdf(
    new Uint8Array(fixtureBytes.buffer, fixtureBytes.byteOffset, fixtureBytes.byteLength)
  );
  assert.equal(pages, 2);
  assert.equal(blocks.length, 4);
  assert.match(blocks[0], /^Reading PDF documents locally/);
});

test("rejects empty input with a clear error", async () => {
  await assert.rejects(
    extractPdf(new File([new Uint8Array(0)], "empty.pdf")),
    /No PDF file provided/
  );
  await assert.rejects(extractPdf(null), /No PDF file provided/);
});

test("rejects malformed PDFs with a clear error", async () => {
  const garbage = new TextEncoder().encode(
    "%PDF-1.4\nthis is not really a pdf at all, just noise\n"
  );
  await assert.rejects(
    extractPdf(new File([garbage], "broken.pdf")),
    /not a valid PDF file/
  );
  await assert.rejects(
    extractPdf(new File([new Uint8Array([1, 2, 3, 4, 5])], "truncated.pdf")),
    /not a valid PDF file|Failed to open PDF/
  );
});

test("caps extracted text at 500k characters", async () => {
  // A generated PDF whose text exceeds the cap must yield exactly 500k
  // characters of blocks, truncated at a block boundary. Lines stay inside
  // the page box (pdf.js drops glyphs positioned outside the viewBox), so
  // each line is one sentence and pages hold ~3k characters.
  const pages = 176;
  const sentence = "This filler sentence exists only to exceed the cap of the extractor.";
  const linesPerPage = 44;
  const leading = 16;
  const objs = new Map();
  objs.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = [];
  for (let p = 1; p <= pages; p++) kids.push(`${2 + p} 0 R`);
  objs.set(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`);
  for (let p = 1; p <= pages; p++) {
    objs.set(
      2 + p,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${3 + pages} 0 R >> >> ` +
        `/Contents ${3 + pages + p} 0 R >>`
    );
    const ops = ["BT", "/F1 10 Tf"];
    let y = 750;
    for (let i = 0; i < linesPerPage; i++) {
      // Td is relative to the previous line matrix: first line positions,
      // the rest advance by the constant leading.
      ops.push(i === 0 ? `40 ${y} Td` : "0 -16 Td");
      ops.push(`(${sentence}) Tj`);
      y -= 16;
    }
    ops.push("ET");
    const body = ops.join("\n");
    objs.set(
      3 + pages + p,
      `<< /Length ${body.length} >>\nstream\n${body}\nendstream`
    );
  }
  objs.set(3 + pages, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const chunks = ["%PDF-1.4\n"];
  const offsets = new Map();
  for (const [num, body] of [...objs.entries()].sort((a, b) => a[0] - b[0])) {
    offsets.set(num, chunks.join("").length);
    chunks.push(`${num} 0 obj\n${body}\nendobj\n`);
  }
  const xrefAt = chunks.join("").length;
  const n = objs.size + 1;
  let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (const [num] of [...objs.entries()].sort((a, b) => a[0] - b[0])) {
    xref += `${String(offsets.get(num)).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(
    xref,
    `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  );
  const big = new File([chunks.join("")], "big.pdf");

  const { blocks, pages: pageCount } = await extractPdf(big);
  assert.equal(pageCount, pages);
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  assert.equal(total, 500_000);
  assert.ok(blocks.every((block) => block.length > 0));
});
