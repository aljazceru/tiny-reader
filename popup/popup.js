/*
 * tiny reader — popup.
 *
 * Thin view over the background state: polls it every 400 ms while open
 * (an open popup also keeps the event page loaded), sends play/pause/stop/
 * seek/pref messages, and opens the reader workspace. Selection-first: when
 * text is selected, "Read selection" is the primary action; otherwise the
 * popup reads the page. Voice options follow the active model's voices.
 */

"use strict";

const $ = (id) => document.getElementById(id);

const speedLabel = (value) => `${Number(value)}×`;

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 4.8 19 12 7.5 19.2z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h3.4v14H6.5zM14.1 5h3.4v14h-3.4z"/></svg>',
};
const STATUS_TEXT = {
  loading: "Loading the voice model…",
  planning: "Preparing the text…",
  playing: "Reading…",
  paused: "Paused",
  done: "Finished reading.",
  idle: "",
};

const FALLBACK_VOICES = ["M2", "F2"];

let renderedVoices = "";

let state = { status: "idle", prefs: null, hasSelection: false, model: null };

async function refresh() {
  try {
    state = await browser.runtime.sendMessage({ type: "getState" });
  } catch (error) {
    state = { status: "error", error: "Background page unavailable", prefs: null };
  }
  render();
}

function render() {
  const busy = ["loading", "planning", "playing", "paused"].includes(state.status);
  $("idle").hidden = busy;
  $("transport").hidden = !busy;

  const hasSelection = Boolean(state.hasSelection);
  $("readSelection").disabled = !hasSelection;
  $("readSelection").textContent = hasSelection ? "Read selection" : "Nothing selected";
  $("selectionHint").textContent = hasSelection
    ? "Only the selection will be read."
    : "Select text on the page first — only the selection is read, or read the whole page.";

  $("playPause").innerHTML = (state.status === "paused" ? ICONS.play : ICONS.pause)
    + `<span>${state.status === "paused" ? "Resume" : "Pause"}</span>`;
  const progress = state.total
    ? `Sentence ${Math.min(state.index + 1, state.total)} of ${state.total}${state.source === "selection" ? " · selection" : ""}`
    : "Preparing…";
  $("progress").textContent = state.status === "paused" ? `${progress} · paused` : progress;
  $("preview").textContent = state.preview || "";

  const status = state.status === "error" ? state.error : STATUS_TEXT[state.status] || "";
  $("status").textContent = status;
  $("status").classList.toggle("error", state.status === "error");

  renderVoices(state.model && state.model.voices);

  const prefs = state.prefs;
  if (prefs) {
    const voice = $("voice");
    if (document.activeElement !== voice && [...voice.options].some((option) => option.value === prefs.voice)) {
      voice.value = prefs.voice;
    }
    if (document.activeElement !== $("speed")) $("speed").value = String(prefs.speed);
    $("speedValue").textContent = speedLabel(Number($("speed").value));
  }
}

/* Voice options follow the active model (state.model.voices); the bundled
 * M2/F2 pair until a worker reports otherwise. Rebuilt only when the set
 * changes so the 400 ms poll never disturbs an open select. */
function renderVoices(voices) {
  const list = Array.isArray(voices) && voices.length ? voices.map(String) : FALLBACK_VOICES;
  const key = list.join("|");
  if (key === renderedVoices) return;
  renderedVoices = key;
  const select = $("voice");
  const keep = document.activeElement === select ? select.value : null;
  select.textContent = "";
  for (const name of list) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  if (keep && list.includes(keep)) select.value = keep;
}

function send(message) {
  browser.runtime.sendMessage(message).catch(() => refresh());
}

$("readSelection").addEventListener("click", () => send({ type: "play", source: "selection" }));
$("readPage").addEventListener("click", () => send({ type: "play", source: "page" }));
$("playPause").addEventListener("click", () => send({ type: state.status === "paused" ? "resume" : "pause" }));
$("stop").addEventListener("click", () => send({ type: "stop" }));
$("next").addEventListener("click", () => send({ type: "next" }));
$("prev").addEventListener("click", () => send({ type: "prev" }));
$("speed").addEventListener("input", () => {
  $("speedValue").textContent = speedLabel(Number($("speed").value));
});
$("speed").addEventListener("change", () => send({ type: "setPrefs", patch: { speed: Number($("speed").value) } }));
$("openReader").addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "openReader" }).then(() => window.close()).catch(() => {});
});

refresh();
setInterval(refresh, 400);
