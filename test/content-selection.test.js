/*
 * Selection extraction in content/content.js, run in a node:vm sandbox
 * against a minimal fake DOM (only what selectionBlocks touches).
 *
 * Regression: a selection inside a single text node — dragging across part
 * of one plain paragraph, e.g. a Hacker News comment — has that text node
 * as range.commonAncestorContainer. A TreeWalker never returns its own
 * root, so the walk found nothing and the read failed with "No text
 * selected" while the popup showed "Read selection".
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SOURCE = readFileSync(join(__dirname, "..", "content", "content.js"), "utf8");

/* Tag-name-only selector matching is enough for BLOCKS / FALLBACK. */
function element(tag, children = []) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: null,
    parentNode: null,
    childNodes: children,
    matches(selector) {
      return selector.split(",").map((s) => s.trim()).includes(tag);
    },
    closest() { return null; },
  };
  for (const child of children) { child.parentElement = el; child.parentNode = el; }
  return el;
}

function text(value) {
  return { nodeType: 3, textContent: value, parentElement: null, parentNode: null, childNodes: [] };
}

function descendants(root) {
  const out = [];
  const walk = (node) => { for (const child of node.childNodes) { out.push(child); walk(child); } };
  walk(root);
  return out;
}

function load(range) {
  let listener = null;
  const sandbox = {
    window: {
      getSelection: () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range }),
    },
    document: {
      title: "Page",
      createTreeWalker(root, _show, filter) {
        const nodes = descendants(root).filter(
          (node) => node.nodeType === 3 && filter.acceptNode(node) === 1
        );
        let i = 0;
        return { nextNode: () => nodes[i++] || null };
      },
    },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
  };
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(SOURCE, sandbox);
  return (source) => listener({ type: "extract", source });
}

test("a selection inside one text node is extracted", async () => {
  const node = text("If you're new to quantized models: don't get too excited.");
  element("body", [element("div", [node])]); // sets the parent chain
  const range = {
    commonAncestorContainer: node,
    startContainer: node,
    startOffset: 3,
    endContainer: node,
    endOffset: 33,
    intersectsNode: (n) => n === node,
  };
  const page = await load(range)("selection");
  assert.equal(page.source, "selection");
  assert.deepEqual([...page.blocks], ["you're new to quantized models"]);
});

test("a selection spanning two paragraphs is extracted per block", async () => {
  const a = text("First paragraph text.");
  const b = text("Second paragraph text.");
  const root = element("div", [element("p", [a]), element("p", [b])]);
  const range = {
    commonAncestorContainer: root,
    startContainer: a,
    startOffset: 6,
    endContainer: b,
    endOffset: 6,
    intersectsNode: (n) => n === a || n === b,
  };
  const page = await load(range)("selection");
  assert.deepEqual([...page.blocks], ["paragraph text.", "Second"]);
});
