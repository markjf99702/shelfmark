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
  'return { coverQuery, pickCover, isbn13, cleanBook, cleanDoc, mergeDocs, canon, live, surname, titleKey, dupIndex, findDup, cleanBatch, shelve, place, placeIndex, placed, shelfOrder, searchWords, keys, searchHit, toCsv, csvCell, linkText, parseIncoming, authorOrder, lengthOf, short, cleanNext, nextPool, dealNext, nextNotes, nextOffers, fitNext, cleanDetails, matchDetails, withDetails, detailChanges, newer, indexKeys, lookupKeys, nearDup, authorsKey, DETAILS, KINDS, WAYS, PACES, CHAPTERS, MOODS, GENRES };'
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
  // Numbers as they're printed: a year with a range, a reprint or a copyright line; pages over two volumes.
  const year = v => S.cleanBook({ id: 'a', title: 'T', year: v }).year, pages = v => S.cleanBook({ id: 'a', title: 'T', pages: v }).pages, stars = v => S.cleanBook({ id: 'a', title: 'T', rating: v }).rating;
  eq(['1937–40', '1925/1953', '©1951, 1979', '2nd ed. 1999', '1999 (2003 printing)', '1937/1951', 'c. 1937', 1999.5, '1999.0'].map(year), [1937, 1925, 1951, 1999, 1999, 1937, 1937, 2000, 1999],
    'a year as printed is its first four-digit number');
  eq(['2 vols, 880', '1,024', '1 024', '1\u2009024', 'xii, 320 p.', '320 pages', 412, '320.0'].map(pages), [880, 1024, 1024, 1024, 320, 320, 412, 320], 'a page count as printed is its largest number, with digit groups joined');
  eq([4.5, 2.5, '3.5', '4 stars', '4.5 out of 5', 0.4, 9].map(stars), [5, 3, 4, 4, 5, undefined, 5], 'a rating rounds half up and takes the first number');
  {
    const yesno = [true, 1, 'true', 'Yes', ' YES ', '1', false, 0, 'false', 'no', '0', 'n', null, {}, 2];
    const want = [true, true, true, true, true, true, false, false, false, false, false, false, false, false, false];
    eq(yesno.map(v => !!S.cleanBook({ id: 'a', title: 'T', signed: v }).signed), want, 'signed is yes only for true, 1, "true", "yes" or "1"');
    eq(yesno.map(v => !!S.cleanBook({ id: 'a', title: 'T', first: v }).first), want, 'and so is first edition');
  }
  // Cleaning a book again gives the same book: text cut at its limit loses the space before the cut, not a character
  // the next time; a name loses its empty neighbours before its "Jr." joins it; a long numeric id stays 40.
  {
    const twice = (o, what) => { const a = S.cleanBook(o), b = S.cleanBook(a); eq(b, a, 'cleaning twice gives the same book: ' + what); return a; };
    eq(twice({ id: 'a', title: 'a'.repeat(299) + ' b' }, 'a title cut after a space').title, 'a'.repeat(299), 'and the cut leaves no space at the end');
    twice({ id: 'a', title: 'T', shelf: 'a'.repeat(59) + ' b', tags: ['a'.repeat(39) + ' b'], publisher: 'p'.repeat(119) + ' q', loan: { to: 'x'.repeat(79) + ' y' }, authors: ['n'.repeat(119) + ' m'] }, 'shelf, tag, publisher, borrower and author cut after a space');
    eq(twice({ id: 'a', title: 'T', notes: 'a'.repeat(3999) + '\n\nb' }, 'notes cut after a line break').notes, 'a'.repeat(3999), 'and the cut leaves no line break at the end');
    eq(twice({ id: 'a', title: 'a'.repeat(299) + '😀' }, 'a title cut inside an emoji').title, 'a'.repeat(299), 'and the cut leaves no half an emoji');
    eq(twice({ id: 'a', title: 'T', authors: ['X', '', 'Jr'] }, 'a "Jr" after an empty name').authors, ['X, Jr'], 'and the "Jr" joins its name the first time');
    eq(S.cleanBook({ id: 'a', title: 'T', authors: 'Kurt Vonnegut, , Jr.' }).authors, ['Kurt Vonnegut, Jr.'], 'as it does typed with an empty piece');
    eq(twice({ id: '1'.repeat(40), title: 'T' }, 'a 40-digit id').id, 'b' + '1'.repeat(39), 'and the id stays 40 long');
  }
  // Ids and batch ids named like something every object has, and times past the last day a date can be.
  {
    const doc = S.cleanDoc({ books: [{ id: 'constructor', t: 1, title: 'A' }, { id: '__proto__', t: 1, title: 'B' }, { id: 'toString', t: 1, title: 'C' }, { id: 'hasOwnProperty', t: 1, del: 1 }],
      seen: JSON.parse('{"constructor": 5, "__proto__": 6, "c1": 7}') });
    eq([Object.keys(doc.books), S.live(doc).map(b => b.title).sort()], [['b__proto__', 'bconstructor', 'bhasOwnProperty', 'btoString'], ['A', 'B', 'C']], 'books with ids like "constructor" and "__proto__" are kept, with a letter in front');
    eq(doc.seen, { b__proto__: 6, bconstructor: 5, c1: 7 }, 'and so are batches seen with such ids');
    eq(S.live(S.mergeDocs(doc, S.cleanDoc({ books: [{ id: 'toString', t: 2, title: 'C2' }] }))).map(b => b.title).sort(), ['A', 'B', 'C2'], 'and they merge like any other');
    eq(S.cleanBatch({ batch: { id: 'constructor', books: [{ title: 'A' }] } }).id, 'bconstructor', 'a batch id like "constructor" gets the same letter');
    const ent = S.cleanDetails({ details: { books: [{ id: 'constructor', title: 'A', kind: 'fiction' }, { id: 'valueOf', title: 'Nothing here', kind: 'fiction' }] } });
    eq(S.matchDetails(doc, ent).map(r => r.bs.map(b => b.id)), [['bconstructor'], []], 'a details entry with such an id finds its book, and one not here finds nothing');
    eq(S.cleanBook({ id: 'a', title: 'T', tags: ['constructor', 'toString', '__proto__'] }).tags, ['constructor', 'toString', '__proto__'], 'tags like "constructor" are kept');
    const far = S.cleanBook({ id: 'a', t: 1e17, title: 'T' });
    eq([far.t, new Date(far.t).getTime()], [8.64e15, 8.64e15], 'a time past the last day a date can be is brought back to it');
    const pool = S.dealNext(S.live(S.cleanDoc({ books: [{ id: 'constructor', t: 1, title: 'A' }, { id: 'b', t: 1, title: 'B' }] })), S.cleanNext({}), rng(1), JSON.parse('{"bconstructor": 1}'), Date.now());
    eq(pool.picks.map(p => p.b.id), ['b', 'bconstructor'], 'what to read next skips a book with such an id once it has been shown');
  }
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
eq([S.searchWords('Pilgrim’s Progress'), S.searchWords("pilgrim's"), S.searchWords('Moby-Dick'), S.searchWords('978-0-261'), S.searchWords('  ')],
  [['pilgrims', 'progress'], ['pilgrims'], ['moby', 'dick'], ['978', '0', '261'], []], 'apostrophes go, and a hyphen or a stop splits a word, but not an ISBN');
{
  // Each word searched starts a word of the book's (a number can be anywhere: part of an ISBN, a year), and an
  // apostrophe reads the same typed straight, curly (as an iPhone types it) or not at all.
  const finds = (b, q) => S.searchHit(b, S.searchWords(q));
  const pilgrim = S.cleanBook({ id: 'w1', t: 1, title: 'The Pilgrim\'s Progress', authors: ['John Bunyan'], kind: 'fiction' });
  const hobbit = S.cleanBook({ id: 'w2', t: 1, title: 'The Hobbit', authors: ['J. R. R. Tolkien'], isbn: '0-261-10221-4', year: 1937, kind: 'fiction' });
  const walden = S.cleanBook({ id: 'w3', t: 1, title: 'Walden', authors: ['Henry David Thoreau'], kind: 'nonfiction', blurb: 'Two years of cooking beans and thinking, in a cabin by a pond.' });
  eq([finds(walden, 'fiction'), finds(hobbit, 'fiction'), finds(walden, 'nonfiction')], [false, true, true], '"fiction" doesn’t find a nonfiction book');
  eq([finds(walden, 'king'), finds(walden, 'cook'), finds(walden, 'ond')], [false, true, false], 'a word inside another one isn’t found ("king" in "cooking")');
  eq([finds(hobbit, 'tolk'), finds(hobbit, 'TOLKIEN hob'), finds(hobbit, 'r r tolkien')], [true, true, true], 'the start of a word finds it');
  eq(['0261', '9780261102217', '978-0-261-10221-7', '1937', '937'].map(q => finds(hobbit, q)), [true, true, true, true, true], 'a number is found anywhere: an ISBN’s digits, a year');
  eq(['pilgrim’s', 'pilgrims', 'pilgrim\'s progress', 'PILGRIM‘S', 'pilgrimʼs progress', 'bunyan’s'].map(q => finds(pilgrim, q)), [true, true, true, true, true, false],
    'an apostrophe typed straight, curly or not at all finds "The Pilgrim\'s Progress"');
  eq([finds(S.cleanBook({ id: 'w4', t: 1, title: 'Moby-Dick', authors: ['Herman Melville'] }), 'dick'), finds(S.cleanBook({ id: 'w4', t: 1, title: 'Moby-Dick', authors: ['Herman Melville'] }), 'moby-dick')], [true, true], 'a hyphenated title is two words');
  // Chinese and Japanese put no spaces between words, and Korean adds endings to them: a word in those is found anywhere.
  const neko = S.cleanBook({ id: 'w5', t: 1, title: '吾輩は猫である', authors: ['夏目漱石'] }), hong = S.cleanBook({ id: 'w6', t: 1, title: '홍길동전', authors: ['허균'] });
  eq([finds(neko, '猫'), finds(neko, 'である'), finds(neko, '漱石'), finds(hong, '길동'), finds(neko, '犬')], [true, true, true, true, false], 'a Chinese, Japanese or Korean title is found by a piece from its middle');
  // A vowel sign belongs to its letter: "दान" isn't the start of a word in "गोदान".
  const godaan = S.cleanBook({ id: 'w7', t: 1, title: 'गोदान', authors: ['प्रेमचंद'] });
  eq([finds(godaan, 'गोदान'), finds(godaan, 'गोदा'), finds(godaan, 'दान'), finds(godaan, 'प्रेम')], [true, true, false, true], 'and letters with their vowel signs are one word');
}
{
  // Search looks in every field a person might type for, the edition's details and the reading details included.
  const finds = (b, q) => S.searchHit(b, S.searchWords(q));
  const kept = S.cleanBook({ id: 's1', t: 1, title: 'Walden', authors: ['Henry David Thoreau'], format: 'hardcover', condition: 'very-good', signed: true, first: true, check: 'glare over the author', pace: 'slow', chapters: 'short', way: 'dip' });
  const plain = S.cleanBook({ id: 's2', t: 1, title: 'Walden', authors: ['Henry David Thoreau'] });
  eq(['signed', 'first edition', 'hardcover', 'very good', 'glare', 'slow pace', 'short chapters', 'dip'].map(q => finds(kept, q)), Array(8).fill(true), 'search finds a signed first edition, its format, condition, Check note, pace, chapters and how it reads');
  eq(['signed', 'first edition', 'hardcover'].map(q => finds(plain, q)), [false, false, false], 'and doesn’t find them in a book without them');
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
  // The volumes of a set are books of their own, however their titles carry the volume; the same book with or without
  // its subtitle is still the same book.
  const set = S.cleanDoc({ books: [
    { id: 's1', t: 1, title: 'The Lantern Cycle: First Light', authors: ['Ada Quill'], room: 'Den', shelf: 'Top' },
    { id: 's2', t: 1, title: 'Tidewater: Volume One', authors: ['Ben Marsh'] },
    { id: 's3', t: 1, title: 'Annals of Ostrava', sub: 'Volume I: The Founding', authors: ['Cy Dorn'] },
    { id: 's4', t: 1, title: 'Gilded Hours', sub: 'A Novel of the Fens', authors: ['Dee Fairweather'] },
    { id: 's5', t: 1, title: 'Война и мир', authors: ['Лев Толстой'] },
    { id: 's6', t: 1, title: 'The Hobbit', authors: ['J.R.R. Tolkien'] },
    { id: 's7', t: 1, title: 'Commonplace: A Brief History', authors: ['Ann Lee'], isbn: '9780140449136' }
  ] });
  const six = S.dupIndex(set), dup = b => (S.findDup(six, b) || {}).id || null, near = b => (S.nearDup(six, b) || {}).id || null;
  eq([dup({ title: 'The Lantern Cycle: Second Dark', authors: ['Ada Quill'] }), near({ title: 'The Lantern Cycle: Second Dark', authors: ['Ada Quill'] })], [null, 's1'],
    'another volume named after the colon is no duplicate, but may be another volume');
  eq(dup({ title: 'Tidewater: Volume Four', authors: ['Ben Marsh'] }), null, 'a volume numbered in words is no duplicate of another');
  eq(dup({ title: 'Annals of Ostrava', sub: 'Volume II: The Wars', authors: ['Cy Dorn'] }), null, 'nor is a volume given in the subtitle');
  eq(dup({ title: 'Lantern Cycle', sub: 'Second Dark', authors: ['Ada Quill'] }), null, 'nor one whose set is the title and volume the subtitle');
  eq(dup({ title: 'Second Dark', sub: 'The Lantern Cycle', authors: ['Ada Quill'] }), null, 'nor one whose volume is the title and set the subtitle');
  eq([dup({ title: 'The Lantern Cycle: First Light', authors: ['Ada Quill'] }), dup({ title: 'Lantern Cycle', sub: 'First Light', authors: ['Ada Quill'] }), dup({ title: 'Tidewater: Volume One', authors: ['Ben Marsh'] })],
    ['s1', 's1', 's2'], 'but the same volume again is, its name after a colon or as the subtitle');
  eq([dup({ title: 'Gilded Hours', authors: ['Dee Fairweather'] }), dup({ title: 'Gilded Hours: A Novel of the Fens', authors: ['Dee Fairweather'] }), dup({ title: 'Commonplace', authors: ['Ann Lee'] }),
    dup({ title: 'Commonplace', sub: 'A Brief History', authors: ['Ann Lee'] })], ['s4', 's4', 's7', 's7'], 'and a book is the same with or without its subtitle');
  eq([dup({ title: 'The Hobbit: or There and Back Again', authors: ['J. R. R. Tolkien'] }), dup({ title: 'Lantern Cycle', authors: ['Ada Quill'] })], ['s6', 's1'], 'as a title without a colon matches one with');
  eq(dup({ title: 'Something Else', authors: ['Nobody'], isbn: '0-14-044913-2' }), 's7', 'the same ISBN is the same book whatever the title');
  eq([dup({ title: 'Анна Каренина', authors: ['Лев Толстой'] }), dup({ title: 'Война и мир', authors: ['Л. Толстой'] })], [null, 's5'], 'titles in other scripts are told apart, and matched');
  eq(near({ title: 'Something Else: Its Name', authors: ['Nobody'] }), null, 'a book unlike any other may be no other volume');
}

