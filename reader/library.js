/*
 * tiny reader — saved-article library panel.
 *
 * A self-contained section for the reader page. Persistence lives in the
 * background event page: this panel only talks to it through the runtime
 * messages libraryList / librarySave / libraryDelete / libraryQueue /
 * libraryRead, and re-renders after every mutation, reporting progress via
 * hooks.onStatus (mirrored in the #libraryStatus line).
 *
 * Layout per item: checkbox ([data-action="queue"], checked in the order
 * the user ticks them), title, source · date, Read and Delete buttons
 * ([data-action="read" / "delete"]); every item root carries
 * [data-library-id]. Header buttons: #saveTab, #playQueue, #clearQueue.
 */

const MAX_TITLE_CHARS = 120;
const MAX_STATUS_CHARS = 60;

function messageOf(error) {
  return String((error && error.message) || error);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clip(text, max = MAX_TITLE_CHARS) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function formatDate(createdAt) {
  const date = new Date(createdAt);
  if (!(date.getTime() > 0)) return "";
  try {
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (error) {
    return date.toLocaleString();
  }
}

function sourceLabel(source) {
  const text = String(source || "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Text";
}

/* Same guard as the background page: extension/internal pages have no
 * readable article. */
function tabProblem(tab) {
  if (!tab || !tab.id) return "No tab to save — open the article in a tab first.";
  if (/^(about|chrome|moz-extension|view-source|data):/i.test(tab.url || "")) {
    return "This kind of page cannot be saved.";
  }
  return null;
}

const STYLE = `
.tv-lib{display:flex;flex-direction:column;gap:10px;}
.tv-lib-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.tv-lib-head h2{margin:0;font-size:1.1em;}
.tv-lib-spacer{flex:1;}
.tv-lib-queue-info{font-size:.85em;opacity:.75;}
.tv-lib-btn{padding:2px 10px;}
.tv-lib-btn:disabled{opacity:.45;}
.tv-lib-danger:hover{color:var(--error,#b3261e);}
.tv-lib-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}
.tv-lib-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid rgba(128,128,128,.35);border-radius:8px;}
.tv-lib-order{font-size:.8em;opacity:.7;min-width:2.2em;text-align:right;}
.tv-lib-text{flex:1;min-width:0;display:flex;flex-direction:column;}
.tv-lib-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tv-lib-meta{font-size:.8em;opacity:.7;white-space:nowrap;}
.tv-lib-empty{opacity:.7;margin:0;}
.tv-lib-status{margin:0;font-size:.85em;opacity:.8;min-height:1.2em;}
`;

export function mountLibrary(root, hooks = {}) {
  if (!(root instanceof HTMLElement)) throw new TypeError("mountLibrary(root: HTMLElement, hooks)");
  const onStatus = typeof hooks.onStatus === "function" ? hooks.onStatus : () => {};

  root.textContent = "";
  root.className = `${root.className} tv-lib`.trim();

  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);

  /* ---------------------------------------------------------- skeleton */

  const saveTab = el("button", "tv-lib-btn", "Save this page");
  saveTab.id = "saveTab";
  saveTab.type = "button";
  const playQueue = el("button", "tv-lib-btn", "▶ Play queue");
  playQueue.id = "playQueue";
  playQueue.type = "button";
  const clearQueue = el("button", "tv-lib-btn tv-lib-danger", "Clear queue");
  clearQueue.id = "clearQueue";
  clearQueue.type = "button";

  const queueInfo = el("span", "tv-lib-queue-info");
  const head = el("div", "tv-lib-head");
  head.append(el("h2", undefined, "Library"), saveTab, playQueue, clearQueue, el("span", "tv-lib-spacer"), queueInfo);

  const list = el("ol", "tv-lib-list");
  const empty = el("p", "tv-lib-empty", "Nothing saved yet — open an article and click “Save this page”."); 
  empty.hidden = true;
  const statusLine = el("p", "tv-lib-status");
  statusLine.id = "libraryStatus";

  root.append(head, list, empty, statusLine);

  /* ------------------------------------------------------------- state */

  let items = []; // as returned by libraryList (newest first)
  let queueOrder = []; // checked ids, in the order they were checked

  function status(text) {
    statusLine.textContent = text;
    onStatus(text);
  }

  function send(message) {
    return browser.runtime.sendMessage(message);
  }

  /* ------------------------------------------------------------- render */

  function row(item) {
    const li = el("li", "tv-lib-item");
    li.dataset.libraryId = item.id;

    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.dataset.action = "queue";
    pick.className = "tv-lib-check";
    pick.checked = queueOrder.includes(item.id);
    pick.title = "Add to the play queue (order = order of checking)";
    pick.addEventListener("change", () => {
      queueOrder = queueOrder.filter((id) => id !== item.id);
      if (pick.checked) queueOrder.push(item.id);
      syncQueueUi();
    });

    const name = el("span", "tv-lib-name", clip(item.title) || "Untitled");
    name.title = clip(item.title);
    const meta = el("span", "tv-lib-meta", [sourceLabel(item.source), formatDate(item.createdAt)].filter(Boolean).join(" · "));
    const text = el("span", "tv-lib-text");
    text.append(name, meta);

    const order = el("span", "tv-lib-order");

    const read = el("button", "tv-lib-btn", "Read");
    read.type = "button";
    read.dataset.action = "read";
    read.addEventListener("click", () => readItem(item));

    const drop = el("button", "tv-lib-btn tv-lib-danger", "Delete");
    drop.type = "button";
    drop.dataset.action = "delete";
    drop.addEventListener("click", () => deleteItem(item));

    li.append(pick, order, text, read, drop);
    return li;
  }

  function render() {
    list.textContent = "";
    for (const item of items) list.append(row(item));
    empty.hidden = items.length > 0;
    syncQueueUi();
  }

  /* Update queue badges and header state without rebuilding the list, so
   * ticking a checkbox never steals focus or scroll position. */
  function syncQueueUi() {
    for (const li of list.children) {
      const order = li.querySelector(".tv-lib-order");
      const at = queueOrder.indexOf(li.dataset.libraryId);
      if (order) order.textContent = at >= 0 ? `#${at + 1}` : "";
    }
    const count = queueOrder.length;
    queueInfo.textContent = count ? `Queue: ${count}` : "";
    playQueue.disabled = !count;
    clearQueue.disabled = !count;
  }

  async function refresh() {
    let reply = null;
    try {
      reply = await send({ type: "libraryList" });
    } catch (error) {
      return status(`Library unavailable: ${messageOf(error)}`);
    }
    items = Array.isArray(reply && reply.items) ? reply.items : [];
    const ids = Array.isArray(reply && reply.queueIds) ? reply.queueIds : [];
    queueOrder = ids.filter((id) => items.some((item) => item && item.id === id));
    render();
  }

  /* ------------------------------------------------------------ actions */

  async function readItem(item) {
    try {
      await send({ type: "libraryRead", id: item.id });
    } catch (error) {
      return status(`Could not start reading: ${messageOf(error)}`);
    }
    status(`Reading “${clip(item.title, MAX_STATUS_CHARS)}”…`);
    refresh();
  }

  async function deleteItem(item) {
    try {
      await send({ type: "libraryDelete", id: item.id });
    } catch (error) {
      return status(`Could not delete: ${messageOf(error)}`);
    }
    queueOrder = queueOrder.filter((id) => id !== item.id);
    status(`Deleted “${clip(item.title, MAX_STATUS_CHARS)}”.`);
    refresh();
  }

  async function startQueue() {
    if (!queueOrder.length) return status("Tick articles to build a queue (order = order of ticking).");
    try {
      await send({ type: "libraryQueue", ids: [...queueOrder] });
      await send({ type: "libraryRead", id: queueOrder[0] });
    } catch (error) {
      return status(`Could not play the queue: ${messageOf(error)}`);
    }
    const count = queueOrder.length;
    status(`Reading queue (${count} article${count === 1 ? "" : "s"})…`);
    refresh();
  }

  async function clearAll() {
    try {
      await send({ type: "libraryQueue", ids: [] });
    } catch (error) {
      return status(`Could not clear the queue: ${messageOf(error)}`);
    }
    queueOrder = [];
    status("Queue cleared.");
    refresh();
  }

  async function saveCurrentTab() {
    let tab = null;
    try {
      [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    } catch (error) {
      return status(`Could not find the active tab: ${messageOf(error)}`);
    }
    const problem = tabProblem(tab);
    if (problem) return status(problem);

    saveTab.disabled = true;
    saveTab.textContent = "Saving…";
    status("Extracting this page…");
    try {
      const page = await extractFrom(tab);
      if (!page || !Array.isArray(page.blocks) || !page.blocks.length) {
        return status("No readable text found on this page.");
      }
      const saved = await send({
        type: "librarySave",
        title: page.title || tab.title || "",
        url: page.url || tab.url || "",
        blocks: page.blocks,
        source: page.source || "url",
      });
      status(`Saved “${clip((saved && saved.title) || page.title || tab.title || "Untitled", MAX_STATUS_CHARS)}”.`);
      await refresh();
    } catch (error) {
      status(`Could not save this page: ${messageOf(error)}`);
    } finally {
      saveTab.disabled = false;
      saveTab.textContent = "Save this page";
    }
  }

  /* The content script is usually already there (declared in the manifest);
   * if not, inject it like the background does, then ask again. */
  async function extractFrom(tab) {
    const ask = () => browser.tabs.sendMessage(tab.id, { type: "extract", source: "page" });
    try {
      return await ask();
    } catch (error) { /* not injected yet */ }
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["vendor/readability.js", "content/content.js"],
    });
    return ask();
  }

  /* --------------------------------------------------------------- wire */

  saveTab.addEventListener("click", () => saveCurrentTab());
  playQueue.addEventListener("click", () => startQueue());
  clearQueue.addEventListener("click", () => clearAll());

  refresh();

  return { refresh };
}
