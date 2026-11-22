# Privacy policy

Effective date: 2026-11-22

tiny reader is made by Aljaz Ceru. The developer collects, receives and
processes no data: there are no tiny reader servers, no analytics, no
telemetry and no accounts. Everything the extension does happens in your
browser.

## What stays on your computer

- The text you read is synthesized locally by the bundled voice model.
  It is not stored and not sent anywhere.
- Your settings — voice, speed and per-site preferences — are kept in
  your browser's local extension storage.
- Voice models you import and remote endpoint settings — including the
  API key — are stored locally in IndexedDB.
- The extension gets no site access at install. It can read a page only
  after you use it there, through the toolbar button, the right-click
  menu or the keyboard shortcut.

## When the extension talks to the network

tiny reader makes a network request only when you ask it to, and only to
an address you gave it:

1. **Reading a web address.** When you enter a URL in the reader
   workspace, the extension fetches that page so it can read it aloud.
2. **Downloading a voice model.** When you enter a model URL, the
   extension downloads that file from the address you gave.
3. **A remote voice endpoint, if you set one up.** This is off by
   default. If you configure a remote TTS endpoint, each sentence you
   read is sent straight from your browser to that endpoint, together
   with the API key if you entered one. The text never passes through
   the developer; the service you chose handles it under its own
   privacy policy.

For each of these, the extension asks your browser for access to just
that one site, at the moment you use the feature. You can decline;
everything else keeps working.

## Contact

Questions or concerns: open an issue at
<https://github.com/aljazceru/tiny-reader/issues>.
