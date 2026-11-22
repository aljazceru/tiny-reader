/*
 * tiny reader — first-run welcome page.
 *
 * Opened once by the background on install (never on update). "Hear it"
 * reads one sample sentence through the shared readBlocks path — proof the
 * voice works, and the first model load. The shortcut row shows the real
 * binding from commands.getAll() and links to the browser's shortcut
 * settings. While a read is busy the page holds the same tv-keepalive port
 * the reader workspace holds, so the background stays alive for it.
 */

"use strict";

const $ = (id) => document.getElementById(id);
const POLL_MS = 400;
const BUSY = ["loading", "planning", "playing", "paused"];
const SAMPLE_TEXT = '"Hello! This is tiny reader. Select any text on a page and I will read it to you."';

const STATUS_TEXT = {
  loading: "Loading the voice model…",
  planning: "Preparing the text…",
  playing: "Reading…",
  paused: "Paused",
  done: "Finished reading.",
  idle: "",
};

let keepalive = null;
let status = "idle";
let errorText = "";

const describe = (error) => String((error && error.message) || error);

/* ------------------------------------------------------------ keepalive */

/* Same contract as reader/reader.js: while this tab drives a read, hold the
 * runtime port that keeps the background alive; dropping it stops playback. */
function setReading(on) {
  if (on && !keepalive) {
    keepalive = browser.runtime.connect({ name: "tv-keepalive" });
    keepalive.onDisconnect.addListener(() => { keepalive = null; });
  } else if (!on && keepalive) {
    keepalive.disconnect();
    keepalive = null;
  }
}

window.addEventListener("pagehide", () => setReading(false));

/* -------------------------------------------------------------- hear it */

function render() {
  $("hearIt").disabled = BUSY.includes(status);
  $("status").textContent = status === "error" ? (errorText || "Something went wrong.") : STATUS_TEXT[status] || "";
  $("status").classList.toggle("error", status === "error");
}

async function poll() {
  let next = null;
  try {
    next = await browser.runtime.sendMessage({ type: "getState" });
  } catch (error) { /* background unreachable — stop polling */ }
  status = (next && next.status) || "error";
  errorText = (next && next.error) || errorText;
  render();
  if (BUSY.includes(status)) setTimeout(poll, POLL_MS);
  else setReading(false);
}

$("hearIt").addEventListener("click", async () => {
  setReading(true); // held until the read leaves the busy states
  errorText = "";
  try {
    await browser.runtime.sendMessage({
      type: "readBlocks",
      title: "tiny reader welcome",
      url: "",
      blocks: [SAMPLE_TEXT],
      source: "paste",
    });
  } catch (error) {
    setReading(false);
    status = "error";
    errorText = describe(error);
    render();
    return;
  }
  poll();
});

/* ------------------------------------------------------------- shortcut */

browser.commands.getAll().then((commands) => {
  const command = (commands || []).find((entry) => entry.name === "toggle-read");
  $("shortcut").textContent = command && command.shortcut ? command.shortcut : "not set";
}).catch(() => {
  $("shortcut").textContent = "not set";
});

$("changeShortcut").addEventListener("click", () => {
  /* Firefox exposes a shortcut-settings opener; Chrome has a fixed page. */
  if (typeof browser.commands.openShortcutSettings === "function") {
    browser.commands.openShortcutSettings();
  } else {
    browser.tabs.create({ url: "chrome://extensions/shortcuts" });
  }
});

/* ------------------------------------------------------------ workspace */

$("openWorkspace").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "openReader" });
});
