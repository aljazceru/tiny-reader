/*
 * tiny reader — full-page reader workspace.
 *
 * Everything here runs in the extension tab and drives playback through the
 * background's runtime messages (readBlocks for direct input, the transport
 * and prefs messages shared with the popup). The workspace polls getState
 * every 400 ms like the popup, renders progress and the current sentence,
 * fills the voice select from state.model.voices, and holds the background
 * keepalive port open while a read is active — exactly what the content
 * script does on normal pages. Text sources: pasted text, .txt/.html files,
 * a fetched URL, and PDF/ePub files via the sibling extractor modules.
 */

"use strict";

import { extractPdf } from "./pdf.js";
import { extractEpub } from "./epub.js";
import { mountModels } from "./models.js";
import { blocksFromText, extractHtml, extractUrl } from "./extract.js";
import { requestOrigin } from "./permissions.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 400;
const NOTICE_MS = 6000; // how long a local notice survives the next polls
const speedLabel = (value) => `${Number(value)}×`;

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 4.8 19 12 7.5 19.2z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h3.4v14H6.5zM14.1 5h3.4v14h-3.4z"/></svg>',
};
const BUSY = ["loading", "planning", "playing", "paused"];

const STATUS_TEXT = {
  loading: "Loading the voice model…",
  planning: "Preparing the text…",
  playing: "Reading…",
  paused: "Paused",
  done: "Finished reading.",
  idle: "",
};

const SOURCE_LABELS = {
  paste: "pasted text",
  url: "web page",
  txt: "file",
  pdf: "PDF",
  epub: "ePub",
};

const VOICE_LABELS = { M2: "M2 (male)", F2: "F2 (female)" };

let state = { status: "idle" };
let lastRead = null; // { title, url, blocks, source } of the last read started here
let notice = null; // { text, error, at, baseStatus } local status message
let voicesKey = null;
let keepalive = null;

/* ------------------------------------------------------------ messages */

const describe = (error) => String((error && error.message) || error);

function setNotice(text, error = false) {
  notice = { text, error, at: Date.now(), baseStatus: state.status };
  renderStatus();
}

async function send(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (error) {
    setNotice(describe(error), true);
    return undefined;
  }
}

async function refresh() {
  try {
    const next = await browser.runtime.sendMessage({ type: "getState" });
    if (!next || typeof next !== "object") throw new Error("bad state");
    state = next;
  } catch {
    state = { ...state, status: "error", error: "The reader background is not responding." };
  }
  render();
}

/* Start reading direct input through the background. */
async function readInput(input) {
  const blocks = ((input && input.blocks) || []).filter((b) => typeof b === "string" && b.trim());
  if (!blocks.length) return setNotice("There is no text to read.", true);
  const message = {
    type: "readBlocks",
    title: input.title || "",
    url: input.url || "",
    blocks,
    source: input.source || "paste",
  };
  try {
    await browser.runtime.sendMessage(message);
  } catch (error) {
    return setNotice(describe(error), true);
  }
  lastRead = { ...input, blocks };
  refresh();
}

/* -------------------------------------------------------------- inputs */

$("readPaste").addEventListener("click", () => {
  readInput({ title: "Pasted text", url: "", blocks: blocksFromText($("pasteText").value), source: "paste" });
});

$("pasteText").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    $("readPaste").click();
  }
});

async function readUrl() {
  const url = $("urlInput").value.trim();
  if (!url) return setNotice("Enter a page URL first.", true);
  setNotice("Fetching the page…");
  try {
    /* permissions.request must be the first await in this handler: Firefox
     * drops the user gesture (and with it the prompt) after any earlier
     * await. The scheme defaulting matches what extractUrl applies. */
    const page = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    const grant = await requestOrigin(page, "read this page");
    if (!grant.granted) return setNotice(grant.message, true);
    const { title, blocks } = await extractUrl(url);
    await readInput({ title, url, blocks, source: "url" });
  } catch (error) {
    setNotice(describe(error), true);
  }
}

$("readUrl").addEventListener("click", readUrl);
$("urlInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    readUrl();
  }
});

