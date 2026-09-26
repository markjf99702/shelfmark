#!/usr/bin/env python3
"""Turn a list of books into a Shelfmark batch: a link that opens it in Shelfmark, and a file.

    python3 make_shelfmark.py books.json [--out DIR] [--base URL] [--no-link]

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
and exits 1 (printing why) if the input can't be used.
"""
import argparse, base64, datetime, hashlib, json, re, sys, zlib
from pathlib import Path

DEFAULT_BASE = 'https://junkdrawer.works/shelfmark/'
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
    raw = s(b.get('isbn'), 24)
    if raw:
        good = isbn13(raw)
        if good:
            out['isbn'] = good
        else:
            flags.append(f'ISBN read as {raw} fails its check digit, so it was left off')
            warn.append(f'“{title}”: ISBN {raw} fails its check digit; dropped and flagged')
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
    body = json.dumps(books, ensure_ascii=False, sort_keys=True)
    bid = 'c' + made.replace('-', '') + '-' + hashlib.sha1((name + body).encode()).hexdigest()[:10]
    batch = {'id': bid, 'name': name, 'made': made, 'room': s(doc.get('room'), 60), 'shelf': s(doc.get('shelf'), 60), 'books': books}
    return {'shelfmark': 1, 'batch': {k: v for k, v in batch.items() if v != ''}}


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
    a = ap.parse_args()
    try:
        doc = json.loads(Path(a.books).read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f'error: can’t read {a.books}: {e}')
    warn = []
    out = build(doc, warn)
    b = out['batch']
    books = b['books']
    place = ' › '.join(x for x in (b.get('room'), b.get('shelf')) if x)
    print(f'{b.get("name") or "Books"}: {len(books)} book{"s" if len(books) != 1 else ""}' + (f', shelved in {place} unless they say otherwise' if place else ''))
    for x in books:
        by = ', '.join(x.get('authors', [])) or 'author unknown'
        where = ' › '.join(y for y in (x.get('room'), x.get('shelf')) if y)
        print(f'  {"?" if x.get("unsure") else "-"} {x["title"]} — {by}' + (f' [{x["isbn"]}]' if x.get('isbn') else '') + (f' ({where})' if where else ''))
        if x.get('unsure'):
            print(f'      check: {x["unsure"]}')
    for w in warn:
        print(f'warning: {w}')
    Path(a.out).mkdir(parents=True, exist_ok=True)
    f = Path(a.out) / f'{slug(b.get("name") or "books")}-{b["made"]}.shelfmark.json'
    f.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'\nFile: {f}')
    if not a.no_link:
        url = link(out, a.base if a.base.endswith('/') else a.base + '/')
        if len(url) > 30000:
            print(f'\nThe link is {len(url):,} characters, too long to pass around safely. Hand over the file instead.')
        else:
            print(f'\nLink: {url}')


if __name__ == '__main__':
    main()
