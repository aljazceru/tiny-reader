// PDF text extraction for the reader page, backed by the vendored Mozilla
// PDF.js build (Apache-2.0, https://github.com/mozilla/pdf.js,
// pdfjs-dist@6.5.438 — see vendor/pdf.mjs for the license notice).
//
// Contract: export async function extractPdf(file) -> { title, blocks, pages }
// - `blocks` are paragraphs in natural reading order (page by page, line by
//   line), never merged across page boundaries.
// - `pages` is the page count of the whole document.
// - `title` is the document metadata title, falling back to the file name
//   without extension.

import {
  GlobalWorkerOptions,
  getDocument,
  InvalidPDFException,
  PasswordException,
} from "../vendor/pdf.mjs";

// Same-origin relative to this module, so it works from the extension page
// (moz-extension://…/reader/reader.html) and in Node (file://…/vendor/…),
// where PDF.js runs a fake worker by importing workerSrc.
GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdf.worker.mjs",
  import.meta.url
).href;

const MAX_CHARS = 500_000;
// A vertical jump larger than this multiple of the page's line leading starts
// a new paragraph (blank-line-free PDFs still get paragraph boundaries).
const PARAGRAPH_GAP = 1.6;
// Horizontal gaps larger than this fraction of the font height between two
// text items mean a word boundary; smaller gaps are words split across runs.
const SPACE_GAP = 0.12;
// Baselines within this epsilon belong to the same text line.
const BASELINE_EPSILON = 0.5;

function fallbackTitle(file) {
  const name =
    typeof file?.name === "string" && file.name.trim()
      ? file.name.trim()
      : "";
  if (name) {
    const base = name.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    if (base) return base;
  }
  return "Untitled document";
}

function collapseSpaces(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Turn a page's text items into { text, y, height } lines. Items within a
// line are joined directly (words are often split across runs); a space is
// inserted when the horizontal gap says a word boundary was positioned but
// not encoded.
function pageLines(textContent) {
  const lines = [];
  let line = null;

  const closeLine = () => {
    const text = collapseSpaces(line?.text ?? "");
    if (text) {
      lines.push({ text, y: line.y, height: line.height });
    }
    line = null;
  };

  for (const item of textContent.items) {
    if (typeof item.str !== "string") continue; // marked-content markers
    const x = item.transform[4];
    const y = item.transform[5];
    const height = item.height || 0;

    if (line && Math.abs(line.y - y) > BASELINE_EPSILON) closeLine();

    if (!line) {
      line = { text: "", x, y, endX: x, height };
    } else {
      const refHeight = Math.max(line.height, height) || 10;
      const gap = x - line.endX;
      if (
        gap > SPACE_GAP * refHeight &&
        line.text.length > 0 &&
        !/\s$/.test(line.text) &&
        !/^\s/.test(item.str)
      ) {
        line.text += " ";
      }
    }

    line.text += item.str;
    line.height = Math.max(line.height, height);
    line.endX = x + (item.width || 0);
    if (item.hasEOL) closeLine();
  }
  closeLine();
  return lines;
}

// Group a page's lines into paragraphs: blank gaps (whitespace-only lines are
// already dropped) and vertical jumps break paragraphs; lines otherwise join.
function pageParagraphs(lines) {
  if (lines.length === 0) return [];

  // The smallest positive baseline step on the page is the line leading.
  let leading = 0;
  for (let i = 1; i < lines.length; i++) {
    const step = lines[i - 1].y - lines[i].y;
    if (step > BASELINE_EPSILON && (leading === 0 || step < leading)) {
      leading = step;
    }
  }

  const paragraphs = [];
  let current = null;
  let prevY = null;
  for (const lineItem of lines) {
    if (
      current !== null &&
      leading > 0 &&
      Math.abs(prevY - lineItem.y) > PARAGRAPH_GAP * leading
    ) {
      current = null;
    }
    if (current === null) {
      current = [];
      paragraphs.push(current);
    }
    current.push(lineItem.text);
    prevY = lineItem.y;
  }
  return paragraphs.map((parts) => parts.join(" ").trim()).filter(Boolean);
}

export async function extractPdf(file) {
  let data;
  if (typeof file?.arrayBuffer === "function") {
    data = new Uint8Array(await file.arrayBuffer());
  } else if (file instanceof ArrayBuffer) {
    data = new Uint8Array(file);
  } else if (ArrayBuffer.isView(file)) {
    data = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  } else {
    throw new Error("No PDF file provided.");
  }
  const title = fallbackTitle(file);
  if (data.length === 0) {
    throw new Error(`No PDF file provided: "${title}" is empty.`);
  }

  const loadingTask = getDocument({ data, isEvalSupported: false });
  let pdf;
  try {
    try {
      pdf = await loadingTask.promise;
    } catch (err) {
      if (err instanceof PasswordException) {
        throw new Error(
          `PDF "${title}" is password-protected and cannot be read.`
        );
      }
      if (err instanceof InvalidPDFException) {
        throw new Error(`"${title}" is not a valid PDF file (${err.message}).`);
      }
      throw new Error(`Failed to open PDF "${title}": ${err.message}`);
    }

    let metaTitle = "";
    try {
      const meta = await pdf.getMetadata();
      metaTitle = collapseSpaces(meta.info?.Title ?? "");
    } catch {
      // Malformed metadata must not block extraction.
    }
    const docTitle = metaTitle || title;

    const pages = pdf.numPages;
    const blocks = [];
    let total = 0;
    let truncated = false;

    for (let pageNum = 1; pageNum <= pages && !truncated; pageNum++) {
      let textContent;
      try {
        const page = await pdf.getPage(pageNum);
        textContent = await page.getTextContent();
      } catch (err) {
        throw new Error(
          `Failed to extract text from page ${pageNum} of "${docTitle}": ${err.message}`
        );
      }
      for (const paragraph of pageParagraphs(pageLines(textContent))) {
        if (total + paragraph.length > MAX_CHARS) {
          blocks.push(paragraph.slice(0, MAX_CHARS - total));
          truncated = true;
          break;
        }
        blocks.push(paragraph);
        total += paragraph.length;
      }
    }

    if (blocks.length === 0) {
      throw new Error(
        `No text found in "${docTitle}" — it may be a scanned document.`
      );
    }
    return { title: docTitle, blocks, pages };
  } finally {
    await loadingTask.destroy();
  }
}
