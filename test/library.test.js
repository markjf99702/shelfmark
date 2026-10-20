// Checks Shelfmark's book cleaning, merging, duplicate finding, links, spreadsheet export and what-to-read-next picks.
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
  'return { coverQuery, pickCover, isbn13, cleanBook, cleanDoc, mergeDocs, canon, live, surname, titleKey, dupIndex, findDup, cleanBatch, shelve, searchWords, toCsv, csvCell, linkText, parseIncoming, authorOrder, lengthOf, cleanNext, nextPool, dealNext };'
].join('\n'))(globalThis);

let failed = 0, passed = 0;
function check(ok, what) { if (ok) passed++; else { failed++; console.log('  FAIL ' + what); } }

// The whole page script has to parse, not just the parts tested below.
{
  const a = src.indexOf('<script>'), b = src.indexOf('</script>', a);
  let err = null; try { new Function(src.slice(a + 8, b)); } catch (e) { err = e; }
  check(!err, 'the page script parses' + (err ? ': ' + err.message : ''));
}
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
  { const n = S.cleanBook({ id: 'a', title: 'T', rating: '3.5', year: '1999.0', pages: '320.0' }); eq([n.rating, n.year, n.pages], [4, 1999, 320], 'numbers written with a decimal point are rounded, not run together'); }
  eq([S.cleanBook({ id: 'a', title: 'T', pages: '1,024' }).pages, S.cleanBook({ id: 'a', title: 'T', pages: '320 pages', year: ' 2001 ' }).year], [1024, 2001], 'a grouped number or one with words around it keeps its digits');
  eq(S.cleanBook({ id: 'x1', t: 9, del: 1, title: 'gone' }), { id: 'x1', t: 9, del: 1 }, 'a removed book keeps only id and time');
  eq(S.cleanBook({ id: '123', title: 'T' }).id, 'b123', 'numeric ids get a letter so key order stays stable');
  check(/^b[0-9a-z]{9}$/.test(S.cleanBook({ title: 'T' }).id), 'a book with no id gets one');
  eq(S.cleanBook({ id: 'a', title: 'T', loan: { to: 'Sam', since: 'last week' } }).loan, { to: 'Sam' }, 'a loan keeps its borrower even with a bad date');
  eq(S.cleanBook({ id: 'a', title: 'T', isbn: '12-34' }).isbn, '1234', 'a non-ISBN number is kept as typed digits');
  eq(['0618260307, 9780618260300', '[0618260307]', '="0618260307"', 'x, 9780618260300', '0618260307 9780618260300', '978 0 618 26030 0'].map(isbn => S.cleanBook({ id: 'a', title: 'T', isbn }).isbn),
    Array(6).fill('9780618260300'), 'the first valid ISBN is kept from a field holding several, as exports have');
  eq(S.cleanBook({ id: 'a', title: 'T', isbn: '=""' }).isbn, undefined, 'an empty Goodreads cell is no ISBN');
  eq(S.cleanBook({ id: 'a', title: 'T', isbn: '0618260308, 9780618260301' }).isbn, '0618260308', 'with none valid, the first one is kept as typed digits');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: 'Ann Lee, Bo Chen & Cy Dee' }).authors, ['Ann Lee', 'Bo Chen', 'Cy Dee'], 'author text splits on commas and &');
  eq(S.cleanBook({ id: 'a', title: 'T', tags: 'Arts & crafts, sf; kids' }).tags, ['Arts & crafts', 'sf', 'kids'], 'tag text splits on commas and semicolons, not &');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: 'Kurt Vonnegut, Jr.' }).authors, ['Kurt Vonnegut, Jr.'], 'a "Jr." after a comma stays with the name');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: 'Martin Luther King, Jr., Coretta Scott King; Ann Lee, PhD & Bo Chen, III' }).authors,
    ['Martin Luther King, Jr.', 'Coretta Scott King', 'Ann Lee, PhD', 'Bo Chen, III'], 'and so do Sr., II, III, IV, PhD and MD, among several authors');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: ['Kurt Vonnegut', 'Jr.'] }).authors, ['Kurt Vonnegut, Jr.'], 'a name split from its "Jr." before is put back together');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: ', Jr., Sammy Davis Jr.' }).authors, ['Jr.', 'Sammy Davis Jr.'], 'a "Jr." with no name before it is left alone');
}

