#!/usr/bin/env python3
"""Turn a list of books into a Shelfmark batch: a link that opens it in Shelfmark, and a file.

    python3 make_shelfmark.py books.json [--out DIR] [--base URL] [--no-link]
    python3 make_shelfmark.py export.csv --import goodreads|librarything [--keep-unowned] [--out DIR]

books.json (every field but "title" is optional; "authors" may be a list or one string):

{
  "name": "Living room, tall bookcase",          # shown when the batch is opened
  "room": "Living room", "shelf": "Tall bookcase",  # for any book that doesn't say its own
  "books": [
    {"title": "Middlemarch", "authors": ["George Eliot"], "isbn": "978-0-14-143954-9",
     "publisher": "Penguin Classics", "year": 2003, "format": "paperback",
     "shelf": "Tall bookcase, top", "status": "read", "rating": 4, "tags": ["classics"],
     "notes": "", "edition": "", "signed": false, "first": false, "condition": "good",
     "loan": {"to": "Sam", "since": "2026-09-01"},
     "unsure": "spine cut off at the top"}       # anything you're not sure of, in a few words
  ]
}

It checks every ISBN's check digit (a misread one is dropped and flagged, never guessed at), maps
common words for format, condition and status onto Shelfmark's, flags likely doubles in the list,
and exits 1 (printing why) if the input can't be used. Shelfmark takes 3,000 books at a time, so a
longer list is written as numbered files of up to 3,000 each, to open one after another.

With --import it reads a Goodreads or LibraryThing export (CSV) instead, and leaves out books that
aren't in the house (on the to-read shelf with no copy owned, or only on the Wishlist) unless it's
given --keep-unowned. It says how many it left out.
"""
import argparse, base64, csv, datetime, hashlib, io, json, re, sys, zlib
from pathlib import Path

