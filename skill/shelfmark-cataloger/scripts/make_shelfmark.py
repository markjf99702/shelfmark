#!/usr/bin/env python3
"""Turn a list of books into a Shelfmark batch: a link that opens it in Shelfmark, and a file.

    python3 make_shelfmark.py books.json [--out DIR] [--base URL] [--no-link]
    python3 make_shelfmark.py export.csv --import goodreads|librarything [--keep-unowned] [--keep-ebooks] [--out DIR]
    python3 make_shelfmark.py details.json --details [--library LIBRARY.json [--redo]] [--out DIR] [--base URL] [--no-link]
    python3 make_shelfmark.py --details --library LIBRARY.json

books.json (every field but "title" is optional; "authors" and "tags" may be a list or one string, which is split
on commas and semicolons, and authors on " & " too, as Shelfmark splits them):

{
  "name": "Living room, tall bookcase",          # shown when the batch is opened
  "room": "Living room", "shelf": "Tall bookcase",  # for any book that doesn't say its own
  "books": [
    {"title": "Middlemarch", "authors": ["George Eliot"], "isbn": "978-0-14-143954-9",
     "publisher": "Penguin Classics", "year": 2003, "format": "paperback",
     "shelf": "Tall bookcase, top", "status": "read", "rating": 4, "finished": "2026-03-14", "tags": ["classics"],
     "notes": "", "edition": "", "signed": false, "first": false, "condition": "good",
     "loan": {"to": "Sam", "since": "2026-09-01"},
     "unsure": "spine cut off at the top"}       # anything you're not sure of, in a few words
  ]
}

It checks every ISBN's check digit (a misread one is dropped and flagged, never guessed at), maps
common words for format, condition and status onto Shelfmark's, flags likely doubles in the list,
and exits 1 (printing why) if the input can't be used. Shelfmark takes 3,000 books at a time, so a
longer list is written as numbered files of up to 3,000 each, to open one after another. A link longer than
8,000 characters comes as numbered links of up to 50 books each instead, each opening its own review (up to
20 of them; past that, it's the file).

With --import it reads a Goodreads or LibraryThing export (CSV) instead, and leaves out books that
aren't in the house (on the to-read shelf with no copy owned, or only on the Wishlist) unless it's
given --keep-unowned, which puts them on Shelfmark's wishlist. Books LibraryThing has only as Read but
unowned stay out either way: read, but neither in the house nor wished for. E-books and audiobooks aren't on a
shelf either, so they're left out too, unless it's given --keep-ebooks. It says how many. It keeps each book's
format, the day it was added and the day it was read, and LibraryThing's loans.

A batch with "wanted": true (books from a shop's table, or a list of books to buy) goes on the wishlist,
as does a book with "wanted": true.

With --details it makes reading details for books already in the library instead: what kind of book each is
and what reading it is like, for What to read next. details.json is {"name": ..., "books": [...]}, each entry
naming its book by "id" (from the library file) and "title"/"authors", with any of "kind", "genres", "moods",
"pace", "chapters", "way", "blurb" and "pages". Opening the link or file fills in what each book doesn't have yet.
Batches of new books can carry the same fields.

With --library (the library file: Shelfmark library.json from Drive, or a backup) it checks the details against the
library first. Each entry is matched to its book the way Shelfmark will match it; an id that names no book, or another
book, is put right from the title; an entry that matches no book, or several different books, is pointed out; details a book already has are taken off, so the link carries only what's new (--redo keeps them,
for when the person asked to redo them and will tick Replace); and the books that still have no reading details are
listed. With --library and no details file, it only lists those books.
"""
import argparse, base64, csv, datetime, hashlib, io, json, math, re, sys, unicodedata, zlib
from pathlib import Path

DEFAULT_BASE = 'https://shelfmark.junkdrawer.works/'
MAX_BOOKS = 3000  # the most Shelfmark takes in one batch (BATCH_MAX in index.html)
# A link longer than this is handed over as numbered links instead, of up to PER_LINK books each: RFC 9110 (HTTP
# Semantics, June 2022), section 4.1, recommends that everything handling a URI supports at least 8000 octets, and
# Claude has to copy every character of a link, where one slip breaks it. Past MAX_LINKS links, it's the file only.
LINK_MAX = 8000
PER_LINK = 50
MAX_LINKS = 20
FORMATS = {
    'hardcover': 'hardcover', 'hardback': 'hardcover', 'hard cover': 'hardcover', 'hc': 'hardcover', 'cloth': 'hardcover', 'library binding': 'hardcover',
    'paperback': 'paperback', 'softcover': 'paperback', 'soft cover': 'paperback', 'trade paperback': 'paperback', 'pb': 'paperback', 'tpb': 'paperback',
    'mass-market': 'mass-market', 'mass market': 'mass-market', 'mass market paperback': 'mass-market', 'mass-market paperback': 'mass-market', 'pocket': 'mass-market',
    'board': 'board', 'board book': 'board', 'leather': 'leather', 'leather-bound': 'leather', 'leatherbound': 'leather', 'leather bound': 'leather', 'other': 'other', 'spiral': 'other',
    'perfect paperback': 'paperback', 'spiral-bound': 'other', 'spiral bound': 'other', 'ring-bound': 'other',
}
CONDITIONS = {
    'fine': 'fine', 'as new': 'fine', 'like new': 'fine', 'new': 'fine', 'near fine': 'fine', 'mint': 'fine',
    'very good': 'very-good', 'very-good': 'very-good', 'vg': 'very-good', 'good': 'good', 'g': 'good',
    'fair': 'fair', 'worn': 'fair', 'poor': 'poor', 'reading copy': 'poor', 'damaged': 'poor',
}
STATUSES = {
    'unread': 'unread', 'to read': 'unread', 'to-read': 'unread', 'want to read': 'unread', 'not read': 'unread',
    'reading': 'reading', 'currently reading': 'reading', 'currently-reading': 'reading', 'in progress': 'reading',
    'read': 'read', 'finished': 'read', 'done': 'read',
}

# Reading details. index.html keeps the same lists (KINDS, WAYS, PACES, CHAPTERS, MOODS, GENRES); the test checks they agree.
KINDS = ['fiction', 'nonfiction', 'poetry']
WAYS = ['through', 'dip', 'browse']
PACES = ['slow', 'medium', 'fast']
CHAPTERS = ['short', 'medium', 'long']
MOODS = ['adventurous', 'challenging', 'dark', 'emotional', 'funny', 'hopeful', 'informative', 'inspiring', 'lighthearted', 'mysterious',
         'reflective', 'relaxing', 'sad', 'tense']
GENRES = ['literary', 'classics', 'historical-fiction', 'mystery', 'thriller', 'sf', 'fantasy', 'romance', 'horror', 'short-stories', 'humor',
          'comics', 'ya', 'children', 'history', 'biography', 'politics', 'economics', 'philosophy', 'science', 'nature', 'travel', 'art',
          'food', 'business', 'self-help', 'society', 'religion', 'sports', 'true-crime', 'reference']