// ---------- searching ----------
eq(S.searchWords('the  978-0-261-10221-7'), ['the', '9780261102217'], 'an ISBN searched as printed on the book becomes the 13 digits kept');
eq(S.searchWords('0261102214'), ['9780261102217'], 'and so does its ISBN-10');
eq(S.searchWords('Hobbit 1937 9780261'), ['hobbit', '1937', '9780261'], 'other words and numbers are left as they are');

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
  eq([S.surname('Kurt Vonnegut, Jr.'), S.surname('Ann Lee, Ph.D.'), S.surname('Bo Chen III.')], ['Vonnegut', 'Lee', 'Chen'], 'and the other endings a name can have');
  eq(S.surname('Homer'), 'Homer', 'single name');
  eq(S.titleKey('The Hobbit: or There and Back Again'), S.titleKey('The Hobbit'), 'title key drops the article and subtitle');
  check(S.titleKey('Heartstopper: Volume 2') !== S.titleKey('Heartstopper: Volume 1'), 'numbered volumes of a series have different title keys');
  const lib = S.cleanDoc({ books: [
    { id: 'h', t: 1, title: 'The Hobbit', authors: ['J.R.R. Tolkien'], room: 'Den' },
    { id: 'w', t: 1, title: 'War and Peace', authors: ['Leo Tolstoy'], isbn: '0140449132' },
    { id: 'z', t: 2, del: 1 }
  ] });
  const ix = S.dupIndex(lib);
  eq((S.findDup(ix, { title: 'Hobbit', authors: ['J. R. R. Tolkien'] }) || {}).id, 'h', 'same title and surname is a duplicate');
  eq((S.findDup(ix, { title: 'Voyna i mir', isbn: '978-0-14-044913-6' }) || {}).id, 'w', 'same ISBN in the other form is a duplicate');
  eq(S.findDup(ix, { title: 'The Hobbit', authors: ['Someone Else'] }), null, 'same title, different author is not');
  eq(S.coverQuery({ title: 'War and Peace', isbn: '0-14-044913-2' }), { key: 'i9780140449136', q: 'isbn=9780140449136', isbn: '9780140449136' }, 'a cover is looked up by ISBN when there is one');
  eq(S.coverQuery({ title: 'Freakonomics: A Rogue Economist', authors: ['Steven D. Levitt', 'Stephen J. Dubner'] }), { key: 'tfreakonomics|steven d. levitt', q: 'title=Freakonomics&author=Steven%20D.%20Levitt', tk: S.titleKey('Freakonomics') }, 'otherwise by title before the colon and first author');
  {
    const botany = S.coverQuery({ title: 'The Botany of Desire', authors: ['Michael Pollan'] });
    const eds = [{ title: 'Die Botanik der Begierde', covers: [3232846] }, { title: 'The Botany of Desire', covers: [-1] }, { title: 'The botany of desire', covers: [227571] }];
    eq(S.pickCover({ title: 'The Botany of Desire', cover_i: 3232846 }, eds, botany), 227571, 'the cover comes from an edition whose title matches, not the German one');
    eq(S.pickCover({ title: 'Some Other Book', cover_i: 55 }, [{ title: 'Some Other Book', covers: [55] }], botany), 0, 'a search hit with a different title gives no cover rather than a wrong one');
    eq(S.pickCover({ title: 'The Botany of Desire', cover_i: 77 }, [], botany), 77, 'with no edition covers, a work whose title matches lends its own');
    const byIsbn = S.coverQuery({ title: 'x', isbn: '9780140449136' });
    eq(S.pickCover({ cover_i: 9 }, [{ title: 'War and Peace', isbn_10: ['0140449132'], covers: [42] }, { title: 'War and Peace', covers: [43] }], byIsbn), 42, 'with an ISBN, the edition carrying that ISBN wins');
    eq(S.pickCover({ cover_i: 9 }, [{ title: 'War and Peace', covers: [43] }], byIsbn), 9, 'and otherwise the work cover the ISBN search found');
  }
  eq(S.coverQuery({ title: 'Cien años de soledad' }).q, 'title=Cien%20a%C3%B1os%20de%20soledad', 'a title with no author is looked up alone, safely encoded');
  const series = S.dupIndex(S.cleanDoc({ books: [{ id: 'v1', t: 1, title: 'Heartstopper: Volume 1', authors: ['Alice Oseman'] }] }));
  eq(S.findDup(series, { title: 'Heartstopper: Volume 2', authors: ['Alice Oseman'] }), null, 'volume 2 of a series is not a duplicate of volume 1');
  eq((S.findDup(series, { title: 'Heartstopper: Volume 1', authors: ['Alice Oseman'] }) || {}).id, 'v1', 'but volume 1 again is');
}