/* One shared file input: dispatch on extension to the right extractor. */
async function readFile(file) {
  const name = file.name || "file";
  const extension = (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  setNotice(`Opening ${name}…`);
  try {
    if (extension === "txt") {
      const text = await file.text();
      await readInput({ title: name.replace(/\.[a-z0-9]+$/i, ""), url: "", blocks: blocksFromText(text), source: "txt" });
    } else if (extension === "html" || extension === "htm") {
      const { title, blocks } = extractHtml(await file.text(), "");
      await readInput({ title, url: "", blocks, source: "txt" });
    } else if (extension === "pdf") {
      const { title, blocks } = await extractPdf(file);
      await readInput({ title, url: "", blocks, source: "pdf" });
    } else if (extension === "epub") {
      const { title, blocks } = await extractEpub(file);
      await readInput({ title, url: "", blocks, source: "epub" });
    } else {
      setNotice(`“${name}” is not a txt, html, pdf or epub file.`, true);
    }
  } catch (error) {
    setNotice(`${name}: ${describe(error)}`, true);
  }
}

$("fileInput").addEventListener("change", () => {
  const [file] = $("fileInput").files || [];
  $("fileInput").value = ""; // allow picking the same file again
  if (file) readFile(file);
});

/* ----------------------------------------------------------- transport */

$("playPause").addEventListener("click", () => {
  send({ type: state.status === "paused" ? "resume" : "pause" });
});
$("stop").addEventListener("click", () => {
  setReading(false); // matches the background: a closed keepalive stops playback
  send({ type: "stop" });
});
$("prev").addEventListener("click", () => send({ type: "prev" }));
$("next").addEventListener("click", () => send({ type: "next" }));

$("readAgain").addEventListener("click", () => {
  if (!lastRead) return setNotice("Read something first — there is nothing to read again.", true);
  readInput(lastRead);
});

$("voice").addEventListener("change", () => send({ type: "setPrefs", patch: { voice: $("voice").value } }));
$("speed").addEventListener("input", () => {
  $("speedValue").textContent = speedLabel(Number($("speed").value));
});
$("speed").addEventListener("change", () => send({ type: "setPrefs", patch: { speed: Number($("speed").value) } }));

/* ------------------------------------------------------------ keepalive */

/* While this tab drives a read (loading/planning/playing/paused), hold the
 * same runtime port the content script holds, so Firefox keeps the event
 * page alive for long direct reads. */
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

/* -------------------------------------------------------------- render */

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function renderVoices() {
  const voices = (state.model && state.model.voices) || [];
  const key = voices.join("\n");
  if (key !== voicesKey) {
    voicesKey = key;
    const wanted = (state.prefs && state.prefs.voice) || $("voice").value;
    const options = voices.length
      ? voices.map((id) => new Option(VOICE_LABELS[id] || id, id))
      : [Object.assign(new Option("No voices available", ""), { disabled: true })];
    $("voice").replaceChildren(...options);
    const values = [...$("voice").options].map((option) => option.value);
    $("voice").value = values.includes(wanted) ? wanted : (values[0] || "");
  }
  if (state.prefs && document.activeElement !== $("voice")) {
    const values = [...$("voice").options].map((option) => option.value);
    if (values.includes(state.prefs.voice)) $("voice").value = state.prefs.voice;
  }
}

function renderStatus() {
  if (notice && (Date.now() - notice.at > NOTICE_MS || state.status !== notice.baseStatus)) notice = null;
  const backgroundText = state.status === "error" ? (state.error || "Something went wrong.") : STATUS_TEXT[state.status] || "";
  $("status").textContent = notice ? notice.text : backgroundText;
  $("status").classList.toggle("error", Boolean(notice ? notice.error : state.status === "error"));
}

function render() {
  const busy = BUSY.includes(state.status);
  const total = state.total || 0;
  const index = typeof state.index === "number" ? state.index : -1;

  $("playPause").innerHTML = (state.status === "paused" ? ICONS.play : ICONS.pause)
    + `<span>${state.status === "paused" ? "Resume" : "Pause"}</span>`;
  $("playPause").disabled = !busy;
  $("stop").disabled = !busy;
  $("prev").disabled = !busy || index <= 0;
  $("next").disabled = !busy || (total ? index + 1 >= total : index < 0);
  $("readAgain").disabled = !lastRead;

  let progress = "Nothing is being read.";
  if (state.status === "done") {
    progress = "Finished reading.";
  } else if (busy) {
    const parts = [total ? `Sentence ${Math.min(index + 1, total)} of ${total}` : "Preparing…"];
    const label = SOURCE_LABELS[state.source] || state.source;
    if (label) parts.push(label);
    if (state.page && state.page.title) parts.push(truncate(state.page.title.trim(), 40));
    progress = parts.join(" · ");
    if (state.status === "paused") progress += " · paused";
  }
  $("progress").textContent = progress;
  $("preview").textContent = state.preview || "";

  renderVoices();
  if (state.prefs && document.activeElement !== $("speed")) $("speed").value = String(state.prefs.speed);
  $("speedValue").textContent = speedLabel(Number($("speed").value));
  renderStatus();
  setReading(busy);
}

/* ------------------------------------------------------------- startup */

mountModels($("models"), { onChanged: () => refresh() });

refresh();
setInterval(refresh, POLL_MS);
