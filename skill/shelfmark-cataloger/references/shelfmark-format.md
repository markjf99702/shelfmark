# Shelfmark formats

Use this when you can't run `scripts/make_shelfmark.py` and need to write a batch by hand, or when you're reading someone's library file.

## A batch (what you hand over)

```json
{"shelfmark": 1, "batch": {
  "name": "Living room, tall bookcase",
  "room": "Living room", "shelf": "Tall bookcase",
  "books": [
    {"title": "Middlemarch", "authors": ["George Eliot"], "shelf": "Tall bookcase, top"},
    {"title": "Beloved", "authors": ["Toni Morrison"], "unsure": "glare on the spine; could be Jazz"}
  ]}}
```

| Field | Meaning |
|---|---|
| `name` | What the batch is, shown when it's opened. Up to 120 characters |
| `room`, `shelf` | Where the books are. A book with no room of its own gets the batch's room. It gets the batch's shelf only when it has no shelf and no room of its own, or its room is the batch's |
| `id` | Optional. Shelfmark remembers batch ids it has added, so it can say when a link is opened twice. The script makes one from the content |
| `books[]` | The books, in shelf order |

Each book:

| Field | Meaning |
|---|---|
| `title` | Required. Up to 300 characters |
| `sub` | Subtitle |
| `authors` | List of names as printed, up to 12 |
| `isbn` | ISBN-10 or ISBN-13, any punctuation. Shelfmark stores valid ones as ISBN-13 |
| `publisher`, `year`, `pages` | As printed |
| `format` | `hardcover`, `paperback`, `mass-market`, `board`, `leather`, `other` |
| `edition` | Free text: "2nd printing", "book club edition" |
| `signed`, `first` | `true` for a signed copy / a first edition |
| `condition` | `fine`, `very-good`, `good`, `fair`, `poor` |
| `room`, `shelf` | Free text, up to 60 characters each |
| `status` | `unread` (the default), `reading`, `read` |
| `rating` | 1–5 |
| `loan` | `{"to": "Sam", "since": "2026-09-01"}`: lent out, with an optional ISO date |
| `tags` | List of short labels |
| `notes` | Free text, line breaks kept |
| `unsure` | What to double-check, in a few words. Shows as "Check" in Shelfmark |

Shelfmark ignores fields it doesn't know, trims text to the limits above, and drops values that don't fit (an unknown format, a rating of 9), so a slip degrades quietly. Get titles and ISBNs right.

## Links

A link is Shelfmark's address with the batch in the fragment:

```
https://shelfmark.junkdrawer.works/#s1z<data>
```

`<data>` is the compact batch JSON, compressed with raw DEFLATE, then base64url-encoded without padding. `#s1j<data>` is the same without compression. `#batch=<URL-encoded JSON>` also works and can be written by hand, but it gets long. The part after `#` never reaches a server.

## The library file (read only)

With Drive sync on, the whole library is `My Drive › Shelfmark › Shelfmark library.json`, and a downloaded backup has the same shape:

```json
{"shelfmark": 1, "library": {
  "books": {"b4k2…": {"id": "b4k2…", "t": 1790000000000, "title": "Middlemarch", "authors": ["George Eliot"], "room": "Den", "added": "2026-09-26"},
            "b9x1…": {"id": "b9x1…", "t": 1790000500000, "del": 1}},
  "seen": {"c20260926-…": 1790000000000}}}
```

Books are keyed by id. `t` is when the book last changed, in milliseconds. `"del": 1` marks a removed book, kept so the removal syncs; skip those. `added` is the date it was catalogued. `check` holds an unresolved "unsure" note. Empty fields are left out. Shelfmark owns this file: read it, never write it.
