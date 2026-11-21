/*
 * tiny reader — content script.
 *
 * Injected on demand (activeTab + scripting, no manifest content_scripts).
 * Extracts what to read, selection first:
 *
 *  - selection: the selected ranges are walked text node by text node and
 *    grouped by their nearest block element (p, li, h1–h6, …). Blocks keep
 *    live references, so the paragraph being read can be highlighted and
 *    scrolled into view exactly.
 *  - page: Mozilla Readability runs on a document clone for clean article
 *    text; its blocks are matched back to live elements by collapsed text
 *    for highlighting. If Readability finds nothing, visible block elements
 *    of the live DOM are used directly.
 *
 * Also holds the keepalive runtime port while its tab is being read, and shows
 * a floating in-page mini-player (Shadow DOM) while reading is active.
 */

(() => {
  "use strict";
  if (window.__tinyReaderLoaded) return; // re-injection guard
  window.__tinyReaderLoaded = true;

  const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption,dd,dt";
  const JUNK = "nav,aside,footer,header,form,noscript,[hidden],[aria-hidden='true']";
  const FALLBACK = "div,section,article,main,td,body";
  const MARK = "tiny-reader-reading";
  const CHAR_CAP = 500000;

  const collapse = (text) => text.replace(/\s+/g, " ").trim();

  /* ------------------------------------------------------------ blocks */

  function blockAncestor(node) {
    let element = node.parentElement;
    let fallback = null;
    while (element) {
      if (!fallback && element.matches(FALLBACK)) fallback = element;
      if (element.matches(BLOCKS)) return element;
      element = element.parentElement;
    }
    return fallback;
  }

  /* Selected text → blocks with live element references. */
  function selectionBlocks() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return { texts: [], elements: [] };
    const order = [];
    const parts = new Map();
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return range.intersectsNode(node) && node.textContent.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.textContent.length;
        if (end <= start) continue;
        const element = blockAncestor(node);
        if (!element) continue;
        if (parts.has(element)) parts.get(element).push(node.textContent.slice(start, end));
        else { parts.set(element, [node.textContent.slice(start, end)]); order.push(element); }
      }
    }
    const blocks = [];
    const elements = [];
    for (const element of order) {
      const text = collapse(parts.get(element).join(" "));
      if (text) { blocks.push(text); elements.push(element); }
      if (blocks.join(" ").length > CHAR_CAP) break;
    }
    return { texts: blocks, elements };
  }

  /* Block elements of a DOM tree (live page or Readability output). */
  function domBlocks(root, detached) {
    const blocks = [];
    let total = 0;
    for (const element of root.querySelectorAll(BLOCKS)) {
      if (!detached && element.closest(JUNK)) continue;
      if (element.parentElement && element.parentElement.closest(BLOCKS)) continue; // keep the outermost block
      if (!detached && element.getClientRects().length === 0) continue;
      const text = collapse(element.textContent);
      if (text.length < 2) continue;
      blocks.push({ element: detached ? null : element, text });
      total += text.length + 1;
      if (total > CHAR_CAP) break;
    }
    return blocks;
  }

  function pageBlocks() {
    const live = domBlocks(document.body, false);
    const byText = new Map();
    for (const block of live) if (!byText.has(block.text)) byText.set(block.text, block.element);

    let title = document.title;
    let blocks = live;
    try {
      if (typeof Readability !== "undefined") {
        const article = new Readability(document.cloneNode(true)).parse();
        const length = collapse((article && article.textContent) || "").length;
        if (article && length >= 240) {
          const dom = new DOMParser().parseFromString(article.content || "", "text/html");
          const parsed = domBlocks(dom.body, true);
          if (parsed.length >= Math.min(3, live.length)) {
            blocks = parsed;
            title = article.title || title;
          }
        }
      }
    } catch (error) { /* Readability is best effort */ }

    if (!blocks.length) {
      const text = collapse(document.body ? document.body.innerText : "");
      if (text.length >= 2) blocks = [{ element: document.body, text: text.slice(0, CHAR_CAP) }];
    }
    return {
      title,
      texts: blocks.map((block) => block.text),
      elements: blocks.map((block) => block.element || byText.get(block.text) || null),
    };
  }

  function extract(source) {
    if (source === "selection" || source === "auto") {
      const selection = selectionBlocks();
      if (selection.texts.length || source === "selection") {
        return { title: document.title, source: "selection", blocks: selection.texts, elements: selection.elements };
      }
    }
    const page = pageBlocks();
    return { title: page.title, source: "page", blocks: page.texts, elements: page.elements };
  }

  /* --------------------------------------------------------- highlight */

  let elements = [];
  let marked = null;
  let port = null;

  function style() {
    if (document.getElementById("tiny-reader-style")) return;
    const element = document.createElement("style");
    element.id = "tiny-reader-style";
    element.textContent =
      `.${MARK}{background-color:rgba(255,193,7,.35);box-shadow:0 0 0 2px rgba(255,152,0,.55);border-radius:2px;}` +
      `@media (prefers-reduced-motion:reduce){.${MARK}{scroll-behavior:auto}}`;
    document.documentElement.appendChild(element);
  }

  function clearHighlight() {
    if (marked) { marked.classList.remove(MARK); marked = null; }
  }

  function highlight(blockId) {
    const element = elements[blockId];
    if (!element || !element.isConnected) return;
    style();
    clearHighlight();
    marked = element;
    element.classList.add(MARK);
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  }

  /* ---------------------------------------------------------- keepalive */

  function setReading(on) {
    if (on && !port) {
      port = browser.runtime.connect({ name: "tv-keepalive" });
      port.onDisconnect.addListener(() => { port = null; });
    } else if (!on && port) {
      port.disconnect();
      port = null;
    }
  }

  /* -------------------------------------------------------- mini-player */

  const MP_ICONS = {
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.2v14H6zM20 5.6v12.8L9.8 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.8 5H18v14h-2.2zM4 5.6v12.8L14.2 12z"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 4.8 19 12 7.5 19.2z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h3.4v14H6.5zM14.1 5h3.4v14h-3.4z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.2 5 5.8 5.8L17.8 5 19 6.2 13.2 12 19 17.8 17.8 19 12 13.2 6.2 19 5 17.8 10.8 12 5 6.2z"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9.4l5 5-1.2 1.2L12 11.8l-3.8 3.8L7 14.4z"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 14.6-5-5L8.2 8.4 12 12.2l3.8-3.8L17 9.6z"/></svg>',
  };
  const MP_STATUS = {
    loading: "Loading page…",
    planning: "Preparing sentences…",
    playing: "Reading",
    paused: "Paused",
    done: "Finished",
    error: "Error",
  };
  const MP_CSS = `
    :host{
      all:initial;
      position:fixed !important;
      right:16px !important;
      bottom:16px !important;
      display:block !important;
      z-index:2147483647 !important;
      width:min(320px,calc(100vw - 24px));
      transition:width .18s ease;
      font:12px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif;
      -webkit-user-select:none;user-select:none;
      --bg:#ffffff;--fg:#1f1f24;--muted:#5f6368;--line:rgba(0,0,0,.14);--chip:rgba(0,0,0,.06);
      --accent:#14804a;--warn:#e8a100;--bad:#b3261e;
    }
    @media (prefers-color-scheme:dark){
      :host{
        --bg:#1e1f24;--fg:#e8eaed;--muted:#9aa0a6;--line:rgba(255,255,255,.16);--chip:rgba(255,255,255,.09);
        --accent:#3ddc84;--warn:#fdd663;--bad:#f28b82;
      }
    }
    *{box-sizing:border-box;margin:0;padding:0}
    [hidden]{display:none !important}
    .card{
      background:var(--bg);color:var(--fg);
      border:1px solid var(--line);border-radius:12px;
      box-shadow:0 8px 28px rgba(0,0,0,.3);
      overflow:hidden;
    }
    :host([data-collapsed]){width:min(280px,calc(100vw - 24px))}
    :host([data-collapsed]) .preview,:host([data-collapsed]) .controls{display:none}
    .head{
      display:flex;align-items:center;gap:7px;
      padding:9px 6px 9px 12px;
      cursor:grab;touch-action:none;
    }
    .card.dragging .head{cursor:grabbing}
    .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--muted)}
    .dot.playing,.dot.done{background:var(--accent)}
    .dot.paused{background:var(--warn)}
    .dot.loading,.dot.planning{background:var(--warn);animation:mp-pulse 1.1s ease-in-out infinite}
    .dot.error{background:var(--bad)}
    .status{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
    .count{flex:none;color:var(--muted);font-variant-numeric:tabular-nums}
    .preview{
      display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;
      overflow:hidden;max-height:2.9em;
      padding:0 12px;color:var(--muted);
      -webkit-user-select:text;user-select:text;
    }
    .preview.error{color:var(--bad)}
    .controls{display:flex;align-items:center;gap:2px;padding:7px 8px 9px}
    .controls button{
      appearance:none;border:0;background:transparent;color:var(--fg);
      width:30px;height:30px;border-radius:8px;
      display:inline-flex;align-items:center;justify-content:center;
      cursor:pointer;transition:background-color .15s ease;
    }
    .controls button:hover{background:var(--chip)}
    .controls button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .controls button:disabled{opacity:.35;cursor:default;background:transparent}
    .controls button svg{width:16px;height:16px;fill:currentColor;display:block}
    .controls .pause{background:var(--chip)}
    .controls .pause:hover{background:var(--line)}
    .controls .pause:disabled{background:transparent}
    .controls .stop:hover{background:rgba(179,38,30,.18)}
    .queue{
      margin-left:auto;padding:2px 9px;border-radius:999px;
      background:var(--chip);color:var(--muted);font-size:11px;white-space:nowrap;
    }
    .track{
      position:relative;height:4px;margin:0 12px 11px;border-radius:2px;
      background:var(--chip);overflow:hidden;
    }
    .fill{
      position:absolute;top:0;bottom:0;left:0;width:0;
      border-radius:2px;background:var(--accent);
      transition:width .3s linear;
    }
    .track.indet .fill{width:38%;animation:mp-slide 1.3s ease-in-out infinite}
    @keyframes mp-pulse{50%{opacity:.35}}
    @keyframes mp-slide{from{transform:translateX(-105%)}to{transform:translateX(265%)}}
    @media (prefers-reduced-motion:reduce){
      *{animation:none !important;transition:none !important}
    }
  `;
  const MP_MARKUP = `
    <div class="card" role="region" aria-label="tiny-voca mini player">
      <div class="head">
        <span class="dot" data-role="dot"></span>
        <span class="status" data-role="status">Reading</span>
        <span class="count" data-role="count">–</span>
        <button data-action="collapse" aria-label="Collapse" aria-expanded="true">${MP_ICONS.down}</button>
        <button data-action="close" aria-label="Close mini player">${MP_ICONS.close}</button>
      </div>
      <div class="preview" data-role="preview"></div>
      <div class="controls">
        <button data-action="prev" aria-label="Previous sentence" disabled>${MP_ICONS.prev}</button>
        <button class="pause" data-action="pause" aria-label="Pause" disabled>${MP_ICONS.pause}</button>
        <button data-action="next" aria-label="Next sentence" disabled>${MP_ICONS.next}</button>
        <button class="stop" data-action="stop" aria-label="Stop">${MP_ICONS.stop}</button>
        <span class="queue" data-role="queue" hidden></span>
      </div>
      <div class="track" data-role="progress" role="progressbar" aria-label="Reading progress"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fill"></div></div>
    </div>
  `;

  let mini = null;

  const mpClamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

  function mpSend(message) {
    try {
      Promise.resolve(browser.runtime.sendMessage(message)).catch(() => {});
    } catch (_) {
      mpClose();
    }
  }

  function mpShow() {
    if (mini) return;
    if (location.protocol === "moz-extension:" || location.protocol === "chrome-extension:") return;
    const host = document.createElement("div");
    host.id = "tiny-reader-miniplayer";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${MP_CSS}</style>${MP_MARKUP}`;

    const refs = {
      card: root.querySelector(".card"),
      head: root.querySelector(".head"),
      dot: root.querySelector('[data-role="dot"]'),
      status: root.querySelector('[data-role="status"]'),
      count: root.querySelector('[data-role="count"]'),
      preview: root.querySelector('[data-role="preview"]'),
      track: root.querySelector('[data-role="progress"]'),
      fill: root.querySelector(".fill"),
      prev: root.querySelector('[data-action="prev"]'),
      pause: root.querySelector('[data-action="pause"]'),
      next: root.querySelector('[data-action="next"]'),
      collapse: root.querySelector('[data-action="collapse"]'),
      queue: root.querySelector('[data-role="queue"]'),
    };

    mini = { host, root, refs, status: "planning", timer: 0 };

    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "prev") mpSend({ type: "prev" });
      else if (action === "next") mpSend({ type: "next" });
      else if (action === "pause") mpSend({ type: mini && mini.status === "playing" ? "pause" : "resume" });
      else if (action === "stop") { mpSend({ type: "stop" }); mpClose(); }
      else if (action === "close") mpClose();
      else if (action === "collapse") mpToggleCollapse();
    });

    /* Drag by the header; clicks on its buttons are never drags. */
    refs.head.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.target.closest("button")) return;
      const rect = host.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const move = (drag) => {
        host.style.left = `${mpClamp(drag.clientX - offsetX, 4, window.innerWidth - host.offsetWidth - 4)}px`;
        host.style.top = `${mpClamp(drag.clientY - offsetY, 4, window.innerHeight - host.offsetHeight - 4)}px`;
        host.style.right = "auto";
        host.style.bottom = "auto";
      };
      const end = () => {
        refs.card.classList.remove("dragging");
        refs.head.removeEventListener("pointermove", move);
      };
      refs.head.setPointerCapture(event.pointerId);
      refs.card.classList.add("dragging");
      refs.head.addEventListener("pointermove", move);
      refs.head.addEventListener("pointerup", end, { once: true });
      refs.head.addEventListener("pointercancel", end, { once: true });
    });

    document.documentElement.appendChild(host);
    mpPoll();
    mini.timer = setInterval(mpPoll, 500);
  }

  function mpToggleCollapse() {
    if (!mini) return;
    const collapsed = mini.host.hasAttribute("data-collapsed");
    if (collapsed) mini.host.removeAttribute("data-collapsed");
    else mini.host.setAttribute("data-collapsed", "");
    mini.refs.collapse.innerHTML = collapsed ? MP_ICONS.down : MP_ICONS.up;
    mini.refs.collapse.setAttribute("aria-label", collapsed ? "Collapse" : "Expand");
    mini.refs.collapse.setAttribute("aria-expanded", String(collapsed));
  }

  function mpPoll() {
    if (!mini) return;
    Promise.resolve(browser.runtime.sendMessage({ type: "getState" })).then(
      (state) => { if (mini) mpRender(state); },
      () => mpClose(), // extension reloaded or context gone
    );
  }

  function mpRender(state) {
    const data = state || {};
    const status = typeof data.status === "string" ? data.status : "idle";
    const total = typeof data.total === "number" ? data.total : 0;
    const index = typeof data.index === "number" ? data.index : -1;
    const error = status === "error" ? String(data.error || "Something went wrong.") : "";
    mini.status = status;

    mini.refs.dot.className = `dot ${status}`;
    mini.refs.status.textContent = MP_STATUS[status] || "Reading";

    const position = index >= 0 ? Math.min(index + 1, total) : 0;
    mini.refs.count.textContent = total > 0 ? `${position} / ${total}` : "–";

    const percent = status === "done" ? 100 : total > 0 && position > 0 ? Math.round((position / total) * 100) : 0;
    mini.refs.fill.style.width = `${percent}%`;
    mini.refs.track.classList.toggle("indet", (status === "loading" || status === "planning") && !(total > 0));
    mini.refs.track.setAttribute("aria-valuenow", String(percent));

    const text = error || data.preview || (data.page && data.page.title) || "";
    mini.refs.preview.textContent = text;
    mini.refs.preview.title = text;
    mini.refs.preview.classList.toggle("error", Boolean(error));

    const queued = typeof data.queueRemaining === "number" ? data.queueRemaining : 0;
    mini.refs.queue.hidden = !(queued > 0);
    mini.refs.queue.textContent = `queue · ${queued}`;

    const active = status === "playing" || status === "paused";
    mini.refs.prev.disabled = !active;
    mini.refs.next.disabled = !active;
    mini.refs.pause.disabled = !active;
    const playing = status === "playing";
    mini.refs.pause.innerHTML = playing ? MP_ICONS.pause : MP_ICONS.play;
    mini.refs.pause.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function mpClose() {
    if (!mini) return;
    clearInterval(mini.timer);
    mini.host.remove();
    mini = null;
  }

  /* --------------------------------------------------------- messaging */

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "extract") {
      const page = extract(message.source || "auto");
      elements = page.elements; // block id → live element, used by highlight
      return Promise.resolve({ title: page.title, source: page.source, blocks: page.blocks });
    }
    if (message.type === "highlight") { highlight(message.blockId); return; }
    if (message.type === "clearHighlight") { clearHighlight(); return; }
    if (message.type === "reading") {
      setReading(message.on);
      if (message.on) mpShow(); else mpClose();
      return;
    }
  });
})();
