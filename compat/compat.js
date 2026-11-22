/*
 * tiny reader — cross-browser API shim.
 *
 * Firefox provides the promise-based `browser` namespace everywhere. Chrome
 * MV3 only provides `chrome` (promise-based since MV3), so this shim aliases
 * `browser` to it when missing. Loaded as the first script of the popup,
 * reader page, content scripts, and the Chrome service worker bootstrap.
 */

(() => {
  if (typeof browser === "object" && browser && browser.runtime) return;
  const chromeApi = typeof chrome === "object" ? chrome : null;
  if (!chromeApi || !chromeApi.runtime) return;
  globalThis.browser = chromeApi;
})();