DEFAULT_BASE = 'https://shelfmark.junkdrawer.works/'
MAX_BOOKS = 3000  # the most Shelfmark takes in one batch (BATCH_MAX in index.html)
FORMATS = {
    'hardcover': 'hardcover', 'hardback': 'hardcover', 'hard cover': 'hardcover', 'hc': 'hardcover', 'cloth': 'hardcover', 'library binding': 'hardcover',
    'paperback': 'paperback', 'softcover': 'paperback', 'soft cover': 'paperback', 'trade paperback': 'paperback', 'pb': 'paperback', 'tpb': 'paperback',
    'mass-market': 'mass-market', 'mass market': 'mass-market', 'mass market paperback': 'mass-market', 'mass-market paperback': 'mass-market', 'pocket': 'mass-market',
    'board': 'board', 'board book': 'board', 'leather': 'leather', 'leather-bound': 'leather', 'leatherbound': 'leather', 'other': 'other', 'spiral': 'other',
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


def s(v, n):
    if isinstance(v, bool) or v is None:
        return ''
    return re.sub(r'\s+', ' ', str(v)).strip()[:n]


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


def names(v, n=12):
    if isinstance(v, str):
        v = re.split(r'\s*;\s*|\s+&\s+|\s+and\s+', v)
    out, seen = [], set()
    for x in v if isinstance(v, list) else []:
        x = s(x, 120)
        if x and x.lower() not in seen:
            seen.add(x.lower())
            out.append(x)
    return out[:n]


def whole(v, lo, hi):
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        x = int(round(v))
    else:
        m = re.search(r'-?\d+', str(v or ''))
        x = int(m[0]) if m else 0
    return max(lo, min(hi, x))


def day(v):
    v = s(v, 10)
    try:
        return datetime.date.fromisoformat(v).isoformat()
    except ValueError:
        return ''


def clean(b, i, warn):
    if not isinstance(b, dict):
        warn.append(f'#{i + 1}: not a book object, left out')
        return None
    title = s(b.get('title'), 300)
    if not title:
        warn.append(f'#{i + 1}: no title, left out')
        return None
    flags = [s(b.get('unsure') or b.get('check'), 300)]
    out = {'title': title, 'sub': s(b.get('sub') or b.get('subtitle'), 300), 'authors': names(b.get('authors') or b.get('author') or [])}
    raw = s(b.get('isbn'), 200)
    if re.search(r'\d', raw):  # an empty Goodreads cell, ="", is no ISBN at all
        good = first_isbn(raw)
        if good:
            out['isbn'] = good
        else:
            flags.append(f'ISBN read as {raw[:40]} fails its check digit, so it was left off')
            warn.append(f'“{title}”: ISBN {raw[:40]} fails its check digit; dropped and flagged')
    out['publisher'] = s(b.get('publisher'), 120)
    out['year'] = whole(b.get('year'), 0, 2200)
    out['pages'] = whole(b.get('pages'), 0, 50000)
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
    loan = b.get('loan') if isinstance(b.get('loan'), dict) else {'to': b.get('lent_to') or b.get('lentTo')} if b.get('lent_to') or b.get('lentTo') else None
    if loan and s(loan.get('to'), 80):
        out['loan'] = {'to': s(loan.get('to'), 80)}
        if day(loan.get('since')):
            out['loan']['since'] = day(loan.get('since'))
    tags = b.get('tags')
    out['tags'] = names(tags.split(',') if isinstance(tags, str) else tags or [], 20)
    out['notes'] = str(b.get('notes') or '').strip()[:4000]
    out['edition'] = s(b.get('edition'), 120)
    out['signed'] = b.get('signed') is True
    out['first'] = b.get('first') is True or b.get('first_edition') is True
    out['added'] = day(b.get('added'))
    flag = '; '.join(f for f in flags if f)[:300]
    if flag:
        out['unsure'] = flag
    return {k: v for k, v in out.items() if v not in ('', 0, False, None, [], {})}


# ---------- Goodreads and LibraryThing exports ----------
# --import reads the export itself and does the mechanical part here rather than by hand: it leaves out books that
# aren't in the house (on the to-read shelf with no copy owned, or only wished for), takes "(Series, #2)" off titles
# so they match the same book read from a spine, turns <br/> into line breaks, keeps reading shelves out of tags and
# turns LibraryThing's "Le Guin, Ursula K." round.

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


def stars(v):
    try:
        return int(float(v) + 0.5)  # LibraryThing gives half stars; 3.5 → 4, as Shelfmark rounds
    except (ValueError, OverflowError):
        return 0


def from_goodreads(rows, keep):
    books, left = [], 0
    for r in rows:
        shelf = cell(r, 'exclusive shelf').lower()
        if shelf == 'to-read' and not whole(cell(r, 'owned copies'), 0, 9999) and not keep:
            left += 1
            continue
        books.append({
            'title': series_off(cell(r, 'title')),
            'authors': [cell(r, 'author')] + split_names(cell(r, 'additional authors')),
            'isbn': ', '.join(x for x in (cell(r, 'isbn13'), cell(r, 'isbn')) if x),
            'publisher': cell(r, 'publisher'), 'year': cell(r, 'year published'), 'pages': cell(r, 'number of pages'),
            'rating': stars(cell(r, 'my rating')),
            'status': {'read': 'read', 'currently-reading': 'reading'}.get(shelf, ''),
            'tags': [t for t in (x.strip() for x in cell(r, 'bookshelves').split(',')) if t and t.lower() not in GR_SHELVES],
            'notes': lines(cell(r, 'my review'), cell(r, 'private notes')),
        })
    return books, (f'{left:,} on the to-read shelf with no copy owned' if left else '')


def publisher(v):
    """LibraryThing's 'Houghton Mifflin (2002), Paperback, 366 pages' → 'Houghton Mifflin'"""
    v = re.split(r'\s*\(', v)[0]
    v = re.sub(r',\s*\d{4}\b.*$', '', v)
    return v.split(' : ')[-1].strip(' .,;')


def from_librarything(rows, keep):
    books, left = [], 0
    for r in rows:
        held = [x.strip() for x in cell(r, 'collections').split(',') if x.strip()]
        low = {x.lower() for x in held}
        if low & LT_UNOWNED and 'your library' not in low and not keep:
            left += 1
            continue
        books.append({
            'title': cell(r, 'title'),
            'authors': [cell(r, 'author (first, last)') or turned(cell(r, 'primary author', 'author (last, first)'))],
            'isbn': ', '.join(x for x in (cell(r, 'isbn'), cell(r, 'isbns')) if x),
            'publisher': publisher(cell(r, 'publication')), 'year': cell(r, 'date'), 'pages': cell(r, 'page count'),
            'rating': stars(cell(r, 'rating')),
            'status': 'reading' if 'currently reading' in low else '',
            'tags': [t for t in (x.strip() for x in cell(r, 'tags').split(',')) if t] + [x for x in held if x.lower() not in LT_SHELVES],
            'notes': lines(cell(r, 'review'), cell(r, 'comment', 'comments'), cell(r, 'private comment', 'private comments')),
        })
    return books, (f'{left:,} in Wishlist or Read but unowned and not in Your library' if left else '')


IMPORTS = {  # name, a column only that export has (any one of them), and how to read its rows
    'goodreads': ('Goodreads export', ('exclusive shelf',), from_goodreads),
    'librarything': ('LibraryThing export', ('primary author', 'author (last, first)', 'author (first, last)'), from_librarything),
}


def from_export(path, kind, keep):
    """A Goodreads or LibraryThing export → the same {name, books} a list of books from photos is, plus what was
    left out and why."""
    name, marks, convert = IMPORTS[kind]
    header, rows = read_table(path)
    if 'title' not in header or not set(marks) & set(header):
        other = next((k for k, (_, m, _) in IMPORTS.items() if k != kind and set(m) & set(header) and 'title' in header), None)
        raise SystemExit(f'error: {path} isn’t a {name.split()[0]} export' + (f'; it looks like a {IMPORTS[other][0].split()[0]} one, so use --import {other}' if other else f' (it has no "Title" and "{marks[0].title()}" columns)'))
    books, left = convert(rows, keep)
    return {'name': name, 'books': books}, left


def key(b):
    # Before any colon, plus every number in the title, so "Series: Volume 2" isn't a double of Volume 1.
    t = re.sub(r'[^a-z0-9]+', '', re.sub(r'^(the|a|an)\s+', '', b['title'].lower().split(':')[0]))
    t += '#' + '.'.join(re.findall(r'\d+', b['title']))
    a = (b.get('authors') or [''])[0].lower().split()
    return t + '|' + (a[-1] if a else '')


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
        ks = [key(b)] + (['i' + b['isbn']] if b.get('isbn') else [])
        hit = next((seen[k] for k in ks if k in seen), None)
        if hit:
            warn.append(f'“{b["title"]}” appears twice (also “{hit}”). Two copies, or read twice from overlapping photos?')
        for k in ks:
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
            bid += f'-{n}'
            tail = f' ({n} of {len(parts)})'
            label = name[:120 - len(tail)] + tail if name else f'Part {n} of {len(parts)}'
        batch = {'id': bid, 'name': label, 'made': made, 'room': s(doc.get('room'), 60), 'shelf': s(doc.get('shelf'), 60), 'books': part}
        outs.append({'shelfmark': 1, 'batch': {k: v for k, v in batch.items() if v != ''}})
    return outs, name


def link(out, base):
    raw = json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode()
    z = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = z.compress(raw) + z.flush()
    return base + '#s1z' + base64.urlsafe_b64encode(packed).decode('ascii').rstrip('=')


def slug(t):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', t.lower())).strip('-')[:48] or 'books'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('books')
    ap.add_argument('--out', default='.', help='folder for the .shelfmark.json file')
    ap.add_argument('--base', default=DEFAULT_BASE, help='where Shelfmark lives')
    ap.add_argument('--no-link', action='store_true')
    ap.add_argument('--import', dest='kind', choices=sorted(IMPORTS), help='read a Goodreads or LibraryThing export (CSV) instead')
    ap.add_argument('--keep-unowned', action='store_true', help='with --import, keep books that aren’t in the house too')
    a = ap.parse_args()
    left = ''
    if a.kind:
        doc, left = from_export(a.books, a.kind, a.keep_unowned)
        if left and not doc['books']:
            raise SystemExit(f'error: every book was left out: {left}. To add them, run again with --keep-unowned.')
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
    if left:
        print(f'Left out: {left}. To add them too, run again with --keep-unowned.')
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
    Path(a.out).mkdir(parents=True, exist_ok=True)
    stem = f'{slug(name or "books")}-{b["made"]}'
    if len(outs) > 1:
        print(f'\nShelfmark takes {MAX_BOOKS:,} books at a time, so these are in {len(outs)} numbered files. '
              'Hand over all of them, to open in Shelfmark one after another (Import › Open a file):')
        for n, o in enumerate(outs, 1):
            f = Path(a.out) / f'{stem}-{n}.shelfmark.json'
            f.write_text(json.dumps(o, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
            k = len(o['batch']['books'])
            print(f'File {n} of {len(outs)} ({k:,} book{"s" if k != 1 else ""}): {f}')
        return
    f = Path(a.out) / f'{stem}.shelfmark.json'
    f.write_text(json.dumps(outs[0], ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'\nFile: {f}')
    if not a.no_link:
        url = link(outs[0], a.base if a.base.endswith('/') else a.base + '/')
        if len(url) > 30000:
            print(f'\nThe link is {len(url):,} characters, too long to pass around safely. Hand over the file instead.')
        else:
            print(f'\nLink: {url}')


if __name__ == '__main__':
    main()
