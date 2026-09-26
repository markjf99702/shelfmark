# Shelfmark

A home-library catalog: one static `index.html`, no build step, served by GitHub Pages at https://junkdrawer.works/shelfmark/. The catalog lives in the browser's localStorage and, optionally, in one file in the owner's Google Drive (`drive.file` scope). Nothing about anyone's books belongs in this repo.

- **Book photos, a list of books, or a Goodreads/LibraryThing export sent in a session here:** follow `skill/shelfmark-cataloger/SKILL.md`. Write the batch JSON and the `.shelfmark.json` output to the scratchpad, not the repo, and hand over the link the script prints.
- **Tests:** `node test/library.test.js` (no dependencies; also round-trips the skill's Python script when `python3` exists). The test pulls the pure logic out of `index.html` between `'use strict';` and `// ---------- state ----------`, plus `linkText` and `parseIncoming` by name, so keep that logic free of DOM access and keep those markers.
- **Formats** (batch, link, library file) are documented in `skill/shelfmark-cataloger/references/shelfmark-format.md`. Link prefix `#s1z` / `#s1j` / `#batch=`; changing the format means bumping the prefix and keeping the old one readable.
- **Drive sync** needs `GOOGLE_CLIENT_ID` set near the top of the script (README › One-time setup). Every incoming book, from any source, goes through `cleanBook`; merges are per book, newest `t` wins, and removals are kept as `{id, t, del: 1}`.
- Style: ES5-ish `var`/`function` code in one IIFE, like the other junkdrawer.works apps; no dependencies.
