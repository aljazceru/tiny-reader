/*
 * tiny reader — ePub extraction.
 *
 * extractEpub(file) unpacks an EPUB (a ZIP archive) with the vendored fflate
 * (MIT), follows META-INF/container.xml to the package document (OPF), and
 * walks the manifest/spine to produce reading-order text:
 *
 *   { title, blocks: string[], chapters }
 *
 * `blocks` are collapsed plain-text paragraphs, headings, list items, … in
 * spine order — the same visible-block semantics as the page reader in
 * content/content.js: outermost blocks only, script/style/nav/aside/footer/
 * header/form and hidden markup stripped, capped at 500k characters.
 * `chapters` records where each spine document contributed:
 *
 *   { title, href, index, count }
 *
 * Clear errors are thrown for data that is not a ZIP, not an EPUB (missing
 * container.xml, package document or spine), or has no readable text.
 */

import { unzipSync } from "../vendor/fflate.js";

const CHAR_CAP = 500000;
const CONTAINER_PATH = "META-INF/container.xml";
const X_MEDIA_TYPES = new Set(["application/xhtml+xml", "text/html"]);
const NAV_PROPERTIES = /(?:^|\s)nav(?:\s|$)/; // EPUB 3 navigation document

/* The same block vocabulary as the page reader (content/content.js). */
const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "figcaption", "dd", "dt"]);
/* Markup that never contributes readable text. */
const SKIP = new Set(["script", "style", "head", "title", "meta", "link", "template", "svg", "nav", "aside", "footer", "header", "form", "noscript"]);
const HEADINGS = new Set(["h1", "h2", "h3"]);

const decoder = new TextDecoder("utf-8");
const collapse = (text) => text.replace(/\s+/g, " ").trim();
const nameOf = (node) => ((node && node.localName) || "").toLowerCase();
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isHidden(node) {
  return node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true";
}

/* ------------------------------------------------------------ zip paths */

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function normalize(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/* OPF hrefs are relative IRIs: resolve against the OPF folder, then decode. */
function resolveHref(baseDir, href) {
  const clean = href.split("#")[0].split("?")[0];
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean)) return null; // absolute URL, never in the archive
  const joined = clean.startsWith("/") ? clean.slice(1) : baseDir ? `${baseDir}/${clean}` : clean;
  return normalize(safeDecode(joined));
}

function readEntry(entries, path) {
  if (hasOwn(entries, path)) return entries[path];
  const decoded = safeDecode(path);
  if (decoded !== path && hasOwn(entries, decoded)) return entries[decoded];
  const wanted = normalize(decoded);
  for (const name of Object.keys(entries)) {
    if (normalize(safeDecode(name)) === wanted) return entries[name];
  }
  return null;
}

/* ------------------------------------------------------------ xml/dom */

function hasParserError(doc) {
  return !doc.documentElement ||
    nameOf(doc.documentElement) === "parsererror" ||
    doc.getElementsByTagName("parsererror").length > 0;
}

function parseXml(text, description) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (hasParserError(doc)) {
    throw new Error(`This file is not a valid EPUB: ${description} is not well-formed XML.`);
  }
  return doc;
}

/* Chapter documents are XML; recover with the lenient HTML mode when not. */
function parseChapter(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xhtml+xml");
  if (!hasParserError(doc)) return doc;
  return parser.parseFromString(text, "text/html");
}

function metadataTitle(opf) {
  for (const element of opf.getElementsByTagName("*")) {
    if (nameOf(element) !== "metadata") continue;
    for (const child of element.getElementsByTagName("*")) {
      if (nameOf(child) !== "title") continue;
      const text = collapse(child.textContent || "");
      if (text) return text;
    }
  }
  return "";
}

/* Manifest items in reach of the spine, and the linear spine order itself. */
function spineItems(opf) {
  const items = new Map();
  for (const element of opf.getElementsByTagName("*")) {
    if (nameOf(element) !== "manifest") continue;
    for (const child of childrenOf(element)) {
      if (nameOf(child) !== "item") continue;
      const id = child.getAttribute("id");
      const href = child.getAttribute("href");
      if (!id || !href) continue;
      items.set(id, {
        href,
        mediaType: child.getAttribute("media-type") || "",
        properties: child.getAttribute("properties") || "",
      });
    }
    break; // the first manifest wins
  }

  const order = [];
  for (const element of opf.getElementsByTagName("*")) {
    if (nameOf(element) !== "spine") continue;
    for (const child of childrenOf(element)) {
      if (nameOf(child) !== "itemref") continue;
      if ((child.getAttribute("linear") || "yes").toLowerCase() === "no") continue; // outside the reading order
      const item = items.get(child.getAttribute("idref"));
      if (!item || NAV_PROPERTIES.test(item.properties)) continue; // ToC is markup, not reading matter
      order.push(item);
    }
    break; // the first spine wins
  }
  return order;
}

