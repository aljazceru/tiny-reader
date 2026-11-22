/*
 * The background page injects the content script on demand: a failed
 * sendMessage triggers scripting.executeScript (compat first, so `browser`
 * exists in Chrome pages too), then the extract question is asked again.
 * Pages the browser refuses to script are rejected before any attempt.
 *
 * loadBackground(fakes) runs the classic background scripts in a node:vm
 * sandbox — same files and order as background/chrome-sw.js — with a fake
 * browser API; it is shared with the install/update tests.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const SCRIPTS = [
  "compat/compat.js",
  "logic/chunks.js",
  "logic/remote.js",
  "logic/model-store.js",
  "logic/prefs.js",
  "background/engine-host.js",
  "background/player.js",
  "background/background.js",
];
const INJECT_FILES = ["compat/compat.js", "vendor/readability.js", "content/content.js"];

/* fakes: { sendMessage, executeScript, storage } — behaviors and seed data.
 * Returns the sandbox, the fake browser, recorded calls, and the listeners
 * the scripts registered. */
function loadBackground(fakes = {}) {
  const calls = { sendMessage: [], executeScript: [], menus: [], tabsCreate: [], storageRemove: [] };
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); } });
  const store = { ...(fakes.storage || {}) };
  const browser = {
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    commands: { onCommand: on("command") },
    menus: { create: (info) => calls.menus.push(info), onClicked: on("menuClick") },
    runtime: {
      getURL: (path) => `moz-extension://fake/${path}`,
      onConnect: on("connect"),
      onInstalled: on("installed"),
      onMessage: on("message"),
    },
    scripting: {
      executeScript: (details) => {
        calls.executeScript.push(details);
        return fakes.executeScript ? fakes.executeScript(details) : Promise.resolve();
      },
    },
    storage: {
      local: {
        get: (keys) => {
          const defaults = keys && typeof keys === "object" && !Array.isArray(keys) ? keys : {};
          const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(defaults);
          const result = { ...defaults };
          for (const key of wanted) if (key in store) result[key] = store[key];
          return Promise.resolve(result);
        },
        set: (entries) => { Object.assign(store, entries); return Promise.resolve(); },
        remove: (keys) => {
          calls.storageRemove.push([].concat(keys));
          for (const key of [].concat(keys)) delete store[key];
          return Promise.resolve();
        },
      },
    },
    tabs: {
      create: (details) => { calls.tabsCreate.push(details); return Promise.resolve({ id: 1 }); },
      onRemoved: on("tabRemoved"),
      query: () => Promise.resolve([]),
      sendMessage: (...args) => {
        calls.sendMessage.push(args);
        if (fakes.sendMessage) return fakes.sendMessage(...args);
        return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
      },
    },
  };
  const sandbox = {
    browser,
    console,
    navigator: { userAgent: "Firefox" },
    setTimeout,
    clearTimeout,
    URL,
    fetch: () => Promise.reject(new Error("no network in tests")),
  };
  vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    vm.runInContext(readFileSync(join(root, file), "utf8"), sandbox, { filename: file });
  }
  return { sandbox, browser, calls, listeners };
}

test("extract injects compat first, then asks again", async () => {
  let asked = 0;
  const h = loadBackground({
    sendMessage: () => ++asked === 1
      ? Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))
      : Promise.resolve({ blocks: ["x"], source: "page" }),
  });
  const page = await h.sandbox.extract({ id: 7, url: "https://example.com/" }, "page");
  assert.equal(asked, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(page)), { blocks: ["x"], source: "page" });
  assert.equal(h.calls.executeScript.length, 1);
  /* The injection request is built inside the vm realm; normalize before
   * comparing. */
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.executeScript[0])), {
    target: { tabId: 7 },
    files: INJECT_FILES,
  });
});

test("store and browser pages are refused up front", () => {
  const h = loadBackground();
  const refused = [
    "https://chromewebstore.google.com/detail/x",
    "https://chrome.google.com/webstore/detail/x",
    "https://addons.mozilla.org/en-US/firefox/",
    "chrome://newtab",
    "about:reader?url=x",
  ];
  for (const url of refused) {
    assert.ok(h.sandbox.readable({ id: 1, url }), `${url} should be refused`);
  }
  assert.equal(h.sandbox.readable({ id: 1, url: "https://example.com/" }), null);
});

test("injection failure gets a specific error", async () => {
  const h = loadBackground({
    sendMessage: () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")),
    executeScript: () => Promise.reject(new Error("Cannot access contents of the page")),
  });
  let error = null;
  try {
    await h.sandbox.extract({ id: 1, url: "https://example.com/" }, "page");
  } catch (e) {
    error = e;
  }
  assert.equal(
    error && error.message,
    "tiny reader can't read this page. Try selecting the text and using the right-click menu, or open it in the reader workspace.",
  );
});

test("install opens the welcome page once", () => {
  const h = loadBackground();
  for (const fn of h.listeners.installed) fn({ reason: "install" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.tabsCreate)), [{ url: "welcome/welcome.html" }]);
});

test("update drops the old library keys but opens no page", () => {
  const h = loadBackground();
  for (const fn of h.listeners.installed) fn({ reason: "update" });
  assert.equal(h.calls.tabsCreate.length, 0);
  assert.deepEqual(h.calls.storageRemove, [["libraryItems", "queueIds"]]);
});

/* A selection inside a cross-origin iframe is invisible to the top-frame
 * extractor (activeTab covers only the tab's own origin), but the context
 * menu hands over the selected text itself — read that instead. */
test("right-click reads the menu's selection text when extraction finds none", async () => {
  const h = loadBackground({
    sendMessage: (tabId, message) => Promise.resolve(
      message.type === "extract" ? { title: "Doc", source: "selection", blocks: [] } : null),
  });
  const jobs = [];
  h.sandbox.ensureModelLoaded = () => Promise.resolve();
  h.sandbox.beginJob = (job) => { jobs.push(JSON.parse(JSON.stringify(job))); };
  const tab = { id: 3, url: "https://example.com/doc", title: "Doc" };
  for (const fn of h.listeners.menuClick) {
    await fn({ menuItemId: "tv-selection", selectionText: "  Text inside a frame.  " }, tab);
  }
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].blocks, ["Text inside a frame."]);
  assert.equal(jobs[0].source, "selection");
  assert.equal(jobs[0].tabId, 3);
});

/* Regression: an already-injected content script's empty answer skipped the
 * checks and reached the engine as zero blocks ("Nothing to pronounce
 * here.") instead of saying nothing was selected. */
test("an empty answer from an injected page is an error, not an empty job", async () => {
  const h = loadBackground({
    sendMessage: () => Promise.resolve({ title: "Doc", source: "selection", blocks: [] }),
  });
  await assert.rejects(
    h.sandbox.extract({ id: 1, url: "https://example.com/" }, "selection"),
    { message: "No text selected — select the text you want read first." },
  );
  assert.equal(h.calls.executeScript.length, 0);
});
