/*
 * tiny reader — Chrome service worker bootstrap.
 *
 * Chrome MV3 requires a service worker (no event pages), and service
 * workers cannot use import maps or module scripts with the classic
 * background code — so this bootstrap loads the same classic scripts the
 * Firefox event page loads, in the same order, via importScripts. The
 * engine Worker and the audio player run in the offscreen audio-host
 * document (see background/engine-host.js); everything else is shared
 * verbatim.
 */

/* global EngineHost */

importScripts(
  "../compat/compat.js",
  "../logic/chunks.js",
  "../logic/remote.js",
  "../logic/model-store.js",
  "../logic/prefs.js",
  "../background/engine-host.js",
  "../background/player.js",
  "../background/background.js",
);

/* Keep the offscreen document only while it can be needed: reading
 * (loading/planning/playing/paused) or while a model worker exists. */
setInterval(() => {
  if (typeof S === "undefined" || typeof EngineHost === "undefined") return;
  const busy = S && ["loading", "planning", "playing", "paused"].includes(S.status);
  if (!busy && EngineHost.useAudioHost) EngineHost.closeDocument();
}, 30000);