function childrenOf(element) {
  return Array.from(element.childNodes).filter((node) => node.nodeType === 1);
}

/* Text of a subtree as it would be visible: skip non-text markup. */
function visibleText(node) {
  let text = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue;
    else if (child.nodeType === 1 && !SKIP.has(nameOf(child)) && !isHidden(child)) text += visibleText(child);
  }
  return text;
}

function blocksOf(doc, budget) {
  const found = [];
  let total = 0;
  for (const element of doc.getElementsByTagName("*")) {
    if (total >= budget) break;
    if (!BLOCKS.has(nameOf(element))) continue;
    let outermost = true;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const name = nameOf(parent);
      if (BLOCKS.has(name) || SKIP.has(name) || isHidden(parent)) {
        outermost = false;
        break;
      }
    }
    if (!outermost) continue;
    const text = collapse(visibleText(element));
    if (text.length < 2) continue;
    const kept = text.length > budget - total ? text.slice(0, budget - total) : text;
    found.push({ text: kept, name: nameOf(element) });
    total += kept.length + 1;
  }
  return found;
}

function chapterTitle(doc, found, fallback) {
  for (const entry of found) {
    if (HEADINGS.has(entry.name)) return entry.text;
  }
  for (const element of doc.getElementsByTagName("*")) {
    if (nameOf(element) !== "title") continue;
    const text = collapse(element.textContent || "");
    if (text) return text;
  }
  return fallback;
}

/* ------------------------------------------------------------- entry */

async function bytesOf(file) {
  if (file instanceof ArrayBuffer) return new Uint8Array(file);
  if (ArrayBuffer.isView(file)) return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  return new Uint8Array(await file.arrayBuffer()); // File/Blob
}

export async function extractEpub(file) {
  let entries;
  try {
    entries = unzipSync(await bytesOf(file));
  } catch {
    throw new Error("This file is not a valid ZIP archive.");
  }

  const containerEntry = readEntry(entries, CONTAINER_PATH);
  if (!containerEntry) {
    throw new Error("This file is not a valid EPUB: META-INF/container.xml is missing.");
  }
  const container = parseXml(decoder.decode(containerEntry), "META-INF/container.xml");

  let opfPath = null;
  for (const element of container.getElementsByTagName("*")) {
    if (nameOf(element) !== "rootfile") continue;
    const fullPath = element.getAttribute("full-path");
    if (fullPath) {
      opfPath = fullPath;
      break;
    }
  }
  if (!opfPath) {
    throw new Error("This file is not a valid EPUB: META-INF/container.xml declares no package document (rootfile).");
  }

  const opfEntry = readEntry(entries, opfPath);
  if (!opfEntry) {
    throw new Error(`This file is not a valid EPUB: the package document "${opfPath}" is missing from the archive.`);
  }
  const opf = parseXml(decoder.decode(opfEntry), "the package document (OPF)");

  const title = metadataTitle(opf) || "Untitled";
  const spine = spineItems(opf);
  if (!spine.length) {
    throw new Error("This file is not a valid EPUB: the spine is missing or has no readable documents.");
  }

  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
  const blocks = [];
  const chapters = [];
  let budget = CHAR_CAP;

  for (const item of spine) {
    if (budget <= 0) break;
    if (!X_MEDIA_TYPES.has(item.mediaType)) continue;
    const path = resolveHref(baseDir, item.href);
    const chapterEntry = path && readEntry(entries, path);
    if (!chapterEntry) continue;
    const doc = parseChapter(decoder.decode(chapterEntry));
    const found = blocksOf(doc, budget);
    if (!found.length) continue; // covers, blank pages, image-only documents
    chapters.push({
      title: chapterTitle(doc, found, `Chapter ${chapters.length + 1}`),
      href: path,
      index: blocks.length,
      count: found.length,
    });
    for (const entry of found) blocks.push(entry.text);
    budget -= found.reduce((sum, entry) => sum + entry.text.length + 1, 0);
  }

  if (!blocks.length) {
    throw new Error("No readable text was found in this EPUB.");
  }
  return { title, blocks, chapters };
}
