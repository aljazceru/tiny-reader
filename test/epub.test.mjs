/*
 * Unit tests for reader/epub.js against the shipped sample fixture
 * (test/fixtures/sample.epub) and in-memory EPUBs built with the vendored
 * fflate. Covers extraction (title, spine order, chapter boundaries,
 * nav/script/style stripping, the 500k cap), path resolution (OPF-relative
 * hrefs, "..", percent-encoded entry names) and the clear-error paths.
 *
 * Node has no DOMParser, so a small XML/DOM stand-in (bottom of this file)
 * is installed as globalThis.DOMParser before extraction runs; production
 * runs in the browser against the real DOMParser with the same calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "../vendor/fflate.js";
import { extractEpub } from "../reader/epub.js";

/* ------------------------------------------------------------ dom shim */

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const VOID_HTML = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, body) => {
    if (body.charCodeAt(0) === 35) { // '#'
      const code = /[xX]/.test(body[1]) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : all;
  });
}

function textOf(node) {
  let text = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 1) text += textOf(child);
    else if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue;
  }
  return text;
}

function namedDescendants(node, name) {
  const found = [];
  const walk = (parent) => {
    for (const child of parent.childNodes) {
      if (child.nodeType !== 1) continue;
      if (name === "*" || child.tagName === name) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

function elementNode(localName, namespaceURI, attributes) {
  return {
    nodeType: 1,
    localName,
    tagName: localName,
    namespaceURI: namespaceURI || null,
    attributes: attributes || {},
    childNodes: [],
    parentNode: null,
    get parentElement() {
      const parent = this.parentNode;
      return parent && parent.nodeType === 1 ? parent : null;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : "";
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    get textContent() {
      return textOf(this);
    },
    getElementsByTagName(name) {
      return namedDescendants(this, name);
    },
  };
}

function textNode(value) {
  return { nodeType: 3, nodeValue: value, localName: null, childNodes: [], parentNode: null };
}

function documentNode() {
  return {
    nodeType: 9,
    localName: null,
    documentElement: null,
    childNodes: [],
    parentNode: null,
    get textContent() {
      return textOf(this);
    },
    getElementsByTagName(name) {
      return namedDescendants(this, name);
    },
  };
}

/*
 * One tokenizer for strict XML and lenient HTML. Strict mode throws on any
 * well-formedness violation; the shim's DOMParser turns that into a document
 * holding a <parsererror> element, exactly like browsers do, so the fallback
 * path in reader/epub.js is exercised.
 */
function parseTree(source, html) {
  const doc = documentNode();
  const stack = [doc];
  const nsScopes = html ? null : [Object.create(null)]; // prefix -> uri
  const fail = (message) => { throw new Error(message); };
  const append = (node) => {
    node.parentNode = stack[stack.length - 1];
    stack[stack.length - 1].childNodes.push(node);
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt !== i) {
      const stop = lt === -1 ? source.length : lt;
      append(textNode(decodeEntities(source.slice(i, stop))));
      i = stop;
      continue;
    }
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end === -1 && !html) fail("unterminated comment");
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end === -1) fail("unterminated CDATA section");
      append(textNode(source.slice(i + 9, end)));
      i = end + 3;
      continue;
    }
    if (source.startsWith("<!", i)) { // DOCTYPE and other declarations
      let j = i + 2;
      let depth = 0;
      while (j < source.length) {
        const ch = source[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
        j++;
      }
      if (j >= source.length) fail("unterminated declaration");
      i = j + 1;
      continue;
    }
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end === -1) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (source.startsWith("</", i)) {
      const end = source.indexOf(">", i);
      if (end === -1) fail("unterminated end tag");
      const name = source.slice(i + 2, end).trim();
      i = end + 1;
      if (html) {
        let at = -1;
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s].tagName === name.toLowerCase()) { at = s; break; }
        }
        if (at > 0) stack.length = at; // close through the match; unmatched tags are ignored
      } else {
        const top = stack[stack.length - 1];
        if (stack.length === 1 || top.nodeType !== 1) fail(`unexpected end tag </${name}>`);
        if (top.tagName !== name) fail(`mismatched end tag: expected </${top.tagName}>, got </${name}>`);
        stack.pop();
        nsScopes.pop();
      }
      continue;
    }

    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(source.slice(i + 1));
    if (!nameMatch) {
      if (html) { append(textNode("<")); i++; continue; }
      fail("invalid tag name");
    }
    const rawName = html ? nameMatch[0].toLowerCase() : nameMatch[0];
    const attributes = Object.create(null);
    let selfClosing = false;
    let k = i + 1 + nameMatch[0].length;
    while (k < source.length) {
      while (k < source.length && /\s/.test(source[k])) k++;
      if (k >= source.length) fail("unterminated start tag");
      if (source[k] === ">") { k++; break; }
      if (source[k] === "/") {
        let m = k + 1;
        while (m < source.length && /\s/.test(source[m])) m++;
        if (source[m] !== ">") fail("malformed '/' in start tag");
        selfClosing = true;
        k = m + 1;
        break;
      }
      const nameStart = k;
      while (k < source.length && !/[\s=/>]/.test(source[k])) k++;
      if (k === nameStart) fail("malformed attribute");
      const attrName = html ? source.slice(nameStart, k).toLowerCase() : source.slice(nameStart, k);
      while (k < source.length && /\s/.test(source[k])) k++;
      let value = "";
      if (source[k] === "=") {
        k++;
        while (k < source.length && /\s/.test(source[k])) k++;
        const quote = source[k];
        if (quote === '"' || quote === "'") {
          const close = source.indexOf(quote, k + 1);
          if (close === -1) fail("unterminated attribute value");
          value = source.slice(k + 1, close);
          k = close + 1;
        } else {
          const valueStart = k;
          while (k < source.length && !/[\s>]/.test(source[k])) k++;
          value = source.slice(valueStart, k);
        }
      }
      attributes[attrName] = decodeEntities(value);
    }
    i = k;

    let scope = null;
    let prefix = "";
    let local = rawName;
    if (!html) {
      scope = Object.create(nsScopes[nsScopes.length - 1]);
      for (const attr of Object.keys(attributes)) {
        if (attr === "xmlns") scope[""] = attributes[attr];
        else if (attr.startsWith("xmlns:")) scope[attr.slice(6)] = attributes[attr];
      }
      const colon = rawName.indexOf(":");
      if (colon !== -1) {
        prefix = rawName.slice(0, colon);
        local = rawName.slice(colon + 1);
        if (!prefix || !local) fail(`malformed element name <${rawName}>`);
      }
    }
    const element = elementNode(local, html ? XHTML_NS : scope[prefix] || null, attributes);
    element.tagName = rawName;
    append(element);
    if (!selfClosing && !(html && VOID_HTML.has(rawName))) {
      stack.push(element);
      if (!html) nsScopes.push(scope);
    }
  }

  if (!html) {
    if (stack.length > 1) fail(`unclosed element <${stack[stack.length - 1].tagName}>`);
    if (doc.childNodes.filter((child) => child.nodeType === 1).length !== 1) fail("the document must have exactly one root element");
    for (const child of doc.childNodes) {
      if (child.nodeType === 3 && child.nodeValue.trim()) fail("content outside the root element");
    }
  }
  doc.documentElement = doc.childNodes.find((child) => child.nodeType === 1) || null;
  return doc;
}

