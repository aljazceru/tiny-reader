/*
 * Unit tests for logic/library.js (pure, no browser APIs).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Library = require("../logic/library.js");

function makeItem(id, createdAt, title) {
  return { id, title: title || `T${id}`, url: "", blocks: [`text ${id}`], source: "url", createdAt };
}

/* ------------------------------------------------------------ normalize */

test("normalizeItem fills defaults for direct inputs", () => {
  const item = Library.normalizeItem({ blocks: ["Hello"] });
  assert.deepEqual(Object.keys(item).sort(), ["blocks", "createdAt", "id", "source", "title", "url"]);
  assert.equal(item.title, "Untitled");
  assert.equal(item.url, "");
  assert.equal(item.source, "paste");
  assert.deepEqual(item.blocks, ["Hello"]);
  assert.ok(Number.isFinite(item.createdAt) && item.createdAt > 0);
  assert.match(item.id, /^lib-/);
});

test("normalizeItem trims fields and drops blank blocks", () => {
  const item = Library.normalizeItem({
    id: "  fixed-id ",
    title: "  My Article  ",
    url: "  https://example.com/a  ",
    blocks: ["  Hi there  ", "   ", null, "Second"],
    source: "  web ",
    createdAt: 42,
  });
  assert.equal(item.id, "fixed-id");
  assert.equal(item.title, "My Article");
  assert.equal(item.url, "https://example.com/a");
  assert.equal(item.source, "web");
  assert.equal(item.createdAt, 42);
  assert.deepEqual(item.blocks, ["  Hi there  ", "Second"]);
});

test("normalizeItem rejects non-objects and empty text", () => {
  assert.throws(() => Library.normalizeItem(null), TypeError);
  assert.throws(() => Library.normalizeItem("nope"), TypeError);
  assert.throws(() => Library.normalizeItem({ blocks: "nope" }), TypeError);
  assert.throws(() => Library.normalizeItem({ blocks: [] }), TypeError);
  assert.throws(() => Library.normalizeItem({ blocks: ["  ", "   "] }), TypeError);
});

test("normalizeItem pins createdAt to the given clock", () => {
  const item = Library.normalizeItem({ blocks: ["Hello"], createdAt: Number.NaN }, 12345);
  assert.equal(item.createdAt, 12345);
  assert.equal(Library.normalizeItem({ blocks: ["x"], createdAt: 7 }, 12345).createdAt, 7);
});

test("makeId is unique per call and embeds the timestamp", () => {
  const a = Library.makeId(5000);
  const b = Library.makeId(5000);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("lib-"));
  assert.ok(Library.makeId(0).startsWith("lib-0-"));
});

/* -------------------------------------------------------------- blocks */

test("charCount sums text plus separators", () => {
  assert.equal(Library.charCount([]), 0);
  assert.equal(Library.charCount(["abc"]), 3);
  assert.equal(Library.charCount(["abc", "de"]), 6);
});

test("truncateBlocks keeps whole blocks under the budget", () => {
  assert.deepEqual(Library.truncateBlocks(["12345", "67890", "xyz"], 12), ["12345", "67890"]);
  assert.deepEqual(Library.truncateBlocks(["abcdef"], 4), ["abcd"]);
  assert.deepEqual(Library.truncateBlocks(["ab", "cd"], 100), ["ab", "cd"]);
  assert.throws(() => Library.truncateBlocks(["ab"], 0), TypeError);
  assert.throws(() => Library.truncateBlocks(["a"], "nope"), TypeError);
});

test("normalizeItem caps items at MAX_CHARS", () => {
  const item = Library.normalizeItem({ blocks: ["a".repeat(300000), "b".repeat(300000)] });
  assert.equal(item.blocks.length, 2);
  assert.equal(item.blocks[1].length, 199998);
  assert.ok(Library.charCount(item.blocks) <= Library.MAX_CHARS);
  assert.equal(Library.MAX_CHARS, 500000);
});

/* ------------------------------------------------------------- ordering */