DETAIL_KEYS = ('kind', 'genres', 'moods', 'pace', 'chapters', 'way', 'blurb')
WORDS = {
    'non-fiction': 'nonfiction', 'cover to cover': 'through', 'read through': 'through', 'dip in and out': 'dip', 'dip in': 'dip',
    'literary fiction': 'literary', 'historical fiction': 'historical-fiction', 'mystery and crime': 'mystery', 'crime': 'mystery',
    'science fiction': 'sf', 'sci-fi': 'sf', 'short stories': 'short-stories', 'humour': 'humor', 'graphic novel': 'comics',
    'graphic novels': 'comics', 'young adult': 'ya', "children's": 'children', 'children’s': 'children', 'biography and memoir': 'biography',
    'memoir': 'biography', 'nature and gardening': 'nature', 'gardening': 'nature', 'art and design': 'art', 'design': 'art',
    'food and drink': 'food', 'cooking': 'food', 'cookbook': 'food', 'self help': 'self-help', 'society and culture': 'society',
    'true crime': 'true-crime', 'light-hearted': 'lighthearted',
}


# What JavaScript calls white space (its \s and trim()), so text is cleaned here as Shelfmark cleans it: Python's own
# \s also takes \x1c-\x1f and \x85, and leaves out the byte-order mark.
WS = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def text(v):
    """A string or number as Shelfmark's page sees it: anything else (true, a list, an object) is no text."""
    if isinstance(v, bool) or not isinstance(v, (str, int, float)):
        return ''
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v) if math.isfinite(v) else ''
    return str(v)


def cut(t, n):
    """The first n characters of t as Shelfmark counts them (in UTF-16, so an emoji is two), never half an emoji, with
    no white space left at the end. Cut before it's tidied, so cleaning it again gives the same text."""
    u = 0
    for i, c in enumerate(t):
        u += 2 if ord(c) > 0xFFFF else 1
        if u > n:
            t = t[:i]
            break
    while t and (t[-1] in WS or '\ud800' <= t[-1] <= '\udbff'):
        t = t[:-1]
    return t


def u16(t):
    """How long text is as Shelfmark counts it: in UTF-16, so an emoji is two."""
    return sum(2 if ord(c) > 0xFFFF else 1 for c in t)


ALL = 10 ** 9  # as a limit: no limit, for seeing how long text is before Shelfmark cuts it


def short(t, n=60):
    """A long title cut at a word near n characters, for a warning."""
    if u16(t) <= n:
        return t
    c = cut(t, n + 1)
    w = c.rfind(' ')
    return (c[:w] if w >= n // 2 else cut(t, n)).rstrip(' ,;:.-') + '…'


def too_long(title, what, whole_text, n, warn):
    """Says when text is longer than Shelfmark keeps, so the end of a long review or reading log isn't lost unseen."""
    if u16(whole_text) > n:
        warn.append(f'“{title}”: {what} {u16(whole_text):,} characters; Shelfmark keeps {n:,}')


def s(v, n):
    """Text in one line, as Shelfmark's str()."""
    return cut(re.sub(f'[{WS}]+', ' ', text(v)).strip(WS), n)


def para(v, n):
    """Text in paragraphs (notes), as Shelfmark's para(): line breaks kept, at most one blank line in a row."""
    if not isinstance(v, str):
        return ''
    return cut(re.sub(r'\n{3,}', '\n\n', re.sub(r'[ \t]+\n', '\n', re.sub(r'\r\n?', '\n', v))).strip(WS), n)


def isbn13(v):
    """ISBN-10 or ISBN-13 in any punctuation → ISBN-13 digits, or '' if the check digit is wrong."""
    d = re.sub(r'[^0-9Xx]', '', str(v or '')).upper()
    if len(d) == 10:
        if not re.fullmatch(r'\d{9}[\dX]', d):
            return ''
        if sum((10 if c == 'X' else int(c)) * (10 - i) for i, c in enumerate(d)) % 11:
            return ''
        d = '978' + d[:9]
        return d + str((10 - sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(d)) % 10) % 10)
    if len(d) == 13 and re.fullmatch(r'97[89]\d{10}', d):
        return d if sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(d)) % 10 == 0 else ''
    return ''


ISBN_SEPS = r'''[,;|/\[\](){}"'=]+'''


def first_isbn(v):
    """The first valid ISBN in a value that may hold several, the way exports give them: "0618260307, 9780618260300",
    "[0618260307]", '="0618260307"'. The whole value is tried first, so "978 0 14 044913 6" is one ISBN."""
    v = str(v or '')
    for parts in ([v], re.split(ISBN_SEPS, v), re.split(ISBN_SEPS, ','.join(v.split()))):
        for p in parts:
            good = isbn13(p)
            if good:
                return good
    return ''


def fold(t):
    """For telling two values apart the way Shelfmark does: accents off, lower case."""
    return re.sub(r'[\u0300-\u036f]', '', unicodedata.normalize('NFD', t)).lower()


def items(v, n, each, names=False):
    """Several values in one field, as Shelfmark reads them (list() in index.html): a list, or text split on commas and
    semicolons, so "Arts & crafts" stays one tag. Names (authors) also split on " & ", not on "and", and keep a "Jr." or
    "III" with the name before it ("Kurt Vonnegut, Jr."). Empty pieces go first, so "Vonnegut, , Jr." is one name. Each
    value up to `each` characters, each once, `n` in all."""
    if isinstance(v, str):
        v = re.split(r'\s*[,;]\s*|\s+&\s+' if names else r'\s*[,;]\s*', v)
    elif not isinstance(v, list):
        v = [v] if v else []
    v = [y for y in (s(x, each) for x in v) if y]
    if names:
        r = []
        for y in v:
            if r and SUFFIX.match(y):
                r[-1] = s(r[-1] + ', ' + y, each)
            else:
                r.append(y)
        v = r
    out, seen = [], set()
    for x in v:
        if fold(x) not in seen:
            seen.add(fold(x))
            out.append(x)
    return out[:n]


def names(v, n=12):
    return items(v, n, 120, True)


def whole(v, lo, hi, how='first'):
    """A whole number in range, read as Shelfmark reads it (int() in index.html). A plain number, decimals and all, is
    rounded half up (3.5 → 4, where Python's round() gives 4 and 2.5 → 2). Otherwise digit groups are joined ("1,024")
    and a year is the first four-digit number ("2nd ed. 1999"), a page count the largest ("2 vols, 880") and anything
    else the first."""
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        x = v
    else:
        t = text(v).strip(WS)
        if re.fullmatch(r'-?([0-9]+\.?[0-9]*|\.[0-9]+)', t):
            x = float(t)
        else:
            ns = re.findall(r'[0-9]+(?:\.[0-9]+)?', re.sub(r'([0-9])[, \u00a0\u2009\u202f](?=[0-9]{3}(?![0-9]))', r'\1', t))
            four = [x for x in ns if re.match(r'[0-9]{4}(\.|$)', x)] if how == 'year' else []
            x = 0 if not ns else max(float(x) for x in ns) if how == 'most' else float((four or ns)[0])
    if not math.isfinite(x):
        return 0
    return max(lo, min(hi, math.floor(x + 0.5)))


def yes(v):
    """Signed, first edition: yes only for true, 1, or "true", "yes" or "1" in any case, as Shelfmark reads them."""
    return v is True or (isinstance(v, (int, float)) and not isinstance(v, bool) and v == 1) or (isinstance(v, str) and re.fullmatch(r'(?i)true|yes|1', v.strip(WS)) is not None)


