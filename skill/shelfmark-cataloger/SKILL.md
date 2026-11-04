---
name: shelfmark-cataloger
description: Catalog someone's books into Shelfmark, their home-library app, from photos of shelves, spines, covers, barcodes or copyright pages (or from a typed list or a Goodreads or LibraryThing export), and hand them over as a one-tap link and a file. Also adds reading details to books already in it (fiction or not, genres, moods, pace, chapter length, a line about each) so its What to read next can choose by them. Use this whenever someone sends photos of books or bookshelves, wants books added to their library or catalog, mentions Shelfmark, wants help choosing what to read from their own shelves, or asks about their own library (whether they own a book, where it is, who borrowed it).
---

# Shelfmark cataloger

Shelfmark (https://shelfmark.junkdrawer.works/) is a home-library catalog that keeps its data in the person's browser and, if they turn on sync, in one file in their own Google Drive. Nothing is stored anywhere else. Your job is to turn photos of their books into an accurate list and hand it to Shelfmark as a **link**. Opening the link shows the list in Shelfmark to check, with duplicates already caught, before anything is added.

Two things make this worth doing, so protect them:
- **Accuracy over completeness.** A wrong book in someone's catalog is worse than a missing one. Never invent details, and say plainly what you couldn't read.
- **Their library, their call.** They review everything in Shelfmark before it's added. Flag doubts rather than resolving them silently.

## 1. Read the photos

Work through each photo left to right, top to bottom, shelf by shelf. Count the spines you can see and make sure every one ends up either in the list or in your "couldn't read" note. Nothing should be skipped silently.

What each kind of photo gives you:
- **Spines:** title and author, often the publisher's logo. Tilt your reading: spines run top-to-bottom (most English-language books) or bottom-to-top (many European ones). Series numbers and volume numbers matter: put a volume's number or name in the `title` as printed ("Les Misérables, Volume 2: Cosette", "The Pickwick Papers: Volume 2"), not only in `sub`, so Shelfmark tells the volumes of a set apart and suggests the first one first.
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
- Keep shelf names consistent across batches from the same bookcase, so they group together in Shelfmark. When you have their library file (see **Questions about their library**), reuse its room and shelf names exactly as they're written there.

Books they want rather than have (a photo of a shop's table or a friend's shelf, a list of books to buy) go on Shelfmark's **wishlist**: put `"wanted": true` at the top level of the batch, and leave out the room and shelf. Say so when you hand it over.

Pick up anything else they mention: "these are all read" → `status: "read"`; "I finished this one last week" → `status: "read"` with that day in `finished`; "I gave up on that one" → `aside: true`; "the signed one on the left" → `signed: true`; "Sam has the Le Guin" → `loan: {"to": "Sam"}`.

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
- `authors`: a list, names as printed ("Ursula K. Le Guin"). The writer comes first, then a translator or editor, with "Translated by …" (or "Edited by …") in `notes`: `"authors": ["Homer", "Samuel Butler"], "notes": "Translated by Samuel Butler"`.
- `sub`: the subtitle. A volume's number or name goes in the `title` (see Spines above).
- `isbn`, `publisher`, `year`, `pages`.
- `format`: hardcover, paperback, mass-market, board, leather or other.
- `edition`: text such as "2nd printing".
- `signed` (a signed copy) and `first` (a first edition): true or false.
- `condition`: fine, very good, good, fair or poor.
- `room`, `shelf`.
- `status`: unread, reading or read.
- `rating`: 1–5.
- `finished`: the day they finished a book they've read (YYYY-MM-DD), only if they tell you.
- `aside`: true for a book they gave up on.
- `wanted`: true for a book they want, not one in the house (or `"wanted": true` on the whole batch).
- `loan`: `{"to", "since"}`.
- `tags`, `notes`.
- `added`: the day it joined the library (YYYY-MM-DD), only if they tell you; otherwise it's the day they add it.
- `unsure`.
- Reading details (`kind`, `genres`, `moods`, `pace`, `chapters`, `way`, `blurb`), only for books you know well: see **Reading details** below.

The script:
- cleans every field;
- checks ISBN check digits, and drops and flags any that fail;
- maps words like "hardback", "VG" and "finished" onto Shelfmark's values;
- warns about likely doubles: the same title (with or without its subtitle) and author twice, or the same ISBN. The volumes of a set aren't doubles;
- warns about anything longer than Shelfmark keeps: notes over 4,000 characters, a title or a line about the book over 300, more than 12 authors or 20 tags;
- prints a summary, a **link** and a `.shelfmark.json` file path.

If it prints warnings, read them: a dropped ISBN or a double usually means one more look at the photo. Another volume of the same set doesn't warn, so keep every volume you see. Pass on any that say notes were cut (a long Goodreads review, say), so the person can keep the whole text somewhere else.

Links are compressed, so a few shelves' worth makes a link of a few thousand characters. For a few hundred books or more, lead with the file; the script says so when a link gets too long to pass around safely.

Shelfmark takes 3,000 books at a time. For more, the script writes numbered files (`…-1.shelfmark.json`, `…-2.shelfmark.json` and so on), each a batch of its own and none with a link: hand over all of them, and say to open them in Shelfmark one after another.

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
1. Search Drive for the title `Shelfmark library.json`. If the search finds more than one, use the one in the Shelfmark folder that isn’t in the trash.
2. Download it, and parse the JSON: `{"shelfmark": 1, "library": {"books": {id: book}, "seen": {…}}}`.
3. Ignore books with `"del": 1`; they were removed.

Book fields are as above, plus `check` (an unresolved flag). A book with `"wanted": true` is on their wishlist, not in the house: "do I own it?" is no, but they meant to buy it. `aside` marks a book they gave up on (shown as Set aside). `finished` says when a read book was finished, so "what did I read this year?" is the books with `status` `read` and a `finished` day in this year. **Only read this file; never write, move or rename it.** Shelfmark syncs it and manages it. New books go in through a link. Changes to existing books (marking one read, recording a loan) are made in Shelfmark itself.

## Reading details

Shelfmark's **What to read next** can choose by what a book is like: fiction, nonfiction or poetry; mood; genre; pace; short chapters; and whether it's read cover to cover, dipped into, or browsed (a cookbook, a picture book or a reference book, which it doesn't suggest unless asked). These come from you. When someone asks for them ("add details to my library", "help Shelfmark pick what I read next"), or asks you to suggest something from their shelves and the books don't have details yet:

1. Read their library: the Drive file as above, or a backup file they send (**Settings › Download a backup**). Skip removed books.
2. Write an entry for each book you know, keyed by its `id` from the file, with its `title`, `sub` and `authors` too, as the file has them (they find the book if the id doesn't). Leave out books that already have every detail, unless they ask you to redo them.
3. Run the script with `--details`, and hand over the link (or the file, when the script says the link is too long).

```
python3 scripts/make_shelfmark.py details.json --details --out /mnt/user-data/outputs
```

```json
{"name": "Reading details", "books": [
  {"id": "b7q2x9m1kd", "title": "Dune", "authors": ["Frank Herbert"], "kind": "fiction", "genres": ["sf", "classics"],
   "moods": ["adventurous", "challenging"], "pace": "medium", "chapters": "medium", "way": "through", "pages": 600,
   "blurb": "A desert planet, the spice everyone wants, and a duke's young heir who may be its messiah."},
  {"id": "b3n8r5t0pa", "title": "Salt Fat Acid Heat", "authors": ["Samin Nosrat"], "kind": "nonfiction", "genres": ["food"],
   "moods": ["informative"], "way": "browse", "blurb": "How four elements make food taste good, with recipes to practise them."}
]}
```

The words each field takes are in `references/shelfmark-format.md`. How to fill them:
- **Only what you know.** For a book you know, give everything. For one you don't, give what its title and publisher make plain (a cookbook is nonfiction, food, browse; a museum catalogue is art, browse) and leave the rest out. Never guess a novel's moods from its title alone.
- **`moods`:** one to three, the feel of reading it, not its subject: a war history is `informative` and maybe `dark`, not `adventurous`.
- **`genres`:** one or two, the main one first; up to four when they really apply.
- **`way`:** `through` for novels and narrative nonfiction; `dip` for poetry, short stories, essays, humor collections and books of short pieces; `browse` for cookbooks, picture and art books, guides, reference and yearbooks.
- **`chapters`:** how long a sitting each chapter or piece is. `short` is a few pages; leave it out for books you browse.
- **`pages`:** a usual edition's page count, only when you're fairly sure; Shelfmark only uses it to fill a blank.
- **`blurb`:** one line, under 150 characters, plain, no spoilers, saying what it is rather than praising it.

Opening the link shows the list to review. It fills in only what each book doesn't have yet, unless they tick **Replace**, and never changes anything else. Opening it twice is safe. New books from photos can carry the same fields in their batch, when you know the books well.

Without code tools, write the entries by hand in the same shape, wrapped as `{"shelfmark": 1, "details": {"name": "Reading details", "books": […]}}`, and give it as text to paste into Shelfmark (**Import**, then the box **Or paste what Claude gave you**). Keep each message to about 50 books, each one a whole JSON block of its own, and say to paste them one after another.

## Imports from other services

For a Goodreads or LibraryThing export, let the script read it rather than mapping the columns yourself:

```
python3 scripts/make_shelfmark.py goodreads_library_export.csv --import goodreads --out /mnt/user-data/outputs
python3 scripts/make_shelfmark.py librarything_export.tsv --import librarything --out /mnt/user-data/outputs
```

It reads CSV or tab-separated files in any of the encodings these exports and spreadsheets save in, and does the mechanical part:
- **Leaves out books that aren't in the house:** on the Goodreads to-read shelf with no copy owned, or only on LibraryThing's Wishlist or Read but unowned. It prints how many ("Left out: 212 on the to-read shelf with no copy owned"). With `--keep-unowned` the to-read shelf's and the Wishlist's come in on Shelfmark's wishlist instead; LibraryThing's Read but unowned stay out either way (read, but neither in the house nor wished for).
- **Takes the series off Goodreads titles,** so "The Name of the Wind (The Kingkiller Chronicle, #1)" matches the same book read from a spine.
- **Turns `<br/>` in reviews into line breaks,** and keeps both the review and any private notes.
- **Keeps the day each book was read:** Goodreads's and LibraryThing's `Date Read` become `finished`, and a LibraryThing book with one is read.
- **Keeps reading shelves out of tags:** read, currently-reading and to-read (and LibraryThing's Your library, Wishlist and the like) become the book's status or nothing. Shelves and collections the person made become tags.
- **Turns LibraryThing's names round:** "Le Guin, Ursula K." becomes "Ursula K. Le Guin".

If it left books out, ask once, with the count: "212 are on your to-read shelf with no copy owned — put them on your Shelfmark wishlist, or leave them out?" Leaving them out is the default, so don't hold things up: hand over the file, and if they want those books on the wishlist, run it again with `--keep-unowned` and hand over the new file instead.

Exports are usually large, so hand over the file rather than the link, and say how many books came through. Over 3,000, the script writes numbered files.

Without code tools, map the columns by hand the same way:
- **Goodreads:** `Title` (without the series in brackets), `Author` and `Additional Authors`, `ISBN13` or `ISBN` (strip the `="…"` wrapper), `Publisher`, `Year Published`, `Number of Pages`, `My Rating` → `rating` (0 means none), `Exclusive Shelf` → `status`, `Date Read` (2023/04/15) → `finished` (2023-04-15), `Bookshelves` (less the reading shelves) → `tags`, `My Review` and `Private Notes` → `notes`.
- **LibraryThing:** `Title`, `Primary Author` (turned round), `ISBN` (pass it as it is), `Publication` (the publisher before the bracket), `Date`, `Rating`, `Date Read` → `finished`, with `status` `read`, `Tags` plus the person's own `Collections` → `tags`, `Review`, `Comment` and `Private Comment` → `notes`.
