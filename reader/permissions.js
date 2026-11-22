/*
 * tiny reader — per-site access, asked for at the moment of use.
 *
 * The manifest ships with optional_host_permissions <all_urls> and no
 * install-time host access, so a feature that fetches another origin —
 * reading a page URL, downloading a model by URL, using a remote TTS
 * endpoint — first requests just that origin from inside the click that
 * needs it. Firefox drops the user gesture after the first await in a
 * handler, so callers must await requestOrigin() before anything else.
 */

"use strict";

/* "https://host.example/some/path?q=1" → "https://host.example/*", the
 * broadest match pattern one site needs. Throws for anything that is not
 * an http(s) URL. */
export function originPattern(url) {
  let target;
  try {
    target = new URL(String(url ?? "").trim());
  } catch {
    throw new Error("That does not look like a URL.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("That does not look like a URL.");
  }
  return `${target.protocol}//${target.hostname}/*`;
}

/* Prompts for access to url's origin (a no-op when already granted).
 * purpose is a verb phrase like "read this page" used in the denial
 * message. Resolves { granted } plus a user-facing message on denial. */
export async function requestOrigin(url, purpose) {
  const origin = originPattern(url);
  const granted = await browser.permissions.request({ origins: [origin] });
  if (granted) return { granted: true };
  const { hostname } = new URL(String(url ?? "").trim());
  return {
    granted: false,
    message: `Permission for ${hostname} was not given, so tiny reader can't ${purpose}. Try again and choose Allow.`,
  };
}