test("sortNewestFirst orders by createdAt desc, ties by id", () => {
  const items = [makeItem("a", 1), makeItem("b", 3), makeItem("c", 2)];
  assert.deepEqual(Library.sortNewestFirst(items).map((it) => it.id), ["b", "c", "a"]);
  const tied = [makeItem("b", 1), makeItem("a", 1)];
  assert.deepEqual(Library.sortNewestFirst(tied).map((it) => it.id), ["a", "b"]);
  assert.deepEqual(items.map((it) => it.id), ["a", "b", "c"]); // pure
});

/* ------------------------------------------------------------------ cap */

test("insert adds newest first and caps the list at MAX_ITEMS", () => {
  let items = [];
  for (let i = 0; i < Library.MAX_ITEMS; i++) {
    items = Library.insert(items, { id: `i${i}`, blocks: ["t"], createdAt: 1000 + i }).items;
  }
  assert.equal(items.length, 50);
  assert.equal(items[0].id, "i49");

  const added = Library.insert(items, { id: "new", blocks: ["t"], createdAt: 2000 });
  assert.equal(added.kept, true);
  assert.equal(added.items.length, Library.MAX_ITEMS);
  assert.equal(added.items[0].id, "new");
  assert.equal(added.items.at(-1).id, "i1"); // oldest dropped
  assert.equal(items.length, 50); // pure, original untouched
});

test("insert drops items older than a full library", () => {
  let items = [];
  for (let i = 0; i < Library.MAX_ITEMS; i++) {
    items = Library.insert(items, { id: `i${i}`, blocks: ["t"], createdAt: 1000 + i }).items;
  }
  const result = Library.insert(items, { id: "old", blocks: ["t"], createdAt: 5 });
  assert.equal(result.kept, false);
  assert.equal(result.items.length, 50);
  assert.ok(!result.items.some((it) => it.id === "old"));
});

test("insert upserts by id and moves the item to the front", () => {
  const items = [makeItem("a", 1), makeItem("b", 2)];
  const result = Library.insert(items, { id: "a", blocks: ["updated"], createdAt: 9 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, "a");
  assert.deepEqual(result.items[0].blocks, ["updated"]);
  assert.equal(result.items.filter((it) => it.id === "a").length, 1);
});

test("remove and find are pure helpers", () => {
  const items = [makeItem("a", 1), makeItem("b", 2)];
  const rest = Library.remove(items, "a");
  assert.deepEqual(rest.map((it) => it.id), ["b"]);
  assert.equal(items.length, 2);
  assert.equal(Library.find(items, "b").id, "b");
  assert.equal(Library.find(items, "zz"), null);
  assert.deepEqual(Library.remove(items, "  ").map((it) => it.id), ["a", "b"]);
});

/* ---------------------------------------------------------------- queue */

test("normalizeQueue keeps order and dedupes", () => {
  assert.deepEqual(Library.normalizeQueue(["a", " ", "a", "b"]), ["a", "b"]);
  assert.deepEqual(Library.normalizeQueue("nope"), []);
  assert.deepEqual(Library.normalizeQueue([]), []);
});

test("nextQueuedId walks the queue and reports the end", () => {
  const queue = ["a", "b", "c"];
  assert.equal(Library.nextQueuedId(queue, "a"), "b");
  assert.equal(Library.nextQueuedId(queue, "b"), "c");
  assert.equal(Library.nextQueuedId(queue, "c"), null);
  assert.equal(Library.nextQueuedId(queue, undefined), "a"); // nothing playing yet
  assert.equal(Library.nextQueuedId(queue, "not-queued"), "a"); // fall back to head
  assert.equal(Library.nextQueuedId([], "a"), null);
  assert.equal(Library.nextQueuedId("nope", "a"), null);
});

test("nextQueuedId works on a cleaned queue", () => {
  assert.equal(Library.nextQueuedId(["a", "", "a", "b"], "a"), "b");
});

test("queueRemaining counts what is left after the current item", () => {
  const queue = ["a", "b", "c"];
  assert.equal(Library.queueRemaining(queue, "a"), 2);
  assert.equal(Library.queueRemaining(queue, "c"), 0);
  assert.equal(Library.queueRemaining(queue, "not-queued"), 3);
  assert.equal(Library.queueRemaining([], "a"), 0);
});