class ShimDOMParser {
  parseFromString(source, type) {
    if (type === "text/html") return parseTree(String(source), true);
    try {
      return parseTree(String(source), false);
    } catch (error) {
      const doc = documentNode();
      const errorElement = elementNode("parsererror", "http://www.mozilla.org/newlayout/error/parsererror");
      const message = textNode(`${error.message} while parsing: ${String(source).slice(0, 120)}`);
      errorElement.childNodes.push(message);
      message.parentNode = errorElement;
      doc.childNodes.push(errorElement);
      errorElement.parentNode = doc;
      doc.documentElement = errorElement;
      return doc;
    }
  }
}

globalThis.DOMParser = ShimDOMParser;

/* -------------------------------------------------------- epub builders */

const containerXml = (opfPath) => `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const opfXml = (title, items) => `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:identifier id="bookid">urn:uuid:0a0a-0b0b</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
${items.map((item) => `    <item id="${item.id}" href="${item.href}" media-type="${item.type || "application/xhtml+xml"}"/>`).join("\n")}
  </manifest>
  <spine>
${items.map((item) => `    <itemref idref="${item.id}"/>`).join("\n")}
  </spine>
</package>`;

const chapterXml = (heading, paragraphs) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${heading}</title></head>
  <body>
    <h1>${heading}</h1>
${paragraphs.map((p) => `    <p>${p}</p>`).join("\n")}
  </body>
</html>`;