def day(v):
    """A day as YYYY-MM-DD, and one on the calendar (not 30 February), as Shelfmark's day() reads it. Newer Pythons'
    fromisoformat also takes 20260101 and 2026-W01-1, which Shelfmark doesn't, so the form is checked first."""
    v = s(v, ALL)
    if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', v):
        return ''
    try:
        return datetime.date.fromisoformat(v).isoformat()
    except ValueError:
        return ''


def no_day(title, what, v, warn):
    """Says when a day was given that Shelfmark can't keep, so a slip (30 February) can be put right."""
    if s(v, ALL) and not day(v):
        warn.append(f'“{title}”: {what} “{s(v, 40)}” isn’t a day as YYYY-MM-DD; left off')


def word(v):
    w = s(v, 40).lower()
    return WORDS.get(w, w)


def reading(b, title, warn):
    """The reading details in a book or an entry: each value checked against its list, unknown ones left off with a warning."""
    out = {}
    for key, allowed in (('kind', KINDS), ('pace', PACES), ('chapters', CHAPTERS), ('way', WAYS)):
        v = word(b.get(key))
        if v and v not in allowed:
            warn.append(f'“{title}”: {key} “{v}” isn’t one Shelfmark knows ({", ".join(allowed)}); left off')
        elif v:
            out[key] = v
    for key, allowed in (('genres', GENRES), ('moods', MOODS)):
        vals = b.get(key)
        vals = re.split(r'\s*[,;]\s*', vals) if isinstance(vals, str) else vals if isinstance(vals, list) else []
        keep = []
        for v in (word(x) for x in vals):
            if v and v not in allowed:
                warn.append(f'“{title}”: {key[:-1]} “{v}” isn’t one Shelfmark knows; left off')
            elif v and v not in keep:
                keep.append(v)
        if len(keep) > 4:
            warn.append(f'“{title}”: more than four {key}; kept the first four')
        out[key] = keep[:4]
    out['blurb'] = s(b.get('blurb'), 300)
    too_long(title, 'the blurb is', s(b.get('blurb'), ALL), 300, warn)
    return out


def clean(b, i, warn):
    if not isinstance(b, dict):
        warn.append(f'#{i + 1}: not a book object, left out')
        return None
    title = s(b.get('title'), 300)
    if not title:
        warn.append(f'#{i + 1}: no title, left out')
        return None
    name = short(title)  # in the warnings about what's cut or dropped
    too_long(name, 'the title is', s(b.get('title'), ALL), 300, warn)
    flags = [s(b.get('unsure') or b.get('check'), 300)]
    out = {'title': title, 'sub': s(b.get('sub') or b.get('subtitle'), 300), 'authors': names(b.get('authors') or b.get('author') or [])}
    every = names(b.get('authors') or b.get('author') or [], ALL)
    if len(every) > 12:
        warn.append(f'“{name}”: {len(every)} authors; Shelfmark keeps the first 12')
    raw = s(b.get('isbn'), 200)
    if re.search(r'\d', raw):  # an empty Goodreads cell, ="", is no ISBN at all
        good = first_isbn(raw)
        if good:
            out['isbn'] = good
        else:
            flags.append(f'ISBN read as {raw[:40]} fails its check digit, so it was left off')
            warn.append(f'“{title}”: ISBN {raw[:40]} fails its check digit; dropped and flagged')
    out['publisher'] = s(b.get('publisher'), 120)
    out['year'] = whole(b.get('year'), 0, 2200, 'year')
    out['pages'] = whole(b.get('pages'), 0, 50000, 'most')
    for key, table, what in (('format', FORMATS, 'format'), ('condition', CONDITIONS, 'condition'), ('status', STATUSES, 'status')):
        v = s(b.get(key), 40).lower()
        if v and v not in table:
            warn.append(f'“{title}”: {what} “{v}” isn’t one Shelfmark knows; left off')
        out[key] = table.get(v, '')
    if out['status'] == 'unread':
        out['status'] = ''
    out['room'] = s(b.get('room'), 60)
    out['shelf'] = s(b.get('shelf'), 60)
    out['rating'] = whole(b.get('rating'), 0, 5)
    # The day it was finished, kept for a book that's read, as Shelfmark keeps it. A day with no status says it was read.
    out['finished'] = day(b.get('finished'))
    no_day(name, 'finished', b.get('finished'), warn)
    if out['finished'] and not s(b.get('status'), 40):
        out['status'] = 'read'
    if out['status'] != 'read':
        out['finished'] = ''
    out['aside'] = yes(b.get('aside'))  # a book they gave up: Shelfmark shows it as Set aside
    out['wanted'] = yes(b.get('wanted'))  # a book they want, not one in the house: it goes on the wishlist
    loan = b.get('loan') if isinstance(b.get('loan'), dict) else {'to': b.get('lent_to') or b.get('lentTo')} if b.get('lent_to') or b.get('lentTo') else None
    if loan and s(loan.get('to'), 80):
        out['loan'] = {'to': s(loan.get('to'), 80)}
        if day(loan.get('since')):
            out['loan']['since'] = day(loan.get('since'))
        no_day(name, 'lent since', loan.get('since'), warn)
    out['tags'] = items(b.get('tags'), 20, 40)
    every = items(b.get('tags'), ALL, 40)
    if len(every) > 20:
        warn.append(f'“{name}”: {len(every)} tags; Shelfmark keeps the first 20')
    out['notes'] = para(b.get('notes'), 4000)
    too_long(name, 'notes are', para(b.get('notes'), ALL), 4000, warn)
    out['edition'] = s(b.get('edition'), 120)
    out['signed'] = yes(b.get('signed'))
    out['first'] = yes(b.get('first')) or yes(b.get('first_edition'))
    out['added'] = day(b.get('added'))
    no_day(name, 'added', b.get('added'), warn)
    out.update(reading(b, title, warn))
    flag = '; '.join(f for f in flags if f)[:300]
    if flag:
        out['unsure'] = flag
    return {k: v for k, v in out.items() if v not in ('', 0, False, None, [], {})}


# ---------- Goodreads and LibraryThing exports ----------
# --import reads the export itself and does the mechanical part here rather than by hand: it leaves out books that
# aren't in the house (on the to-read shelf with no copy owned, or only wished for, and e-books and audiobooks), takes
# "(Series, #2)" off titles so they match the same book read from a spine, keeps the day each was read (Date Read, as
# finished), its format, the day it was added and LibraryThing's loans, turns <br/> into line breaks, keeps reading
# shelves out of tags and turns LibraryThing's "Le Guin, Ursula K." round.

SUFFIX = re.compile(r'^(jr|sr|ii|iii|iv|ph\.?d|m\.?d)\.?$', re.I)
GR_SHELVES = {'read', 'currently-reading', 'to-read'}  # Goodreads's own shelves, which say where a book is in the reading
LT_SHELVES = {'your library', 'wishlist', 'currently reading', 'to read', 'read but unowned'}  # LibraryThing's own collections
LT_UNOWNED = {'wishlist', 'read but unowned'}