// ---------- titles in a toast ----------
eq(['Middlemarch', 'Piranesi: A Novel', 'The Interesting Narrative of the Life of Olaudah Equiano, or Gustavus Vassa, the African', 'Dr. No', 'A: Life', 'Ab: the rest',
  'Supercalifragilisticexpialidocious-Antidisestablishmentarianism', '  Gilead  '].map(S.short),
  ['Middlemarch', 'Piranesi', 'The Interesting Narrative of the Life of…', 'Dr. No', 'A: Life', 'Ab: the rest', 'Supercalifragilisticexpialidocious-Antid…', 'Gilead'],
  'a toast quotes a title up to its colon, cut at a word near 40 characters');
eq(S.short('a'.repeat(39) + '😀😀'), 'a'.repeat(39) + '…', 'a title cut inside an emoji loses the half');

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
  eq(S.cleanNext({ len: 'huge', lean: 'Waiting longest', tag: 7, reread: 'yes', kind: 'Fiction', moods: ['funny', 'nope', 'Tense'], genre: 'History', pace: 'zippy', short: 1 }),
    { len: '', lean: 'oldest', tag: '7', room: '', reread: true, kind: 'fiction', moods: ['funny', 'tense'], genre: 'history', pace: '', short: true, browse: false, more: false }, 'saved choices are cleaned');

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
    const said = added => S.dealNext(S.live(S.cleanDoc({ books: [{ id: 'x', t: 1, title: 'X', added }, { id: 'o', t: 1, title: 'O', added: '2020-01-01' }] })), base, rng(1), { o: 1 }, at).picks[0].why[0];
    eq([said('2026-10-13'), said('2026-10-12'), said('2026-10-01')], ['New arrival: added today', 'New arrival: added yesterday', 'New arrival: added 12 days ago'], 'new arrivals count calendar days, at ' + hour);
  }
  {
    // A library catalogued in one go: when a book was added tells it from none of the others, so no reason says it.
    const oneDay = added => S.live(S.cleanDoc({ books: ['A', 'B', 'C'].map(t => ({ id: t, t: 1, title: t, added })) }));
    const reasons = (lib, lean) => { const out = new Set(); for (let k = 0; k < 20; k++) S.dealNext(lib, S.cleanNext({ lean }), rng(k), {}, now).picks.forEach(p => p.why.forEach(w => out.add(w))); return [...out]; };
    eq([reasons(oneDay('2024-01-01'), 'newest'), reasons(oneDay('2024-01-01'), ''), reasons(oneDay('2026-10-04'), ''), reasons(oneDay('2026-10-04'), 'oldest')], [[], [], [], []],
      'books all added the same day get no "In your library since" or "New arrival", under any lean');
    // Two batches this month: only the later one's books are new arrivals.
    const twoBatches = S.live(S.cleanDoc({ books: [{ id: 'a', t: 1, title: 'A', added: '2026-09-26' }, { id: 'b', t: 1, title: 'B', added: '2026-09-26' }, { id: 'c', t: 1, title: 'C', added: '2026-10-04' }] }));
    const whyOf = id => S.dealNext(twoBatches, base, rng(1), { a: id !== 'a', b: 1, c: id !== 'c' }, now).picks[0].why;
    eq([whyOf('a'), whyOf('c')], [[], ['New arrival: added 2 days ago']], 'a book from the first batch isn’t a new arrival, one from a later batch is');
  }
  {
    // Only the choices that can change something are offered.
    const leans = lib => S.nextOffers(S.live(S.cleanDoc({ books: lib }))).leans.map(l => l[0]);
    const one = [{ id: 'a', t: 1, title: 'A', authors: ['Ann Lee'], added: '2026-09-26' }, { id: 'b', t: 1, title: 'B', authors: ['Bo Chen'], added: '2026-09-26' }];
    eq([leans(one), !!S.nextOffers(S.live(S.cleanDoc({ books: one }))).len], [[''], false], 'one batch with no page counts, nothing read: no Length, and only Surprise me to lean on');
    eq(leans(one.concat({ id: 'c', t: 1, title: 'C', added: '2025-01-01' })), ['', 'oldest', 'newest'], 'books added on two days can lean to the oldest or newest');
    eq(leans(one.concat({ id: 'r', t: 1, title: 'R', authors: ['Ann Lee'], status: 'read', added: '2026-09-26' })), ['', 'loved'], 'an unread book by an author you’ve read can lean to favorite authors');
    eq(leans(one.concat({ id: 'r', t: 1, title: 'R', authors: ['Cy Dee'], status: 'read', rating: 5, added: '2026-09-26' })), [''], 'but not when you’ve read none of the authors on hand');
    eq(leans(one.concat({ id: 'l', t: 1, title: 'L', added: '2020-01-01', loan: { to: 'Sam' } })), [''], 'a book lent out doesn’t count: it isn’t on hand');
    eq(!!S.nextOffers(S.live(S.cleanDoc({ books: one.concat({ id: 'p', t: 1, title: 'P', pages: 300 }) }))).len, true, 'one book with a page count is enough for Length');
    const c = S.fitNext(S.cleanNext({ len: 'short', lean: 'oldest', tag: 'gone', room: 'Hall', moods: ['funny'] }), S.nextOffers(S.live(S.cleanDoc({ books: one }))));
    eq([c.len, c.lean, c.tag, c.room, c.moods], ['', '', '', '', []], 'a saved length, lean, tag, room or mood that isn’t offered goes back to Any');
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
  {
    // An author you gave one or two stars isn't a favorite: no lift, no reason, and no Favorite authors to lean on.
    const meh = S.live(S.cleanDoc({ books: [
      { id: 'r2', t: 1, title: 'So-so', authors: ['Bo Chen'], status: 'read', rating: 2 }, { id: 'r1', t: 1, title: 'Awful', authors: ['Cy Dee'], status: 'read', rating: 1 },
      { id: 'b', t: 1, title: 'Another Chen', authors: ['Bo Chen'] }, { id: 'c', t: 1, title: 'Another Dee', authors: ['Cy Dee'] }, { id: 'n', t: 1, title: 'Never Read', authors: ['Di Eng'] }] }));
    const share = {}; for (let k = 0; k < 900; k++) { const id = S.dealNext(meh, S.cleanNext({ lean: 'loved' }), rng(700 + k), {}, now).picks[0].b.id; share[id] = (share[id] || 0) + 1; }
    check(['b', 'c', 'n'].every(id => share[id] > 220), 'books by authors you gave one or two stars come up as often as one by an author you haven’t read ' + JSON.stringify(share));
    eq(S.dealNext(meh, S.cleanNext({ lean: 'loved' }), rng(1), {}, now).picks.map(p => p.why), [[], [], []], 'and no reason says you read them');
    eq(S.nextOffers(meh).leans.map(l => l[0]), [''], 'and Favorite authors isn’t offered for them');
  }
  const tied = S.live(S.cleanDoc({ books: [{ id: 'a', t: 1, title: 'A', added: '2019-01-01' }, { id: 'b', t: 1, title: 'B', added: '2019-01-01' }, { id: 'c', t: 1, title: 'C', added: '2026-01-01' }] }));
  check(S.dealNext(tied, S.cleanNext({ lean: 'oldest' }), rng(1), {}, now).picks.every(p => !/longest/.test(p.why.join())), 'books tied for the oldest date don’t each claim to be waiting longest');
  const two = S.live(S.cleanDoc({ books: [{ id: 'a', t: 1, title: 'A', added: '2026-01-01' }, { id: 'b', t: 1, title: 'B', added: '2026-01-01' }] }));
  check(S.dealNext(two, S.cleanNext({ lean: 'oldest' }), rng(1), {}, now).even, 'books all added the same day weigh the same');
  eq(S.dealNext(two, S.cleanNext({ lean: 'loved' }), rng(1), {}, now).fans, 0, 'and none by authors you have read is reported');
}

