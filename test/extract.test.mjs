/*
 * Unit tests for reader/extract.js — blocksFromText edge cases (pure, no DOM).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksFromText, MAX_CHARS } from "../reader/extract.js";

test("splits on blank lines, keeps single newlines inside a block", () => {
  const text = "First paragraph line one\ncontinues here.\n\nSecond paragraph\n\n\n\nThird after blank runs.";
  assert.deepEqual(blocksFromText(text), [
    "First paragraph line one continues here.",
    "Second paragraph",
    "Third after blank runs.",
  ]);
});

test("blank lines may contain spaces and tabs", () => {
  const text = "Alpha one.\n   \n\t\nBeta two.\n \nGamma three.";
  assert.deepEqual(blocksFromText(text), ["Alpha one.", "Beta two.", "Gamma three."]);
});

test("collapses whitespace inside blocks and normalises CRLF", () => {
  const text = "A\ttabbed\n  and   spaced   line\r\n\r\nNext\r\nblock stays whole";
  assert.deepEqual(blocksFromText(text), ["A tabbed and spaced line", "Next block stays whole"]);
});

test("drops blocks with nothing pronounceable but keeps neighbours", () => {
  const text = "***\n\n—\n\n🙂🙂\n\nButter flies at dawn.\n\n42 marks the spot";
  assert.deepEqual(blocksFromText(text), ["Butter flies at dawn.", "42 marks the spot"]);
});

test("returns an empty list for empty, blank or missing input", () => {
  assert.deepEqual(blocksFromText(""), []);
  assert.deepEqual(blocksFromText("  \n\n   \n"), []);
  assert.deepEqual(blocksFromText(null), []);
  assert.deepEqual(blocksFromText(undefined), []);
});

test("caps input at 500k characters", () => {
  assert.equal(MAX_CHARS, 500000);
  const huge = "a".repeat(600000); // no whitespace, so trimming cannot shorten it
  const blocks = blocksFromText(huge);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].length, MAX_CHARS);
});

test("cap bounds the total output across many paragraphs", () => {
  const huge = Array.from({ length: 40000 }, (_, i) => `Paragraph number ${i} with ordinary words.`).join("\n\n");
  const blocks = blocksFromText(huge);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.reduce((sum, block) => sum + block.length, 0) <= MAX_CHARS);
});

test("short input passes through untouched in order", () => {
  const text = "One small block.\n\nTwo small block.\n\nThree small block.";
  assert.deepEqual(blocksFromText(text), ["One small block.", "Two small block.", "Three small block."]);
});