const buildEpub = (files) => zipSync({
  mimetype: [strToU8("application/epub+zip"), { level: 0 }],
  ...files,
});

const fixtureBytes = () => readFileSync(new URL("./fixtures/sample.epub", import.meta.url));

/* --------------------------------------------------------------- tests */

test("the fixture yields its title, two chapters and their text in spine order", async () => {
  const book = await extractEpub(fixtureBytes());
  assert.equal(book.title, "Voca Sample Book");
  assert.equal(book.chapters.length, 2);
  assert.deepEqual(book.chapters.map((c) => c.title), ["The Morning Walk", "The Lighthouse Letters"]);
  assert.deepEqual(book.chapters.map((c) => c.count), [5, 4]);
  assert.deepEqual(book.chapters.map((c) => [c.index, c.index + c.count]), [[0, 5], [5, 9]]);
  assert.equal(book.blocks.length, 9);
  assert.equal(book.blocks[0], "The Morning Walk");
  assert.equal(book.blocks[1], "Anna woke before the sun and listened to the rain tap against the window.");
  assert.ok(book.blocks.some((t) => t.startsWith("The sea keeps every promise")));
  assert.equal(book.blocks[5], "The Lighthouse Letters"); // chapter two starts at its heading
  assert.ok(book.blocks.some((t) => t.startsWith("Ships far away answered")));
  assert.ok(book.blocks.some((t) => t.startsWith("On the last night of autumn")));
});

test("fixture markup is stripped: script, style and nav text never surface", async () => {
  const book = await extractEpub(fixtureBytes());
  const text = book.blocks.join("\n");
  assert.ok(!text.includes("neverReadAloud"));
  assert.ok(!text.includes("navy"));
  assert.ok(!text.includes("Contents: chapter one"));
});

test("spine hrefs resolve relative to the OPF folder and decode percent-encoded names", async () => {
  // The fixture itself reads a nested OPF dir (OEBPS/text/) and a chapter
  // stored as "chapter two.xhtml" but referenced as "text/chapter%20two.xhtml".
  const book = await extractEpub(fixtureBytes());
  assert.deepEqual(
    book.chapters.map((c) => c.href),
    ["OEBPS/text/chapter-one.xhtml", "OEBPS/text/chapter two.xhtml"],
  );

  const epub = buildEpub({
    "META-INF/container.xml": strToU8(containerXml("content.opf")),
    "content.opf": strToU8(opfXml("Path Book", [
      { id: "deep", href: "Sub/One%20Chapter.xhtml" },
      { id: "up", href: "../up/second.xhtml" },
    ])),
    "Sub/One Chapter.xhtml": strToU8(chapterXml("Deep Chapter", ["Text from the nested chapter."])),
    "up/second.xhtml": strToU8(chapterXml("Upper Chapter", ["Text above the package document."])),
  });
  const paths = await extractEpub(epub);
  assert.equal(paths.title, "Path Book");
  assert.deepEqual(paths.chapters.map((c) => c.href), ["Sub/One Chapter.xhtml", "up/second.xhtml"]);
  assert.equal(paths.blocks[0], "Deep Chapter");
  assert.equal(paths.blocks[2], "Upper Chapter");
  assert.ok(paths.blocks.includes("Text from the nested chapter."));
  assert.ok(paths.blocks.includes("Text above the package document."));
});

