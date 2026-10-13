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
  'return { coverQuery, pickCover, isbn13, cleanBook, cleanDoc, mergeDocs, canon, live, surname, titleKey, dupIndex, findDup, cleanBatch, shelve, toCsv, csvCell, linkText, parseIncoming, authorOrder, lengthOf, cleanNext, nextPool, dealNext };'
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
  eq(S.cleanBook({ id: 'x1', t: 9, del: 1, title: 'gone' }), { id: 'x1', t: 9, del: 1 }, 'a removed book keeps only id and time');
  eq(S.cleanBook({ id: '123', title: 'T' }).id, 'b123', 'numeric ids get a letter so key order stays stable');
  check(/^b[0-9a-z]{9}$/.test(S.cleanBook({ title: 'T' }).id), 'a book with no id gets one');
  eq(S.cleanBook({ id: 'a', title: 'T', loan: { to: 'Sam', since: 'last week' } }).loan, { to: 'Sam' }, 'a loan keeps its borrower even with a bad date');
  eq(S.cleanBook({ id: 'a', title: 'T', isbn: '12-34' }).isbn, '1234', 'a non-ISBN number is kept as typed digits');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: 'Ann Lee, Bo Chen & Cy Dee' }).authors, ['Ann Lee', 'Bo Chen', 'Cy Dee'], 'author text splits on commas and &');
  eq(S.cleanBook({ id: 'a', title: 'T', tags: 'Arts & crafts, sf; kids' }).tags, ['Arts & crafts', 'sf', 'kids'], 'tag text splits on commas and semicolons, not &');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: 'Kurt Vonnegut, Jr.' }).authors, ['Kurt Vonnegut, Jr.'], 'a "Jr." after a comma stays with the name');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: 'Martin Luther King, Jr., Coretta Scott King; Ann Lee, PhD & Bo Chen, III' }).authors,
    ['Martin Luther King, Jr.', 'Coretta Scott King', 'Ann Lee, PhD', 'Bo Chen, III'], 'and so do Sr., II, III, IV, PhD and MD, among several authors');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: ['Kurt Vonnegut', 'Jr.'] }).authors, ['Kurt Vonnegut, Jr.'], 'a name split from its "Jr." before is put back together');
  eq(S.cleanBook({ id: 'a', title: 'T', authors: ', Jr., Sammy Davis Jr.' }).authors, ['Jr.', 'Sammy Davis Jr.'], 'a "Jr." with no name before it is left alone');
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
  eq(batch, { id: 'c20260926-abc', name: 'Hall', made: '', room: 'Hall', shelf: '', books: [{ title: 'Middlemarch', authors: ['George Eliot'], check: 'spine cut off' }] },
    'a batch keeps good books only, turns "unsure" into a check flag, and ignores ids, times and removals');
  eq(S.cleanBatch([{ title: 'A' }]).books.length, 1, 'a bare list of books is a batch');
  eq(S.cleanBatch({ nope: 1 }), null, 'something else is not');

  // "Shelve them in" on the review screen. A whole bookcase from one photo comes with a shelf for each book and,
  // when the room isn't known, no room: typing one in must not wipe those shelves.
  const where = (books, bulk) => books.map(b => S.shelve(Object.assign({}, b), bulk)).map(b => [b.room || '', b.shelf || ''].join(' > '));
  const bookcase = [{ title: 'Middlemarch', shelf: 'Shelf 1 from top' }, { title: 'Gilead', shelf: 'Shelf 2 from top' }, { title: 'Beloved', room: 'Den', shelf: 'Top' }];
  eq(where(bookcase, { room: 'Living room', shelf: '', touched: true }), ['Living room > Shelf 1 from top', 'Living room > Shelf 2 from top', 'Living room > Top'], 'a room typed for the batch moves every book there and keeps each one\'s shelf');
  eq(where(bookcase, { room: '', shelf: 'By the window', touched: true }), [' > By the window', ' > By the window', 'Den > By the window'], 'a shelf typed for the batch moves every book onto it and keeps each one\'s room');
  eq(where(bookcase, { room: '', shelf: '', touched: true }), [' > Shelf 1 from top', ' > Shelf 2 from top', 'Den > Top'], 'both left blank keeps what each book says');
  eq(where([{ title: 'A' }, { title: 'B', shelf: 'Top' }, { title: 'C', room: 'Den' }, { title: 'D', room: 'hall' }], { room: 'Hall', shelf: 'Tall bookcase', touched: false }),
    ['Hall > Tall bookcase', 'Hall > Top', 'Den > ', 'hall > Tall bookcase'], 'untouched, the batch\'s own room and shelf fill in only for books Claude didn\'t place');

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
    check(url.startsWith('https://shelfmark.junkdrawer.works/#s1z'), 'the script makes a Shelfmark link');
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
