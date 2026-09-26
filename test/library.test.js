// Checks Shelfmark's book cleaning, merging, duplicate finding, links and spreadsheet export.
// Run with: node test/library.test.js   (no dependencies; Node 18 or later)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// The app is one HTML file. Its pure logic sits between 'use strict' and the state section; the
// link reader comes later. Pull both out and run them here with a stand-in window.
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const logic = src.slice(src.indexOf("'use strict';"), src.indexOf('// ---------- state ----------'));
function fn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing function ' + name);
  let d = 0, q = null;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const c = src[k];
    if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '{') d++;
    else if (c === '}' && !--d) return src.slice(i, k + 1);
  }
}
const S = new Function('window', [logic, fn('linkText'), fn('parseIncoming'),
  'return { isbn13, cleanBook, cleanDoc, mergeDocs, canon, live, surname, titleKey, dupIndex, findDup, cleanBatch, toCsv, csvCell, linkText, parseIncoming, authorOrder };'
].join('\n'))(globalThis);

let failed = 0, passed = 0;
function check(ok, what) { if (ok) passed++; else { failed++; console.log('  FAIL ' + what); } }
function eq(a, b, what) { const x = JSON.stringify(a), y = JSON.stringify(b); check(x === y, what + (x === y ? '' : '\n    got  ' + x + '\n    want ' + y)); }
function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------- ISBNs ----------
eq(S.isbn13('0-14-044913-2'), '9780140449136', 'ISBN-10 with hyphens becomes ISBN-13');
eq(S.isbn13('978 0 14 044913 6'), '9780140449136', 'ISBN-13 with spaces');
eq(S.isbn13('080442957X'), '9780804429573', 'ISBN-10 ending in X');
eq(S.isbn13('0140449133'), '', 'ISBN-10 with a wrong check digit');
eq(S.isbn13('9780140449137'), '', 'ISBN-13 with a wrong check digit');
eq(S.isbn13('9790140449136'.replace(/6$/, '0')), S.isbn13('9790140449130'), '979 prefix is allowed');
eq(S.isbn13('12345'), '', 'too short');
eq(S.isbn13('X800442957'), '', 'X only allowed last');

// ---------- cleaning ----------
{
  const b = S.cleanBook({ id: 'abc', t: 5, title: '  The   Hobbit ', authors: 'J. R. R. Tolkien', isbn: '0-261-10221-4', year: 'c. 1937', status: 'Unread', rating: 9, pages: -4,
    loan: { to: '', since: '2026-01-01' }, tags: ['Fantasy', 'fantasy', ' Kids '], format: 'Hardcover', condition: 'nope', signed: 'yes', junk: 1 });
  eq(b, { id: 'abc', t: 5, title: 'The Hobbit', authors: ['J. R. R. Tolkien'], isbn: '9780261102217', year: 1937, format: 'hardcover', rating: 5, tags: ['Fantasy', 'Kids'], signed: true },
    'cleanBook trims, clamps, maps labels and drops empties and unknown fields');
  eq(S.cleanBook({ title: '' }), null, 'no title → not a book');
  eq(S.cleanBook({ id: 'x1', t: 9, del: 1, title: 'gone' }), { id: 'x1', t: 9, del: 1 }, 'a removed book keeps only id and time');
  eq(S.cleanBook({ id: '123', title: 'T' }).id, 'b123', 'numeric ids get a letter so key order stays stable');
  check(/^b[0-9a-z]{9}$/.test(S.cleanBook({ title: 'T' }).id), 'a book with no id gets one');
  eq(S.cleanBook({ id: 'a', title: 'T', loan: { to: 'Sam', since: 'last week' } }).loan, { to: 'Sam' }, 'a loan keeps its borrower even with a bad date');
  eq(S.cleanBook({ id: 'a', title: 'T', isbn: '12-34' }).isbn, '1234', 'a non-ISBN number is kept as typed digits');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: 'Ann Lee, Bo Chen & Cy Dee' }).authors, ['Ann Lee', 'Bo Chen', 'Cy Dee'], 'author text splits on commas and &');
}