// ---------- properties, on thousands of random books ----------
// Seeded, so a failure comes back the same way each run. Books here have near-limit text, odd white space, emoji,
// names with a "Jr." and empty pieces, numbers as printed, ids like "constructor", and times past the last date.
{
  const t0 = Date.now(), r = rng(2026), any = a => a[Math.floor(r() * a.length)];
  const BITS = ['é', 'e\u0301', ' ', '  ', '\t', '\n', '\n\n\n', '\r\n', '\u00a0', '\u2009', '\ufeff', '😀', ',', ';', ' & ', 'Jr.', 'III', ':', '1'];
  const words = n => { let x = ''; while (x.length < n) x += r() < 0.75 ? 'abcdefghijklmnop'[Math.floor(r() * 16)] : any(BITS); return x; };
  // Near its limit, text is a plain run and then a random tail across the limit, where the cut falls.
  const long = n => 'abcdefgh'.repeat(Math.ceil(n / 8)).slice(0, n - 9 + Math.floor(r() * 6)) + words(8);
  const text = n => r() < 0.3 ? long(n) : r() < 0.2 ? '' : words(1 + Math.floor(r() * 14));
  const names = () => r() < 0.5 ? Array.from({ length: Math.floor(r() * 5) }, () => any([text(120), '', ' ', 'Jr', 'Jr.', 'III', 'Ann Lee', 'Bo Chen, PhD']))
    : Array.from({ length: 1 + Math.floor(r() * 4) }, () => any(['Ann Lee', 'Jr.', '', text(120), 'Kurt Vonnegut'])).join(any([', ', '; ', ' & ', ' and ', ', , ']));
  const book = () => ({
    id: any(['', 'a', '123', '1'.repeat(40), '7'.repeat(45), 'constructor', '__proto__', 'toString', 'b' + Math.floor(r() * 9), 'a b-c_d', 'x'.repeat(39) + ' y']),
    t: any([0, 5, 1e17, -3, '12', 1.5, 8.64e15, undefined]), del: r() < 0.08 ? 1 : 0,
    title: r() < 0.05 ? ' ' : text(300), sub: text(300), authors: names(),
    isbn: any(['', '0-14-044913-2', '9780140449137', '12-34', '0618260307, 9780618260300', text(20)]), publisher: text(120),
    year: any([1999, '1937–40', '©1951, 1979', '2nd ed. 1999', 1999.5, -5, 'x', 3000, '']), pages: any(['2 vols, 880', '1,024', 412, '320.0', 60000, '', '1\u2009024']),
    format: any(['Hardcover', 'paperback', 'nope', '']), condition: any(['very good', 'Fine', 'x', '']), room: text(60), shelf: text(60),
    status: any(['read', 'Reading', 'unread', 'x', '']), rating: any([4.5, '3.5', 9, -1, '4 stars', 0, 2.5]),
    loan: r() < 0.3 ? { to: text(80), since: any(['2026-01-01', 'x', '']) } : null, tags: r() < 0.5 ? Array.from({ length: Math.floor(r() * 24) }, () => text(40)) : text(200),
    notes: r() < 0.2 ? long(4000) : text(60), edition: text(120), signed: any([true, 'false', 'yes', 1, 0, 'no', 'TRUE']), first: any([true, 'no', '1', 2, false]),
    added: any(['2026-09-26', '2019-03-04', 'x', '']), check: text(300), unsure: text(300), blurb: text(300),
    kind: any(['Fiction', 'poetry', 'x', '']), genres: any([['sf', 'Classics', 'x', 'fantasy', 'horror', 'ya'], 'History; Science', '', ['biography']]),
    moods: any([['funny', 'Tense', 'bogus'], 'dark, sad; hopeful, tense, reflective', '']), pace: any(['slow', 'Fast', '']), chapters: any(['short', 'huge', '']), way: any(['browse', 'Dip in and out', 'through', '']),
  });

  // Cleaning a clean book gives it back as it was.
  let bad = null, n = 0;
  for (let k = 0; k < 2000; k++) {
    const x = book(), a = S.cleanBook(x); if (!a) continue; n++;
    const b = S.cleanBook(a);
    if (JSON.stringify(a) !== JSON.stringify(b)) { bad = bad || [x, a, b]; }
  }
  check(!bad && n > 1500, 'cleaning any of ' + n + ' random books twice gives the same book' + (bad ? '\n    ' + JSON.stringify(bad[1]).slice(0, 300) + '\n    ' + JSON.stringify(bad[2]).slice(0, 300) : ''));

  // Merging rich books is order-free, groupable and repeatable, and of two different copies one is always newer.
  // (What decides a merge is the time, then how many fields a copy has, then its text, so these books have a few
  // times between them and any number of fields, but short text.)
  const lite = () => r() < 0.12 ? { id: 'b' + Math.floor(r() * 8), t: 1 + Math.floor(r() * 3), del: 1 } : {
    id: 'b' + Math.floor(r() * 8), t: 1 + Math.floor(r() * 3), title: any(['Same', 'Other', 'Dune']), authors: any([[], ['Ann Lee'], ['Ann Lee', 'Bo Chen']]),
    notes: any(['', 'x', 'line one\nline two']), rating: any([0, 3, 5]), status: any(['', 'read', 'reading']), kind: any(['', 'fiction']), moods: any([[], ['funny'], ['dark', 'sad']]),
    tags: any([[], ['sf'], ['sf', 'kids']]), loan: any([null, { to: 'Sam' }, { to: 'Sam', since: '2026-01-02' }]), signed: any([false, true]), pages: any([0, 300]) };
  const doc = () => S.cleanDoc({ books: Array.from({ length: 6 }, lite), seen: { ['c' + Math.floor(r() * 3)]: 1 + Math.floor(r() * 9) } });
  let laws = true, total = true;
  for (let k = 0; k < 300; k++) {
    const a = doc(), b = doc(), c = doc(), m = (x, y) => S.canon(S.mergeDocs(x, y));
    if (m(a, b) !== m(b, a) || S.canon(S.mergeDocs(S.mergeDocs(a, b), c)) !== S.canon(S.mergeDocs(a, S.mergeDocs(b, c))) || m(a, a) !== S.canon(a)) laws = false;
    for (const id of Object.keys(a.books)) {
      const x = a.books[id], y = b.books[id];
      if (y && JSON.stringify(x) !== JSON.stringify(y) && S.newer(x, y) === S.newer(y, x)) total = false;
    }
  }
  check(laws, 'merging rich random libraries is order-free, groupable and repeatable');
  check(total, 'of two different copies of a book, exactly one is newer');

  // Reading details touch only the reading details, and a page count only where there was none.
  let only = true, kept = true;
  for (let k = 0; k < 400; k++) {
    const b = S.cleanBook(Object.assign(book(), { id: 'a', del: 0, title: 'T' })), e = S.cleanDetails({ details: { books: [Object.assign(book(), { id: 'a', title: 'T', del: 0 })] } }).books[0];
    if (!e) continue;
    const rep = r() < 0.5, x = S.withDetails(b, e, rep);
    if (!x) continue;
    for (const f of new Set([...Object.keys(b), ...Object.keys(x)])) {
      if (S.DETAILS.includes(f)) { if (!rep && b[f] != null && JSON.stringify(x[f]) !== JSON.stringify(b[f])) kept = false; }
      else if (f === 'pages') { if (x.pages !== (b.pages || e.pages)) only = false; }
      else if (JSON.stringify(x[f]) !== JSON.stringify(b[f])) only = false;
    }
  }
  check(only, 'details change nothing but the reading details and a blank page count');
  check(kept, 'and without Replace leave the details a book has');

  // Details find every copy they're for, and never a removed book.
  const SHELF = [['Middlemarch', 'George Eliot', '9780141439549'], ['The Republic', 'Plato', ''], ['Moby-Dick', 'Herman Melville', '9780142437247'], ['Walden', 'Henry David Thoreau', '']];
  let never = true, every = true;
  for (let k = 0; k < 300; k++) {
    const books = Array.from({ length: 2 + Math.floor(r() * 8) }, (_, i) => { const [title, who, isbn] = any(SHELF);
      return { id: 'k' + i, t: 1, del: r() < 0.15 ? 1 : 0, title: r() < 0.2 ? title + ': A Novel' : title, authors: r() < 0.3 ? [who, any(['F. M. Cornford', 'Allan Bloom'])] : [who], isbn: r() < 0.5 ? isbn : '' }; });
    const lib = S.cleanDoc({ books }), live = S.live(lib);
    const det = S.cleanDetails({ details: { books: Array.from({ length: 1 + Math.floor(r() * 4) }, () => { const [title, who, isbn] = any(SHELF);
      return { id: any(['', 'k' + Math.floor(r() * 10), 'zz']), title, authors: r() < 0.3 ? [who, any(['F. M. Cornford', 'Allan Bloom'])] : [who], isbn: r() < 0.5 ? isbn : '', kind: 'fiction' }; }) } });
    const named = new Set(det.books.map(e => e.id).filter(id => lib.books[id] && !lib.books[id].del));
    S.matchDetails(lib, det).forEach(({ e, bs }) => {
      if (bs.some(b => b.del)) never = false;
      if (named.has(e.id)) { if (bs.length !== 1 || bs[0].id !== e.id) every = false; return; }
      const keys = S.lookupKeys(e), copies = live.filter(b => !named.has(b.id) && S.indexKeys(b).some(x => keys.includes(x)));
      const same = copies.filter(b => S.authorsKey(b) === S.authorsKey(e)), want = copies.length > 1 && same.length ? same : copies;
      if (want.map(b => b.id).sort().join() !== bs.map(b => b.id).sort().join()) every = false;
    });
  }
  check(never, 'details never find a removed book');
  check(every, 'and find every copy they’re for: the book named by id, or each copy with the ISBN or title and author');

  // What to read next, dealt again and again as its sheet does: no book twice in a deal, books not yet shown first,
  // and nothing lent out, being read, read (unless rereads are asked for) or browsed (unless asked for).
  const now = new Date('2026-11-03T12:00:00').getTime();
  let fair = true, why = '';
  for (let k = 0; k < 200 && fair; k++) {
    const lib = S.live(S.cleanDoc({ books: Array.from({ length: Math.floor(r() * 16) }, (_, i) => ({ id: 'n' + i, t: 1, title: 'Book ' + i, authors: [any(['Ann Lee', 'Bo Chen', 'Cy Dee'])],
      status: any(['', '', 'read', 'reading']), rating: any([0, 3, 5]), loan: r() < 0.15 ? { to: 'Sam' } : null, way: any(['', 'browse', 'dip']), pages: any([0, 120, 300, 600]),
      added: any(['2019-03-04', '2026-10-30', '']), kind: any(['', 'fiction', 'nonfiction']), moods: any([[], ['funny'], ['dark', 'tense']]), chapters: any(['', 'short']) })) }));
    const c = S.cleanNext({ reread: r() < 0.3, browse: r() < 0.3, lean: any(['', 'oldest', 'newest', 'loved']), len: any(['', '', 'short', 'long']), kind: any(['', '', 'fiction']), moods: any([[], ['funny']]), short: r() < 0.2 });
    const pool = S.nextPool(lib, c), rnd = rng(9000 + k);
    let seen = {};
    for (let d = 0; d < 6; d++) {
      const deal = S.dealNext(lib, c, rnd, seen, now), ids = deal.picks.map(p => p.b.id);
      const unseen = pool.filter(b => !seen[b.id]).length;
      if (new Set(ids).size !== ids.length) why = 'a book twice in one deal';
      else if (ids.length !== Math.min(3, pool.length)) why = ids.length + ' picks from ' + pool.length;
      else if (deal.fresh !== Math.min(ids.length, unseen) || ids.some((id, i) => !!seen[id] === i < deal.fresh)) why = 'books already shown came before new ones';
      else if (deal.picks.some(({ b }) => b.loan || b.status === 'reading' || b.way === 'browse' && !c.browse || b.status === 'read' && !(c.reread && b.rating >= 4))) why = 'a book that can’t be suggested was';
      if (why) { fair = false; break; }
      if (ids.length && !deal.fresh) seen = {};
      ids.forEach(id => { seen[id] = 1; });
    }
  }
  check(fair, 'what to read next, dealt six times over 200 random libraries, keeps its promises' + (why ? ': ' + why : ''));
  check(Date.now() - t0 < 5000, 'the random checks run quickly (' + (Date.now() - t0) + ' ms)');
}

