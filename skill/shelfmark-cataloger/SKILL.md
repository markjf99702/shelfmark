---
name: shelfmark-cataloger
description: Catalog someone's books into Shelfmark, their home-library app, from photos of shelves, spines, covers, barcodes or copyright pages (or from a typed list or a Goodreads or LibraryThing export), and hand them over as a one-tap link and a file. Use this whenever someone sends photos of books or bookshelves, wants books added to their library or catalog, mentions Shelfmark, or asks about their own library (whether they own a book, where it is, who borrowed it).
---

# Shelfmark cataloger

Shelfmark (https://junkdrawer.works/shelfmark/) is a home-library catalog that keeps its data in the person's browser and, if they turn on sync, in one file in their own Google Drive. Nothing is stored anywhere else. Your job is to turn photos of their books into an accurate list and hand it to Shelfmark as a **link**. Opening the link shows the list in Shelfmark to check, with duplicates already caught, before anything is added.

Two things make this worth doing, so protect them:
- **Accuracy over completeness.** A wrong book in someone's catalog is worse than a missing one. Never invent details, and say plainly what you couldn't read.
- **Their library, their call.** They review everything in Shelfmark before it's added. Flag doubts rather than resolving them silently.

## 1. Read the photos

Work through each photo left to right, top to bottom, shelf by shelf. Count the spines you can see and make sure every one ends up either in the list or in your "couldn't read" note. Nothing should be skipped silently.

What each kind of photo gives you:
- **Spines:** title and author, often the publisher's logo. Tilt your reading: spines run top-to-bottom (most English-language books) or bottom-to-top (many European ones). Series numbers and volume numbers matter ("Vol. 2").
- **Covers:** title, subtitle, author, sometimes the edition ("40th anniversary edition").
- **Barcodes on the back:** the ISBN is printed above or below the bars and starts with 978 or 979. The small second barcode to its right is a price code, not part of the ISBN. An ISBN pins down the exact edition, so it's the best thing to capture when the person cares about editions.
- **Copyright pages:** ISBN, publisher, year, edition statements. A "First Edition" line with a number line running down to 1 means a first printing. If the lowest number is 3, it's a third printing; put that in `edition`.

Rules:
- **ISBNs, publishers and years only from what's visible.** A spine photo doesn't tell you which edition is on the shelf, so leave those fields out rather than filling them from memory. The script checks every ISBN's check digit and drops any you misread, so copy digits carefully.
- **Titles and authors can be completed from what you know** when the photo clearly shows enough. A spine reading "TOLSTOY · ANNA KARENINA" is *Anna Karenina* by Leo Tolstoy. If you're completing more than an obvious name, flag it.
- **Flag anything you're not sure of** with `unsure`, in a few words about what's uncertain: "spine cut off at the top; could be volume 2", "glare over the author", "title partly hidden by the next book". Shelfmark shows these as "Check" in the review list and keeps a filter for them afterwards.
- **Unreadable spines:** if you can make a reasonable guess, include it with `unsure`. If you can't, leave it out and mention it in your reply ("third from the right on the top shelf, thin black spine, no readable text").
- **Same book in two photos** (overlapping shots): include it once. The script warns about likely doubles. If they really have two copies, keep both.

## 2. Where the books are

Shelfmark tracks a **room** and a **shelf** for each book, free text they choose ("Living room" / "Tall bookcase, top"). If they told you where the photo was taken, use it. If not, ask once, briefly, and don't hold things up waiting: the review screen lets them set a room and shelf for the whole batch before adding.

- Put a room and shelf that apply to everything at the top level of the batch.
- For a photo of a whole bookcase, give each book its own `shelf` ("Tall bookcase, shelf 2 from top"). Count shelves the way they'd say it, and tell them the convention you used.
- Keep shelf names consistent across batches from the same bookcase, so they group together in Shelfmark.

Pick up anything else they mention: "these are all read" → `status: "read"`; "the signed one on the left" → `signed: true`; "Sam has the Le Guin" → `loan: {"to": "Sam"}`.

## 3. Build the batch

When code tools are available, write the batch as JSON and run the bundled script:

```
python3 scripts/make_shelfmark.py books.json --out /mnt/user-data/outputs
```

(Use any writable folder for `--out`; `/mnt/user-data/outputs` is where claude.ai offers files for download.)

```json
{"name": "Living room, tall bookcase", "room": "Living room", "shelf": "Tall bookcase",
 "books": [
  {"title": "Middlemarch", "authors": ["George Eliot"], "shelf": "Tall bookcase, top"},
  {"title": "Beloved", "authors": ["Toni Morrison"], "shelf": "Tall bookcase, top", "unsure": "glare on the spine; could be Jazz"},
  {"title": "The Hobbit", "authors": ["J. R. R. Tolkien"], "isbn": "9780261102217", "publisher": "HarperCollins", "year": 1991, "format": "paperback"}
 ]}
```

Every field but `title` is optional. The full list is in `references/shelfmark-format.md`:
- `authors`: a list, names as printed ("Ursula K. Le Guin").
- `sub`: the subtitle.
- `isbn`, `publisher`, `year`, `pages`.
- `format`: hardcover, paperback, mass-market, board, leather or other.
- `edition`: text such as "2nd printing".
- `signed`, `first`: first edition, true or false.
- `condition`: fine, very good, good, fair or poor.
- `room`, `shelf`.
- `status`: unread, reading or read.
- `rating`: 1–5.
- `loan`: `{"to", "since"}`.
- `tags`, `notes`.
- `unsure`.

The script:
- cleans every field;
- checks ISBN check digits, and drops and flags any that fail;
- maps words like "hardback", "VG" and "finished" onto Shelfmark's values;
- warns about likely doubles;
- prints a summary, a **link** and a `.shelfmark.json` file path.

If it prints warnings, read them: a dropped ISBN or a double usually means one more look at the photo.

Links are compressed, so a few shelves' worth makes a link of a few thousand characters. For a few hundred books or more, lead with the file; the script says so when a link gets too long to pass around safely.

Without code tools, write the JSON by hand in the same shape, wrapped as `{"shelfmark": 1, "batch": {…}}`, and give it as text to paste into Shelfmark (**Import** › paste box). The link needs the script.

## 4. Hand it over

Keep the reply tidy:
1. One line: how many books, and from where.
2. The list, short: *Title — Author*, one per line, grouped by shelf if there are several. Mark flagged ones and say what to check.
3. Anything you couldn't read, and where it is in the photo.
4. The Shelfmark link, as a link. Tapping it opens Shelfmark with the list to review. Copy it character for character from the script's output: it's encoded data, and one changed character breaks it.
5. The file as the fallback (**Import** › **Open a file** in Shelfmark).

Don't claim you've added books to their library. They add them when they open the link and tap **Add**.

Opening the same link twice is safe: Shelfmark says it was used before and unticks books already in the library. If they send more photos of the same shelf, make a new batch with only the new books.

## Questions about their library

If a Google Drive connector is available and they ask about their collection ("do I own *Gilead*?", "what's on the hall shelf?", "who has my books?"), read the library file:
1. Search Drive for the title `Shelfmark library.json`.
2. Download it, and parse the JSON: `{"shelfmark": 1, "library": {"books": {id: book}, "seen": {…}}}`.
3. Ignore books with `"del": 1`; they were removed.

Book fields are as above, plus `added` (date) and `check` (an unresolved flag). **Only read this file; never write, move or rename it.** Shelfmark syncs it and manages it. New books go in through a link. Changes to existing books (marking one read, recording a loan) are made in Shelfmark itself.

## Imports from other services

For a Goodreads or LibraryThing export (CSV), map the columns onto batch fields and run the script. It's the same path as photos:
- **Goodreads:**
  - `ISBN13` or `ISBN` (strip the `="…"` wrapper), `Title`, `Author` and `Additional Authors`, `Publisher`, `Year Published`, `Number of Pages`.
  - `My Rating` → `rating` (0 means none).
  - `Exclusive Shelf` → `status` (read, currently-reading, to-read).
  - `Bookshelves` → `tags`.
  - `My Review` or `Private Notes` → `notes`.
- **LibraryThing:** `Title`, `Primary Author`, `ISBNs`, `Publication`, `Date`, `Tags`, `Collections`, `Comments`.

These are usually large, so hand over the file rather than the link, and say how many books came through.