// ---------- merging ----------
function randomDoc(r, n) {
  const books = [];
  for (let i = 0; i < n; i++) {
    const id = 'b' + Math.floor(r() * 12), t = Math.floor(r() * 5);
    books.push(r() < 0.25 ? { id, t, del: 1 } : { id, t, title: 'Title ' + Math.floor(r() * 3), rating: Math.floor(r() * 6) });
  }
  const seen = {}; if (r() < 0.5) seen['c' + Math.floor(r() * 3)] = 1 + Math.floor(r() * 9);
  return S.cleanDoc({ books, seen });
}
{
  const r = rng(7); let ok = true;
  for (let k = 0; k < 400; k++) {
    const a = randomDoc(r, 8), b = randomDoc(r, 8), c = randomDoc(r, 8);
    const ab = S.canon(S.mergeDocs(a, b)), ba = S.canon(S.mergeDocs(b, a));
    const abc1 = S.canon(S.mergeDocs(S.mergeDocs(a, b), c)), abc2 = S.canon(S.mergeDocs(a, S.mergeDocs(b, c)));
    const aa = S.canon(S.mergeDocs(a, a));
    if (ab !== ba || abc1 !== abc2 || aa !== S.canon(a)) { ok = false; break; }
  }
  check(ok, 'merging is order-free, groupable and repeatable (400 random libraries)');
  const a = S.cleanDoc({ books: [{ id: 'x', t: 10, title: 'Old' }] });
  const b = S.cleanDoc({ books: [{ id: 'x', t: 20, del: 1 }] });
  const c = S.cleanDoc({ books: [{ id: 'x', t: 30, title: 'Back' }] });
  eq(S.live(S.mergeDocs(a, b)).length, 0, 'a later removal wins over an older copy');
  eq(S.live(S.mergeDocs(S.mergeDocs(a, b), c))[0].title, 'Back', 'a later edit wins over an older removal');
  eq(S.mergeDocs(S.cleanDoc({ seen: { c1: 50 } }), S.cleanDoc({ seen: { c1: 20, c2: 5 } })).seen, { c1: 20, c2: 5 }, 'batches seen: keep the first time each was added');
  const wrapped = S.cleanDoc(JSON.parse(S.canon(c)));
  eq(S.canon(wrapped), S.canon(c), 'a library survives a round trip through its file format');
}

// ---------- duplicates ----------
{
  eq(S.surname('Ursula K. Le Guin'), 'Le Guin', 'surname keeps particles');
  eq(S.surname('Martin Luther King Jr.'), 'King', 'surname drops Jr.');
  eq(S.surname('Homer'), 'Homer', 'single name');
  eq(S.titleKey('The Hobbit: or There and Back Again'), 'hobbit', 'title key drops the article and subtitle');
  const lib = S.cleanDoc({ books: [
    { id: 'h', t: 1, title: 'The Hobbit', authors: ['J.R.R. Tolkien'], room: 'Den' },
    { id: 'w', t: 1, title: 'War and Peace', authors: ['Leo Tolstoy'], isbn: '0140449132' },
    { id: 'z', t: 2, del: 1 }
  ] });
  const ix = S.dupIndex(lib);
  eq((S.findDup(ix, { title: 'Hobbit', authors: ['J. R. R. Tolkien'] }) || {}).id, 'h', 'same title and surname is a duplicate');
  eq((S.findDup(ix, { title: 'Voyna i mir', isbn: '978-0-14-044913-6' }) || {}).id, 'w', 'same ISBN in the other form is a duplicate');
  eq(S.findDup(ix, { title: 'The Hobbit', authors: ['Someone Else'] }), null, 'same title, different author is not');
}

