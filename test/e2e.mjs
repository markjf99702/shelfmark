// Uses Shelfmark in Chromium through the real page:  node test/e2e.mjs [part of a step name]  (needs Playwright)
// Opens a link made by the cataloger skill's script, adds the books, edits one, and checks that it all survives a
// reload and a reload with the network off, at phone size, with nothing scrolling sideways.
// Nothing here reaches the internet: every request that leaves the page's own server is refused.
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { fakeGoogle } from './fake-google.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1280, height: 800 } };
const browser = await pw.chromium.launch();
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await wait(200); }
  throw new Error('gave up waiting for ' + what);
}

async function context(opts = PHONE) {
  const ctx = await browser.newContext(opts);
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  return ctx;
}
// A page with its errors collected in page.problems. Failed loads of refused outside requests and of anything
// while offline are expected; any other error, or a failed load from the site itself, is a problem.
async function open(ctx, url = base) {
  const page = await ctx.newPage();
  page.problems = []; page.outside = [];
  page.on('request', r => { if (!r.url().startsWith(base)) page.outside.push(r.url()); });
  page.on('pageerror', e => page.problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR_(FAILED|INTERNET_DISCONNECTED)/.test(m.text())) page.problems.push(m.text()); });
  await page.goto(url);
  return page;
}
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('shelfmark.library') || 'null'));
const storedBook = async (page, id) => ((await stored(page)) || { library: { books: {} } }).library.books[id];
const titles = page => page.$$eval('#list .bk .bk-t', els => els.map(e => e.firstChild.textContent));
const sheetOpen = page => page.evaluate(() => !document.getElementById('sheet').hidden);
async function seed(page, books) {
  await page.evaluate(lib => localStorage.setItem('shelfmark.library', lib), JSON.stringify({ shelfmark: 1, library: { books: Object.fromEntries(books.map(b => [b.id, b])), seen: {} } }));
  await page.reload();
}
// A link to a batch, made by the skill's own script when python3 is here (so its links are known to open),
// otherwise the same way in Node.
function linkTo(batch) {
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'shelfmark-e2e-'));
    try {
      writeFileSync(join(tmp, 'in.json'), JSON.stringify(batch));
      const out = execFileSync('python3', [join(root, 'skill/shelfmark-cataloger/scripts/make_shelfmark.py'), join(tmp, 'in.json'), '--out', tmp, '--base', base], { encoding: 'utf8' });
      return /Link: (\S+)/.exec(out)[1];
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return base + '#s1z' + deflateRawSync(Buffer.from(JSON.stringify({ shelfmark: 1, batch: { id: 'e2e', ...batch } }))).toString('base64url');
  }
}

// Open Library, faked: every search finds a work whose cover id counts up from 1001. Searches after the first
// take `slow` ms to answer, to have lookups on their way at a chosen moment.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function fakeOpenLibrary(ctx, slow = 0) {
  const ol = { searches: 0 };
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await ctx.route('https://openlibrary.org/**', async r => {
    const u = new URL(r.request().url());
    try {
      if (u.pathname !== '/search.json') return await r.fulfill({ contentType: 'application/json', headers: cors, body: '{"entries":[]}' });
      const n = ++ol.searches;
      if (n > 1 && slow) await wait(slow);
      await r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ docs: [{ key: '/works/OL' + (1000 + n) + 'W', title: u.searchParams.get('title') || 'x', cover_i: 1000 + n }] }) });
    } catch { /* the test closed the page first */ }
  });
  await ctx.route('https://covers.openlibrary.org/**', r => r.fulfill({ contentType: 'image/png', body: PIXEL }).catch(() => {}));
  return ol;
}

const PIRANESI = { id: 'b03', t: 1000, title: 'Piranesi', authors: ['Susanna Clarke'], notes: 'Sam says start here', added: '2026-10-01', room: 'Hall' };
const MIDDLEMARCH = { id: 'b04', t: 1000, title: 'Middlemarch', authors: ['George Eliot'], added: '2026-10-01', room: 'Den' };
const CRADLE = { id: 'b05', t: 1000, title: 'Cat\u2019s Cradle', authors: ['Kurt Vonnegut, Jr.'], tags: ['Arts & crafts', 'sf'], added: '2026-10-01' };