// ---------- what to read next ----------
{
  const now = new Date('2026-10-06T12:00:00').getTime();
  const lib = S.live(S.cleanDoc({ books: [
    { id: 'old', t: 1, title: 'Middlemarch', authors: ['George Eliot'], pages: 880, added: '2019-03-04', room: 'Den', tags: ['classics'] },
    { id: 'new', t: 1, title: 'Piranesi', authors: ['Susanna Clarke'], pages: 272, added: '2026-10-01', room: 'Hall', notes: 'Sam says start here\nsecond line' },
    { id: 'lg2', t: 1, title: 'The Lathe of Heaven', authors: ['Ursula K. Le Guin'], pages: 184, added: '2024-06-01', room: 'Den', tags: ['sf'] },
    { id: 'nop', t: 1, title: 'No Pages', authors: ['Ann Lee'], added: '2025-01-01' },
    { id: 'rdg', t: 1, title: 'Being Read', status: 'reading', pages: 100 },
    { id: 'lnt', t: 1, title: 'Lent Out', pages: 100, loan: { to: 'Sam' } },
    { id: 'lg1', t: 1, title: 'The Dispossessed', authors: ['Ursula K. Le Guin'], status: 'read', rating: 5, pages: 387 },
    { id: 'meh', t: 1, title: 'So-so', authors: ['Bo Chen'], status: 'read', rating: 2, pages: 90 },
    { id: 'gone', t: 2, del: 1 }
  ] }));
  const ids = bs => bs.map(b => b.id).sort();
  const base = S.cleanNext({});
  eq(ids(S.nextPool(lib, base)), ['lg2', 'new', 'nop', 'old'], 'suggestions are unread books on hand: not read, being read, lent out or removed');
  eq(ids(S.nextPool(lib, S.cleanNext({ reread: true }))), ['lg1', 'lg2', 'new', 'nop', 'old'], 'rereads add read books rated four stars or more, and only those');
  eq([S.lengthOf(0), S.lengthOf(249), S.lengthOf(250), S.lengthOf(450), S.lengthOf(451)], ['', 'short', 'medium', 'medium', 'long'], 'length bands go by page count');
  eq(ids(S.nextPool(lib, S.cleanNext({ len: 'Short' }))), ['lg2'], 'a length leaves out books with no page count');
  eq(ids(S.nextPool(lib, S.cleanNext({ tag: 'sf', room: 'Den' }))), ['lg2'], 'tag and room narrow it');
  eq(S.cleanNext({ len: 'huge', lean: 'Waiting longest', tag: 7, reread: 'yes' }), { len: '', lean: 'oldest', tag: '7', room: '', reread: true }, 'saved choices are cleaned');

  const d = S.dealNext(lib, base, rng(3), {}, now);
  eq(d.picks.length, 3, 'three picks from four matches');
  eq(new Set(d.picks.map(p => p.b.id)).size, 3, 'no book twice in one pick');
  eq(d.pool, 4, 'the pool size is reported');
  // Working through every match before repeating one.
  const seen = {}; d.picks.forEach(p => { seen[p.b.id] = 1; });
  const d2 = S.dealNext(lib, base, rng(4), seen, now);
  eq(d2.fresh, 1, 'the next pick starts with the one not yet shown');
  check(!seen[d2.picks[0].b.id], 'and puts it first');
  eq(S.dealNext(lib, base, rng(5), { old: 1, new: 1, lg2: 1, nop: 1 }, now).fresh, 0, 'once every match has been shown, fresh is 0');

  const first = lean => { const n = {}; for (let k = 0; k < 600; k++) { const id = S.dealNext(lib, S.cleanNext({ lean }), rng(100 + k), {}, now).picks[0].b.id; n[id] = (n[id] || 0) + 1; } return n; };
  const any = first(''), oldest = first('oldest'), newest = first('newest'), loved = first('loved');
  check(any.old > 100 && any.new > 100 && any.lg2 > 100 && any.nop > 100, 'surprise me gives every match a fair chance ' + JSON.stringify(any));
  check(oldest.old > 300 && oldest.old > 4 * (oldest.new || 0), 'waiting longest mostly picks the book added longest ago ' + JSON.stringify(oldest));
  check(newest.new > 300 && newest.new > 4 * (newest.old || 0), 'newest arrivals mostly picks the latest one ' + JSON.stringify(newest));
  check(loved.lg2 > 300, 'favorite authors mostly picks the Le Guin, after a five-star Le Guin ' + JSON.stringify(loved));

  const why = (lean, id) => S.dealNext(lib, S.cleanNext({ lean }), rng(1), { old: id !== 'old' ? 1 : 0, new: id !== 'new' ? 1 : 0, lg2: id !== 'lg2' ? 1 : 0, nop: id !== 'nop' ? 1 : 0 }, now).picks[0].why;
  eq(why('', 'lg2'), ['You gave “The Dispossessed” 5 stars', 'In your library since ' + new Date(2024, 5, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })], 'a book by an author you rated highly says so, and one over two years on the shelf says how long');
  check(/^Waiting longest of these: in your library since .*2019$/.test(why('oldest', 'old')[0]), 'the longest-waiting book says so, with the month it was added');
  eq(why('', 'new'), ['New arrival: added 5 days ago', 'Your note: Sam says start here'], 'a recent arrival says so, and the first line of a note comes along');
  eq(why('', 'nop'), [], 'nothing special to say → no reasons');
  for (const hour of ['00:30', '09:00', '15:00', '23:30']) {
    const at = new Date('2026-10-13T' + hour + ':00').getTime();
    const said = added => S.dealNext(S.live(S.cleanDoc({ books: [{ id: 'x', t: 1, title: 'X', added }] })), base, rng(1), {}, at).picks[0].why[0];
    eq([said('2026-10-13'), said('2026-10-12'), said('2026-10-01')], ['New arrival: added today', 'New arrival: added yesterday', 'New arrival: added 12 days ago'], 'new arrivals count calendar days, at ' + hour);
  }
  const reread = S.dealNext(lib, S.cleanNext({ reread: true, len: 'medium' }), rng(1), {}, now).picks;
  eq(reread.map(p => p.b.id).sort(), ['lg1', 'new'], 'medium length with rereads');
  eq(reread.find(p => p.b.id === 'lg1').why, ['A reread: you gave it 5 stars'], 'a reread says what you gave it');
  const none = S.dealNext(lib, S.cleanNext({ len: 'long', tag: 'sf' }), rng(1), {}, now);
  eq([none.picks.length, none.noPages], [0, 0], 'no matches → no picks');
  eq(S.dealNext(lib, S.cleanNext({ len: 'short', room: 'Hall' }), rng(1), {}, now).noPages, 0, 'books without pages are counted only when they would otherwise match');
  eq(S.dealNext(lib, S.cleanNext({ len: 'long' }), rng(1), {}, now).noPages, 1, 'and counted when they would');
  const jr = S.live(S.cleanDoc({ books: [
    { id: 'a', t: 1, title: 'Slaughterhouse-Five', authors: ['Kurt Vonnegut', 'Jr.'], status: 'read', rating: 5 },
    { id: 'b', t: 1, title: 'Breakfast of Champions', authors: ['Kurt Vonnegut, Jr.'], status: 'read', rating: 3 },
    { id: 'c', t: 1, title: 'Cat’s Cradle', authors: ['Kurt Vonnegut, Jr.'] }] }));
  eq(S.dealNext(jr, S.cleanNext({ lean: 'loved' }), rng(1), {}, now).picks[0].why, ['You’ve read 2 by Vonnegut and gave “Slaughterhouse-Five” 5 stars'], 'an author with a "Jr." is named by surname, not as "Jr."');
  const tied = S.live(S.cleanDoc({ books: [{ id: 'a', t: 1, title: 'A', added: '2019-01-01' }, { id: 'b', t: 1, title: 'B', added: '2019-01-01' }, { id: 'c', t: 1, title: 'C', added: '2026-01-01' }] }));
  check(S.dealNext(tied, S.cleanNext({ lean: 'oldest' }), rng(1), {}, now).picks.every(p => !/longest/.test(p.why.join())), 'books tied for the oldest date don’t each claim to be waiting longest');
  const two = S.live(S.cleanDoc({ books: [{ id: 'a', t: 1, title: 'A', added: '2026-01-01' }, { id: 'b', t: 1, title: 'B', added: '2026-01-01' }] }));
  check(S.dealNext(two, S.cleanNext({ lean: 'oldest' }), rng(1), {}, now).even, 'books all added the same day weigh the same');
  eq(S.dealNext(two, S.cleanNext({ lean: 'loved' }), rng(1), {}, now).fans, 0, 'and none by authors you have read is reported');
}