// ---------- batches and links ----------
(async () => {
  // ---------- reading details ----------
  {
    const b = S.cleanBook({ id: 'r', t: 1, title: 'Dune', kind: 'Fiction', genres: ['Science fiction', 'sf', 'nonsense', 'Classics', 'adventure', 'Fantasy', 'Horror', 'Thriller'],
      moods: 'adventurous, Tense, bogus', pace: 'Medium', chapters: 'huge', way: 'Cover to cover', blurb: '  A desert   planet. ' });
    eq([b.kind, b.genres, b.moods, b.pace, b.chapters, b.way, b.blurb], ['fiction', ['sf', 'classics', 'fantasy', 'horror'], ['adventurous', 'tense'], 'medium', undefined, 'through', 'A desert planet.'],
      'reading details take a value or its label, drop unknown ones, and keep up to four genres');
    const lib = S.cleanDoc({ books: [
      { id: 'a1', t: 5, title: 'Becoming', authors: ['Michelle Obama'], room: 'Den' },
      { id: 'a2', t: 5, title: 'Becoming', authors: ['Michelle Obama'], room: 'Sunroom' },
      { id: 'c1', t: 5, title: 'Dune', authors: ['Frank Herbert'], isbn: '9780441013593', pages: 412, kind: 'fiction', moods: ['tense'] },
      { id: 'gone', t: 6, del: 1 }
    ] });
    const det = S.cleanDetails({ shelfmark: 1, details: { id: 'd1', name: 'Reading details', books: [
      { id: 'a1', title: 'Becoming', authors: ['Michelle Obama'], kind: 'nonfiction', genres: ['biography'], moods: ['inspiring'], pace: 'medium', pages: 448, blurb: 'A former First Lady on growing up and the White House.' },
      { id: 'zzz', title: 'Dune', authors: ['Frank Herbert'], isbn: '0441013597', kind: 'fiction', genres: ['sf'], moods: ['adventurous'], pages: 600 },
      { title: 'Becoming', authors: ['Michelle Obama'], way: 'through' },
      { id: 'gone', title: 'Removed one', kind: 'fiction' },
      { id: 'x', title: 'Unknown Book', authors: ['Nobody'], kind: 'poetry' },
      { id: 'y', title: 'No details at all' }, 'junk'
    ] } });
    eq([det.id, det.name, det.books.length], ['d1', 'Reading details', 5], 'details keep entries that say something and name a book');
    const m = S.matchDetails(lib, det);
    eq(m.map(r => r.bs.map(b => b.id)), [['a1'], ['c1'], ['a2'], [], []], 'an entry finds its book by id, else by ISBN or title and author (every copy another entry doesn’t name by id), and a removed or unknown book by nothing');
    const a1 = S.withDetails(lib.books.a1, m[0].e, false);
    eq([a1.kind, a1.genres, a1.pages, a1.room], ['nonfiction', ['biography'], 448, 'Den'], 'details fill in a book, page count included, and leave the rest alone');
    const dune = S.withDetails(lib.books.c1, m[1].e, false);
    eq([dune.kind, dune.moods, dune.genres, dune.pages], ['fiction', ['tense'], ['sf'], 412], 'only blanks are filled: details already there and the page count stay');
    const dune2 = S.withDetails(lib.books.c1, m[1].e, true);
    eq([dune2.moods, dune2.pages], [['adventurous'], 412], 'replacing swaps in the details, but never the book’s own page count');
    eq(S.withDetails(Object.assign({}, lib.books.c1, { genres: ['sf'] }), m[1].e, false), null, 'nothing new → no change');
    // Entries whose ids aren't in this library (made from another copy of it, or from an older backup) find books by
    // ISBN and by title and author both, and so every copy.
    const matched = (books, entries) => S.matchDetails(S.cleanDoc({ books }), S.cleanDetails({ details: { books: entries } })).map(r => r.bs.map(b => b.id));
    const eliots = [{ id: 'd1', t: 1, title: 'Middlemarch', authors: ['George Eliot'], isbn: '9780141439549' }, { id: 'd2', t: 1, title: 'Middlemarch', authors: ['George Eliot'] }];
    eq(matched(eliots, [{ id: 'old', title: 'Middlemarch', authors: ['George Eliot'], isbn: '9780141439549', kind: 'fiction' }]), [['d1', 'd2']], 'an entry with an ISBN finds the copy without one too');
    eq(matched(eliots, [{ title: 'Middlemarch', authors: ['George Eliot'], kind: 'fiction' }]), [['d1', 'd2']], 'as an entry without one does');
    // Two translations: the same title and first author, but each entry is for one of them.
    const republics = [{ id: 'r1', t: 1, title: 'The Republic', authors: ['Plato', 'F. M. Cornford'], room: 'Den' }, { id: 'r2', t: 1, title: 'The Republic', authors: ['Plato', 'Allan Bloom'], room: 'Study' }];
    const tr = S.cleanDetails({ details: { books: [
      { id: 'x1', title: 'The Republic', authors: ['Plato', 'F.M. Cornford'], blurb: 'Plato’s dialogue on justice, in Cornford’s translation.', pages: 360 },
      { id: 'x2', title: 'The Republic', authors: ['Plato', 'Allan Bloom'], blurb: 'Plato’s dialogue on justice, in Bloom’s literal translation.', pages: 490 }] } });
    const lib2 = S.cleanDoc({ books: republics }), tm = S.matchDetails(lib2, tr);
    eq(tm.map(r => r.bs.map(b => b.id)), [['r1'], ['r2']], 'two translations each get the entry with their own translator');
    const filled = S.detailChanges(lib2, tm, true);
    eq([Object.keys(filled).length, filled.r1.pages, filled.r2.pages, /Bloom/.test(filled.r2.blurb)], [2, 360, 490, true], 'and their own page count and line, even with Replace');
    eq(matched(republics, [{ title: 'The Republic', authors: ['Plato'], kind: 'nonfiction' }]), [['r1', 'r2']], 'an entry naming neither translator is for both');
    // The volumes of a set: an entry for one fills only that one, and one naming the set alone fills every volume.
    const cycle = [{ id: 'l1', t: 1, title: 'The Lantern Cycle: First Light', authors: ['Ada Quill'] }, { id: 'l2', t: 1, title: 'The Lantern Cycle: Second Dark', authors: ['Ada Quill'] },
      { id: 'l3', t: 1, title: 'Annals of Ostrava', sub: 'Volume I', authors: ['Cy Dorn'] }, { id: 'l4', t: 1, title: 'Annals of Ostrava', sub: 'Volume II', authors: ['Cy Dorn'] }];
    eq(matched(cycle, [{ id: 'old', title: 'The Lantern Cycle: Second Dark', authors: ['Ada Quill'], kind: 'fiction' }, { title: 'Annals of Ostrava: Volume I', authors: ['Cy Dorn'], kind: 'nonfiction' },
      { title: 'The Lantern Cycle', authors: ['Ada Quill'], pace: 'slow' }, { id: 'old2', title: 'Annals of Ostrava', sub: 'Volume II', authors: ['Cy Dorn'], kind: 'nonfiction' }]), [['l2'], ['l3'], ['l1', 'l2'], ['l4']],
      'details for one volume of a set fill only that volume, its name in the title or the subtitle, and details for the set fill each');
    eq(matched(republics, [{ id: 'r1', title: 'The Republic', authors: ['Plato', 'F. M. Cornford'], kind: 'nonfiction' }, { title: 'The Republic', authors: ['Plato', 'F. M. Cornford'], kind: 'nonfiction' }]), [['r1'], ['r2']],
      'a copy one entry names by id is left out of another entry’s title match');
    // Two copies, two entries without ids: each entry finds both, and each book counts once.
    const waldens = S.cleanDoc({ books: [{ id: 'a1', t: 1, title: 'Walden', authors: ['Henry David Thoreau'] }, { id: 'a2', t: 1, title: 'Walden', authors: ['Henry David Thoreau'] }] });
    const twice = S.matchDetails(waldens, S.cleanDetails({ details: { books: [{ title: 'Walden', authors: ['Henry David Thoreau'], kind: 'nonfiction', pace: 'medium' }, { title: 'Walden', authors: ['Henry David Thoreau'], kind: 'nonfiction', pace: 'fast' }] } }));
    eq(twice.map(r => r.bs.map(b => b.id)), [['a1', 'a2'], ['a1', 'a2']], 'two entries for a book with two copies find both');
    eq([Object.keys(S.detailChanges(waldens, twice, false)).length, Object.keys(S.detailChanges(waldens, twice, true)).length], [2, 2], 'and change two books, not four');
    eq(S.detailChanges(waldens, twice, false).a1.pace, 'medium', 'filling in, the first entry’s details stay');
    const r = await S.parseIncoming(JSON.stringify({ shelfmark: 1, details: { books: [{ id: 'a1', kind: 'fiction' }] } }));
    eq([r.kind, r.details.books[0]], ['details', { id: 'a1', kind: 'fiction' }], 'a details file opens as details, an id alone being enough');
    let threw = false; try { await S.parseIncoming(JSON.stringify({ shelfmark: 1, details: { books: [{ title: 'x' }] } })); } catch (e) { threw = true; } check(threw, 'details with nothing to add are refused');

    // An older Shelfmark that doesn't know the reading details drops them without changing the time. Its copy mustn't win.
  const full = S.cleanDoc({ books: [{ id: 'o', t: 9, title: 'Dune', kind: 'fiction', moods: ['tense'] }] }), bare = S.cleanDoc({ books: [{ id: 'o', t: 9, title: 'Dune' }] });
  eq([S.mergeDocs(full, bare).books.o.kind, S.mergeDocs(bare, full).books.o.kind], ['fiction', 'fiction'], 'at the same time, the copy with the reading details wins, whichever way round');
  eq(S.mergeDocs(full, S.cleanDoc({ books: [{ id: 'o', t: 10, title: 'Dune' }] })).books.o.kind, undefined, 'but a later edit still wins');

  // What to read next, by reading details.
    const now = new Date('2026-11-02T12:00:00').getTime();
    const shelf = S.live(S.cleanDoc({ books: [
      { id: 'f1', t: 1, title: 'Funny Novel', kind: 'fiction', moods: ['funny', 'lighthearted'], chapters: 'short', pace: 'fast', genres: ['humor'] },
      { id: 'f2', t: 1, title: 'Sad Novel', kind: 'fiction', moods: ['sad', 'reflective'], chapters: 'long', pace: 'slow', genres: ['literary'] },
      { id: 'n1', t: 1, title: 'History Book', kind: 'nonfiction', moods: ['informative', 'reflective'], genres: ['history'], pace: 'slow' },
      { id: 'p1', t: 1, title: 'Poems', kind: 'poetry', moods: ['reflective'], way: 'dip' },
      { id: 'k1', t: 1, title: 'Cookbook', kind: 'nonfiction', genres: ['food'], way: 'browse' },
      { id: 'u1', t: 1, title: 'Not Described' }
    ] }));
    const ids = c => S.nextPool(shelf, S.cleanNext(c)).map(b => b.id).sort();
    eq(ids({}), ['f1', 'f2', 'n1', 'p1', 'u1'], 'books you browse aren’t suggested unless asked for');
    eq(ids({ browse: true }).length, 6, 'and are when asked');
    eq(ids({ kind: 'fiction' }), ['f1', 'f2'], 'fiction or not narrows it');
    eq(ids({ kind: 'poetry' }), ['p1'], 'poetry is a choice of its own');
    eq(ids({ moods: ['funny', 'sad'] }), ['f1', 'f2'], 'moods match any of those picked');
    eq(ids({ short: true }), ['f1', 'p1'], 'short chapters, or a book to dip into');
    eq(ids({ genre: 'history', pace: 'slow' }), ['n1'], 'genre and pace narrow it too');
    // Moods and genres offered follow the kind chosen, and whether books you browse are in, keeping one already chosen.
    const offered = c => { const o = S.nextOffers(shelf, S.cleanNext(c)); return [Object.keys(o.fit.moods).sort(), Object.keys(o.fit.genres).sort()]; };
    eq(offered({ kind: 'poetry' }), [['reflective'], []], 'with poetry chosen, only the moods and genres of poems on hand');
    eq(offered({ kind: 'nonfiction' }), [['informative', 'reflective'], ['history']], 'a cookbook’s genre waits until books you browse are in');
    eq(offered({ kind: 'nonfiction', browse: true }), [['informative', 'reflective'], ['food', 'history']], 'and then it’s offered');
    eq(offered({ kind: 'poetry', moods: ['funny'], genre: 'humor' }), [['funny', 'reflective'], ['humor']], 'a mood or genre already chosen stays, to be taken off');
    const reflective = {}; for (let k = 0; k < 400; k++) { const id = S.dealNext(shelf, S.cleanNext({ moods: ['reflective', 'sad'] }), rng(500 + k), {}, now).picks[0].b.id; reflective[id] = (reflective[id] || 0) + 1; }
    check(reflective.f2 > reflective.n1 && reflective.f2 > reflective.p1, 'a book with more of the moods picked comes up more ' + JSON.stringify(reflective));
    const picky = S.dealNext(shelf, S.cleanNext({ kind: 'fiction' }), rng(1), {}, now);
    eq([picky.bare, picky.browsed], [1, 1], 'it counts books without details that a choice leaves out, and books you browse');
    eq(S.dealNext(shelf, S.cleanNext({}), rng(1), {}, now).bare, 0, 'with no details chosen, books without them still come up');
    check(S.KINDS.length === 3 && S.MOODS.length === 14, 'the lists are there for the script to match');

    // The notes under a pick say what was left out and why: books without a chosen detail, without a page count, and
    // books you browse that would match.
    const honest = S.live(S.cleanDoc({ books: [
      { id: 'f1', t: 1, title: 'F1', kind: 'fiction', moods: ['funny'], pace: 'fast', chapters: 'short', genres: ['humor'], pages: 200 },
      { id: 'f2', t: 1, title: 'F2', kind: 'fiction', moods: ['sad'], pace: 'slow', chapters: 'long', genres: ['literary'], pages: 500 },
      { id: 'f3', t: 1, title: 'F3', kind: 'fiction', moods: ['tense'], pace: 'fast', genres: ['thriller'] },
      { id: 'f4', t: 1, title: 'F4', kind: 'fiction', moods: ['reflective'], genres: ['literary'], pages: 300 },
      { id: 'f5', t: 1, title: 'F5', kind: 'fiction', moods: ['dark'] },
      { id: 'n1', t: 1, title: 'N1', kind: 'nonfiction', genres: ['food'], moods: ['informative'], pace: 'slow', pages: 240 },
      { id: 'u1', t: 1, title: 'U1', pages: 150 }, { id: 'u2', t: 1, title: 'U2' },
      ...['k1', 'k2', 'k3'].map(id => ({ id, t: 1, title: id, kind: 'nonfiction', genres: ['food'], way: 'browse' }))
    ] }));
    const notes = (c, lib = honest) => S.nextNotes(S.dealNext(lib, S.cleanNext(c), rng(1), {}, now), S.cleanNext(c), false).join(' ');
    eq(notes({ pace: 'fast' }), 'From 2 unread books that match. 4 books with no pace yet are left out.', 'a pace chosen counts the books with no pace, not only those with no details at all');
    eq(notes({ kind: 'fiction' }), 'From 5 unread books that match. 2 books without reading details are left out.', 'books with no details at all are called that');
    eq(notes({ genre: 'food' }), 'From 1 unread book that matches. 3 books with no genre yet are left out. 3 books you browse match too: tick Include books you browse under More choices.',
      'books you browse that would match are counted, with how to include them');
    eq(notes({ genre: 'food', browse: true }), 'From 4 unread books that match. 3 books with no genre yet are left out.', 'and aren’t once they’re included');
    eq(notes({ len: 'short' }), 'From 3 unread books that match. 3 books have no page count, so they only come up under Any length.', 'a length chosen says how many books have no page count, though some match');
    eq(notes({ kind: 'fiction', short: true }), 'From 1 unread book that matches. 5 books not yet marked fiction, nonfiction or poetry, or with no chapter length yet, are left out.', 'two details missing are both named');
    eq(notes({ kind: 'poetry' }), '2 books without reading details are left out. Try fewer of them.', 'when the choices themselves rule out every book that has the details, it says to try fewer');
    eq(notes({ pace: 'fast' }, honest.filter(b => ['f5', 'u1', 'u2'].includes(b.id))), '3 books with no pace yet are left out.', 'but not when only missing details leave nothing');
    eq(notes({ len: 'long', room: 'Nowhere' }), 'Try fewer of them.', 'nothing left out for want of details: just try fewer');
    eq(S.nextNotes(S.dealNext(honest, S.cleanNext({}), rng(1), {}, now), S.cleanNext({}), true), ['From 8 unread books on hand.', 'Going round again: you’ve seen all 8.'], 'a repeat round says so');
  }

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

  // A room or shelf is saved as the library already spells it, whatever the capitals or apostrophes it was typed with
  // (each new chat with Claude starts afresh, and a room typed by hand can differ from Claude's), the most used
  // spelling if there are several; a new place is kept as typed, with its spaces tidied.
  eq(S.place(' Living  Room ', { 'Living room': 3 }), 'Living room', 'a room typed with other capitals is saved as the library spells it');
  eq(S.place('living room', { 'Living room': 1, 'Living Room': 4, Den: 9 }), 'Living Room', 'the spelling most books use wins');
  eq([S.place('LIVING ROOM', { 'Living room': 2, 'Living Room': 2 }), S.place('LIVING ROOM', { 'Living Room': 2, 'Living room': 2 })], ['Living Room', 'Living Room'], 'a tie goes the same way whatever the order');
  eq([S.place('cafe', { 'Café': 2 }), S.place('Kid’s room', { "Kid's room": 2 }), S.place('Den', { 'Living room': 3 }), S.place('  Sun   room ', {}), S.place('', { Den: 1 })],
    ['Café', "Kid's room", 'Den', 'Sun room', ''], 'accents and apostrophes don\'t make a new place either, and a new one is kept as typed');
  {
    const ix = S.placeIndex([{ room: 'Bedroom', shelf: 'Top shelf' }, { room: 'Hall', shelf: 'Top Shelf' }, { room: 'Hall', shelf: 'Top Shelf' }, { room: 'hall', shelf: 'top shelf' }, { shelf: 'Loose' }]);
    const at = b => { const x = S.placed(Object.assign({}, b), ix); return [x.room || '', x.shelf || ''].join(' > '); };
    eq([at({ room: 'HALL', shelf: 'top shelf' }), at({ room: 'Bedroom', shelf: 'TOP SHELF' }), at({ room: 'Attic', shelf: 'top shelf' }), at({ shelf: 'loose' }), at({ room: 'hall' })],
      ['Hall > Top Shelf', 'Bedroom > Top shelf', 'Attic > top shelf', ' > Loose', 'Hall > '], 'a shelf takes the spelling of a shelf in the same room only');
  }
  // Books saved before with another spelling sort together, so the list shows them as one shelf.
  {
    const b = (id, room, shelf, a) => S.cleanBook({ id, t: 1, title: 'T' + id, authors: [a], room, shelf });
    const lib = [b('o1', 'Living room', 'Left bookcase', 'Zola'), b('o2', 'Living Room', 'Left Bookcase', 'Austen'), b('o3', 'Living room', 'Left bookcase', 'Eliot'),
      b('o4', 'living room', 'Desk', 'Woolf'), b('o5', 'Kid’s room', 'Low', 'Dahl'), b('o6', "Kid's room", 'low', 'Alcott'), b('o7', 'Den', '', 'Hardy')];
    eq(lib.slice().sort(S.shelfOrder).map(x => x.id), ['o7', 'o6', 'o5', 'o4', 'o2', 'o3', 'o1'], 'shelf order puts a place\'s spellings together, by author within it');
    const shelf = lib.map(x => Object.assign({}, x, { id: x.id }));
    eq(S.nextPool(shelf, S.cleanNext({ room: 'LIVING ROOM' })).map(x => x.id).sort(), ['o1', 'o2', 'o3', 'o4'], 'What to read next\'s room takes in every spelling of it');
    eq(Object.keys(S.nextOffers(shelf).rooms).sort(), ['Den', "Kid's room", 'Living room'], 'and offers each room once, as most books spell it');
    eq(S.fitNext(S.cleanNext({ room: 'living ROOM' }), S.nextOffers(shelf)).room, 'Living room', 'a room chosen before in other capitals stays chosen');
  }

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
  // Claude's whole reply pasted, as a phone copies a message: the JSON in a code block, with words around it.
  const said = async t => { try { const r = await S.parseIncoming(t); return r.kind === 'details' ? 'details: ' + r.details.books.map(b => b.title).join(', ') : r.batch.books.map(b => b.title).join(', '); } catch (e) { return 'refused'; } };
  const det = JSON.stringify({ shelfmark: 1, details: { books: [{ id: 'b1', title: 'Walden', kind: 'nonfiction' }] } }, null, 1);
  const pretty = JSON.stringify(JSON.parse(json), null, 2);
  for (const [text, want, what] of [
    ['```json\n' + pretty + '\n```', 'Cien años de soledad', 'JSON in a ```json code block'],
    ['```\n' + pretty + '\n```', 'Cien años de soledad', 'JSON in a plain code block'],
    ['Here are the 3 books from your hall shelf:\n\n```json\r\n' + pretty + '\r\n```\n\nPaste this into Shelfmark (Import › paste box).', 'Cien años de soledad', 'a line before the code block and one after'],
    ['Here you go: ' + json, 'Cien años de soledad', '"Here you go:" and the JSON'],
    ['Here you go: ' + json + ' Let me know if any are wrong.', 'Cien años de soledad', 'and with words after it too'],
    ['The books: [{"title": "Walden"}, {"title": "Emma"}]', 'Walden, Emma', 'a bare list of books after a line of text'],
    ['Reading details for your library:\n```json\n' + det + '\n```', 'details: Walden', 'reading details in a code block'],
    ['Sorry, I can’t read {the spine} on the left, or [the one] beside it.', 'refused', 'words with braces in them, and no books'],
    ['```json\n{"books": [{"title": "Unfinished"\n```', 'refused', 'a code block cut short'],
  ]) eq(await said(text), want, 'a pasted reply opens: ' + what);
  let threw = false; try { await S.parseIncoming('{"books": []}'); } catch (e) { threw = true; } check(threw, 'an empty batch is refused');
  threw = false; try { await S.parseIncoming('hello'); } catch (e) { threw = true; } check(threw, 'plain text is refused');
  // A spreadsheet export can't be read here; it's refused with a word on what to do instead.
  const sheetSaid = async t => { try { await S.parseIncoming(t); return 'opened'; } catch (e) { return e.say ? e.message : 'refused'; } };
  const hint = 'That’s a spreadsheet export. Send it to Claude with the Shelfmark skill and open the file or link it gives you.';
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

      // The script reads numbers, yes/no and lists the way the page does: each book it writes is the page's own reading
      // of the same input.
      const odd = [
        { title: 'Two Authors', authors: 'Neil Gaiman, Terry Pratchett', pages: '1,024', rating: 4.5, tags: 'classics; fantasy', signed: 'yes', first: 'no' },
        { title: 'Reprint', authors: 'Ann Lee and Bo Chen', year: '2nd ed. 1999', pages: '2 vols, 880', rating: 2.5, signed: 'false', first: 1, moods: 'funny; tense', genres: 'History; Science' },
        { title: 'Copyright Line', authors: 'Kurt Vonnegut, Jr. & Ann Lee', year: '©1951, 1979', rating: '3.5', signed: 1, first: 'TRUE', tags: ['a'.repeat(45), 'Arts & crafts'], pages: 312.5 },
        { title: 'Range', authors: ['Leo Tolstoy'], year: '1865–69', pages: '1 225', rating: '4 stars', signed: 0, first: 'No', tags: 'war, Russia; War' },
      ];
      const sorted = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
      const oddIn = path.join(tmp, 'odd.json'), oddDir = fs.mkdtempSync(path.join(tmp, 'odd-'));
      fs.writeFileSync(oddIn, JSON.stringify({ books: odd }));
      const oddSaid = execFileSync('python3', [py, oddIn, '--out', oddDir, '--no-link'], { encoding: 'utf8' });
      const oddOut = JSON.parse(fs.readFileSync(path.join(oddDir, fs.readdirSync(oddDir)[0]), 'utf8')).batch.books;
      odd.forEach((x, i) => { const c = S.cleanBook(Object.assign({}, x, { id: 'n', t: 0 })); delete c.id; delete c.t; eq(sorted(oddOut[i]), sorted(c), 'the script reads “' + x.title + '” as the page does'); });
      check(!/isn’t one Shelfmark knows/.test(oddSaid), 'moods and genres split on semicolons are known words to the script');
      // And cuts text at the same place: in UTF-16 units, as the page counts, never inside an emoji, and with no space left.
      const edge = [{ title: 'a'.repeat(299) + ' b', authors: ['X', '', 'Jr'], notes: 'n'.repeat(3999) + '\n\nb', tags: ['constructor', 'b'.repeat(39) + ' c'] },
        { title: 'a'.repeat(298) + '😀😀', authors: 'Kurt Vonnegut, , Jr.', notes: 42, shelf: '\ufeffTop\ufeff' }, { title: '\ufeff' }, { title: 'T', authors: ['é'.repeat(119) + '😀'] }];
      const edgeIn = path.join(tmp, 'edge.json'), edgeDir = fs.mkdtempSync(path.join(tmp, 'edge-'));
      fs.writeFileSync(edgeIn, JSON.stringify({ books: edge }));
      execFileSync('python3', [py, edgeIn, '--out', edgeDir, '--no-link'], { encoding: 'utf8' });
      const edgeOut = JSON.parse(fs.readFileSync(path.join(edgeDir, fs.readdirSync(edgeDir)[0]), 'utf8')).batch.books;
      const edgePage = edge.map(x => S.cleanBook(Object.assign({}, x, { id: 'n', t: 0 }))).filter(Boolean).map(c => { delete c.id; delete c.t; return sorted(c); });
      eq(edgeOut.map(sorted), edgePage, 'the script cuts and splits text where the page does');
      const oddDet = path.join(tmp, 'odd-details.json');
      fs.writeFileSync(oddDet, JSON.stringify({ books: [{ id: 'b1', title: 'Reprint', sub: ' Volume  II ', authors: 'Ann Lee, Bo Chen', moods: 'funny; tense', genres: 'History; Science', pages: '1,024' }] }));
      const oddDetOut = JSON.parse(fs.readFileSync(/File: (\S+)/.exec(execFileSync('python3', [py, oddDet, '--details', '--out', oddDir, '--no-link'], { encoding: 'utf8' }))[1], 'utf8')).details.books;
      // The script finds the same book twice where the page does: it files and looks for each book under the same keys.
      const pairs = [
        { title: 'The Lantern Cycle: First Light', authors: ['Ada Quill'] }, { title: 'The Lantern Cycle', sub: 'Second Dark', authors: ['Ada Quill'] },
        { title: 'Tidewater: Volume Four', authors: ['Ben Marsh'] }, { title: 'Annals of Ostrava', sub: 'Volume II: The Wars', authors: ['Cy Dorn'] },
        { title: 'The Hobbit: or There and Back Again', authors: ['J. R. R. Tolkien'], isbn: '0-261-10221-4' }, { title: 'A Hobbit', authors: 'J.R.R. Tolkien' },
        { title: 'A Made-Up Novel', authors: ['Otto Pell, Jr.'] }, { title: 'An Invented Shore', authors: ['Nina van der Berg'] },
        { title: 'Les Misérables: Fantine', authors: ['Victor Hugo'] }, { title: 'Les Miserables', sub: 'Cosette', authors: ['Victor Hugo'] },
        { title: 'Война и мир', authors: ['Лев Толстой'] }, { title: 'Анна Каренина: Часть 1', authors: ['Лев Толстой'] }, { title: '红楼梦', authors: ['曹雪芹'] },
        { title: '  An   Odd: Title, 2nd ed. ', sub: 'Ignored', authors: ['Ann Lee, PhD'] }, { title: 'Ivanhoe', authors: ['Sir Walter Scott, III'] },
        { title: 'Smørrebrød & Co.: 1001 Recipes', authors: ['Kari Ødegård'], isbn: '9780140449137' }, { title: 'De Profundis', authors: ['Hal de Vries'] }, { title: 'Untitled' }
      ];
      const pairsIn = path.join(tmp, 'pairs.json');
      fs.writeFileSync(pairsIn, JSON.stringify(pairs));
      const pyKeys = JSON.parse(execFileSync('python3', ['-c', 'import json, sys, importlib.util as u\ns = u.spec_from_file_location("m", sys.argv[1]); m = u.module_from_spec(s); s.loader.exec_module(m)\n' +
        'print(json.dumps([m.keys(m.clean(b, i, [])) for i, b in enumerate(json.load(open(sys.argv[2], encoding="utf-8")))]))', py, pairsIn], { encoding: 'utf8' }));
      eq(pyKeys, pairs.map(b => { const c = S.cleanBook(Object.assign({ id: 'n' }, b)); return [S.indexKeys(c), S.lookupKeys(c)]; }), 'the script files and looks for each book under the keys the page does');
      // So it no longer warns of doubles for the volumes of a set, and still does for a book read twice.
      const volsIn = path.join(tmp, 'vols.json'), volsDir = fs.mkdtempSync(path.join(tmp, 'vols-'));
      fs.writeFileSync(volsIn, JSON.stringify({ books: [{ title: 'The Lantern Cycle: First Light', authors: ['Ada Quill'] }, { title: 'The Lantern Cycle: Second Dark', authors: ['Ada Quill'] },
        { title: 'Annals of Ostrava', sub: 'Volume I', authors: ['Cy Dorn'] }, { title: 'Annals of Ostrava', sub: 'Volume II', authors: ['Cy Dorn'] }, { title: 'Tidewater: Volume One', authors: ['Ben Marsh'] },
        { title: 'Tidewater: Volume Two', authors: ['Ben Marsh'] }, { title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Middlemarch: A Study of Provincial Life', authors: ['George Eliot'] }] }));
      const volsSaid = execFileSync('python3', [py, volsIn, '--out', volsDir, '--no-link'], { encoding: 'utf8' });
      eq(volsSaid.match(/“[^”]*” appears twice/g), ['“Middlemarch: A Study of Provincial Life” appears twice'], 'the script warns of a book read twice, and not of the volumes of a set');
      eq(oddDetOut.map(sorted), S.cleanDetails({ details: { books: [{ id: 'b1', title: 'Reprint', sub: ' Volume  II ', authors: 'Ann Lee, Bo Chen', moods: 'funny; tense', genres: 'History; Science', pages: '1,024' }] } }).books.map(sorted), 'and its reading details as the page does');

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

      // Reading details: the script and the page know the same words, and its details link opens in the page.
      const pyList = n => JSON.parse(('[' + new RegExp('^' + n + ' = \\[([^\\]]*)\\]', 'm').exec(fs.readFileSync(py, 'utf8'))[1] + ']').replace(/'/g, '"').replace(/\s+/g, ' '));
      for (const [n, list] of Object.entries({ KINDS: S.KINDS, WAYS: S.WAYS, PACES: S.PACES, CHAPTERS: S.CHAPTERS, MOODS: S.MOODS, GENRES: S.GENRES }))
        eq(pyList(n), list.map(x => x[0]), 'the script’s ' + n + ' match the page’s');
      const detIn = path.join(tmp, 'details.json');
      fs.writeFileSync(detIn, JSON.stringify({ name: 'Reading details', books: [
        { id: 'b1', title: 'Dune', authors: ['Frank Herbert'], kind: 'Fiction', genres: ['science fiction', 'classics'], moods: ['adventurous', 'bogus'], pace: 'medium', chapters: 'medium', way: 'cover to cover', blurb: 'Spice, sand and a prophecy.', pages: 612 },
        { id: 'b2', title: 'Salt Fat Acid Heat', kind: 'nonfiction', genres: 'cooking', way: 'browse', chapters: 'short' },
        { title: 'Nothing to say' }
      ] }));
      const detSaid = execFileSync('python3', [py, detIn, '--details', '--out', tmp], { encoding: 'utf8' });
      const detGot = await S.parseIncoming(/Link: (\S+)/.exec(detSaid)[1]);
      eq(detGot.kind, 'details', 'the script’s details link opens as reading details');
      eq(detGot.details.books, [
        { id: 'b1', title: 'Dune', authors: ['Frank Herbert'], pages: 612, kind: 'fiction', genres: ['sf', 'classics'], moods: ['adventurous'], pace: 'medium', chapters: 'medium', way: 'through', blurb: 'Spice, sand and a prophecy.' },
        { id: 'b2', title: 'Salt Fat Acid Heat', kind: 'nonfiction', genres: ['food'], way: 'browse' }
      ], 'every detail comes through, with words mapped onto Shelfmark’s');
      check(/mood “bogus” isn’t one Shelfmark knows/.test(detSaid) && /“Nothing to say”: no reading details, left out/.test(detSaid), 'and the script says what it left off');
      check(/“Salt Fat Acid Heat”: chapters left off, since it’s a book to browse/.test(detSaid), 'including chapters for a book to browse, which SKILL.md says to leave out');
      const withDet = execFileSync('python3', [py, detIn, '--out', tmp, '--no-link'], { encoding: 'utf8' });
      const newBooks = (await S.parseIncoming(fs.readFileSync(path.join(tmp, fs.readdirSync(tmp).find(f => /^reading-details-\d{4}-\d\d-\d\d\.shelfmark\.json$/.test(f))), 'utf8'))).batch.books;
      eq([newBooks[0].genres, newBooks[1].way], [['sf', 'classics'], 'browse'], 'a batch of new books carries reading details too');
      check(/Reading details: 3 books/.test(withDet), 'as an ordinary batch');
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
  // OWASP's CSV Injection page (community.owasp.org/attacks/CSV_Injection) lists = + - @, tab, carriage return and line
  // feed, and their full-width forms, as the starts of a cell to defuse.
  eq(['- signed on the title page', '-2+3', '-5.5', '＝1+1', '＋1', '－1', '＠SUM(A1)', '\nx', '\tx', '@x'].map(S.csvCell),
    ["'- signed on the title page", "'-2+3", '-5.5', "'＝1+1", "'＋1", "'－1", "'＠SUM(A1)", '"\'\nx"', "'\tx", "'@x"], 'a cell starting with a dash, a line break or a full-width = + - @ is defused too, a plain number isn’t');

  console.log(failed ? `\n${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
