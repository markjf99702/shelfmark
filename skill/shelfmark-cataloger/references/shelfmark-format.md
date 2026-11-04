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
| `made` | Optional. The day the batch was made, as `YYYY-MM-DD`. The script fills it in |
| `books[]` | The books, in shelf order. Up to 3,000: Shelfmark takes the first 3,000 and says how many more there were, so put the rest in another batch |

Each book:

| Field | Meaning |
|---|---|
| `title` | Required. Up to 300 characters. A volume's number or name goes here as printed, "Les Misérables, Volume 2: Cosette" or "The Pickwick Papers: Volume 2", so the volumes of a set are told apart |
| `sub` | Subtitle, up to 300 characters. Shelfmark takes two books for one when their ISBNs agree, or when their first authors' surnames and their titles do: the part before any colon, every number in the title, and the part after the colon (or else the subtitle), unless one of them has none. So a book is the same with or without its subtitle, and "Series: Its Name" isn't "Series: Another Name" |
| `authors` | List of names as printed, up to 12, each up to 120 characters. The writer first, then a translator or editor (with "Translated by …" in `notes`) |
| `isbn` | ISBN-10 or ISBN-13, any punctuation. Shelfmark stores valid ones as ISBN-13; given several ("0618260307, 9780618260300"), it keeps the first valid one |
| `publisher`, `year`, `pages` | As printed: the publisher up to 120 characters, the year 0–2200, pages 0–50,000. A year is read as its first four-digit number ("1937–40" is 1937, "2nd ed. 1999" is 1999) and a page count as its largest number ("2 vols, 880" is 880, "1,024" is 1024) |
| `format` | `hardcover`, `paperback`, `mass-market`, `board`, `leather`, `other` |
| `edition` | Free text, up to 120 characters: "2nd printing", "book club edition" |
| `signed`, `first` | `true` for a signed copy / a first edition. `"yes"` and `1` count too; anything else, `"no"` and `"false"` included, is no |
| `condition` | `fine`, `very-good`, `good`, `fair`, `poor` |
| `room`, `shelf` | Free text, up to 60 characters each |
| `status` | `unread` (the default), `reading`, `read` |
| `rating` | 1–5. A half star rounds up: 4.5 is 5 |
| `loan` | `{"to": "Sam", "since": "2026-09-01"}`: lent out, the borrower up to 80 characters, with an optional ISO date |
| `tags` | List of short labels, up to 20, each up to 40 characters |
| `notes` | Free text, line breaks kept, up to 4,000 characters |
| `added` | The day it joined the library, `YYYY-MM-DD`. Left out, it's the day the books are added in Shelfmark |
| `unsure` | What to double-check, in a few words, up to 300 characters. Shows as "Check" in Shelfmark |
| `kind` | `fiction`, `nonfiction`, `poetry` |
| `genres` | Up to 4, main one first: `literary`, `classics`, `historical-fiction`, `mystery`, `thriller`, `sf`, `fantasy`, `romance`, `horror`, `short-stories`, `humor`, `comics`, `ya`, `children`, `history`, `biography` (and memoir), `politics`, `economics`, `philosophy`, `science`, `nature` (and gardening), `travel`, `art` (and design, fashion), `food` (and drink), `business`, `self-help`, `society` (and culture), `religion`, `sports`, `true-crime`, `reference` |
| `moods` | Up to 4, the feel of reading it: `adventurous`, `challenging`, `dark`, `emotional`, `funny`, `hopeful`, `informative`, `inspiring`, `lighthearted`, `mysterious`, `reflective`, `relaxing`, `sad`, `tense` |
| `pace` | `slow`, `medium`, `fast` |
| `chapters` | `short`, `medium`, `long`: how long a sitting each chapter or piece is |
| `way` | `through` (read cover to cover), `dip` (dip in and out: poems, stories, essays, short pieces), `browse` (cookbooks, picture and art books, guides, reference). What to read next leaves out `browse` books unless asked |
| `blurb` | One line about the book, no spoilers. Up to 300 characters; aim for under 150 |

Shelfmark ignores fields it doesn't know, cuts text to the limits above, brings a number into its range (a rating of 9 is 5), and drops a value that doesn't fit (an unknown format or mood), so a slip degrades quietly. Get titles and ISBNs right.

## Reading details (for books already in the library)

```json
{"shelfmark": 1, "details": {
  "id": "d20261102-…", "name": "Reading details",
  "books": [
    {"id": "b7q2x9m1kd", "title": "Dune", "authors": ["Frank Herbert"], "kind": "fiction", "genres": ["sf"], "moods": ["adventurous"], "pace": "medium", "pages": 600}
  ]}}
```

Each entry names its book by `id` (from the library file) and by `title`, `sub`, `authors` and `isbn`: Shelfmark finds the book with that id, or else every copy of the same book (the same ISBN, or the same title, subtitle and author's surname, as for a batch), leaving out any copy another entry names by id. An entry for one volume of a set finds only that volume, so give each volume its own entry, with its title as the library file has it. When those copies have different authors (two translations, each with its translator), it takes the ones whose authors match the entry's in full, so copy `authors` from the library file as they are; a copy with the entry's ISBN always gets it. It carries any of the reading-detail fields above, and `pages`. Opening it fills in only the details a book doesn't have yet (or replaces them, if the person ticks **Replace**), and a page count only where there is none; nothing else on the book changes. Up to 3,000 entries. `scripts/make_shelfmark.py --details` makes these; they travel in the same links (`#s1z…`).

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