def read_table(path):
    """An export's rows as dicts keyed by its header, lower-cased: CSV or tab-separated, UTF-8 (BOM or not),
    UTF-16, or a Windows code page from a spreadsheet's Save As."""
    try:
        raw = Path(path).read_bytes()
    except OSError as e:
        raise SystemExit(f'error: can’t read {path}: {e}')
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'):
        text = raw.decode('utf-16')
    elif b'\x00' in raw[:400]:
        text = raw.decode('utf-16-le' if raw[1:2] == b'\x00' else 'utf-16-be', errors='replace')
    else:
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = raw.decode('cp1252', errors='replace')
    text = text.lstrip('﻿')
    head = text.split('\n', 1)[0]
    sep = max((',', '\t', ';'), key=head.count)
    rows = csv.reader(io.StringIO(text, newline=''), delimiter=sep)
    header = [h.strip().strip('\'"').lower() for h in next(rows, [])]  # older LibraryThing files say 'TITLE'
    return header, [dict(zip(header, r)) for r in rows if any(c.strip() for c in r)]


def cell(r, *names):
    for n in names:
        v = re.sub(r'^="(.*)"$', r'\1', (r.get(n) or '').strip()).strip()  # Goodreads writes ISBNs as ="0618260307"
        if v:
            return v
    return ''


def split_names(v):
    """'Neil Gaiman, Kurt Vonnegut, Jr.' → ['Neil Gaiman', 'Kurt Vonnegut, Jr.']"""
    out = []
    for x in (p.strip() for p in v.split(',')):
        if out and SUFFIX.match(x):
            out[-1] += ', ' + x
        elif x:
            out.append(x)
    return out


def turned(name):
    """LibraryThing's 'Le Guin, Ursula K.' → 'Ursula K. Le Guin'; 'Vonnegut, Kurt, Jr.' → 'Kurt Vonnegut, Jr.'"""
    p = [x.strip() for x in name.split(',')]
    if len(p) == 2 and all(p):
        return f'{p[1]} {p[0]}'
    if len(p) == 3 and all(p) and SUFFIX.match(p[2]):
        return f'{p[1]} {p[0]}, {p[2]}'
    return name


def series_off(title):
    """'The Name of the Wind (The Kingkiller Chronicle, #1)' → 'The Name of the Wind'"""
    t = re.sub(r'\s*\((?=[^()]*#\s*\d)[^()]*\)\s*$', '', title)
    return t or title


def lines(*texts):
    """Reviews and notes, with Goodreads's <br/> as line breaks, each kept, a blank line apart."""
    return '\n\n'.join(t for t in (re.sub(r'<br\s*/?>', '\n', x, flags=re.I).strip() for x in texts) if t)


def when(v):
    """A day as an export writes it, Goodreads's "2023/04/15" or LibraryThing's "2023-04-15", as Shelfmark keeps it."""
    m = re.match(r'\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', v or '')
    return day(f'{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}') if m else ''


def stars(v):
    try:
        return int(float(v) + 0.5)  # LibraryThing gives half stars; 3.5 → 4, as Shelfmark rounds
    except (ValueError, OverflowError):
        return 0


# E-books and audiobooks, as Goodreads's Binding and LibraryThing's Media name them: not on a shelf in the house.
# "ebook" as a word of its own, so a Notebook or a Picturebook isn't one.
DIGITAL = re.compile(r'(?i)kindle|\be-?book|nook|kobo|audio|audible|mp3|digital|electronic')


def binding(v):
    """A binding as an export names it → Shelfmark's format, or '' for one it doesn't know ("Unknown Binding", "Paper
    Book"). LibraryThing may give the whole path ("Book > Paper Book > Paperback"): the most specific piece wins."""
    for piece in reversed(re.split(r'\s*[>,;/]\s*', v.strip().lower())):
        if piece in FORMATS:
            return FORMATS[piece]
    return ''


def digital(v, keep):
    """For a book whose binding or media says it's an e-book or audiobook: None, to leave it out, or with --keep-ebooks
    its format (other) and edition (the binding as given)."""
    return {'format': 'other', 'edition': v} if keep else None


def left_out(parts):
    """The 'Left out:' line's words, and what to run again for each, from [(count, words, hint)]."""
    parts = [p for p in parts if p[0]]
    return ', and '.join(w for _, w, _ in parts), ' '.join(h for _, _, h in parts if h)


EBOOK_HINT = 'To bring in the e-books and audiobooks, run again with --keep-ebooks.'


def ebook_count(n):
    return '1 e-book or audiobook' if n == 1 else f'{n:,} e-books and audiobooks'


def from_goodreads(rows, keep, ebooks=False):
    books, left, dig = [], 0, 0
    for r in rows:
        shelf = cell(r, 'exclusive shelf').lower()
        away = shelf == 'to-read' and not whole(cell(r, 'owned copies'), 0, 9999)  # not in the house
        if away:
            left += 1
            if not keep:
                continue
        bind, extra = cell(r, 'binding'), {}
        if not away and DIGITAL.search(bind):  # a Kindle edition or an audiobook: not on a shelf
            dig += 1
            extra = digital(bind, ebooks)
            if extra is None:
                continue
        books.append({
            'wanted': away,
            'format': binding(bind), 'added': when(cell(r, 'date added')), **extra,
            'title': series_off(cell(r, 'title')),
            'authors': [cell(r, 'author')] + split_names(cell(r, 'additional authors')),
            'isbn': ', '.join(x for x in (cell(r, 'isbn13'), cell(r, 'isbn')) if x),
            'publisher': cell(r, 'publisher'), 'year': cell(r, 'year published'), 'pages': cell(r, 'number of pages'),
            'rating': stars(cell(r, 'my rating')),
            'status': {'read': 'read', 'currently-reading': 'reading'}.get(shelf, ''),
            'finished': when(cell(r, 'date read')),
            'tags': [t for t in (x.strip() for x in cell(r, 'bookshelves').split(',')) if t and t.lower() not in GR_SHELVES],
            'notes': lines(cell(r, 'my review'), cell(r, 'private notes')),
        })
    said = f'{left:,} on the to-read shelf with no copy owned' if left else ''
    out, hint = left_out([(0 if keep else left, said, 'To put them on the wishlist, run again with --keep-unowned.' if not dig or ebooks else
                           f'To put the {left:,} on the to-read shelf on the wishlist, run again with --keep-unowned.'),
                          (0 if ebooks else dig, ebook_count(dig) + ' (Kindle Edition, Audible Audio and the like)', EBOOK_HINT)])
    return books, {'wished': said if keep else '', 'left': out, 'hint': hint}


def publisher(v):
    """LibraryThing's 'Houghton Mifflin (2002), Paperback, 366 pages' → 'Houghton Mifflin'"""
    v = re.split(r'\s*\(', v)[0]
    v = re.sub(r',\s*\d{4}\b.*$', '', v)
    return v.split(' : ')[-1].strip(' .,;')


def lt_loan(r):
    """LibraryThing's lending: who has the book and since when, unless it says the book came back. Its column names
    aren't documented, so a few spellings are tried; a file without them has no loans."""
    to = cell(r, 'lending patron', 'lent to', 'borrower')
    back = when(cell(r, 'lending end', 'returned', 'date returned')) or re.search(r'(?i)return|back|avail', cell(r, 'lending status'))
    return {'to': to, 'since': when(cell(r, 'lending start', 'lent on', 'date lent'))} if to and not back else None


