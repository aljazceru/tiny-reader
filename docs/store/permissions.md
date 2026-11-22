# Permission justifications

For the Chrome Web Store privacy-practices tab and the AMO permission
questions. The two builds differ where noted: `menus` and `contextMenus`
are the same API under different names, and `offscreen` is Chrome-only.

## Single purpose

Reads text aloud from web pages and documents the user chooses.

## Per permission

| Permission | Justification |
| --- | --- |
| `activeTab` | Reads the page only when the user activates tiny reader on it through the toolbar button, the right-click menu or the keyboard shortcut. |
| `scripting` | Injects the text extractor and the reading highlight into the page the user asked to hear. |
| `storage` | Saves voice, speed and per-site preferences in local browser storage. |
| `contextMenus` / `menus` | Adds the "Read selection" and "Read whole page" right-click entries. |
| `offscreen` (Chrome only) | Chrome service workers cannot play audio, so speech plays from an offscreen document instead of a tab. |
| `optional_host_permissions: <all_urls>` | No site access is granted at install; when the user enters a page URL to read, a model URL to download, or a remote voice endpoint, the extension requests access to just that site at that moment. |

Remote endpoint settings, including the API key, are stored locally in
IndexedDB (not under the `storage` permission).

## Remote code

No remote code; models are data files.
