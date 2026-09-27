# Shelfmark

A catalog for the books in your house: what you have, where each one is, what you've read, and who borrowed what. Photograph a shelf, send the photos to Claude, and open the link it gives you to add them.

It is one HTML file with no build step and no server. Open `index.html` in a browser, or host it anywhere static (GitHub Pages works). It lives at [junkdrawer.works/shelfmark](https://junkdrawer.works/shelfmark/).

## What it does

- **Catalog.** For each book it keeps:
  - title, subtitle, authors
  - ISBN, publisher, year, pages, format
  - where it is: a room and a shelf, in your own words
  - unread, reading or read, and a rating
  - who you lent it to, and since when
  - tags and notes
  - edition details: signed, first edition, condition, printing
- **Find things.** Search matches every field, borrowers included. Filters cover status, lent out, room and tag. Sort by author, title, shelf (grouped under each room and shelf), or newest first.
- **Add from photos.** Claude reads spines, covers, barcodes and copyright pages and makes a Shelfmark link. Opening it shows the list first. There you can:
  - fix titles and authors;
  - put the whole batch on one shelf;
  - see books you already own, which are unticked;
  - see anything Claude wasn't sure of, marked **Check**.
  Checked books keep a **To check** filter until you say they're right.
- **Covers and lookups** from Open Library, only if you turn them on in Settings. Covers are found by ISBN, or by title and author for a book without one (so a cover may show another edition), and each cover's id is remembered in the browser. Lookups send the ISBN, title and author, nothing else.
- **Backups.** Download the whole library as a file, open it on any device (it merges), or download a spreadsheet (CSV).

## Your data

The [privacy page](https://junkdrawer.works/shelfmark/privacy.html) (`privacy.html`) says this for anyone using it. Your catalog is kept in this browser's local storage and, if you turn on sync, in one file in your own Google Drive. Nothing else stores it: this site is static files, and links from Claude carry their books in the part of the address after `#`, which browsers never send to a server.

Shelfmark asks Google for the narrowest Drive permission there is (`drive.file`). It can see and change only files it made itself, which is one folder, `Shelfmark`, holding `Shelfmark library.json`. It can't see anything else in your Drive.

## Sync across devices with Google Drive

Each device keeps its own copy and works offline. When you sync, Shelfmark:
1. reads the file in your Drive;
2. merges it with this device's copy, book by book, keeping whichever version was changed most recently;
3. writes it back if anything changed.

Removed books are remembered, so a removal on your phone reaches your laptop instead of the old copy coming back. Syncing happens:
- a few seconds after each change;
- when you come back to the tab;
- once a minute while the page is open;
- whenever you tap **Sync now**.

Google signs a page like this out after an hour. When that happens the sync button turns amber and says **Sync**, and one tap signs you back in. Your changes wait safely on the device until then.

The sign-in is shared with the other junkdrawer.works projects on the same device (kept under `junkdrawer.google` in localStorage). Signing in to any of them lets Shelfmark sync during that hour without asking, and the other way round. **Disconnect this device** only stops syncing here; it doesn't revoke Google's permission, which would sign every project out. To take the permission back, remove junkdrawer.works under Third-party apps & services in your Google Account.

Drive keeps earlier versions of the library file for 30 days (**File information › Manage versions** in Drive). If the file is ever damaged, Shelfmark leaves it alone rather than overwrite it, and says so.

### One-time setup

Sync needs an OAuth client ID from a Google Cloud project, tied to the address Shelfmark is served from. It takes about ten minutes:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, for example "Shelfmark".
2. In **APIs & Services › Library**, find **Google Drive API** and enable it.
3. Open **Google Auth Platform** (called **OAuth consent screen** in older versions of the console) and choose **Get started**:
   - app name: Shelfmark
   - support email: your address
   - audience: **External**
   - contact email: your address
4. In **Data Access**, choose **Add or remove scopes**. Add `https://www.googleapis.com/auth/drive.file` ("See, edit, create, and delete only the specific Google Drive files you use with this app"), then save.
5. In **Branding**, fill in:
   - **Application home page:** `https://junkdrawer.works/shelfmark/`
   - **Application privacy policy link:** `https://junkdrawer.works/shelfmark/privacy.html`
   - **Authorized domains:** `junkdrawer.works`

   Save. Google won't publish the app without these, even though the form doesn't mark them required.
6. In **Audience**, choose **Publish app**. `drive.file` is a non-sensitive scope, so publishing needs no review. Or skip publishing: an app left in **Testing** works for the Google accounts you add under **Test users**, but Google may ask them to approve it again from time to time.
7. In **Clients**, create a client of type **Web application**. Under **Authorized JavaScript origins**, add `https://junkdrawer.works`, then create it and copy the **Client ID**. It ends in `.apps.googleusercontent.com`. A client ID isn't a secret; it only works from the origins you listed.
8. Put the ID in `GOOGLE_CLIENT_ID` near the top of the script in `index.html`. Until then, you can paste it into **Settings › Sync with Google Drive** on each device.

Then open **Settings › Connect Google Drive** on each device you use. The copy at junkdrawer.works already has its client ID.

## Adding books with Claude

`skill/shelfmark-cataloger/` is a skill for Claude. Send it photos of your shelves and it:
1. reads every spine, cover, barcode or copyright page, and says what it couldn't read;
2. checks each ISBN's check digit, so a misread ISBN is dropped and flagged rather than guessed;
3. hands the books to Shelfmark as a link and a `.shelfmark.json` file.

It can also convert a Goodreads or LibraryThing export. With a Google Drive connector, it can answer questions about your library by reading the library file, which it never changes.

To use it, zip the `shelfmark-cataloger` folder and upload it as a skill in claude.ai; it needs code execution turned on. Its script also runs on its own:

```
python3 skill/shelfmark-cataloger/scripts/make_shelfmark.py books.json
```

## Opening books from a link

A link like `https://junkdrawer.works/shelfmark/#s1z…` carries a batch of books in the part after `#`. Opening one shows the books and asks before adding them. Opening the same link again says so and unticks what's already there. The format is the batch JSON, compressed with raw DEFLATE and base64url-encoded; `#s1j…` is the same uncompressed. `#batch=` followed by URL-encoded JSON also works, for writing one by hand. `skill/shelfmark-cataloger/references/shelfmark-format.md` describes every field.

## Files

- **A batch from Claude** is `{"shelfmark": 1, "batch": {…}}`.
- **A library backup, or the Drive file,** is `{"shelfmark": 1, "library": {"books": {…}, "seen": {…}}}`.

Both open from **Import › Open a file**. Opening a library merges it into yours. Anything that comes in is cleaned field by field first, so a hand-edited file can't break the page.

## Tests

```
node test/library.test.js
```

No dependencies. The test reads the logic straight out of `index.html` and checks:
- **ISBNs:** ISBN-10 to ISBN-13 conversion, and check digits.
- **Cleaning:** every field is trimmed, clamped and mapped.
- **Merging:** hundreds of random libraries merge the same whatever the order, and a later removal or edit wins.
- **Duplicates:** matched by ISBN, and by title and author surname.
- **Links:** compressed, uncompressed, hand-written and pasted links all open.
- **The skill's script:** its link and file open in the page with every field intact. This runs when `python3` is available.
- **Spreadsheet export:** quoting, and defusing cells that would otherwise run as formulas.

## License

MIT — see [LICENSE](LICENSE).