def from_librarything(rows, keep, ebooks=False):
    books, wished, read, dig = [], 0, 0, 0
    for r in rows:
        held = [x.strip() for x in cell(r, 'collections').split(',') if x.strip()]
        low = {x.lower() for x in held}
        away = bool(low & LT_UNOWNED) and 'your library' not in low  # not in the house
        wish = away and 'wishlist' in low  # wished for: with --keep-unowned, on Shelfmark's wishlist
        if away:
            wished += wish
            read += not wish
            # A book only read, not owned (Read but unowned), isn't one to buy, so it stays out either way.
            if not (keep and wish):
                continue
        media, extra = cell(r, 'media'), {}
        if not away and DIGITAL.search(media):  # an e-book or audiobook: not on a shelf
            dig += 1
            extra = digital(media, ebooks)
            if extra is None:
                continue
        done = when(cell(r, 'date read', 'date finished', 'date ended', 'finished'))
        books.append({
            'wanted': wish,
            'format': binding(media), 'added': when(cell(r, 'acquired', 'date acquired', 'entry date', 'date entered', 'date added')),
            'loan': None if wish else lt_loan(r), **extra,
            'title': cell(r, 'title'),
            'authors': [cell(r, 'author (first, last)') or turned(cell(r, 'primary author', 'author (last, first)'))],
            'isbn': ', '.join(x for x in (cell(r, 'isbn'), cell(r, 'isbns')) if x),
            'publisher': publisher(cell(r, 'publication')), 'year': cell(r, 'date'), 'pages': cell(r, 'page count'),
            'rating': stars(cell(r, 'rating')),
            'status': 'reading' if 'currently reading' in low else 'read' if done else '',
            'finished': done,
            'tags': [t for t in (x.strip() for x in cell(r, 'tags').split(',')) if t] + [x for x in held if x.lower() not in LT_SHELVES],
            'notes': lines(cell(r, 'review'), cell(r, 'comment', 'comments'), cell(r, 'private comment', 'private comments')),
        })
    dig_out = (0 if ebooks else dig, ebook_count(dig) + ' (Ebook, Audiobook and the like)', EBOOK_HINT)
    if not keep:
        out, hint = left_out([(wished + read, f'{wished + read:,} in Wishlist or Read but unowned and not in Your library',
                               '' if not wished else 'To put them on the wishlist, run again with --keep-unowned.' if not read else
                               f'To put the {wished:,} in Wishlist on the wishlist, run again with --keep-unowned.'), dig_out])
        return books, {'wished': '', 'left': out, 'hint': hint}
    out, hint = left_out([(read, f'{read:,} in Read but unowned and not in Your library (read, but neither in the house nor wished for)', ''), dig_out])
    return books, {'wished': f'{wished:,} in Wishlist and not in Your library' if wished else '', 'hint': hint, 'left': out}


IMPORTS = {  # name, a column only that export has (any one of them), and how to read its rows
    'goodreads': ('Goodreads export', ('exclusive shelf',), from_goodreads),
    'librarything': ('LibraryThing export', ('primary author', 'author (last, first)', 'author (first, last)'), from_librarything),
}


def from_export(path, kind, keep, ebooks=False):
    """A Goodreads or LibraryThing export → the same {name, books} a list of books from photos is, plus what went on
    the wishlist (wished), what was left out (left) and what --keep-unowned or --keep-ebooks would do with it (hint)."""
    name, marks, convert = IMPORTS[kind]
    header, rows = read_table(path)
    if 'title' not in header or not set(marks) & set(header):
        other = next((k for k, (_, m, _) in IMPORTS.items() if k != kind and set(m) & set(header) and 'title' in header), None)
        raise SystemExit(f'error: {path} isn’t a {name.split()[0]} export' + (f'; it looks like a {IMPORTS[other][0].split()[0]} one, so use --import {other}' if other else f' (it has no "Title" and "{marks[0].title()}" columns)'))
    books, said = convert(rows, keep, ebooks)
    return {'name': name, 'books': books}, said


PARTICLES = re.compile(r'^(de|da|di|du|del|della|der|den|van|von|le|la|st\.?|al|el|bin|ibn|ten|ter)$', re.I)


def surname(name):
    """A name's surname, as Shelfmark finds it: 'Ursula K. Le Guin' → 'Le Guin', 'Kurt Vonnegut, Jr.' → 'Vonnegut'."""
    w = re.sub(f'(?i),?[{WS}]+(jr|sr|ii|iii|iv|ph\\.?d|m\\.?d)\\.?$', '', s(name, 120)).split(' ')
    if len(w) < 2:
        return w[0]
    i = len(w) - 1
    while i > 1 and PARTICLES.match(w[i - 1]):
        i -= 1
    return ' '.join(w[i:])


def only(t, cats):
    """The characters of t in these Unicode categories ('L' letters, 'N' digits), as \\p{L}\\p{N} keep them in JavaScript."""
    return ''.join(c for c in t if unicodedata.category(c)[0] in cats)


def bare(t):
    return only(re.sub(f'^(the|a|an)[{WS}]+', '', t.strip(WS)), 'LN')


def keys(b):
    """Where Shelfmark files a book and where it looks for one, for finding the same book twice (indexKeys() and
    lookupKeys() in index.html). Two books are the same when their ISBNs agree, or their first authors' surnames do and
    so do their titles: the head (before any colon, without "The", "A" or "An"), every number in the title, and the rest
    (after the colon, or else the subtitle), unless one of them has no rest. So "The Hobbit" is "The Hobbit: or There
    and Back Again", but the volumes of a set ("Series: Volume 2", "Series: Its Name") are books of their own.
    Returns (index, lookup)."""
    f = fold(b['title'])
    head, colon, rest = f.partition(':')
    if not colon:
        rest = fold(b.get('sub') or '')
    who = only(fold(surname((b.get('authors') or [''])[0])), 'L')
    t = bare(head) + '#' + '.'.join(re.findall(r'[0-9]+', f)) + '|' + who
    rest = bare(rest)
    i = ['i:' + isbn13(b['isbn'])] if isbn13(b.get('isbn')) else []
    return (i + ['h:' + t, 'f:' + t + '|' + rest if rest else 'e:' + t],
            i + (['f:' + t + '|' + rest, 'e:' + t] if rest else ['h:' + t]))


def build(doc, warn):
    if isinstance(doc, list):
        doc = {'books': doc}
    if isinstance(doc, dict) and isinstance(doc.get('batch'), dict):
        doc = doc['batch']
    if not isinstance(doc, dict) or not isinstance(doc.get('books'), list):
        raise SystemExit('error: the input needs a "books" list')
    books = [b for b in (clean(b, i, warn) for i, b in enumerate(doc['books'])) if b]
    if not books:
        raise SystemExit('error: no usable books (each needs at least a title)')
    seen = {}
    for b in books:
        index, lookup = keys(b)
        hit = next((seen[k] for k in lookup if k in seen), None)
        if hit:
            warn.append(f'“{b["title"]}” appears twice (also “{hit}”). Two copies, or read twice from overlapping photos?')
        for k in index:
            seen.setdefault(k, b['title'])
    made = datetime.date.today().isoformat()
    name = s(doc.get('name'), 120)
    # Up to 3,000 books a batch. Longer lists are cut into parts, each a batch of its own with its own id, named
    # "… (2 of 3)" so the review screen says which one it is.
    parts = [books[i:i + MAX_BOOKS] for i in range(0, len(books), MAX_BOOKS)]
    outs = []
    for n, part in enumerate(parts, 1):
        body = json.dumps(part, ensure_ascii=False, sort_keys=True)
        bid = 'c' + made.replace('-', '') + '-' + hashlib.sha1((name + body).encode()).hexdigest()[:10]
        label = name
        if len(parts) > 1:
            bid, label = part_of(bid, name, n, len(parts))
        batch = {'id': bid, 'name': label, 'made': made, 'room': s(doc.get('room'), 60), 'shelf': s(doc.get('shelf'), 60), 'books': part}
        if yes(doc.get('wanted')):  # books from a shop's table or a list to buy: all of them go on the wishlist
            batch['wanted'] = True
        outs.append({'shelfmark': 1, 'batch': {k: v for k, v in batch.items() if v != ''}})
    return outs, name


