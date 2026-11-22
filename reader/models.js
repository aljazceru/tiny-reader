/*
 * tiny reader — model manager for the reader page.
 *
 * mountModels(root, hooks) mounts the "Models" section: the active model,
 * an editable name, a GGUF file picker, a direct HTTPS URL download, and a
 * few curated community links. The heavy lifting — download, validation in
 * a fresh synthesis worker, persistence in IndexedDB across sessions — is
 * the background page's job, reached with the `setModel` message (bytes for
 * local files, URL for remote ones). Only tiny-voca GGUFs with an embedded
 * phonemizer are accepted; anything else is rejected by the engine and the
 * error surfaces in the status line.
 */

/* Curated, known-good sources of tiny-voca-compatible GGUFs. Links point at
 * model repositories; download a file and paste its direct URL above. */
const COMMUNITY = [
  { name: "tiny-voca (upstream weights)", url: "https://huggingface.co/n4ze3m/tiny-voca" },
  { name: "tiny-voca-GGUF (community quants)", url: "https://huggingface.co/prithivMLmods/tiny-voca-GGUF" },
  { name: "all tiny-voca quantizations", url: "https://huggingface.co/models?other=base_model:quantized:n4ze3m/tiny-voca" },
];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

/* "Lilia-Q8.gguf" → "Lilia-Q8"; a URL's last path segment, likewise. */
function suggestName(fileNameOrUrl) {
  const tail = String(fileNameOrUrl).split(/[/?#]/).filter(Boolean).pop() || fileNameOrUrl;
  return tail.replace(/\.gguf$/i, "").trim() || "custom";
}

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function mountModels(root, hooks = {}) {
  /* Resolved per call: Chrome can redefine the browser namespace after
   * module load, which orphans captured references. */
  const runtime = { sendMessage: (message) => (globalThis.browser || globalThis.chrome).runtime.sendMessage(message) };
  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle("tv-model-error", bad);
    if (hooks.onStatus) hooks.onStatus(text);
  };

  const head = el("h2", { text: "Model" });
  const activeModel = el("p", { id: "activeModel", class: "tv-model-active", text: "Active model: checking…" });
  const explain = el("p", { class: "tv-model-note" });
  explain.append(
    "Models must be tiny-voca GGUF files with an embedded phonemizer (built with tiny-voca's ",
    el("a", { href: "https://github.com/n4ze3m/tiny-voca", target: "_blank", rel: "noreferrer", text: "packing tools" }),
    "). Arbitrary GGUFs — LLM weights and the like — are rejected.",
  );
  const nameLabel = el("label", { class: "tv-model-row" }, "Name");
  const name = el("input", { id: "modelName", type: "text", placeholder: "my-model", spellcheck: "false" });
  nameLabel.append(name);
  const endpointHead = el("h2", { text: "Remote TTS endpoint" });
  const endpointNote = el("p", { class: "tv-model-note" },
    "Use an OpenAI-compatible /audio/speech endpoint instead of a local model. ",
    "Text and your API key (stored locally in this browser only) go to that server when reading.");
  const remoteNameLabel = el("label", { class: "tv-model-row" }, "Name");
  const remoteName = el("input", { id: "remoteName", type: "text", placeholder: "my-openai", spellcheck: "false" });
  remoteNameLabel.append(remoteName);
  const remoteUrlLabel = el("label", { class: "tv-model-row" }, "Endpoint URL");
  const remoteUrl = el("input", { id: "remoteUrl", type: "url", placeholder: "https://api.openai.com/v1/audio/speech", spellcheck: "false" });
  remoteUrlLabel.append(remoteUrl);
  const remoteKeyLabel = el("label", { class: "tv-model-row" }, "API key (optional)");
  const remoteKey = el("input", { id: "remoteKey", type: "password", placeholder: "sk-…", autocomplete: "off" });
  remoteKeyLabel.append(remoteKey);
  const remoteModelLabel = el("label", { class: "tv-model-row" }, "Model id (optional)");
  const remoteModel = el("input", { id: "remoteModel", type: "text", placeholder: "gpt-4o-mini-tts", spellcheck: "false" });
  remoteModelLabel.append(remoteModel);
  const remoteVoicesLabel = el("label", { class: "tv-model-row" }, "Voices (comma-separated)");
  const remoteVoices = el("input", { id: "remoteVoices", type: "text", placeholder: "alloy, echo, fable, onyx, nova, shimmer", spellcheck: "false" });
  remoteVoicesLabel.append(remoteVoices);
  const applyRemote = el("button", { id: "applyRemote", type: "button", text: "Use this endpoint" });
  const fileLabel = el("label", { class: "tv-model-row" }, "GGUF file");
  const file = el("input", { id: "modelFile", type: "file", accept: ".gguf" });
  fileLabel.append(file);
  const urlLabel = el("label", { class: "tv-model-row" }, "Or direct HTTPS URL");
  const url = el("input", { id: "modelUrl", type: "url", placeholder: "https://example.org/model.gguf", spellcheck: "false" });
  urlLabel.append(url);
  const apply = el("button", { id: "applyModel", type: "button", text: "Use this model" });
  const status = el("p", { id: "modelStatus", class: "tv-model-status", "aria-live": "polite" });
  const community = el("p", { class: "tv-model-note" }, "Community GGUFs: ");
  COMMUNITY.forEach((link, index) => {
    if (index) community.append(" · ");
    community.append(el("a", { href: link.url, target: "_blank", rel: "noreferrer", text: link.name }));
  });
  const style = el("style", { text: `
    .tv-models h2 { margin: 0 0 12px; }
    .tv-models h2:not(:first-child) { margin-top: 1.8rem; }
    .tv-models input[type="text"], .tv-models input[type="url"], .tv-models input[type="password"] { width: min(100%, 34rem); box-sizing: border-box; }
    .tv-models .tv-model-note, .tv-models .tv-model-status { font-size: 0.85rem; color: var(--muted, #555); }
    .tv-models .tv-model-error { color: var(--error, #b3261e); }
  ` });

  const section = el("div", { class: "tv-models" }, style, head, activeModel, explain, nameLabel, fileLabel, urlLabel, apply, status, community,
    endpointHead, endpointNote, remoteNameLabel, remoteUrlLabel, remoteKeyLabel, remoteModelLabel, remoteVoicesLabel, applyRemote);
  root.append(section);

  // The GGUF staged by the file picker, sent as bytes on apply.
  let staged = null;

  async function refresh() {
    if (!runtime) return;
    try {
      const state = await runtime.sendMessage({ type: "getState" });
      const model = state && state.model;
      activeModel.textContent = model
        ? `Active model: ${model.name}${model.voices ? ` (voices: ${model.voices.join(", ")})` : ""}`
        : "Active model: unknown";
    } catch {
      activeModel.textContent = "Active model: unknown";
    }
  }

  file.addEventListener("change", async () => {
    const picked = file.files && file.files[0];
    staged = null;
    if (!picked) return;
    if (!/\.gguf$/i.test(picked.name)) {
      say(`"${picked.name}" is not a GGUF file.`, true);
      return;
    }
    if (!name.value.trim()) name.value = suggestName(picked.name);
    try {
      staged = { name: picked.name, buffer: await picked.arrayBuffer() };
      say(`Loaded "${picked.name}" (${megabytes(staged.buffer.byteLength)}) — press "Use this model".`);
    } catch (error) {
      say(`Could not read "${picked.name}": ${String((error && error.message) || error)}`, true);
    }
  });

  url.addEventListener("input", () => {
    if (url.value.trim()) staged = null; // the last-touched source wins
  });

  apply.addEventListener("click", async () => {
    if (!runtime) {
      say("The model manager only works inside the extension.", true);
      return;
    }
    const download = url.value.trim();
    if (!staged && !download) {
      say("Pick a GGUF file or paste a direct URL to a GGUF.", true);
      return;
    }
    if (download) {
      try {
        if (!/^https?:$/.test(new URL(download).protocol)) throw new Error("only http(s) URLs are supported");
      } catch (error) {
        say(`Invalid URL: ${String((error && error.message) || error)}`, true);
        return;
      }
    }
    const model = staged
      ? { name: name.value.trim() || suggestName(staged.name), buffer: staged.buffer }
      : { name: name.value.trim() || suggestName(download), url: download };
    apply.disabled = true;
    file.disabled = true;
    say(staged
      ? `Validating "${model.name}" (${megabytes(model.buffer.byteLength)})…`
      : `Downloading and validating "${model.name}"…`);
    try {
      const active = await runtime.sendMessage({ type: "setModel", ...model });
      say(`✓ "${active.name}" is now the active model${active.voices ? ` (voices: ${active.voices.join(", ")})` : ""}.`);
      await refresh();
      if (hooks.onChanged) hooks.onChanged();
    } catch (error) {
      say(`Model rejected: ${String((error && error.message) || error)}`, true);
    } finally {
      apply.disabled = false;
      file.disabled = false;
    }
  });
  applyRemote.addEventListener("click", async () => {
    if (!runtime) {
      say("The model manager only works inside the extension.", true);
      return;
    }
    const voices = remoteVoices.value.split(",").map((voice) => voice.trim()).filter(Boolean);
    const remote = {
      name: remoteName.value.trim(),
      url: remoteUrl.value.trim(),
      apiKey: remoteKey.value.trim(),
      model: remoteModel.value.trim(),
      voices: voices.length ? voices : undefined,
    };
    if (!remote.url) {
      say("Paste the endpoint URL first.", true);
      return;
    }
    applyRemote.disabled = true;
    say(`Checking "${remote.name || remoteUrl}"…`);
    try {
      const active = await runtime.sendMessage({ type: "setModel", remote });
      say(`✓ "${active.name}" is now the active endpoint (voices: ${active.voices.join(", ")}).`);
      await refresh();
      if (hooks.onChanged) hooks.onChanged();
    } catch (error) {
      say(`Endpoint rejected: ${String((error && error.message) || error)}`, true);
    } finally {
      applyRemote.disabled = false;
    }
  });
  refresh();
}
