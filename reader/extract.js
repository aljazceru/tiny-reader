/*
 * tiny reader — text extraction for the reader workspace.
 *
 * Pure helpers shared by the reader tab: plain text and HTML are turned
 * into the same "blocks" (paragraph-sized strings) the background reads
 * directly. HTML goes through the vendored Readability first and falls
 * back to a walk over visible block elements when a page resists article
 * extraction. URL fetches send no credentials and no cookies.
 */

"use strict";

/* global Readability */

/* Longest input accepted, matching the background's cap on direct reads. */
export const MAX_CHARS = 500000;

const PRONOUNCEABLE = /[\p{L}\p{N}]/u;
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i;
const SKIP_TAGS = /^(script|style|template|noscript|head|title|select|datalist|svg)$/i;
const BLOCK_SELECTOR =
  "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dd,dt,figcaption,td,th";

/* Blank-line-aware paragraphs: normalise line endings, keep single line
 * breaks inside a block, collapse all whitespace, drop blocks with nothing
 * pronounceable (rules, separators, page furniture) and cap the input. */
export function blocksFromText(text) {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").slice(0, MAX_CHARS);
  return raw
    .split(/\n\s*\n/) // a blank line (or a run of them) starts a new block
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => PRONOUNCEABLE.test(block));
}

/* True if the element or any ancestor hides it inline (works on documents
 * that were never rendered, where getComputedStyle is unavailable). */
function hiddenBy(element) {
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return true;
    if (HIDDEN_STYLE.test(node.getAttribute("style") || "")) return true;
    if (SKIP_TAGS.test(node.localName)) return true;
  }
  return false;
}

/* Last-resort extraction: every visible block element in document order,
 * skipping blocks already covered by a collected ancestor (nested lists). */
function visibleBlocks(doc) {
  const blocks = [];
  const taken = new Set();
  for (const element of doc.querySelectorAll(BLOCK_SELECTOR)) {
    if (hiddenBy(element)) continue;
    let covered = false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (taken.has(parent)) { covered = true; break; }
    }
    if (covered) continue;
    const text = (element.textContent || "").replace(/\s+/g, " ").trim();
    if (PRONOUNCEABLE.test(text)) {
      taken.add(element);
      blocks.push(text);
    }
  }
  return blocks;
}

/* Parse HTML into { title, blocks }: Readability first; if the article pass
 * comes up empty (or suspiciously thin), the visible-block fallback decides.
 * article.textContent runs paragraphs together, so blocks come from walking
 * block elements — of the cleaned article when possible, of the original
 * document otherwise. `url` is optional and lets Readability resolve
 * relative links. */
export function extractHtml(html, url) {
  const source = String(html ?? "");
  const doc = new DOMParser().parseFromString(source, "text/html");
  if (url) {
    try {
      const base = doc.createElement("base");
      base.href = url;
      doc.head.prepend(base);
    } catch { /* odd scheme; Readability simply keeps about:blank */ }
  }

  let title = "";
  let blocks = [];
  try {
    const article = new Readability(doc).parse();
    if (article && (article.textContent || "").replace(/\s+/g, " ").trim().length >= 240) {
      const rendered = new DOMParser().parseFromString(String(article.content || ""), "text/html");
      const parsed = blocksFromText(visibleBlocks(rendered).join("\n\n"));
      if (parsed.length) {
        blocks = parsed;
        title = String(article.title || "").trim();
      }
    }
  } catch { /* Readability is best effort */ }

  if (blocks.join("").length < 200) {
    const plain = new DOMParser().parseFromString(source, "text/html"); // Readability mutated the first doc
    const fallback = blocksFromText(visibleBlocks(plain).join("\n\n"));
    if (fallback.join("").length > blocks.join("").length) {
      blocks = fallback;
      if (!title) title = (plain.querySelector("title")?.textContent || "").trim();
    }
  }

  if (!blocks.length) throw new Error("No readable text found on this page.");
  if (!title) title = (doc.querySelector("title")?.textContent || "").trim();
  return { title, blocks };
}

/* Fetch a web page without credentials or cookies, then extract it. */
export async function extractUrl(url) {
  let candidate = String(url || "").trim();
  if (candidate && !/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
  let target;
  try {
    target = new URL(candidate);
  } catch {
    throw new Error("That does not look like a URL.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only http(s) pages can be fetched.");
  }

  let response;
  try {
    response = await fetch(target.href, { credentials: "omit", redirect: "follow" });
  } catch (error) {
    throw new Error(`Could not fetch the page: ${(error && error.message) || error}`);
  }
  if (!response.ok) throw new Error(`The page answered HTTP ${response.status}.`);
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (/^(image|audio|video)\//.test(type) || /(pdf|zip|octet-stream)/.test(type)) {
    throw new Error(`The page is ${type.split(";")[0] || "binary"}, not text.`);
  }
  return extractHtml(await response.text(), target.href);
}
