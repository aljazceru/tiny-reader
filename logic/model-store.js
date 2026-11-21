/*
 * tiny reader — active model store.
 *
 * Persists the active synthesis model (name + GGUF bytes) in IndexedDB so a
 * custom model survives browser restarts; `loadActive()` returns null when
 * the bundled default is in effect. Pure logic, no imports: loaded as a
 * classic script by the background event page (global ModelStore) and via
 * module.exports by the Node tests. Node has no IndexedDB, so the same API
 * transparently falls back to a single in-memory slot there.
 */

"use strict";

const ModelStore = (() => {
  const DATABASE = "tiny-reader", STORE = "models", KEY = "active";
  let memory = null; // Node-safe fallback when IndexedDB is unavailable

  const hasIndexedDB = () => typeof indexedDB === "object" && indexedDB !== null;

  const why = (request) => String((request.error && request.error.message) || "indexedDB failure");

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`model store: ${why(request)}`));
      request.onblocked = () => reject(new Error("model store: database is blocked by another connection"));
    });
  }

  /* One-shot transaction: opens, runs `run(store)`, closes the connection. */
  function withStore(mode, run) {
    return open().then((db) => {
      const done = new Promise((resolve, reject) => {
        try {
          const request = run(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error(`model store: ${why(request)}`));
        } catch (error) {
          reject(error);
        }
      });
      return done.finally(() => db.close());
    });
  }

  function bytesOf(buffer) {
    if (buffer instanceof ArrayBuffer) return buffer;
    if (ArrayBuffer.isView(buffer)) return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return null;
  }

  class ModelStore {
    /* The persisted active model as {name, buffer}, or null for the bundled
     * default. */
    static loadActive() {
      if (!hasIndexedDB()) return Promise.resolve(memory ? { name: memory.name, buffer: memory.buffer } : null);
      return withStore("readonly", (store) => store.get(KEY)).then((record) => {
        return record && record.name && record.buffer ? { name: record.name, buffer: record.buffer } : null;
      });
    }

    /* Persists {name, buffer} (buffer: ArrayBuffer with the GGUF bytes) and
     * returns the normalized record. Invalid input rejects — the API is
     * async, so even validation failures come back as rejected promises. */
    static saveActive({ name, buffer } = {}) {
      const bytes = bytesOf(buffer);
      if (typeof name !== "string" || !name.trim()) return Promise.reject(new TypeError("saveActive: name must be a non-empty string"));
      if (!bytes) return Promise.reject(new TypeError("saveActive: buffer must be an ArrayBuffer"));
      const record = { name: name.trim(), buffer: bytes, savedAt: Date.now() };
      const normalized = { name: record.name, buffer: record.buffer };
      if (!hasIndexedDB()) {
        memory = record;
        return Promise.resolve(normalized);
      }
      return withStore("readwrite", (store) => store.put(record, KEY)).then(() => normalized);
    }

    /* Forgets the persisted model; the bundled default takes over again. */
    static clear() {
      if (!hasIndexedDB()) {
        memory = null;
        return Promise.resolve();
      }
      return withStore("readwrite", (store) => store.delete(KEY)).then(() => undefined);
    }
  }

  return ModelStore;
})();

if (typeof module === "object") module.exports = { ModelStore };
if (typeof self === "object") self.ModelStore = ModelStore;
else globalThis.ModelStore = ModelStore;