const steps = [];
const step = (name, fn) => steps.push([name, fn]);

step('a link from the skill adds its books, and an edit survives a reload and going offline', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    assert.match(await page.textContent('#list'), /Your shelves are empty/);
    await page.goto(linkTo({ name: 'Hall shelf', room: 'Hall', books: [
      { title: 'Middlemarch', authors: ['George Eliot'], isbn: '0-14-143954-8', shelf: 'Top' },
      { title: 'Piranesi', authors: ['Susanna Clarke'], unsure: 'glare on the spine' },
      { title: 'Cien años de soledad', authors: ['Gabriel García Márquez'] },
    ] }));
    await page.waitForSelector('#rv-add');
    assert.match(await page.textContent('.lede'), /Hall shelf · 3 books · 1 to check/);
    assert.equal(await page.evaluate(() => location.hash), '', 'the batch is taken off the address once it is open');
    await page.click('#rv-add');
    assert.equal(await sheetOpen(page), false);
    assert.match(await page.textContent('#toastTx'), /Added 3 books/);
    assert.deepEqual((await titles(page)).sort(), ['Cien años de soledad', 'Middlemarch', 'Piranesi']);

    // Mark one read, with a rating and a note.
    const row = page.locator('#list .bk', { hasText: 'Middlemarch' });
    const id = await row.getAttribute('data-id');
    await row.click();
    await page.click('#f-status button[data-v="read"]');
    await page.click('#f-rating button[data-v="4"]');
    await page.fill('#f-notes', 'Dorothea!');
    await page.click('#bkx2');
    assert.equal(await sheetOpen(page), false);
    const b = await storedBook(page, id);
    assert.deepEqual([b.title, b.isbn, b.room, b.shelf, b.status, b.rating, b.notes], ['Middlemarch', '9780141439549', 'Hall', 'Top', 'read', 4, 'Dorothea!']);

    await page.reload();
    assert.match(await page.textContent(`#list .bk[data-id="${id}"]`), /Read/, 'the edit is there after a reload');
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '') + ' ' + f.style); });
    for (const f of ['Newsreader normal', 'Newsreader italic', 'IBM Plex Mono normal']) assert.ok(fonts.includes(f), f + ' didn\'t load; loaded: ' + fonts);

    // Fits a phone: nothing scrolls sideways.
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

    // Works offline once it has been opened.
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 });
    await ctx.setOffline(true);
    await page.reload();
    assert.equal((await titles(page)).length, 3, 'the library shows offline');
    assert.match(await page.textContent(`#list .bk[data-id="${id}"]`), /Read/);
    await ctx.setOffline(false);
    assert.deepEqual(page.problems, []);
    assert.deepEqual(page.outside, [], 'nothing should load from anywhere else');
  } finally { await ctx.close(); }
});

step('the pictures the README shows are all here', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const pictures = [...readme.matchAll(/<img src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(pictures.length >= 2, 'the README shows no screenshots');
  for (const f of pictures) assert.equal((await fetch(base + f)).status, 200, f + ' is missing');
});

step('every file the service worker keeps for offline is there', async () => {
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const shell = eval('[' + /const SHELL = \[([^\]]*)\]/.exec(sw)[1] + ']');
  assert.ok(shell.length > 4);
  for (const f of shell) assert.equal((await fetch(base + f)).status, 200, f + ' is missing');
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const used = [...html.matchAll(/url\((fonts\/[^)]+)\)/g)].map(m => m[1]);
  assert.deepEqual(used.filter(f => !shell.includes(f)), [], 'a font the page uses isn\'t kept for offline');
});

step('the header buttons have names on a phone, where they show only icons', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    for (const [id, name] of [['importBtn', 'Import'], ['setBtn', 'Settings'], ['addBtn', 'Add a book']]) {
      assert.equal(await page.locator('#' + id).isVisible(), true);
      assert.equal(await page.getByRole('button', { name, exact: true }).getAttribute('id'), id, '#' + id + ' has no name on a phone');
    }
  } finally { await ctx.close(); }
});