def part_of(pid, name, n, k):
    """Part n of k of a batch or of reading details: its own id, and its name with "(2 of 3)" after it, which the review
    screen shows."""
    tail = f' ({n} of {k})'
    return f'{pid}-{n}', name[:120 - len(tail)] + tail if name else f'Part {n} of {k}'


def details_entries(doc, warn):
    """The entries of reading details for books already in the library, cleaned: [entry], and the name."""
    if isinstance(doc, list):
        doc = {'books': doc}
    if isinstance(doc, dict) and isinstance(doc.get('details'), dict):
        doc = doc['details']
    if not isinstance(doc, dict) or not isinstance(doc.get('books'), list):
        raise SystemExit('error: the input needs a "books" list')
    entries = []
    for i, b in enumerate(doc['books']):
        if not isinstance(b, dict):
            warn.append(f'#{i + 1}: not an entry object, left out')
            continue
        title, bid = s(b.get('title'), 300), re.sub(r'[^\w-]', '', s(b.get('id'), 40), flags=re.ASCII)
        if not title and not bid:
            warn.append(f'#{i + 1}: no id or title, so Shelfmark couldn’t tell which book it is; left out')
            continue
        e = {'id': bid, 'title': title, 'sub': s(b.get('sub') or b.get('subtitle'), 300) if title else '', 'authors': names(b.get('authors') or b.get('author') or []), 'isbn': first_isbn(s(b.get('isbn'), 200)),
             'pages': whole(b.get('pages'), 0, 50000, 'most')}
        e.update(reading(b, title or bid, warn))
        if e.get('way') == 'browse' and e.get('chapters'):  # a book to browse isn't read chapter by chapter
            warn.append(f'“{title or bid}”: chapters left off, since it’s a book to browse')
            e['chapters'] = ''
        e = {k: v for k, v in e.items() if v not in ('', 0, None, [])}
        if not any(k in e for k in DETAIL_KEYS + ('pages',)):
            warn.append(f'“{title or bid}”: no reading details, left out')
            continue
        entries.append(e)
    if not entries:
        raise SystemExit('error: no usable entries (each needs an id or title, and at least one detail)')
    return entries, s(doc.get('name'), 120) or 'Reading details'


def details_files(entries, name):
    """Reading details for books already in the library: [{"shelfmark": 1, "details": {id, name, made, books}}], up to
    3,000 entries a file, as for a batch: more come as numbered files, each of its own."""
    made = datetime.date.today().isoformat()
    parts = [entries[i:i + MAX_BOOKS] for i in range(0, len(entries), MAX_BOOKS)]
    outs = []
    for n, part in enumerate(parts, 1):
        did, label = 'd' + made.replace('-', '') + '-' + hashlib.sha1((name + json.dumps(part, ensure_ascii=False, sort_keys=True)).encode()).hexdigest()[:10], name
        if len(parts) > 1:
            did, label = part_of(did, name, n, len(parts))
        outs.append({'shelfmark': 1, 'details': {'id': did, 'name': label, 'made': made, 'books': part}})
    return outs


def build_details(doc, warn):
    entries, name = details_entries(doc, warn)
    return details_files(entries, name), name


# ---------- reading details checked against the library ----------
# With --library, the entries are matched to the books in the person's library file the way Shelfmark matches them
# (matchDetails() in index.html), so what the link does is known before it's handed over: an id that names no book, or
# another book, is put right from the title; an entry that finds no book, or several different books, is pointed out; details a book already has are taken off (Shelfmark fills only blanks unless Replace is ticked);
# and the books that still have no reading details are listed, to write entries for next.

def read_library(path):
    """The books in a Shelfmark library file (Shelfmark library.json from Drive, or a backup), removed ones left out."""
    try:
        doc = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f'error: can’t read {path}: {e}')
    lib = doc.get('library') if isinstance(doc, dict) else None
    books = lib.get('books') if isinstance(lib, dict) else None
    if not isinstance(books, dict):
        raise SystemExit(f'error: {path} isn’t a Shelfmark library file (Shelfmark library.json from Drive, or a backup from Settings › Download a backup)')
    out = []
    for k, b in books.items():
        if not isinstance(b, dict) or b.get('del'):
            continue
        x = {'id': s(b.get('id') or k, 80), 'title': s(b.get('title'), 300) or '?', 'sub': s(b.get('sub'), 300), 'authors': names(b.get('authors') or []),
             'isbn': isbn13(b.get('isbn')), 'pages': whole(b.get('pages'), 0, 50000, 'most'), 'wanted': b.get('wanted') is True}
        x.update({d: b[d] for d in DETAIL_KEYS if b.get(d) not in (None, '', [])})
        out.append(x)
    return out


def has_details(b):
    return any(b.get(k) not in (None, '', []) for k in DETAIL_KEYS)


def without_details(books, hit=()):
    """The books in the house (not on the wishlist) with no reading details, and none of the ids in hit, by title."""
    return sorted((b for b in books if not b['wanted'] and not has_details(b) and b['id'] not in hit), key=lambda b: (fold(b['title']), fold(', '.join(b['authors']))))


def authors_key(b):
    return '|'.join(sorted(only(fold(a), 'LN') for a in b.get('authors') or []))


def match_details(books, entries):
    """[(entry, [book…])], each entry's books as Shelfmark finds them: the book its id names, or else every copy of the
    same book (by ISBN, or title and author's surname) that no other entry names by id, those with all the entry's
    authors when the copies' authors differ, and any with the entry's ISBN."""
    byid = {b['id']: b for b in books}
    ix = {}
    for b in books:
        for k in keys(b)[0]:
            ix.setdefault(k, []).append(b)
    named = {e['id'] for e in entries if e.get('id') in byid}
    out = []
    for e in entries:
        if e.get('id') in byid:
            out.append((e, [byid[e['id']]]))
            continue
        bs, seen = [], set()
        for k in keys(e)[1] if e.get('title') else []:
            for x in ix.get(k, []):
                if x['id'] not in seen and x['id'] not in named:
                    seen.add(x['id'])
                    bs.append(x)
        same = [x for x in bs if authors_key(x) == authors_key(e)]
        i = isbn13(e.get('isbn'))
        if len(bs) > 1 and same:
            bs = [x for x in bs if x in same or i and x['isbn'] == i]
        out.append((e, bs))
    return out


def head(t):
    return bare(fold(t).partition(':')[0])


def rest(b):
    """What follows a title's head: after its colon, or else the subtitle (as keys() reads it)."""
    f, colon, r = fold(b.get('title') or '').partition(':')
    return bare(r if colon else fold(b.get('sub') or ''))


