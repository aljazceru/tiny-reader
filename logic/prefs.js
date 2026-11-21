/*
 * tiny reader — preference helpers.
 *
 * Pure logic: no browser APIs. Loaded as a classic script by the background
 * event page and via require() by the Node tests.
 *
 * Preferences are global defaults ({ voice, speed }, stored under the
 * historical "voice"/"speed" keys) with optional per-site overrides for
 * http(s) page reads (stored as { [hostname]: { voice?, speed? } } under
 * "sitePrefs"). Effective preferences are always the defaults merged with
 * an optional site override; direct reader inputs never use overrides.
 */

"use strict";

const VocaPrefs = (() => {
  /* Hostname of an http(s) URL, lowercased; null for anything else. Only
   * web pages get site overrides — extension pages, weird schemes and
   * garbage input all fall back to the global defaults. */
  function hostFromUrl(url) {
    if (typeof url !== "string" || !url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      return parsed.hostname.toLowerCase();
    } catch (error) {
      return null;
    }
  }

  function normalizeVoice(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function normalizeSpeed(value, fallback) {
    const speed = Number(value);
    return Number.isFinite(speed) && speed > 0 ? speed : fallback;
  }

  /* Keeps only the meaningful fields of a patch, falling back to the `base`
   * values for malformed input. */
  function normalizePatch(patch, base) {
    const clean = {};
    const fallback = base && typeof base === "object" ? base : {};
    if (!patch || typeof patch !== "object") return clean;
    if (patch.voice !== undefined) clean.voice = normalizeVoice(patch.voice, fallback.voice);
    if (patch.speed !== undefined) clean.speed = normalizeSpeed(patch.speed, fallback.speed);
    return clean;
  }

  /* Effective preferences: defaults with a partial site override on top. */
  function mergePrefs(defaults, override) {
    const base = defaults && typeof defaults === "object" ? defaults : {};
    const merged = {
      voice: normalizeVoice(base.voice, "M2"),
      speed: normalizeSpeed(base.speed, 1),
    };
    if (override && typeof override === "object") {
      if (override.voice !== undefined) merged.voice = normalizeVoice(override.voice, merged.voice);
      if (override.speed !== undefined) merged.speed = normalizeSpeed(override.speed, merged.speed);
    }
    return merged;
  }

  return { hostFromUrl, normalizeVoice, normalizeSpeed, normalizePatch, mergePrefs };
})();

if (typeof module === "object") module.exports = VocaPrefs;
