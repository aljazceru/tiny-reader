/*
 * tiny reader — saved-article library (pure logic).
 *
 * Normalizes and orders library items for the background event page. An
 * item is { id, title, url, blocks, source, createdAt }: lists are kept
 * newest-first, capped at MAX_ITEMS entries, with at most MAX_CHARS
 * characters of text per item. Queue helpers decide what plays next when a
 * queued article finishes (nextQueuedId) and how much is left (queueRemaining).
 *
 * Pure logic: no browser APIs. Loaded as a classic script by the background
 * event page and via require() by the Node tests. All helpers are
 * deterministic given their arguments; pass `now` to pin the clock in tests.
 */

"use strict";

const Library = (() => {
  const MAX_ITEMS = 50;
  const MAX_CHARS = 500000; // per item, counted over all blocks plus separators
  const SOURCES = ["paste", "url", "pdf", "epub", "txt", "library"];

  /* ---------------------------------------------------------- primitives */

  function asString(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function trimmed(value) {
    return asString(value).trim();
  }

  function toTimestamp(value, fallback) {
    const at = Number(value);
    if (Number.isFinite(at) && at > 0) return at;
    return Number.isFinite(fallback) ? fallback : Date.now();
  }

  function makeId(now) {
    const at = Math.max(0, Math.trunc(Number.isFinite(now) ? now : Date.now()));
    const crypto = globalThis.crypto;
    const rand = crypto && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return `lib-${at.toString(36)}-${rand}`;
  }

  /* --------------------------------------------------------------- blocks */

  function normalizeBlocks(blocks) {
    if (!Array.isArray(blocks)) throw new TypeError("blocks must be an array of strings");
    const clean = [];
    for (const block of blocks) {
      if (block === null || block === undefined) continue;
      const text = typeof block === "string" ? block : String(block);
      if (text.trim()) clean.push(text);
    }
    return clean;
  }

  /* Characters a block list occupies: text plus one separator per gap. */
  function charCount(blocks) {
    if (!Array.isArray(blocks)) throw new TypeError("blocks must be an array of strings");
    let total = 0;
    for (const block of blocks) total += block.length + 1;
    return blocks.length ? total - 1 : 0;
  }

  /* Keep whole blocks while the budget lasts; split the block that crosses
   * it. The separator between blocks counts toward the budget. */
  function truncateBlocks(blocks, maxChars) {
    const budget = maxChars === undefined ? MAX_CHARS : Number(maxChars);
    if (!Array.isArray(blocks)) throw new TypeError("blocks must be an array of strings");
    if (!Number.isFinite(budget) || budget < 1) throw new TypeError("maxChars must be a positive number");
    const kept = [];
    let used = 0;
    for (const block of blocks) {
      const room = budget - used - (kept.length ? 1 : 0);
      if (room <= 0) break;
      if (block.length <= room) {
        kept.push(block);
        used += block.length + 1;
      } else {
        kept.push(block.slice(0, room));
        break;
      }
    }
    return kept;
  }

  /* ---------------------------------------------------------------- items */

  function normalizeItem(input, now) {
    if (!input || typeof input !== "object") throw new TypeError("item must be an object");
    const createdAt = toTimestamp(input.createdAt, now);
    const blocks = truncateBlocks(normalizeBlocks(input.blocks));
    if (!blocks.length) throw new TypeError("item needs at least one non-empty text block");
    return {
      id: trimmed(input.id) || makeId(createdAt),
      title: trimmed(input.title) || "Untitled",
      url: trimmed(input.url),
      blocks,
      source: trimmed(input.source) || "paste",
      createdAt,
    };
  }

  /* Newest first; ties break by id ascending so the order is stable. */
  function byNewestFirst(a, b) {
    return (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function sortNewestFirst(items) {
    if (!Array.isArray(items)) throw new TypeError("items must be an array");
    return [...items].sort(byNewestFirst);
  }

  /* Upsert: an item with the same id is replaced and moved to the front.
   * Returns the normalized item, the capped list, and whether the item was
   * kept — an item strictly older than the oldest entry of a full library
   * is dropped instead of evicting stored items. */
  function insert(items, input, now) {
    if (!Array.isArray(items)) throw new TypeError("items must be an array");
    const item = normalizeItem(input, now);
    const rest = sortNewestFirst(items.filter((existing) => existing && existing.id !== item.id));
    const oldest = rest.length >= MAX_ITEMS ? rest[rest.length - 1] : null;
    if (oldest && item.createdAt < oldest.createdAt) {
      /* Not in rest (it was filtered), so the stored library is unchanged;
       * only normalize its order. */
      return { item, items: sortNewestFirst(items), kept: false };
    }
    const next = [item, ...rest].slice(0, MAX_ITEMS);
    return { item, items: next, kept: next.some((existing) => existing.id === item.id) };
  }

  function remove(items, id) {
    if (!Array.isArray(items)) throw new TypeError("items must be an array");
    const key = trimmed(id);
    return items.filter((item) => item && item.id !== key);
  }

  function find(items, id) {
    if (!Array.isArray(items)) throw new TypeError("items must be an array");
    const key = trimmed(id);
    return items.find((item) => item && item.id === key) || null;
  }

  /* --------------------------------------------------------------- queue */

  /* Non-empty strings, first occurrence wins, order preserved. */
  function normalizeQueue(ids) {
    if (!Array.isArray(ids)) return [];
    const seen = new Set();
    const queue = [];
    for (const id of ids) {
      const key = trimmed(id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      queue.push(key);
    }
    return queue;
  }

  /* The id that should play after `currentId` finishes: the next entry of
   * the queue, or the queue's head if the current item is not queued at
   * all, or null when the queue is done. */
  function nextQueuedId(queueIds, currentId) {
    const queue = normalizeQueue(queueIds);
    if (!queue.length) return null;
    const at = queue.indexOf(trimmed(currentId));
    if (at === -1) return queue[0];
    return at + 1 < queue.length ? queue[at + 1] : null;
  }

  /* How many queued articles are left after `currentId` (the whole queue
   * if the current item is not part of it). */
  function queueRemaining(queueIds, currentId) {
    const queue = normalizeQueue(queueIds);
    const at = queue.indexOf(trimmed(currentId));
    if (at === -1) return queue.length;
    return queue.length - 1 - at;
  }

  return {
    MAX_ITEMS,
    MAX_CHARS,
    SOURCES,
    makeId,
    normalizeBlocks,
    normalizeItem,
    normalizeQueue,
    charCount,
    truncateBlocks,
    byNewestFirst,
    sortNewestFirst,
    insert,
    remove,
    find,
    nextQueuedId,
    queueRemaining,
  };
})();

if (typeof module === "object") module.exports = Library;