def agrees(e, b):
    """Whether an entry is for the book its id names: no title to say otherwise, the same ISBN or book, or the same
    head of the title with the same rest, when both have one. So one volume of a set ("Series: Its Name") isn't taken
    for another with the same head, and a slip between them is put right too."""
    if not e.get('title') or set(keys(e)[1]) & set(keys(b)[0]):
        return True
    return head(e['title']) == head(b['title']) and (not rest(e) or not rest(b) or rest(e) == rest(b))


def copies(bs):
    """Whether the books are copies of one book (the same title, subtitle and authors), not different books."""
    def which(b):
        f = fold(b['title'])
        return head(f), bare(f.partition(':')[2] or fold(b.get('sub') or '')), authors_key(b)
    return len({which(b) for b in bs}) == 1


def full(b):
    """The title with its subtitle, for a warning that tells two of them apart."""
    t = b.get('title') or ''
    return t + (f': {b["sub"]}' if b.get('sub') and ':' not in t else '')


def book_line(b):
    return f'“{short(full(b), 90)}”' + (f' by {", ".join(b["authors"])}' if b.get('authors') else '')


def check_details(entries, books, redo):
    """Matches the entries to the library's books and puts them right (see above). Returns the entries to hand over and
    what was done: {fixed, kept, lost, several, had, trimmed, left}."""
    byid = {b['id']: b for b in books}
    did = {'fixed': [], 'kept': [], 'lost': [], 'several': [], 'had': 0, 'trimmed': 0, 'left': []}
    wrong = {}  # entry index: (the id it gave, the book that id names, or None)
    for n, e in enumerate(entries):
        b = byid.get(e.get('id'))
        if e.get('id') and (not b or not agrees(e, b)):
            wrong[n] = (e.pop('id'), b)
    for n, (e, bs) in enumerate(match_details(books, entries)):
        if e.get('id'):
            continue
        if len(bs) == 1:
            e['id'] = bs[0]['id']
        elif not bs and n in wrong:
            # Nothing has its title: perhaps the title is written another way. Kept for the book its id names, to check.
            # An id that names no book is kept too: a book added since the library file was saved may have it, and
            # Shelfmark goes on to the title when no book does, so keeping it can't make the link worse.
            e['id'] = wrong[n][0]
            if wrong[n][1]:
                did['kept'].append((full(e), e['id'], wrong[n][1]))
        if n in wrong and (len(bs) == 1 or len(bs) > 1 and copies(bs)):
            did['fixed'].append((e, wrong[n], bs))
    out, hit = [], set()
    for e, bs in match_details(books, entries):
        if not bs:  # kept: Shelfmark says it isn't in the library, and fills it in once it's added and the link opened again
            did['lost'].append(e)
            out.append(e)
            continue
        hit.update(b['id'] for b in bs)
        if len(bs) > 1 and not copies(bs):
            did['several'].append((e, bs))
        if len(bs) == 1:  # as the library has it, so it's found the same way on any copy of the library
            b = bs[0]
            for k in ('title', 'sub', 'authors', 'isbn'):
                if b.get(k):
                    e[k] = b[k]
                else:
                    e.pop(k, None)
        if not redo:
            gone = [k for k in DETAIL_KEYS + ('pages',) if k in e and all(b.get(k) not in (None, '', [], 0) for b in bs)]
            for k in gone:
                del e[k]
            if not any(k in e for k in DETAIL_KEYS + ('pages',)):
                did['had'] += 1
                continue
            if gone:
                did['trimmed'] += 1
        out.append(e)
    did['left'] = without_details(books, hit)
    return out, did


def say_left(left, shown=50, here=''):
    """The books with no reading details yet, to write entries for: here is what else they are (", and aren't in these details")."""
    print(f'\n{count(len(left), "book")} in the library {"has" if len(left) == 1 else "have"} no reading details yet' + (here if left else '') + (':' if left else '.'))
    for b in left[:shown]:
        print(f'  - {b["title"]}' + (f': {b["sub"]}' if b.get('sub') else '') + (f' — {", ".join(b["authors"])}' if b['authors'] else '') + f' (id {b["id"]})')
    if len(left) > shown:
        print(f'  … and {len(left) - shown:,} more')


def count(n, one, many=''):
    """'1 book', '2 books', '1 entry', '3 entries'."""
    return f'{n:,} ' + (one if n == 1 else many or one + 's')


def details_main(doc, a):
    warn = []
    entries, name = details_entries(doc, warn)
    did = None
    if a.library:
        library = read_library(a.library)
        entries, did = check_details(entries, library, a.redo)
    outs = details_files(entries, name) if entries else []
    books = [e for o in outs for e in o['details']['books']]
    kinds = {k: sum(1 for e in books if e.get('kind') == k) for k in KINDS}
    browse = sum(1 for e in books if e.get('way') == 'browse')
    print(f'{name}: {len(books):,} book{"s" if len(books) != 1 else ""}' + (' (' + ', '.join(f'{n} {k}' for k, n in kinds.items() if n) +
          (f'; {browse} to browse rather than read' if browse else '') + ')' if any(kinds.values()) or browse else ''))
    for e in books:
        bits = [e.get('kind', ''), ', '.join(e.get('genres', [])), ', '.join(e.get('moods', [])), e.get('pace', '') and e['pace'] + ' pace',
                e.get('chapters', '') and e['chapters'] + ' chapters', e.get('way', '') if e.get('way') != 'through' else '', e.get('pages') and f'{e["pages"]} pages']
        print(f'  - {e.get("title") or e["id"]}: ' + ' · '.join(x for x in bits if x))
    if did:
        given = len(entries) + did['had']
        print(f'\nChecked against the library ({count(len(library), "book")}): {given - len(did["lost"]):,} of {count(given, "entry", "entries")} found their book.')
        for e, (old, b), bs in did['fixed']:
            print(f'  Fixed the id of “{short(e.get("title") or old)}”: {old} ' + (f'is {book_line(b)}' if b else 'isn’t in the library') +
                  (f'; it’s {e["id"]}' if e.get('id') else f'; it’s for the {len(bs)} copies of it, found by title'))
        for title, bid, b in did['kept']:
            warn.append(f'“{short(title, 90)}”: its id {bid} is {book_line(b)}, and no book has its title; kept for that book, so check it’s the right one')
        for e in did['lost']:
            warn.append(f'“{short(e.get("title") or e.get("id") or "")}” matches no book in the library. If it’s there under another title, give that one’s id and run again; '
                        'if it hasn’t been added yet, Shelfmark leaves it out until it is, and the link is opened again')
        for e, bs in did['several']:
            warn.append(f'“{short(e["title"])}” matches {len(bs)} books: ' + ', '.join(book_line(b) for b in bs[:5]) + (' and more' if len(bs) > 5 else '') +
                        '. Each gets these details; if they’re for one, give that one’s id and run again')
        if did['had']:
            print(f'  Left out {did["had"]:,} {"entry" if did["had"] == 1 else "entries"} whose book already has every detail given (--redo keeps them).')
        if did['trimmed']:
            print(f'  Took off the details {did["trimmed"]:,} {"book already has" if did["trimmed"] == 1 else "books already have"}, from {"its entry" if did["trimmed"] == 1 else "their entries"} (--redo keeps them).')
        say_left(did['left'], here=', and ' + ('isn’t' if len(did['left']) == 1 else 'aren’t') + ' in these details')
    for w in warn:
        print(f'warning: {w}')
    if not outs:
        print('\nNothing to hand over: every entry’s book already has its details.')
        return
    hand_over(outs, 'details', a, f'{slug(name)}-{outs[0]["details"]["made"]}', '.details.shelfmark.json')