// ---------- batches and links ----------
(async () => {
  const batch = S.cleanBatch({ shelfmark: 1, batch: { id: 'c20260926-abc', name: 'Hall', room: 'Hall', books: [
    { title: 'Middlemarch', authors: ['George Eliot'], unsure: 'spine cut off', id: 'evil', t: 99, del: 1 },
    { title: '' }, 'nonsense'
  ] } });
  eq(batch, { id: 'c20260926-abc', name: 'Hall', made: '', room: 'Hall', shelf: '', books: [{ title: 'Middlemarch', authors: ['George Eliot'], check: 'spine cut off' }] },
    'a batch keeps good books only, turns "unsure" into a check flag, and ignores ids, times and removals');
  eq(S.cleanBatch([{ title: 'A' }]).books.length, 1, 'a bare list of books is a batch');
  eq(S.cleanBatch({ nope: 1 }), null, 'something else is not');

  const json = JSON.stringify({ shelfmark: 1, batch: { id: 'c1', books: [{ title: 'Cien años de soledad', authors: ['Gabriel García Márquez'] }] } });
  const z = zlib.deflateRawSync(Buffer.from(json)).toString('base64url');
  const j = Buffer.from(json).toString('base64url');
  eq((await S.parseIncoming('https://junkdrawer.works/shelfmark/#s1z' + z)).batch.books[0].title, 'Cien años de soledad', 'a compressed link opens, accents intact');
  eq((await S.parseIncoming('#s1j' + j)).batch.books[0].authors[0], 'Gabriel García Márquez', 'an uncompressed link opens');
  eq((await S.parseIncoming('https://x/#batch=' + encodeURIComponent(json))).kind, 'batch', 'a hand-written #batch= link opens');
  eq((await S.parseIncoming('  ' + json + '\n')).batch.id, 'c1', 'pasted JSON opens');
  eq((await S.parseIncoming(S.canon(S.cleanDoc({ books: [{ id: 'q', t: 1, title: 'Q' }] })))).kind, 'library', 'a library backup is recognized as one');
  let threw = false; try { await S.parseIncoming('{"books": []}'); } catch (e) { threw = true; } check(threw, 'an empty batch is refused');
  threw = false; try { await S.parseIncoming('hello'); } catch (e) { threw = true; } check(threw, 'plain text is refused');

  // The skill's script and the page must agree on the link format.
  const py = path.join(__dirname, '..', 'skill', 'shelfmark-cataloger', 'scripts', 'make_shelfmark.py');
  let havePy = true; try { execFileSync('python3', ['--version']); } catch (e) { havePy = false; }
  if (havePy) {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shelfmark-'));
    const input = path.join(tmp, 'in.json');
    fs.writeFileSync(input, JSON.stringify({ name: 'Den, left case', room: 'Den', books: [
      { title: 'Middlemarch', authors: 'George Eliot', isbn: '0-14-143954-8', format: 'Paperback', status: 'finished', condition: 'VG', year: '1994' },
      { title: 'Beloved', authors: ['Toni Morrison'], isbn: '9780140449137', unsure: 'glare on the spine' },
      { title: 'The Hobbit', authors: ['J. R. R. Tolkien'], loan: { to: 'Sam', since: '2026-09-01' }, first: true },
      { title: '' }
    ] }));
    const out = execFileSync('python3', [py, input, '--out', tmp], { encoding: 'utf8' });
    const url = /Link: (\S+)/.exec(out)[1];
    check(url.startsWith('https://junkdrawer.works/shelfmark/#s1z'), 'the script makes a Shelfmark link');
    const got = (await S.parseIncoming(url)).batch;
    eq(got.books.map(b => b.title), ['Middlemarch', 'Beloved', 'The Hobbit'], 'the script’s link opens with every usable book, in order');
    eq(got.books[0], { title: 'Middlemarch', authors: ['George Eliot'], isbn: '9780141439549', year: 1994, format: 'paperback', status: 'read', condition: 'very-good' }, 'the script maps words onto Shelfmark’s fields');
    check(!got.books[1].isbn && /glare on the spine; ISBN read as 9780140449137 fails its check digit/.test(got.books[1].check), 'a misread ISBN is dropped and flagged, not guessed');
    eq(got.books[2].loan, { to: 'Sam', since: '2026-09-01' }, 'loans come through');
    eq(got.room, 'Den', 'the batch keeps its room');
    const file = fs.readdirSync(tmp).find(f => f.endsWith('.shelfmark.json'));
    eq((await S.parseIncoming(fs.readFileSync(path.join(tmp, file), 'utf8'))).batch.id, got.id, 'the script’s file opens as the same batch');
    check(/warning: #4: no title/.test(out), 'the script says what it left out');
  } else console.log('  (python3 not found; skipped the script round trip)');

  // ---------- spreadsheet ----------
  const csv = S.toCsv(S.cleanDoc({ books: [
    { id: 'a', t: 1, title: 'Zed, "the" book', authors: ['Amy Zane'], tags: ['x', 'y'], notes: 'line one\nline two', loan: { to: 'Sam', since: '2026-02-03' } },
    { id: 'b', t: 1, title: '=HYPERLINK("x")', authors: ['Al Able'], status: 'read', signed: true },
    { id: 'c', t: 1, del: 1 }
  ] }));
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  check(lines[0].startsWith('title,subtitle,authors,isbn'), 'the spreadsheet has a header row');
  check(lines[1].startsWith('"\'=HYPERLINK(""x"")"'), 'cells that would run as formulas are defused, and books sort by author');
  check(csv.includes('"Zed, ""the"" book"') && csv.includes('"line one\nline two"'), 'commas, quotes and line breaks are quoted');
  check(!csv.includes(',c,'), 'removed books are left out');
  eq(S.csvCell('-5'), '-5', 'plain negative numbers are left alone');

  console.log(failed ? `\n${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
