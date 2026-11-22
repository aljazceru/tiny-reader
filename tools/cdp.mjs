/*
 * tiny reader — shared Chromium launch + CDP helpers for tools.
 *
 * launchChromium() spawns CHROME_BIN (default /usr/bin/chromium-browser)
 * with an extension loaded and remote debugging on, then waits for the
 * /json/version endpoint. connect() is a minimal CDP client over the
 * global WebSocket. Node 22+.
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function launchChromium({ ext, port = 9391, headless = false, profile }) {
  const bin = process.env.CHROME_BIN || "/usr/bin/chromium-browser";
  for (const path of [bin, join(ext, "manifest.json")]) {
    if (!existsSync(path)) throw new Error("missing " + path + " (build with node tools/build-chrome.mjs)");
  }
  const dir = profile || mkdtempSync(join(tmpdir(), "tiny-reader-cdp-"));
  mkdirSync(dir, { recursive: true });

  /* Real-time Web Audio needs a live audio thread; headless Chrome freezes
   * the AudioContext clock, so headed is the default. */
  const proc = spawn(bin, [
    headless ? "--headless=new" : "--no-first-run",
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    `--load-extension=${ext}`,
    "--window-size=1280,900",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env.DISPLAY ? process.env : { ...process.env, DISPLAY: ":0" },
  });
  const close = () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } };
  process.on("exit", close);

  const list = () => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await delay(500); }
  }
  return { list, close };
}

/* ---- minimal CDP client over the global WebSocket ---- */

export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: ok, reject: bad } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) bad(new Error(message.error.message));
      else ok(message.result);
    } else if (message.method && listeners.has(message.method)) {
      for (const fn of listeners.get(message.method)) fn(message.params);
    }
  });
  return ready.then(() => ({
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    async evaluate(expression, awaitPromise = true) {
      const result = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error("page error: " + String(result.exceptionDetails.exception?.description || result.exceptionDetails.text).slice(0, 300));
      }
      return result.result.value;
    },
    close() { try { ws.close(); } catch { /* gone */ } },
  }));
}

export async function waitForTarget(browser, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const target = (await browser.list()).find(predicate);
    if (target) return target;
    if (Date.now() > deadline) throw new Error("timeout waiting for CDP target");
    await delay(500);
  }
}