def hand_over(outs, key, a, stem, ext='.shelfmark.json'):
    """Writes the file, and prints where it is and the link that opens it. A link longer than LINK_MAX comes as numbered
    links of up to PER_LINK books each, every one a batch (or reading details) of its own, with its own id and named
    "… (2 of 6)", so each opens its own review and is safe to open twice. More than MAX_BOOKS make numbered files, with no
    link."""
    Path(a.out).mkdir(parents=True, exist_ok=True)
    one, what = ('book', 'books') if key == 'batch' else ('entry', 'entries')
    if len(outs) > 1:
        print(f'\nShelfmark takes {MAX_BOOKS:,} {what} at a time, so these are in {len(outs)} numbered files. '
              'Hand over all of them, to open in Shelfmark one after another (Import › Open a file):')
        for n, o in enumerate(outs, 1):
            f = Path(a.out) / f'{stem}-{n}{ext}'
            f.write_text(json.dumps(o, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
            k = len(o[key]['books'])
            print(f'File {n} of {len(outs)} ({k:,} {what if k != 1 else one}): {f}')
        return
    f = Path(a.out) / f'{stem}{ext}'
    f.write_text(json.dumps(outs[0], ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'\nFile: {f}')
    if a.no_link:
        return
    base = a.base if a.base.endswith('/') else a.base + '/'
    url = link(outs[0], base)
    if len(url) <= LINK_MAX:
        print(f'\nLink: {url}')
        return
    parts, why = links(outs[0], key, base)
    if why:
        print(f'\nThe link would be {len(url):,} characters, too long to copy safely, and {why}. Hand over the file instead.')
        return
    print(f'\nThe link would be {len(url):,} characters, too long to copy safely, so here it is as {len(parts)} links of up to {PER_LINK} books each. '
          'Hand over all of them, numbered, to tap one after another: each opens its own review in Shelfmark, and is safe to open twice. '
          'On a computer, the file is simpler.')
    for n, (k, u) in enumerate(parts, 1):
        print(f'Link {n} of {len(parts)} ({k:,} book{"s" if k != 1 else ""}, {len(u):,} characters): {u}')


def links(out, key, base):
    """The links for a batch or reading details too long for one: [(books, link)], each of up to PER_LINK books and
    LINK_MAX characters, taken in order. Or why there are none: too many to tap one by one, or a book that alone makes a
    link too long."""
    inner, groups, cur = out[key], [], []
    if len(inner['books']) > PER_LINK * MAX_LINKS:
        return [], f'{-(-len(inner["books"]) // PER_LINK)} links would be too many to tap one by one'

    def doc(books, n, k):
        pid, label = part_of(inner['id'], inner.get('name', ''), n, k)
        return {'shelfmark': 1, key: dict(inner, id=pid, name=label, books=books)}
    for b in inner['books']:
        if cur and (len(cur) == PER_LINK or len(link(doc(cur + [b], 99, 99), base)) > LINK_MAX):
            groups.append(cur)
            cur = []
        cur.append(b)
    groups.append(cur)
    if len(groups) > MAX_LINKS:
        return [], f'{len(groups)} links would be too many to tap one by one'
    made = [(len(g), link(doc(g, n, len(groups)), base)) for n, g in enumerate(groups, 1)]
    long = next((u for k, u in made if len(u) > LINK_MAX), None)
    if long:
        return [], f'one book alone makes a link of {len(long):,} characters'
    return made, ''


def link(out, base):
    raw = json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode()
    z = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = z.compress(raw) + z.flush()
    return base + '#s1z' + base64.urlsafe_b64encode(packed).decode('ascii').rstrip('=')


def slug(t):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', t.lower())).strip('-')[:48] or 'books'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('books', nargs='?', help='the books (or with --details, the reading details) as JSON, or with --import an export')
    ap.add_argument('--out', default='.', help='folder for the .shelfmark.json file')
    ap.add_argument('--base', default=DEFAULT_BASE, help='where Shelfmark lives')
    ap.add_argument('--no-link', action='store_true')
    ap.add_argument('--import', dest='kind', choices=sorted(IMPORTS), help='read a Goodreads or LibraryThing export (CSV) instead')
    ap.add_argument('--keep-unowned', action='store_true', help='with --import, put books that aren’t in the house on the wishlist')
    ap.add_argument('--keep-ebooks', action='store_true', help='with --import, bring in e-books and audiobooks too, which are left out otherwise')
    ap.add_argument('--details', action='store_true', help='make reading details for books already in the library, not a batch of new books')
    ap.add_argument('--library', help='with --details, the library file (Shelfmark library.json, or a backup) to check the details against; alone, it lists the books with no reading details yet')
    ap.add_argument('--redo', action='store_true', help='with --details --library, keep details a book already has, for when they asked to redo them (they tick Replace in Shelfmark)')
    a = ap.parse_args()
    if a.library and not a.details:
        ap.error('--library goes with --details')
    if a.details and not a.books:
        if not a.library:
            ap.error('--details needs the reading details file, or --library to list the books that have none')
        say_left(without_details(read_library(a.library)), shown=ALL)
        return
    if not a.books:
        ap.error('the books file is needed')
    if a.details:
        try:
            doc = json.loads(Path(a.books).read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as e:
            raise SystemExit(f'error: can’t read {a.books}: {e}')
        return details_main(doc, a)
    said = {}
    if a.kind:
        doc, said = from_export(a.books, a.kind, a.keep_unowned, a.keep_ebooks)
        if said['left'] and not doc['books']:
            raise SystemExit(f'error: every book was left out: {said["left"]}.' + (' ' + said['hint'] if said['hint'] else ''))
    else:
        try:
            doc = json.loads(Path(a.books).read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as e:
            raise SystemExit(f'error: can’t read {a.books}: {e}')
    warn = []
    outs, name = build(doc, warn)
    b = outs[0]['batch']
    books = [x for o in outs for x in o['batch']['books']]
    place = ' › '.join(x for x in (b.get('room'), b.get('shelf')) if x)
    print(f'{name or "Books"}: {len(books):,} book{"s" if len(books) != 1 else ""}' + (f', shelved in {place} unless they say otherwise' if place else ''))
    if said.get('wished'):
        print(f'On the wishlist: {said["wished"]}.')
    if said.get('left'):
        print(f'Left out: {said["left"]}.' + (' ' + said['hint'] if said['hint'] else ''))
    shown = books[:20] if a.kind else books  # an export's whole list is in the file; here it would only be long
    for x in shown:
        by = ', '.join(x.get('authors', [])) or 'author unknown'
        where = ' › '.join(y for y in (x.get('room'), x.get('shelf')) if y)
        print(f'  {"?" if x.get("unsure") else "-"} {x["title"]} — {by}' + (f' [{x["isbn"]}]' if x.get('isbn') else '') + (f' ({where})' if where else ''))
        if x.get('unsure'):
            print(f'      check: {x["unsure"]}')
    if len(shown) < len(books):
        print(f'  … and {len(books) - len(shown):,} more')
    for w in warn:
        print(f'warning: {w}')
    hand_over(outs, 'batch', a, f'{slug(name or "books")}-{b["made"]}')


if __name__ == '__main__':
    main()