// ---------- batches and links ----------
(async () => {
  const batch = S.cleanBatch({ shelfmark: 1, batch: { id: 'c20260926-abc', name: 'Hall', room: 'Hall', books: [
    { title: 'Middlemarch', authors: ['George Eliot'], unsure: 'spine cut off', id: 'evil', t: 99, del: 1 },
    { title: '' }, 'nonsense'
  ] } });
  eq(batch, { id: 'c20260926-abc', name: 'Hall', made: '', room: 'Hall', shelf: '', books: [{ title: 'Middlemarch', authors: ['George Eliot'], check: 'spine cut off' }], more: 0 },
    'a batch keeps good books only, turns "unsure" into a check flag, and ignores ids, times and removals');
  eq(S.cleanBatch([{ title: 'A' }]).books.length, 1, 'a bare list of books is a batch');
  eq(S.cleanBatch({ nope: 1 }), null, 'something else is not');
  {
    // A phone takes 3,000 at a time; the batch says how many more there were, junk not counted.
    const many = [{ title: '' }, 'junk'].concat(Array.from({ length: 3005 }, (_, i) => ({ title: 'Book ' + (i + 1) })), [{ title: ' ' }, null]);
    const big = S.cleanBatch({ books: many });
    eq([big.books.length, big.books[0].title, big.books[2999].title, big.more], [3000, 'Book 1', 'Book 3000', 5], 'a batch takes the first 3,000 books and counts the rest');
  }

  // "Shelve them in" on the review screen: bulk is what its two fields say, batch the room and shelf the batch came
  // with. A whole bookcase from one photo comes with a shelf for each book and, when the room isn't known, no room:
  // typing one in must not wipe those shelves.
  const where = (books, bulk, batch = { room: '', shelf: '' }) => books.map(b => S.shelve(Object.assign({}, b), bulk, batch)).map(b => [b.room || '', b.shelf || ''].join(' > '));
  const bookcase = [{ title: 'Middlemarch', shelf: 'Shelf 1 from top' }, { title: 'Gilead', shelf: 'Shelf 2 from top' }, { title: 'Beloved', room: 'Den', shelf: 'Top' }];
  eq(where(bookcase, { room: 'Living room', shelf: '' }), ['Living room > Shelf 1 from top', 'Living room > Shelf 2 from top', 'Living room > Top'], 'a room typed for the batch moves every book there and keeps each one\'s shelf');
  eq(where(bookcase, { room: '', shelf: 'By the window' }), [' > By the window', ' > By the window', 'Den > By the window'], 'a shelf typed for the batch moves every book onto it and keeps each one\'s room');
  eq(where(bookcase, { room: '', shelf: '' }), [' > Shelf 1 from top', ' > Shelf 2 from top', 'Den > Top'], 'both left blank keeps what each book says');
  const hall = { room: 'Hall', shelf: 'Tall bookcase' };
  eq(where([{ title: 'A' }, { title: 'B', shelf: 'Top' }, { title: 'C', room: 'Den' }, { title: 'D', room: 'hall' }], hall, hall),
    ['Hall > Tall bookcase', 'Hall > Top', 'Den > ', 'hall > Tall bookcase'], 'untouched, the batch\'s own room and shelf fill in only for books Claude didn\'t place');
  // SKILL.md's own example: a room and a shelf for the batch, and books on the bookcase's top shelf. Changing one field
  // moves every book there; the other field, left as the batch gave it, still only fills in.
  const living = { room: 'Living room', shelf: 'Tall bookcase' };
  const tall = [{ title: 'Middlemarch', shelf: 'Tall bookcase, top' }, { title: 'The Hobbit' }, { title: 'Gilead', room: 'Hall' }];
  eq(where(tall, { room: 'Den', shelf: 'Tall bookcase' }, living), ['Den > Tall bookcase, top', 'Den > Tall bookcase', 'Den > '], 'changing only the room moves every book to it and keeps each one\'s own shelf');
  eq(where(tall, { room: 'Living room', shelf: 'Bottom' }, living), ['Living room > Bottom', 'Living room > Bottom', 'Hall > Bottom'], 'changing only the shelf moves every book onto it and keeps each one\'s own room');
  eq(where(tall, { room: '', shelf: 'Tall bookcase' }, living), [' > Tall bookcase, top', ' > Tall bookcase', 'Hall > '], 'emptying the room gives no book the batch\'s room');
  eq(where(tall, { room: 'Living room', shelf: '' }, living), ['Living room > Tall bookcase, top', 'Living room > ', 'Hall > '], 'emptying the shelf gives no book the batch\'s shelf');

  const json = JSON.stringify({ shelfmark: 1, batch: { id: 'c1', books: [{ title: 'Cien años de soledad', authors: ['Gabriel García Márquez'] }] } });
  const z = zlib.deflateRawSync(Buffer.from(json)).toString('base64url');
  const j = Buffer.from(json).toString('base64url');
  eq((await S.parseIncoming('https://shelfmark.junkdrawer.works/#s1z' + z)).batch.books[0].title, 'Cien años de soledad', 'a compressed link opens, accents intact');
  eq((await S.parseIncoming('#s1j' + j)).batch.books[0].authors[0], 'Gabriel García Márquez', 'an uncompressed link opens');
  eq((await S.parseIncoming('https://x/#batch=' + encodeURIComponent(json))).kind, 'batch', 'a hand-written #batch= link opens');
  eq((await S.parseIncoming('  ' + json + '\n')).batch.id, 'c1', 'pasted JSON opens');
  eq((await S.parseIncoming(S.canon(S.cleanDoc({ books: [{ id: 'q', t: 1, title: 'Q' }] })))).kind, 'library', 'a library backup is recognized as one');
  // A link cut short, or written by hand with a bare %, is refused the way other bad input is: by a promise that
  // fails, so the page can say so, never by an error thrown on the spot.
  async function refused(f) { let p; try { p = f(); } catch (e) { return 'threw on the spot'; } try { await p; return 'opened'; } catch (e) { return 'refused'; } }
  for (let cut = 1; cut <= 4; cut++) eq(await refused(() => S.parseIncoming('https://shelfmark.junkdrawer.works/#s1z' + z.slice(0, z.length - cut))), 'refused', 'a link cut ' + cut + ' short is refused');
  eq(await refused(() => S.linkText('#s1z' + z.slice(0, 4 * Math.floor(z.length / 4) - 3))), 'refused', 'even with a length base64 can\'t have');
  eq(await refused(() => S.linkText('#batch=%E9t%C3')), 'refused', 'a #batch= link that isn\'t UTF-8 is refused');
  eq((await S.parseIncoming('#batch={%22books%22:[{%22title%22:%22100%%20Fun%22}]}')).batch.books[0].title, '100% Fun', 'a hand-written #batch= link with a % in it opens, as a browser hands it over');
  eq((await S.parseIncoming('https://shelfmark.junkdrawer.works/#batch={"books":[{"title":"100%Fun"}]}')).batch.books[0].title, '100%Fun', 'and pasted');
  // Pasted links come with all sorts around them.
  const link = 'https://shelfmark.junkdrawer.works/#s1z' + z, half = Math.floor(link.length / 2);
  for (const [text, what] of [[link + '.', 'with a full stop after it'], ['[Open in Shelfmark](' + link + ')', 'inside a markdown link'],
    [link.slice(0, half) + '\n' + link.slice(half), 'broken over two lines'], ['Link: ' + link + '\n\nFile: /tmp/den.shelfmark.json', 'as the script prints it'],
    ['Here it is: ' + link + ' Open it and check the list', 'with words after it']]) {
    let got = null; try { got = (await S.parseIncoming(text)).batch.books[0].title; } catch (e) { got = 'refused'; }
    eq(got, 'Cien años de soledad', 'a pasted link opens ' + what);
  }
  eq((await S.parseIncoming(JSON.stringify({ books: [{ title: 'T', notes: 'from https://x/#s1zAAAA' }] }))).batch.books[0].notes, 'from https://x/#s1zAAAA', 'JSON that mentions a link is still read as JSON');
  let threw = false; try { await S.parseIncoming('{"books": []}'); } catch (e) { threw = true; } check(threw, 'an empty batch is refused');
  threw = false; try { await S.parseIncoming('hello'); } catch (e) { threw = true; } check(threw, 'plain text is refused');
  // A spreadsheet export can't be read here; it's refused with a word on what to do instead.
  const sheetSaid = async t => { try { await S.parseIncoming(t); return 'opened'; } catch (e) { return e.say ? e.message : 'refused'; } };
  const hint = 'That’s a spreadsheet export. Send it to Claude with the Shelfmark skill and open the link it gives you.';
  eq(await sheetSaid('﻿Book Id,Title,Author,ISBN\r\n5907,"The Hobbit, or There and Back Again",J.R.R. Tolkien,"=""0618260307"""\r\n'), hint, 'a Goodreads export says what to do with it');
  eq(await sheetSaid('"Book Id","Title","Primary Author"\n"101","The Hobbit","Tolkien, J. R. R."'), hint, 'and so does a LibraryThing one');
  eq(await sheetSaid('��B\u0000o\u0000o\u0000k\u0000 \u0000I\u0000d\u0000\t\u0000T\u0000i\u0000t\u0000l\u0000e\u0000\r\u0000\n\u0000'), hint, 'and LibraryThing\'s UTF-16 one, read as UTF-8');
  eq(await sheetSaid(S.toCsv(S.cleanDoc({ books: [{ id: 'a', t: 1, title: 'T' }] }))), hint, 'and Shelfmark\'s own spreadsheet');
  eq(await sheetSaid('Title\tAuthor\nDune\tFrank Herbert'), hint, 'and cells copied from a spreadsheet');
  eq(await sheetSaid('The title of my favourite book, I forget'), 'refused', 'plain text that mentions a title is refused as before');

  // The skill's script and the page must agree on the link format.
  const py = path.join(__dirname, '..', 'skill', 'shelfmark-cataloger', 'scripts', 'make_shelfmark.py');
  let havePy = true; try { execFileSync('python3', ['--version']); } catch (e) { havePy = false; }
  if (havePy) {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shelfmark-'));
    try {
      const input = path.join(tmp, 'in.json');
      fs.writeFileSync(input, JSON.stringify({ name: 'Den, left case', room: 'Den', books: [
        { title: 'Middlemarch', authors: 'George Eliot', isbn: '0-14-143954-8', format: 'Paperback', status: 'finished', condition: 'VG', year: '1994' },
        { title: 'Beloved', authors: ['Toni Morrison'], isbn: '9780140449137', unsure: 'glare on the spine' },
        { title: 'The Hobbit', authors: ['J. R. R. Tolkien'], loan: { to: 'Sam', since: '2026-09-01' }, first: true, isbn: '0618260307, 9780618260300' },
        { title: '' },
        { title: 'A Kindle book', isbn: '=""' }
      ] }));
      const out = execFileSync('python3', [py, input, '--out', tmp], { encoding: 'utf8' });
      const url = /Link: (\S+)/.exec(out)[1];
      check(url.startsWith('https://shelfmark.junkdrawer.works/#s1z'), 'the script makes a Shelfmark link');
      const got = (await S.parseIncoming(url)).batch;
      eq(got.books.map(b => b.title), ['Middlemarch', 'Beloved', 'The Hobbit', 'A Kindle book'], 'the script’s link opens with every usable book, in order');
      eq(got.books[0], { title: 'Middlemarch', authors: ['George Eliot'], isbn: '9780141439549', year: 1994, format: 'paperback', status: 'read', condition: 'very-good' }, 'the script maps words onto Shelfmark’s fields');
      check(!got.books[1].isbn && /glare on the spine; ISBN read as 9780140449137 fails its check digit/.test(got.books[1].check), 'a misread ISBN is dropped and flagged, not guessed');
      eq(got.books[2].loan, { to: 'Sam', since: '2026-09-01' }, 'loans come through');
      eq([got.books[2].isbn, got.books[2].check], ['9780618260300', undefined], 'the script keeps the first valid ISBN from a list, as LibraryThing gives them');
      eq([got.books[3].isbn, got.books[3].check], [undefined, undefined], 'and takes an empty Goodreads cell for no ISBN, without a flag');
      check((out.match(/warning: .*fails its check digit/g) || []).length === 1, 'the script warns about the one bad ISBN only');
      eq(got.room, 'Den', 'the batch keeps its room');
      const file = fs.readdirSync(tmp).find(f => f.endsWith('.shelfmark.json'));
      eq((await S.parseIncoming(fs.readFileSync(path.join(tmp, file), 'utf8'))).batch.id, got.id, 'the script’s file opens as the same batch');
      check(/warning: #4: no title/.test(out), 'the script says what it left out');

      // More books than Shelfmark takes at once: numbered files of up to 3,000, each a batch of its own.
      const bigIn = path.join(tmp, 'big.json'), bigOut = path.join(tmp, 'big');
      fs.writeFileSync(bigIn, JSON.stringify({ name: 'Goodreads export', books: Array.from({ length: 6001 }, (_, i) => ({ title: 'Book ' + (i + 1), authors: ['Ann Lee'] })) }));
      const said = execFileSync('python3', [py, bigIn, '--out', bigOut], { encoding: 'utf8' });
      const files = fs.readdirSync(bigOut).sort();
      eq(files.map(f => f.replace(/-\d{4}-\d\d-\d\d/, '')), ['goodreads-export-1.shelfmark.json', 'goodreads-export-2.shelfmark.json', 'goodreads-export-3.shelfmark.json'], 'a list of over 3,000 books is written as numbered files');
      const parts = [];
      for (const f of files) parts.push((await S.parseIncoming(fs.readFileSync(path.join(bigOut, f), 'utf8'))).batch);
      eq(parts.map(p => [p.books.length, p.more, p.name]), [[3000, 0, 'Goodreads export (1 of 3)'], [3000, 0, 'Goodreads export (2 of 3)'], [1, 0, 'Goodreads export (3 of 3)']], 'of up to 3,000 books each, every one taken whole and named for its part');
      eq(new Set(parts.map(p => p.id)).size, 3, 'each part has a batch id of its own');
      eq([parts[1].books[0].title, parts[2].books[0].title], ['Book 3001', 'Book 6001'], 'the parts keep the list in order');
      check(/Shelfmark takes 3,000 books at a time, so these are in 3 numbered files/.test(said) && /File 3 of 3 \(1 book\): /.test(said) && !/Link:/.test(said), 'the script says so, and hands over the files without a link');

      // Exports from Goodreads and LibraryThing, read by the script itself, the way they come: a byte-order mark,
      // CRLF line ends, quoted line breaks and a short row; LibraryThing's tab-separated file in UTF-16.
      const cellq = v => /[",\r\n\t]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      const table = (rows, sep) => rows.map(r => r.map(cellq).join(sep)).join('\r\n') + '\r\n';
      const GR = ['Book Id', 'Title', 'Author', 'Author l-f', 'Additional Authors', 'ISBN', 'ISBN13', 'My Rating', 'Average Rating', 'Publisher', 'Binding', 'Number of Pages', 'Year Published',
        'Original Publication Year', 'Date Read', 'Date Added', 'Bookshelves', 'Bookshelves with positions', 'Exclusive Shelf', 'My Review', 'Spoiler', 'Private Notes', 'Read Count', 'Owned Copies'];
      const LT = ['Book Id', 'Title', 'Sort Character', 'Primary Author', 'Primary Author Role', 'Secondary Author', 'Secondary Author Roles', 'Publication', 'Date', 'Review', 'Rating',
        'Comment', 'Private Comment', 'Summary', 'Media', 'Physical Description', 'Page Count', 'Tags', 'Collections', 'ISBN', 'ISBNs'];
      const row = (cols, o) => cols.map(h => o[h] == null ? '' : String(o[h]));
      const grIn = path.join(tmp, 'goodreads_library_export.csv'), ltIn = path.join(tmp, 'librarything_export.tsv');
      fs.writeFileSync(grIn, '﻿' + table([GR,
        row(GR, { Title: 'The Name of the Wind (The Kingkiller Chronicle, #1)', Author: 'Patrick Rothfuss', ISBN: '="075640407X"', ISBN13: '="9780756404079"', 'My Rating': 5, 'Exclusive Shelf': 'read',
          Bookshelves: 'fantasy, read', 'My Review': 'Wow.<br/><br/>Kvothe, "the" Arcane.\nSecond line', 'Private Notes': 'Lent to Sam once', 'Owned Copies': 1 }),
        row(GR, { Title: 'Mort (Discworld, #4; Death, #1)', Author: 'Terry Pratchett', ISBN: '=""', ISBN13: '=""', 'My Rating': 0, 'Exclusive Shelf': 'currently-reading', Bookshelves: 'currently-reading, humor', 'Owned Copies': 0 }),
        row(GR, { Title: 'Wishful Thinking (Some Series, #2)', Author: 'Ann Wish', ISBN: '=""', ISBN13: '=""', 'Exclusive Shelf': 'to-read', Bookshelves: 'to-read', 'Owned Copies': 0 }),
        row(GR, { Title: 'Bought, Not Read Yet', Author: 'Bo Owner', 'Additional Authors': 'Kurt Vonnegut, Jr., Neil Gaiman', 'Exclusive Shelf': 'to-read', Bookshelves: 'to-read, classics', 'Owned Copies': 1 }),
        ['99', 'A Short Row'],
      ], ','));
      fs.writeFileSync(ltIn, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(table([LT,
        row(LT, { Title: 'The Hobbit', 'Primary Author': 'Tolkien, J. R. R.', Publication: 'Houghton Mifflin (2002), Paperback, 366 pages', Date: '1937', Rating: '4.5', Comment: 'Read aloud<br>twice',
          Tags: 'fantasy, kids', Collections: 'Your library, Favorites', ISBN: '[0618260307]', ISBNs: '0618260307, 9780618260300' }),
        row(LT, { Title: 'Slaughterhouse-Five', 'Primary Author': 'Vonnegut, Kurt, Jr.', Publication: 'New York : Delacorte, 1969.', Collections: 'Currently reading' }),
        row(LT, { Title: 'Le Petit Prince', 'Primary Author': 'Saint-Exupéry, Antoine de', Collections: 'Wishlist' }),
      ], '\t'), 'utf16le')]));
      const imported = async (file, kind, ...more) => {
        const dir = fs.mkdtempSync(path.join(tmp, 'import-'));
        const said = execFileSync('python3', [py, file, '--import', kind, '--out', dir, '--no-link', ...more], { encoding: 'utf8' });
        const f = fs.readdirSync(dir).find(f => f.endsWith('.shelfmark.json'));
        return { said, batch: (await S.parseIncoming(fs.readFileSync(path.join(dir, f), 'utf8'))).batch };
      };
      const grOut = await imported(grIn, 'goodreads');
      const byTitle = Object.fromEntries(grOut.batch.books.map(b => [b.title, b]));
      eq(grOut.batch.books.map(b => b.title), ['The Name of the Wind', 'Mort', 'Bought, Not Read Yet', 'A Short Row'], 'a Goodreads import leaves out the to-read shelf with no copy owned, and takes the series off titles');
      eq(byTitle['The Name of the Wind'], { title: 'The Name of the Wind', authors: ['Patrick Rothfuss'], isbn: '9780756404079', status: 'read', rating: 5, tags: ['fantasy'],
        notes: 'Wow.\n\nKvothe, "the" Arcane.\nSecond line\n\nLent to Sam once' }, 'its <br/> become line breaks, the review and private notes both kept, and the read shelf is a status, not a tag');
      eq([byTitle.Mort.status, byTitle.Mort.tags, byTitle.Mort.isbn, byTitle.Mort.check], ['reading', ['humor'], undefined, undefined], 'currently-reading is a status, and empty ="" cells are no ISBN');
      eq([byTitle['Bought, Not Read Yet'].status, byTitle['Bought, Not Read Yet'].tags, byTitle['Bought, Not Read Yet'].authors], [undefined, ['classics'], ['Bo Owner', 'Kurt Vonnegut, Jr.', 'Neil Gaiman']],
        'a to-read book with a copy owned comes in unread, its additional authors whole');
      check(/Left out: 1 on the to-read shelf with no copy owned\. To add them too, run again with --keep-unowned\./.test(grOut.said), 'the script says how many it left out, and how to add them');
      const grAll = await imported(grIn, 'goodreads', '--keep-unowned');
      eq([grAll.batch.books.length, grAll.batch.books[2].title, /Left out/.test(grAll.said)], [5, 'Wishful Thinking', false], 'with --keep-unowned they come in too');
      const ltOut = await imported(ltIn, 'librarything');
      eq(ltOut.batch.books, [
        { title: 'The Hobbit', authors: ['J. R. R. Tolkien'], isbn: '9780618260300', publisher: 'Houghton Mifflin', year: 1937, rating: 5, tags: ['fantasy', 'kids', 'Favorites'], notes: 'Read aloud\ntwice' },
        { title: 'Slaughterhouse-Five', authors: ['Kurt Vonnegut, Jr.'], publisher: 'Delacorte', status: 'reading' },
      ], 'a LibraryThing import turns "Last, First" round, leaves out the Wishlist and keeps its own collections out of tags');
      check(/Left out: 1 in Wishlist or Read but unowned and not in Your library/.test(ltOut.said), 'and says what it left out');
      // The point of it all: imported books are found as books already on the shelves.
      const shelves = S.dupIndex(S.cleanDoc({ books: [{ id: 'w', t: 1, title: 'The Name of the Wind', authors: ['Patrick Rothfuss'] }, { id: 'h', t: 1, title: 'The Hobbit', authors: ['J.R.R. Tolkien'] }] }));
      eq([S.findDup(shelves, byTitle['The Name of the Wind']), S.findDup(shelves, ltOut.batch.books[0])].map(b => b && b.id), ['w', 'h'], 'so imported books match the same books read from the shelves');
      let wrong = ''; try { execFileSync('python3', [py, ltIn, '--import', 'goodreads', '--out', tmp], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { wrong = String(e.stderr); }
      check(/looks like a LibraryThing one, so use --import librarything/.test(wrong), 'the wrong --import says which to use');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    check(!fs.existsSync(tmp), 'the script round trip leaves nothing behind in ' + require('os').tmpdir());
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
