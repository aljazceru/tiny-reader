/*
 * Unit tests for reader/permissions.js — origin match patterns and the
 * point-of-use permission request (with a fake browser.permissions.request).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { originPattern, requestOrigin } from "../reader/permissions.js";

test("originPattern reduces a URL to its scheme+host match pattern", () => {
  assert.equal(originPattern("http://localhost:8880/v1/audio/speech"), "http://localhost/*");
  assert.equal(originPattern("https://huggingface.co/a/b.gguf?download=1"), "https://huggingface.co/*");
});

test("originPattern rejects non-http(s) schemes and non-URLs", () => {
  for (const bad of ["ftp://x", "not a url", "", "file:///etc/passwd"]) {
    assert.throws(() => originPattern(bad), /That does not look like a URL\./);
  }
});

test("requestOrigin returns granted when the prompt is accepted", async () => {
  const calls = [];
  globalThis.browser = { permissions: { request: async (arg) => { calls.push(arg); return true; } } };
  try {
    const result = await requestOrigin("https://example.com/a", "read this page");
    assert.deepEqual(result, { granted: true });
    assert.deepEqual(calls, [{ origins: ["https://example.com/*"] }]);
  } finally {
    delete globalThis.browser;
  }
});

test("requestOrigin names the host and purpose when denied, and asks again on retry", async () => {
  const calls = [];
  globalThis.browser = { permissions: { request: async (arg) => { calls.push(arg); return false; } } };
  try {
    const denied = await requestOrigin("https://example.com/a", "read this page");
    assert.deepEqual(denied, {
      granted: false,
      message: "Permission for example.com was not given, so tiny reader can't read this page. Try again and choose Allow.",
    });
    await requestOrigin("https://example.com/a", "read this page");
    assert.equal(calls.length, 2); // a denial does not disable the prompt
  } finally {
    delete globalThis.browser;
  }
});
