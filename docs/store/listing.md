# Store listing material

Paste-ready text for the Chrome Web Store and addons.mozilla.org
dashboards.

## Name

tiny reader

## Summary (Chrome limit 132 characters; this one is 114)

Read web pages, selections, PDFs and ePubs aloud with a voice that runs
on your computer. No account, no tracking.

## Full description

tiny reader reads text aloud — selected text, whole web pages, pasted
text, URLs, PDFs and ePubs — with a voice that runs on your own
computer. No account, no tracking, and nothing is sent anywhere by
default.

Ways to read:

- Select text on a page, right-click, choose "Read selection".
- Click the toolbar button to read the selection or the page.
- Press Alt+Shift+S (you can rebind it in your browser's extension
  shortcut settings).
- Open the reader workspace for pasted text, TXT/HTML/PDF/ePub files
  and web addresses.

While it reads, the current paragraph is highlighted and a small player
floats on the page with pause, skip and stop. Speed adjusts from half
to two and a half times, and voice and speed choices are remembered per
site.

The bundled voice is English: two voices, male and female, in an 8 MB
model that runs entirely in your browser. Being a small model, it has
the pronunciation limits documented upstream — foreign names and
unusual spellings can come out wrong. For other languages and voices
you can load a compatible voice model from a file or a URL, or point
tiny reader at an OpenAI-compatible TTS endpoint you choose.

Privacy: everything runs locally. The extension asks for no site access
at install, and it reads a page only when you use it there. When a
feature needs to fetch an address you entered — a page to read, a model
to download, a remote endpoint — it asks for that one site at that
moment. Text leaves your browser only if you set up a remote endpoint
yourself; then sentences go straight from your browser to that service,
under that service's own policy.

Free and open source: https://github.com/aljazceru/tiny-reader

## Categories

- Chrome Web Store: Accessibility
- addons.mozilla.org: Accessibility; Language Support

## Links

- Support: https://github.com/aljazceru/tiny-reader/issues
- Privacy policy:
  https://github.com/aljazceru/tiny-reader/blob/main/PRIVACY.md
- Homepage: https://github.com/aljazceru/tiny-reader