step('the keyboard stays in an open sheet, and comes back to the book after', async () => {
  const ctx = await context(DESK);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    await page.focus('#list .bk[data-id="b03"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#f-title');
    const outside = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const at = await page.evaluate(() => { const a = document.activeElement; return a === document.body || a.closest('#sheet') ? '' : a.id || a.className || a.tagName; });
      if (at) outside.push(at);
    }
    assert.deepEqual(outside, [], 'Tab reached the page behind the sheet');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'b03');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a room typed on the review screen keeps the shelf Claude gave each book', async () => {
  const ctx = await context();
  try {
    // A whole bookcase in one photo, room not known: a shelf for each book and none for the batch.
    const page = await open(ctx, linkTo({ name: 'Bookcase by the window', books: [
      { title: 'Middlemarch', authors: ['George Eliot'], shelf: 'Shelf 1 from top' },
      { title: 'Gilead', authors: ['Marilynne Robinson'], shelf: 'Shelf 2 from top' },
    ] }));
    await page.waitForSelector('#rv-add');
    assert.match(await page.textContent('#rv-bulknote'), /Leave blank to keep what each book says/);
    await page.fill('#rv-room', 'Living room');
    await page.click('#rv-add');
    const lib = await stored(page);
    assert.deepEqual(Object.values(lib.library.books).map(b => b.title + ' @ ' + b.room + ' > ' + b.shelf).sort(),
      ['Gilead @ Living room > Shelf 2 from top', 'Middlemarch @ Living room > Shelf 1 from top']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a link cut short says so, and a hand-written link with a % opens', async () => {
  const ctx = await context();
  try {
    const link = linkTo({ name: 'Den', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Gilead', authors: ['Marilynne Robinson'] }] });
    const data = link.split('#s1z')[1];
    let n = data.length - 6; while (n % 4 !== 1) n--; // the length atob refuses outright
    const page = await open(ctx, base + '#s1z' + data.slice(0, n));
    await until(() => page.evaluate(() => document.getElementById('toast').classList.contains('show')), 'a message');
    assert.match(await page.textContent('#toastTx'), /doesn’t look like books from Claude/);
    assert.equal(await sheetOpen(page), false);
    await page.goto(base + '#batch={"books":[{"title":"100% Fun"}]}');
    await page.waitForSelector('#rv-add');
    assert.equal(await page.inputValue('#rv input[data-f="title"]'), '100% Fun');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a link pasted into Import with a full stop after it opens', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await page.click('#importBtn');
    await page.fill('#impaste', 'Here are your books: ' + linkTo({ name: 'Den', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }] }) + '.');
    await page.click('#imgo');
    await page.waitForSelector('#rv-add');
    assert.equal(await page.inputValue('#rv input[data-f="title"]'), 'Middlemarch');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('search finds a book by the ISBN printed on it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH, { id: 'b06', t: 1000, title: 'The Hobbit', authors: ['J. R. R. Tolkien'], isbn: '9780261102217' }]);
    for (const q of ['978-0-261-10221-7', '0261102214']) {
      await page.fill('#q', q);
      await until(async () => (await titles(page)).length === 1, 'the search');
      assert.deepEqual(await titles(page), ['The Hobbit'], q);
    }
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('the privacy page links lead somewhere else', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx, base + 'privacy.html');
    const self = page.url();
    const links = await page.$$eval('main a[href]', as => as.map(a => [a.textContent, a.href]));
    assert.ok(links.length > 4);
    assert.deepEqual(links.filter(([, href]) => href.split('#')[0] === self), [], 'a link on the privacy page goes to the privacy page');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('erasing this device\'s copy leaves no list of the books behind', async () => {
  const ctx = await context();
  await fakeOpenLibrary(ctx, 2500);
  try {
    const page = await open(ctx);
    await page.evaluate(() => localStorage.setItem('shelfmark.prefs', JSON.stringify({ sort: 'shelf', lookups: true, next: { lean: 'oldest', room: 'Hall', tag: 'sf' } })));
    await seed(page, [PIRANESI, MIDDLEMARCH, CRADLE]);
    await until(() => page.evaluate(() => localStorage.getItem('shelfmark.covers')), 'the first cover to be kept');
    await page.click('#setBtn');
    await page.click('#stErase');
    await page.click('#stErase');
    await wait(3500); // the other two lookups answer meanwhile
    assert.match(await page.textContent('#list'), /Your shelves are empty/);
    const left = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
    assert.deepEqual(Object.keys(left).filter(k => /^shelfmark\.(library|covers)$/.test(k)), [], 'the library or the covers found are still here');
    assert.deepEqual(JSON.parse(left['shelfmark.prefs']), { sort: 'shelf', lookups: true }, 'only this device\'s settings are kept');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});


step('a tag typed with an & in it stays one tag', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [MIDDLEMARCH]);
    await page.click('#list .bk[data-id="b04"]');
    await page.fill('#f-tags', 'Arts & crafts, classics');
    await page.click('#bkx2');
    assert.deepEqual((await storedBook(page, 'b04')).tags, ['Arts & crafts', 'classics']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('an author typed with a "Jr." stays one author', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await page.click('#addBtn');
    await page.fill('#f-title', 'Why We Can’t Wait');
    await page.fill('#f-authors', 'Martin Luther King, Jr.');
    await page.click('#f-add');
    const lib = await stored(page);
    assert.deepEqual(Object.values(lib.library.books).map(b => b.authors), [['Martin Luther King, Jr.']]);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('typing in a card is kept when the page closes straight after', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await page.click('#list .bk[data-id="b03"]');
    await page.fill('#f-notes', 'Typed just now');
    await page.reload();
    assert.equal((await storedBook(page, 'b03')).notes, 'Typed just now');
    // and when the tab is hidden (switching apps on a phone)
    await page.click('#list .bk[data-id="b03"]');
    await page.fill('#f-shelf', 'By the door');
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal((await storedBook(page, 'b03')).shelf, 'By the door');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a card left open while another tab changes the book keeps that change', async () => {
  const ctx = await context(DESK);
  try {
    const a = await open(ctx);
    await seed(a, [PIRANESI, MIDDLEMARCH, CRADLE]);
    // Opening a card and closing it untouched writes nothing, even for a book whose fields would read back
    // differently from the form.
    await a.click('#list .bk[data-id="b05"]');
    await a.click('#bkx2');
    assert.deepEqual(await storedBook(a, 'b05'), CRADLE, 'an untouched card was saved again');

    await a.click('#list .bk[data-id="b03"]');
    const b = await open(ctx);
    await b.click('#list .bk[data-id="b03"]');
    await b.click('#f-status button[data-v="read"]');
    await b.click('#f-rating button[data-v="4"]');
    await b.fill('#f-notes', 'Loved the statues.');
    await b.click('#bkx2');
    const fromB = await storedBook(b, 'b03');
    assert.deepEqual([fromB.status, fromB.rating, fromB.notes], ['read', 4, 'Loved the statues.']);
    await a.bringToFront();
    await a.click('#bkx2');
    assert.deepEqual(await storedBook(a, 'b03'), fromB, 'closing the untouched card in the other tab undid the change');

    // An edit in a card that has gone stale changes only what was edited, a cleared field included.
    await a.click('#list .bk[data-id="b03"]');
    await b.click('#list .bk[data-id="b03"]');
    await b.click('#f-rating button[data-v="5"]');
    await b.click('#bkx2');
    await a.bringToFront();
    await a.fill('#f-shelf', 'By the door');
    await a.fill('#f-notes', '');
    await a.click('#bkx2');
    const both = await storedBook(a, 'b03');
    assert.deepEqual([both.status, both.rating, both.shelf, both.notes], ['read', 5, 'By the door', undefined]);
    await b.bringToFront();
    await until(async () => /By the door/.test(await b.textContent('#list .bk[data-id="b03"]')), 'the other tab to show the shelf');
    assert.deepEqual([...a.problems, ...b.problems], []);
  } finally { await ctx.close(); }
});

step('a failure to load Google sign-in isn\'t kept, and errors in Settings are red', async () => {
  const ctx = await context(); // refuses accounts.google.com, as when offline
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await page.click('#setBtn');
    await page.waitForSelector('#driveSect .err');
    assert.match(await page.textContent('#driveSect .err'), /Couldn’t load Google sign-in/);
    const [shown, bad] = await page.evaluate(() => {
      const t = document.createElement('i'); t.style.color = 'var(--bad)'; document.body.append(t);
      const c = getComputedStyle(t).color; t.remove();
      return [getComputedStyle(document.querySelector('#driveSect .err')).color, c];
    });
    assert.equal(shown, bad, 'the error isn\'t in the error colour');
    await page.click('#stx');
    await page.click('#list .bk[data-id="b03"]');
    await page.click('#f-status button[data-v="read"]');
    await page.click('#bkx2');
    assert.doesNotMatch(await page.evaluate(() => localStorage.getItem('shelfmark.drive') || ''), /Couldn’t load/, 'the error was saved');

    // Online again, with the error saved the way it used to be: Google's script loads and nothing is wrong.
    await page.evaluate(() => localStorage.setItem('shelfmark.drive', JSON.stringify({ on: false, fileId: '', version: '', token: '', exp: 0, last: 0, err: 'Couldn’t load Google sign-in. Check your connection.', pending: true, clientId: '' })));
    await fakeGoogle().install(ctx);
    await page.reload();
    await page.click('#setBtn');
    await page.waitForFunction(() => window.google && window.google.accounts);
    await page.waitForSelector('#dvGo');
    assert.equal(await page.locator('#driveSect .err').count(), 0, 'an old error still shows');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a card left open while another device changes the book keeps that change in Drive', async () => {
  const g = fakeGoogle();
  const driveBook = id => { const f = g.files().find(f => f.appProperties && f.appProperties.shelfmark === 'library'); return f && f.body ? JSON.parse(f.body).library.books[id] : null; };
  async function device() {
    const ctx = await context(DESK);
    await g.install(ctx);
    const page = await open(ctx);
    return page;
  }
  async function connect(page) {
    await page.click('#setBtn');
    await page.waitForFunction(() => window.google && window.google.accounts);
    await page.click('#dvGo');
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('shelfmark.drive') || '{}').fileId), 'Drive to connect');
    await page.click('#stx');
  }
  const syncNow = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const a = await device(), b = await device();
  try {
    await seed(a, [PIRANESI]);
    await connect(a);
    await until(() => driveBook('b03'), 'the library to reach Drive');
    await connect(b);
    await until(() => storedBook(b, 'b03'), 'the second device to get the book');

    await a.click('#list .bk[data-id="b03"]');
    await b.click('#list .bk[data-id="b03"]');
    await b.click('#f-status button[data-v="read"]');
    await b.click('#f-rating button[data-v="5"]');
    await b.click('#bkx2');
    await until(() => (driveBook('b03') || {}).status === 'read', 'the change to reach Drive');
    await syncNow(a);
    await until(async () => (await storedBook(a, 'b03')).status === 'read', 'the first device to sync while its card is open');
    await a.click('#bkx2');
    await wait(3500); // a change would be sent to Drive 2.5 s after it was saved
    await syncNow(a);
    await wait(1500);
    assert.deepEqual([driveBook('b03').status, driveBook('b03').rating], ['read', 5], 'closing the untouched card undid the change in Drive');
    await syncNow(b);
    await wait(1500);
    assert.equal((await storedBook(b, 'b03')).rating, 5);
    assert.deepEqual([...a.problems, ...b.problems], []);
  } finally { await a.context().close(); await b.context().close(); }
});

const only = process.argv.slice(2);
let failed = 0, ran = 0;
try {
  for (const [name, fn] of steps) {
    if (only.length && !only.some(o => name.includes(o))) continue;
    ran++;
    try { await fn(); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')); }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} of ${ran} failed` : `All ${ran} browser checks passed`);
process.exit(failed ? 1 : 0);