test("a chapter that is not well-formed XML still reads via the HTML fallback", async () => {
  const epub = buildEpub({
    "META-INF/container.xml": strToU8(containerXml("book.opf")),
    "book.opf": strToU8(opfXml("Recovery Book", [{ id: "broken", href: "broken.xhtml" }])),
    "broken.xhtml": strToU8("<html><body><h1>Broken Chapter</h1><p>Text that survives a broken tag"),
  });
  const book = await extractEpub(epub);
  assert.equal(book.title, "Recovery Book");
  assert.deepEqual(book.chapters.map((c) => c.title), ["Broken Chapter"]);
  assert.deepEqual(book.blocks, ["Broken Chapter", "Text that survives a broken tag"]);
});

test("blocks stop at the 500k character cap", async () => {
  const filler = "word ".repeat(200000); // 1M characters
  const epub = buildEpub({
    "META-INF/container.xml": strToU8(containerXml("book.opf")),
    "book.opf": strToU8(opfXml("Big Book", [{ id: "c", href: "c.xhtml" }])),
    "c.xhtml": strToU8(chapterXml("Big Chapter", [filler])),
  });
  const book = await extractEpub(epub);
  assert.equal(book.chapters.length, 1);
  assert.ok(book.blocks.join("").length <= 500000);
  assert.deepEqual(book.blocks.slice(0, 1), ["Big Chapter"]);
  // heading (11 chars + 1 separator) leaves 500000 - 12 characters of budget
  assert.equal(book.blocks.length, 2);
  assert.equal(book.blocks[1].length, 499988);
});

test("linear='no' itemrefs and the EPUB 3 nav document are not read", async () => {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Order Book</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="aux" href="aux.xhtml" media-type="application/xhtml+xml"/>
    <item id="main" href="main.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="nav"/>
    <itemref idref="aux" linear="no"/>
    <itemref idref="main"/>
  </spine>
</package>`;
  const epub = buildEpub({
    "META-INF/container.xml": strToU8(containerXml("book.opf")),
    "book.opf": strToU8(opf),
    "nav.xhtml": strToU8(chapterXml("Table of Contents", ["Chapter one. Chapter two."])),
    "aux.xhtml": strToU8(chapterXml("Auxiliary", ["Answer key for the quiz."])),
    "main.xhtml": strToU8(chapterXml("Main Story", ["The only readable chapter."])),
  });
  const book = await extractEpub(epub);
  assert.deepEqual(book.chapters.map((c) => c.title), ["Main Story"]);
  assert.deepEqual(book.blocks, ["Main Story", "The only readable chapter."]);
});

test("accepts ArrayBuffer and Blob-like input as well as typed arrays", async () => {
  const bytes = fixtureBytes();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const fromBuffer = await extractEpub(buffer);
  assert.equal(fromBuffer.title, "Voca Sample Book");
  const fakeFile = { arrayBuffer: async () => buffer };
  const fromFile = await extractEpub(fakeFile);
  assert.deepEqual(fromFile.blocks, fromBuffer.blocks);
  assert.deepEqual(fromFile.chapters, fromBuffer.chapters);
});

test("clear errors for invalid ZIPs, missing containers and missing spines", async () => {
  await assert.rejects(
    extractEpub(strToU8("this is definitely not a zip archive")),
    /not a valid ZIP archive/,
  );

  await assert.rejects(
    extractEpub(zipSync({ "loose.txt": strToU8("no container here") })),
    /META-INF\/container\.xml is missing/,
  );

  const spineless = buildEpub({
    "META-INF/container.xml": strToU8(containerXml("book.opf")),
    "book.opf": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>No Spine</dc:title></metadata>
  <manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest>
</package>`),
    "c.xhtml": strToU8(chapterXml("Hidden", ["Nobody can read this."])),
  });
  await assert.rejects(extractEpub(spineless), /spine is missing/);

  const brokenContainer = zipSync({
    "META-INF/container.xml": strToU8("<container><rootfiles>"),
  });
  await assert.rejects(extractEpub(brokenContainer), /not well-formed XML/);
});
