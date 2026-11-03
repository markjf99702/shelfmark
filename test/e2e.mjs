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
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fakeGoogle } from './fake-google.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection) or 'stalled' (a train, a captive
// wifi: it takes each request and holds on to it). With `release` set it serves the next release (see the offline copy's step).
let net = 'up', release = false;
const held = [];
const server = createServer((req, res) => {
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled') { held.push([req, res]); return; }
  serve(req, res);
}).listen(0);
async function serve(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  if (release && (path === '/' || path === '/index.html')) body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
// Back to a connection that answers, and the requests held while it stalled answered too.
function reconnect() { net = 'up'; for (const [req, res] of held.splice(0)) serve(req, res); }
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

// A link to reading details for books already in the library, made by the skill's script the same way.
function detailsLink(books) {
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'shelfmark-e2e-'));
    try {
      writeFileSync(join(tmp, 'in.json'), JSON.stringify({ name: 'Reading details', books }));
      const out = execFileSync('python3', [join(root, 'skill/shelfmark-cataloger/scripts/make_shelfmark.py'), join(tmp, 'in.json'), '--details', '--out', tmp, '--base', base], { encoding: 'utf8' });
      return /Link: (\S+)/.exec(out)[1];
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return base + '#s1z' + deflateRawSync(Buffer.from(JSON.stringify({ shelfmark: 1, details: { id: 'e2e-d', name: 'Reading details', books } }))).toString('base64url');
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

    // Works offline once it has been opened. The server goes down as well as the browser: in some Chromium builds the
    // browser's offline switch alone doesn't stop the service worker's own requests, and this passed with no copy at all.
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 });
    net = 'down';
    await ctx.setOffline(true);
    try {
      await page.reload();
      assert.equal((await titles(page)).length, 3, 'the library shows offline');
      assert.match(await page.textContent(`#list .bk[data-id="${id}"]`), /Read/);
    } finally { await ctx.setOffline(false); reconnect(); }
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

step('GitHub Pages is told to serve the files as they are, SKILL.md included', async () => {
  assert.equal((await fetch(base + '.nojekyll')).status, 200, 'no .nojekyll, so Jekyll turns SKILL.md into SKILL.html');
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

step('the offline copy opens on a connection that doesn\'t answer, and a new release\'s copy comes from the server', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 });
    // Chromium would offer to install it.
    const cdp = await ctx.newCDPSession(page);
    assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], 'Chromium wouldn\'t install it');
    await cdp.detach();
    // In a bookshop with one bar of signal, or on a captive wifi, the network is up but doesn't answer. After the worker's
    // few seconds' wait the page opens from the copy, with every file it loads (were any left waiting, it wouldn't open).
    net = 'stalled';
    try {
      const t0 = Date.now();
      await page.reload({ timeout: 10000 }).catch(() => {});
      const took = Date.now() - t0;
      assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
      assert.deepEqual(await titles(page), ['Piranesi'], 'the library didn\'t show on a stalled connection');
    } finally { reconnect(); }
    // A new release: every file in the new copy comes from the server, though the browser still has its own copies of
    // the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
    release = true;
    try {
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      await until(() => page.evaluate(async () => { const r = await caches.match('index.html'); return !!r && (await r.text()).includes('<!-- the next release -->'); }),
        'the new release\'s offline copy to hold the new index.html', 10000);
    } finally { release = false; }
    assert.deepEqual(page.problems, []);
  } finally { reconnect(); release = false; await ctx.close(); }
});

step('sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once', async () => {
  // FILES in sw.js is a fingerprint of every file in SHELL: the sha1 of each, in the list's order, an address like './'
  // read as its index.html; the first 8 hex of the sha1 of those.
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
  const all = createHash('sha1');
  for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
  const files = all.digest('hex').slice(0, 8);
  assert.equal((sw.match(/const FILES = '([0-9a-f]*)'/) || [])[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
});

step('without JavaScript the page says what it needs', async () => {
  const ctx = await browser.newContext({ ...PHONE, javaScriptEnabled: false });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  try {
    const page = await ctx.newPage();
    await page.goto(base);
    // Chromium with scripts turned off this way still parses <noscript> as if they were on, so read the source.
    assert.match(await readFile(join(root, 'index.html'), 'utf8'), /<noscript>.*Shelfmark needs JavaScript to keep your catalog\..*<\/noscript>/);
    assert.equal(await page.locator('#q').isVisible(), false, 'an empty search box shows');
  } finally { await ctx.close(); }
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

step('the Back button closes an open sheet instead of leaving Shelfmark', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, t: 1000, title: 'Book ' + (i + 1), authors: ['Ann Lee'] })));
    const here = page.url(), length = () => page.evaluate(() => history.length), start = await length();
    // Back on a card closes it, and keeps what was typed.
    await page.click('#list .bk[data-id="n0"]');
    await page.fill('#f-notes', 'Half typed');
    await page.goBack();
    await until(async () => !(await sheetOpen(page)), 'Back to close the card');
    assert.equal(page.url(), here, 'Back left Shelfmark');
    assert.equal((await storedBook(page, 'n0')).notes, 'Half typed');
    // A sheet closed with its own button takes its history entry with it, so Back isn't needed twice later.
    await page.click('#list .bk[data-id="n1"]');
    await page.click('#bkx2');
    await until(() => page.evaluate(() => !(history.state && history.state.sheet)), 'the card\'s entry to go');
    // A sheet that takes another's place takes over its entry: Import, then the books it read.
    await page.click('#importBtn');
    await page.fill('#impaste', linkTo({ name: 'Den', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }] }));
    await page.click('#imgo');
    await page.waitForSelector('#rv-add');
    assert.equal(await length(), start + 1, 'the review screen added a second entry over the Import sheet\'s');
    await page.goBack();
    await until(async () => !(await sheetOpen(page)), 'one Back to close the review screen');
    assert.equal(page.url(), here);
    // Adding books moves the list to its top, and leaving the sheet's entry doesn't scroll it back down.
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.goto(linkTo({ name: 'Hall', books: [{ title: 'Gilead', authors: ['Marilynne Robinson'] }] }));
    await page.waitForSelector('#rv-add');
    await page.click('#rv-add');
    await until(() => page.evaluate(() => !(history.state && history.state.sheet)), 'the review screen\'s entry to go');
    await wait(300);
    assert.equal(await page.evaluate(() => scrollY), 0, 'the list scrolled back down after adding');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a sheet opens with its heading focused, not a ring around Not now', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx, linkTo({ name: 'Den', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }] }));
    await page.waitForSelector('#rv-add');
    const focused = () => page.evaluate(() => { const a = document.activeElement, c = getComputedStyle(a); return [a.id || a.tagName, c.outlineStyle === 'none' || c.outlineWidth === '0px']; });
    assert.deepEqual(await focused(), ['sheetTitle', true], 'focus isn\'t on the heading, or the heading has a ring');
    await page.keyboard.press('Tab'); // and the keyboard goes on from there, inside the sheet
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rvx');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a book on the review screen ticks with a tap anywhere along its left edge', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx, linkTo({ name: 'Den', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Gilead', authors: ['Marilynne Robinson'] }] }));
    await page.waitForSelector('#rv-add');
    const row = page.locator('#rv li').first(), box = row.locator('input[type=checkbox]');
    const r = await row.boundingBox(), b = await box.boundingBox();
    assert.deepEqual([Math.round(b.x - r.x), Math.round(b.y - r.y), Math.round(b.width)], [11, 16, 18], 'the box moved');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height + 14);
    assert.equal(await box.isChecked(), false, 'a tap just below the box did nothing');
    await page.touchscreen.tap(r.x + 3, r.y + r.height - 6);
    assert.equal(await box.isChecked(), true, 'a tap at the row\'s bottom-left corner did nothing');
    assert.equal(await page.textContent('#rv-add'), 'Add 2 books');
    await page.touchscreen.tap(r.x + 60, r.y + 18);
    assert.equal(await box.isChecked(), true, 'a tap on the title ticked the box');
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

step('changing only the room on the review screen keeps each book\'s own shelf', async () => {
  const ctx = await context();
  try {
    // SKILL.md's own example: a room and a shelf for the batch, and books on the bookcase's top shelf.
    const page = await open(ctx, linkTo({ name: 'Living room, tall bookcase', room: 'Living room', shelf: 'Tall bookcase', books: [
      { title: 'Middlemarch', authors: ['George Eliot'], shelf: 'Tall bookcase, top' },
      { title: 'Beloved', authors: ['Toni Morrison'], shelf: 'Tall bookcase, top' },
      { title: 'The Hobbit', authors: ['J. R. R. Tolkien'] },
    ] }));
    await page.waitForSelector('#rv-add');
    assert.equal(await page.inputValue('#rv-shelf'), 'Tall bookcase');
    await page.fill('#rv-room', 'Den');
    await page.click('#rv-add');
    const lib = await stored(page);
    assert.deepEqual(Object.values(lib.library.books).map(b => b.title + ' @ ' + b.room + ' > ' + b.shelf).sort(),
      ['Beloved @ Den > Tall bookcase, top', 'Middlemarch @ Den > Tall bookcase, top', 'The Hobbit @ Den > Tall bookcase']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a batch of more than 3,000 books says how many didn\'t fit and what to do', async () => {
  const ctx = await context();
  try {
    const books = Array.from({ length: 3002 }, (_, i) => ({ title: 'Book ' + (i + 1) }));
    const page = await open(ctx, base + '#s1z' + deflateRawSync(Buffer.from(JSON.stringify({ shelfmark: 1, batch: { id: 'big', name: 'Goodreads export', books } }))).toString('base64url'));
    await page.waitForSelector('#rv-add', { timeout: 60000 });
    assert.equal(await page.textContent('.lede'), 'Goodreads export · 3,000 books. 2 more didn’t fit. Shelfmark takes 3,000 at a time — ask Claude to put the rest in another file.');
    assert.equal(await page.textContent('#rv-add'), 'Add 3,000 books');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('books added from a link keep the shelf\'s order, and the sort chosen before stays saved', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await page.evaluate(() => localStorage.setItem('shelfmark.prefs', JSON.stringify({ sort: 'shelf', lookups: false })));
    await seed(page, [PIRANESI]);
    const shelf = ['Wuthering Heights', 'Beloved', 'Middlemarch', 'Gilead', 'Dune', 'Circe', 'Emma', 'Atonement'];
    await page.goto(linkTo({ name: 'Den, left case', room: 'Den', books: shelf.map(title => ({ title, authors: ['Ann Lee'] })) }));
    await page.waitForSelector('#rv-add');
    await page.click('#rv-add');
    assert.equal(await page.inputValue('#sortSel'), 'added', 'the list isn\'t newest first after adding');
    assert.deepEqual(await titles(page), [...shelf, 'Piranesi'], 'the books came out of the shelf\'s order');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('shelfmark.prefs'))).sort, 'shelf', 'adding books changed the saved sort');
    await page.reload();
    assert.equal(await page.inputValue('#sortSel'), 'shelf', 'the sort chosen before didn\'t come back');
    await page.selectOption('#sortSel', 'title'); // a sort chosen by hand is still kept
    await page.reload();
    assert.equal(await page.inputValue('#sortSel'), 'title');
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

step('a link pasted into Import with a full stop after it opens, and so does Claude\'s whole reply with JSON in it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await page.click('#importBtn');
    await page.fill('#impaste', 'Here are your books: ' + linkTo({ name: 'Den', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }] }) + '.');
    await page.click('#imgo');
    await page.waitForSelector('#rv-add');
    assert.equal(await page.inputValue('#rv input[data-f="title"]'), 'Middlemarch');
    await page.click('#rvx');
    await wait(450);
    // Without code tools, Claude writes the JSON by hand, in a code block between two lines of its own.
    await page.click('#importBtn');
    await page.fill('#impaste', 'Here are the 2 books from the den:\n\n```json\n' + JSON.stringify({ shelfmark: 1, batch: { name: 'Den', books: [{ title: 'Walden', authors: ['Henry David Thoreau'] }, { title: 'Emma', authors: ['Jane Austen'] }] } }, null, 2) + '\n```\n\nPaste it into Shelfmark (Import › paste box).');
    await page.click('#imgo');
    await page.waitForSelector('#rv-add');
    assert.deepEqual(await page.$$eval('#rv input[data-f="title"]', els => els.map(e => e.value)), ['Walden', 'Emma']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a spreadsheet export, pasted or opened, says to send it to Claude', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    const hint = 'That’s a spreadsheet export. Send it to Claude with the Shelfmark skill and open the file or link it gives you.';
    const csv = '﻿Book Id,Title,Author,ISBN,Exclusive Shelf\r\n5907,"The Hobbit, or There and Back Again",J.R.R. Tolkien,"=""0618260307""",read\r\n';
    await page.click('#importBtn');
    await page.fill('#impaste', csv);
    await page.click('#imgo');
    await until(async () => await page.textContent('#toastTx') === hint, 'the hint about spreadsheets');
    assert.match(await page.getAttribute('#fileIn', 'accept'), /(^|,)\.csv(,|$)/, 'a phone\'s file picker won\'t offer a .csv');
    await page.evaluate(() => { document.getElementById('toastTx').textContent = ''; });
    await page.setInputFiles('#fileIn', { name: 'goodreads_library_export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await until(async () => await page.textContent('#toastTx') === hint, 'the hint for an opened file');
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

// Connects this page to the fake Drive from Settings, and closes Settings once the library file is known.
async function connectDrive(page) {
  await page.click('#setBtn');
  await page.waitForFunction(() => window.google && window.google.accounts);
  await page.click('#dvGo');
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('shelfmark.drive') || '{}').fileId), 'Drive to connect');
  await page.click('#stx');
  await wait(450); // a tap where Done was is ignored for a moment after (see tapGuard), and Settings is near it
}

step('erasing this device\'s copy signs Google out here too, so Connect asks Google again', async () => {
  const g = fakeGoogle();
  const ctx = await context();
  await g.install(ctx);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    await connectDrive(page);
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('junkdrawer.google') || '{}').email === 'mark@gmail.com'), 'the account\'s email to be kept with the sign-in');
    await until(() => page.evaluate(() => document.getElementById('syncTx').textContent === 'Synced'), 'the first sync');
    const asked = await page.evaluate(() => (window.__prompts || []).length);
    await page.click('#setBtn');
    assert.match(await page.textContent('#stEraseNote'), /removes your library and your Google sign-in from this browser only/);
    await page.click('#stErase');
    await page.click('#stErase');
    assert.equal(await page.evaluate(() => localStorage.getItem('junkdrawer.google')), null, 'the Google sign-in and the account\'s email are still in this browser');
    assert.match(await page.textContent('#list'), /Your shelves are empty/);
    // Whoever has the device next can't bring the library back without signing in to Google.
    await page.click('#setBtn');
    await page.click('#dvGo');
    await until(() => page.evaluate(n => (window.__prompts || []).length > n, asked), 'Connect to ask Google', 5000);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});


step('erasing with changes that haven\'t reached Drive says so before they\'re lost', async () => {
  const g = fakeGoogle();
  const ctx = await context();
  await g.install(ctx);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await connectDrive(page);
    await until(() => page.evaluate(() => document.getElementById('syncTx').textContent === 'Synced'), 'the first sync');
    // An hour on, Google's sign-in has run out, and a book is marked read here.
    await page.evaluate(() => {
      for (const k of ['junkdrawer.google', 'shelfmark.drive']) localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)), exp: Date.now() - 1000 }));
    });
    await page.reload();
    await until(() => page.evaluate(() => document.getElementById('syncBtn').dataset.s === 'tap'), 'the sync button to ask for a tap');
    await page.click('#list .bk[data-id="b03"]');
    await page.click('#f-status button[data-v="read"]');
    await page.click('#bkx2');
    await wait(450);
    await page.click('#setBtn');
    assert.match(await page.textContent('#stEraseNote'), /Your latest changes here haven’t reached Drive yet\. Tap Sync now first, or they’ll be lost\./);
    await page.click('#stErase');
    assert.equal(await page.textContent('#stErase'), 'Tap again to erase, changes not in Drive included');
    assert.equal(await page.evaluate(() => document.getElementById('stErase').getBoundingClientRect().right <= innerWidth - 16), true, 'the button runs off the side of a phone');
    assert.equal(await storedBook(page, 'b03').then(b => b.status), 'read', 'the first tap erased something');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a browser that won\'t let Shelfmark save says so, rather than saying the books were added', async () => {
  const ctx = await context();
  // As when the browser blocks site data: every save of Shelfmark's throws.
  await ctx.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('shelfmark')) throw new DOMException('The operation is insecure.', 'SecurityError'); return set.call(this, k, v); };
  });
  try {
    const page = await open(ctx, linkTo({ name: 'Den', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Gilead', authors: ['Marilynne Robinson'] }] }));
    await page.waitForSelector('#rv-add');
    const blocked = /This browser isn’t letting Shelfmark save, so books added here will be gone when you close it\./;
    assert.match(await page.textContent('#sheet .ft'), blocked, 'the review screen doesn\'t say the books won\'t be kept');
    await page.click('#rv-add');
    assert.equal(await page.textContent('#toastTx'), 'Not saved: this browser isn’t letting Shelfmark save. See the note at the top.');
    assert.equal(await page.locator('#storeNote').isVisible(), true, 'no note above the list');
    assert.match(await page.textContent('#storeNote'), blocked);
    await wait(450);
    await page.click('#addBtn');
    await page.fill('#f-title', 'Walden');
    await page.click('#f-add');
    assert.match(await page.textContent('#toastTx'), /^Not saved/);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a browser out of room says so once, not with every save while typing', async () => {
  const ctx = await context();
  await ctx.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (window.__full && k === 'shelfmark.library') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return set.call(this, k, v); };
  });
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    assert.equal(await page.locator('#storeNote').isVisible(), false);
    await page.evaluate(() => {
      window.__full = true; window.__toasts = [];
      new MutationObserver(() => window.__toasts.push(document.getElementById('toastTx').textContent)).observe(document.getElementById('toastTx'), { childList: true, characterData: true, subtree: true });
    });
    await page.click('#list .bk[data-id="b03"]');
    for (const word of ['One', ' two', ' three', ' four']) { await page.type('#f-notes', word); await wait(700); }
    await page.click('#bkx2');
    const room = await page.evaluate(() => window.__toasts.filter(t => /out of room/.test(t)).length);
    assert.equal(room, 1, 'said it was out of room ' + room + ' times');
    assert.match(await page.textContent('#storeNote'), /This browser is out of room/);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a backup opens on another device, and the library sheet says what merging it would change', async () => {
  const a = await context(), b = await context();
  try {
    const page = await open(a);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    await page.click('#setBtn');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#stDl')]);
    const backup = await readFile(await dl.path(), 'utf8');
    const lede = p => p.textContent('#sheet .lede');
    const what = p => p.$$eval('#sheet .lb-what li', lis => lis.map(li => li.textContent));
    const openFile = (p, text) => p.setInputFiles('#fileIn', { name: 'shelfmark-library.json', mimeType: 'application/json', buffer: Buffer.from(text) });

    // On a new device it merges, and the library there is the one backed up.
    const other = await open(b);
    await openFile(other, backup);
    assert.equal(await lede(other), 'This file holds 2 books.');
    assert.deepEqual(await what(other), ['2 aren’t on this device yet, so merging adds them']);
    assert.deepEqual(await other.$$eval('#sheet button', bs => bs.map(x => x.textContent)), ['Not now', 'Merge into my library'], 'two buttons that close it, or the wrong ones');
    await other.click('#lbgo');
    assert.deepEqual(await stored(other), JSON.parse(backup));
    // Opened again, there's nothing to merge, and it says so.
    await wait(450);
    await openFile(other, backup);
    assert.equal(await lede(other), 'Nothing to merge: this device already has everything in this file.');
    assert.deepEqual(await other.$$eval('#sheet button', bs => bs.map(x => x.textContent)), ['Close']);
    await other.click('#lbx');
    // A book removed here since stays removed, and the sheet counts it.
    await other.click('#list .bk[data-id="b04"]');
    await other.click('#f-del');
    await wait(450);
    await openFile(other, backup);
    assert.equal(await lede(other), 'Nothing to merge: this device already has everything in this file, apart from 1 book removed here since, which stays removed.');
    await other.click('#lbx');
    // A file in which one of the books here was removed later says so before merging.
    const removed = { shelfmark: 1, library: { books: { b03: { id: 'b03', t: Date.now() + 60000, del: 1 }, b04: MIDDLEMARCH, b05: CRADLE }, seen: {} } };
    await wait(450);
    await openFile(other, JSON.stringify(removed));
    assert.equal(await lede(other), 'This file holds 2 books.');
    assert.deepEqual(await what(other), ['1 isn’t on this device yet, so merging adds it', '1 was removed here since, and stays removed', '1 of your books was removed in the file, so merging removes it here too']);
    await other.click('#lbgo');
    assert.deepEqual((await titles(other)).sort(), ['Cat’s Cradle']);
    assert.deepEqual([...page.problems, ...other.problems], []);
  } finally { await a.close(); await b.close(); }
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

step('a card closed while typing doesn\'t save over the next book opened', async () => {
  const ctx = await context(DESK);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    // Escape closes the card with the notes still being edited, and another book opens straight after.
    await page.click('#list .bk[data-id="b03"]');
    await page.fill('#f-notes', 'Typed, then Escape');
    await page.keyboard.press('Escape');
    await page.click('#list .bk[data-id="b04"]');
    await wait(900); // past the moment a late save would come
    assert.deepEqual(await storedBook(page, 'b03'), { ...PIRANESI, t: (await storedBook(page, 'b03')).t, notes: 'Typed, then Escape' }, 'the book closed was saved with the next one\'s details');
    assert.deepEqual(await storedBook(page, 'b04'), MIDDLEMARCH);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('filter chips read their counts apart, and a card offers only tags the book hasn\'t got', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ id: 'b06', t: 1000, title: 'The Hobbit', authors: ['J. R. R. Tolkien'], tags: ['kids', 'fantasy'] }, { ...MIDDLEMARCH, tags: ['classics'] }, CRADLE]);
    assert.equal(await page.getByRole('button', { name: 'Unread, 3', exact: true }).count(), 1, 'the Unread chip\'s name runs into its count');
    await page.click('#list .bk[data-id="b06"]');
    const picks = () => page.$$eval('#f-tagpicks button:not([hidden])', bs => bs.map(b => b.dataset.t));
    assert.deepEqual(await picks(), ['Arts & crafts', 'classics', 'sf']);
    await page.click('#f-tagpicks button[data-t="sf"]');
    assert.equal(await page.inputValue('#f-tags'), 'kids, fantasy, sf');
    assert.deepEqual(await picks(), ['Arts & crafts', 'classics']);
    await page.fill('#f-tags', 'kids, fantasy, sf, classics, Arts & crafts');
    assert.equal(await page.locator('#f-tagpicks').isVisible(), false, 'an empty row of picks still shows');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('small grey text and the Reading badge reach WCAG AA contrast, light and dark', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await context({ ...PHONE, colorScheme });
    try {
      for (const [url, pairs] of [[base, [['ink3', 'ground'], ['ink3', 'surface'], ['ink3', 'surface2'], ['brass', 'brass-soft'], ['brass', 'surface']]], [base + 'privacy.html', [['ink3', 'ground']]]]) {
        const page = await open(ctx, url);
        const ratios = await page.evaluate(pairs => {
          const css = getComputedStyle(document.documentElement), hex = n => css.getPropertyValue('--' + n).trim();
          const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
          return pairs.map(([fg, bg]) => { const [a, b] = [lum(hex(fg)), lum(hex(bg))].sort((x, y) => y - x); return [fg + ' on ' + bg, (a + 0.05) / (b + 0.05)]; });
        }, pairs);
        for (const [what, r] of ratios) assert.ok(r >= 4.5, colorScheme + ', ' + (url === base ? 'the app' : 'the privacy page') + ': ' + what + ' is ' + r.toFixed(2) + ':1');
        assert.deepEqual(page.problems, []);
        await page.close();
      }
    } finally { await ctx.close(); }
  }
});

step('on a phone, a narrow one too, the menus and the search box show their words whole', async () => {
  const narrow = width => ({ ...PHONE, viewport: { width, height: 760 } });
  for (const [size, placeholder] of [[PHONE, 'Search your books'], [narrow(360), 'Search your books'], [narrow(320), 'Search your books'], [DESK, 'Search titles, authors, shelves, tags, borrowers…']]) {
    const ctx = await context(size);
    try {
      const page = await open(ctx);
      await seed(page, [{ ...PIRANESI, tags: ['sf'] }, { ...MIDDLEMARCH, room: 'Living room', tags: ['classics'] }]);
      await page.selectOption('#sortSel', 'added');
      await page.evaluate(() => document.fonts.ready);
      // How much of each box's words fits inside it, as text drawn in its own font.
      const fits = id => page.$eval(id, el => {
        const c = getComputedStyle(el), g = document.createElement('canvas').getContext('2d');
        g.font = c.fontWeight + ' ' + c.fontSize + ' ' + c.fontFamily;
        const text = el.tagName === 'SELECT' ? el.options[el.selectedIndex].text : el.placeholder;
        return [text, g.measureText(text).width <= el.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight) + 0.5];
      });
      assert.deepEqual(await fits('#roomSel'), ['All rooms', true], 'the room menu is cut short at ' + size.viewport.width);
      assert.deepEqual(await fits('#tagSel'), ['All tags', true], 'the tag menu is cut short at ' + size.viewport.width);
      assert.deepEqual(await fits('#sortSel'), ['Newest first', true], 'the sort menu is cut short at ' + size.viewport.width);
      assert.deepEqual(await fits('#q'), [placeholder, true], 'the search box\'s placeholder is cut short at ' + size.viewport.width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('a book\'s ISBN reads like its other details', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ id: 'b06', t: 1000, title: 'The Hobbit', authors: ['J. R. R. Tolkien'], isbn: '9780261102217', publisher: 'HarperCollins' }]);
    await page.click('#list .bk[data-id="b06"]');
    await page.click('details.more > summary');
    const look = id => page.$eval(id, e => { const c = getComputedStyle(e); return [c.color, c.fontWeight, c.textTransform, c.letterSpacing]; });
    assert.deepEqual(await look('#f-isbn'), await look('#f-publisher'));
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('What to read next counts one match in the singular', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...PIRANESI, pages: 272 }, { ...MIDDLEMARCH, pages: 880 }]);
    await page.click('#nextBtn');
    await page.click('[data-len="long"]');
    assert.equal(await page.textContent('#nxOut .note'), 'From 1 unread book that matches.');
    await page.click('[data-len=""]');
    assert.equal(await page.textContent('#nxOut .note'), 'From 2 unread books on hand.');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('junk in the saved covers and settings doesn\'t stop covers or sorting', async () => {
  const ctx = await context();
  const ol = await fakeOpenLibrary(ctx);
  try {
    const page = await open(ctx);
    await page.evaluate(() => { localStorage.setItem('shelfmark.covers', '5'); localStorage.setItem('shelfmark.prefs', JSON.stringify({ sort: 'junk', lookups: true })); });
    await seed(page, [PIRANESI, MIDDLEMARCH, CRADLE]);
    await until(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('shelfmark.covers')) || {}).length === 3), 'all three covers to be found');
    assert.equal(ol.searches, 3);
    assert.equal(await page.inputValue('#sortSel'), 'author');
    assert.equal(await page.locator('#list .cv img').count(), 3, 'the covers didn\'t show');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a quick second tap on Add to library doesn\'t open the book underneath', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, Array.from({ length: 9 }, (_, i) => ({ id: 'n' + i, t: 1000, title: 'Book ' + (i + 1), authors: ['Ann Lee'] })));
    await page.click('#addBtn');
    await page.fill('#f-title', 'Double Tap');
    const b = await page.locator('#f-add').boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
    const under = await page.evaluate(([x, y]) => {
      const s = document.getElementById('sheet'), behind = [...document.querySelectorAll('[inert]')];
      s.style.visibility = 'hidden'; behind.forEach(e => e.inert = false);
      const e = document.elementFromPoint(x, y);
      s.style.visibility = ''; behind.forEach(e => e.inert = true);
      const b = e && e.closest('button'); return b && (b.id || b.className);
    }, [x, y]);
    assert.ok(under, 'nothing to tap lies under the button');
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
    await wait(500);
    assert.equal(await sheetOpen(page), false, 'the second tap went through to ' + under);
    assert.equal(Object.values((await stored(page)).library.books).filter(b => b.title === 'Double Tap').length, 1);
    await page.click('#list .bk >> nth=0'); // a tap elsewhere, a moment later, works
    assert.equal(await sheetOpen(page), true);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a book opened straight after adding one closes with Done, though Done is where Add was', async () => {
  const ctx = await context();
  // The clock stands still from here on, so however slow the machine, every tap comes within the moment after a
  // sheet closes, when a tap where the closing tap was is ignored.
  await ctx.clock.install({ time: new Date('2026-10-13T10:00:00') });
  try {
    const page = await open(ctx);
    await seed(page, Array.from({ length: 9 }, (_, i) => ({ id: 'n' + i, t: 1000, title: 'Book ' + (i + 1), authors: ['Ann Lee'] })));
    await ctx.clock.pauseAt(new Date('2026-10-13T10:00:05'));
    await page.click('#addBtn');
    await page.fill('#f-title', 'Quick One');
    const add = await page.locator('#f-add').boundingBox();
    await page.touchscreen.tap(add.x + add.width / 2, add.y + add.height / 2);
    assert.equal(await sheetOpen(page), false);
    const row = await page.locator('#list .bk >> nth=0').boundingBox();
    await page.touchscreen.tap(row.x + 40, row.y + row.height / 2); // a book, nowhere near Add
    assert.equal(await sheetOpen(page), true, 'the book didn\'t open');
    const done = await page.locator('#bkx2').boundingBox();
    assert.ok(Math.abs(done.x + done.width / 2 - (add.x + add.width / 2)) < 40 && Math.abs(done.y + done.height / 2 - (add.y + add.height / 2)) < 40, 'Done isn\'t where Add was, so this proves nothing');
    await page.touchscreen.tap(done.x + done.width / 2, done.y + done.height / 2);
    assert.equal(await sheetOpen(page), false, 'Done was ignored');
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
    await until(async () => await a.locator('#f-rating button.on').count() === 5, 'the change to reach the other tab'); // as it has by the time a person gets there
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

step('an open card shows another tab\'s change in the fields not being edited', async () => {
  const ctx = await context(DESK);
  try {
    const a = await open(ctx);
    await seed(a, [PIRANESI]);
    await a.click('#list .bk[data-id="b03"]');
    await a.$eval('#f-shelf', e => { e.value = 'Half typed'; }); // being typed here, not saved yet
    const b = await open(ctx);
    await b.click('#list .bk[data-id="b03"]');
    await b.click('#f-status button[data-v="read"]');
    await b.click('#f-rating button[data-v="4"]');
    await b.fill('#f-notes', 'Loved the statues.');
    await b.fill('#f-shelf', 'Theirs');
    await b.click('#bkx2');
    await a.bringToFront();
    await until(async () => await a.inputValue('#f-notes') === 'Loved the statues.', 'the open card to show the new note');
    assert.equal(await a.getAttribute('#f-status button[data-v="read"]', 'aria-pressed'), 'true');
    assert.equal(await a.locator('#f-rating button.on').count(), 4);
    assert.equal(await a.inputValue('#f-shelf'), 'Half typed', 'what was being typed was replaced');
    await a.click('#bkx2');
    const got = await storedBook(a, 'b03');
    assert.deepEqual([got.status, got.rating, got.notes, got.shelf], ['read', 4, 'Loved the statues.', 'Half typed']);
    assert.deepEqual([...a.problems, ...b.problems], []);
  } finally { await ctx.close(); }
});

step('the list behind a card shows another tab\'s change once the card closes', async () => {
  const ctx = await context(DESK);
  try {
    const a = await open(ctx);
    await seed(a, [PIRANESI, MIDDLEMARCH]);
    await a.focus('#list .bk[data-id="b03"]');
    await a.keyboard.press('Enter');
    await a.waitForSelector('#f-title');
    const b = await open(ctx);
    await b.click('#list .bk[data-id="b03"]');
    await b.click('#f-status button[data-v="read"]');
    await b.click('#f-rating button[data-v="4"]');
    await b.click('#bkx2');
    await a.bringToFront();
    await until(async () => await a.getAttribute('#f-status button[data-v="read"]', 'aria-pressed') === 'true', 'the open card to show the change');
    await a.keyboard.press('Escape'); // closed untouched, so nothing is saved
    assert.equal(await sheetOpen(a), false);
    assert.match(await a.textContent('#list .bk[data-id="b03"]'), /Read/, 'the list still shows the book as it was');
    assert.match(await a.textContent('#count'), /1 read/);
    assert.equal(await a.evaluate(() => document.activeElement.dataset.id), 'b03', 'the keyboard didn\'t come back to the book');
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

step('signing back in after the hour goes straight to the same Google account', async () => {
  const g = fakeGoogle();
  const ctx = await context();
  await g.install(ctx);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await page.click('#setBtn');
    await page.waitForFunction(() => window.google && window.google.accounts);
    await page.click('#dvGo');
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('junkdrawer.google') || '{}').email === 'mark@gmail.com'), 'the account\'s email to be kept with the sign-in');
    assert.ok(g.calls.some(c => c.startsWith('GET /drive/v3/about')), 'the email wasn\'t asked of Drive');
    await until(() => page.evaluate(() => /Your library is in mark@gmail\.com’s Google Drive:/.test(document.getElementById('driveSect').textContent)), 'Settings to say which account it saves to', 5000);
    assert.match(await page.textContent('#driveSect'), /Drive keeps its earlier versions for 30 days, and only the last 100/);
    await page.click('#stx');
    // An hour on, Google's sign-in has run out.
    await page.evaluate(() => {
      for (const k of ['junkdrawer.google', 'shelfmark.drive']) localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)), exp: Date.now() - 1000 }));
    });
    await page.reload();
    await page.waitForFunction(() => window.google && window.google.accounts);
    await until(() => page.evaluate(() => document.getElementById('syncBtn').dataset.s === 'tap'), 'the sync button to ask for a tap');
    await page.click('#syncBtn');
    await until(() => page.evaluate(() => (window.__prompts || []).length > 0), 'Google to be asked');
    assert.deepEqual(await page.evaluate(() => window.__prompts.at(-1)), { prompt: '', login_hint: 'mark@gmail.com' }, 'Google wasn\'t told which account, so it shows the chooser');
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

step('two devices that connect at the same moment end up with one library file and every book', async () => {
  const g = fakeGoogle();
  const libraries = () => g.files().filter(f => f.appProperties && f.appProperties.shelfmark === 'library' && !f.trashed);
  async function device(book) {
    const ctx = await context(DESK);
    await g.install(ctx);
    const page = await open(ctx);
    await seed(page, [book]);
    await page.click('#setBtn');
    await page.waitForFunction(() => window.google && window.google.accounts);
    return page;
  }
  const a = await device(PIRANESI), b = await device(MIDDLEMARCH);
  try {
    // Both tap Connect at once, so each finds no library file in Drive and makes its own.
    await Promise.all([a.click('#dvGo'), b.click('#dvGo')]);
    const fileId = page => page.evaluate(() => JSON.parse(localStorage.getItem('shelfmark.drive') || '{}').fileId);
    await until(async () => (await fileId(a)) && (await fileId(b)), 'both devices to connect');
    const synced = page => page.evaluate(() => document.getElementById('syncTx').textContent === 'Synced');
    await until(async () => (await synced(a)) && (await synced(b)), 'both to sync');
    for (const page of [a, b]) { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await wait(1500); }
    const ids = async page => Object.keys((await stored(page)).library.books).sort();
    await until(async () => (await ids(a)).length === 2 && (await ids(b)).length === 2, 'both devices to have both books', 10000).catch(() => {});
    assert.deepEqual([await ids(a), await ids(b)], [['b03', 'b04'], ['b03', 'b04']], 'a device kept only its own book');
    assert.equal(libraries().length, 1, 'Drive kept ' + libraries().length + ' library files');
    assert.deepEqual([await fileId(a), await fileId(b)], [libraries()[0].id, libraries()[0].id], 'a device still saves to a file in the trash');
    assert.deepEqual(Object.keys(JSON.parse(libraries()[0].body).library.books).sort(), ['b03', 'b04'], 'the file in Drive hasn\'t both books');
    // The file kept is the first one made, which any other device that synced already holds.
    const first = libraries()[0].id;
    assert.equal(first, g.files().filter(f => f.appProperties && f.appProperties.shelfmark === 'library')[0].id);
    // A second file left from before is folded in on the next visit.
    g.drive.files['f' + g.drive.next++] = { owner: 'mark', name: 'Shelfmark library.json', mimeType: 'application/json', appProperties: { shelfmark: 'library' }, version: 1, modified: Date.now(),
      body: JSON.stringify({ shelfmark: 1, library: { books: { b05: CRADLE }, seen: {} } }) };
    await a.reload();
    await until(async () => (await ids(a)).includes('b05'), 'the next visit to fold in the other file', 10000);
    await until(() => libraries().length === 1 && JSON.parse(libraries()[0].body).library.books.b05, 'the folded file to go to the trash and its book to reach the first');
    assert.equal(libraries()[0].id, first);
    assert.deepEqual([...a.problems, ...b.problems], []);
  } finally { await a.context().close(); await b.context().close(); }
});

step('losing the connection mid-sync shows Offline, not Sync failed, and coming back syncs', async () => {
  const g = fakeGoogle();
  const ctx = await context();
  await g.install(ctx);
  const driveBook = id => { const f = g.files().find(f => f.appProperties && f.appProperties.shelfmark === 'library' && !f.trashed); return f && f.body ? JSON.parse(f.body).library.books[id] : null; };
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await connectDrive(page);
    await until(() => driveBook('b03'), 'the library to reach Drive');
    // The connection drops while the change is on its way to Drive.
    let dropped = 0;
    await ctx.route('https://www.googleapis.com/upload/drive/v3/files/**', r => r.request().method() === 'PATCH' ? (dropped++, r.abort('internetdisconnected')) : r.fallback());
    await page.click('#list .bk[data-id="b03"]');
    await page.click('#f-status button[data-v="read"]');
    await page.click('#bkx2');
    await until(() => dropped > 0, 'the change to be sent');
    const sync = () => page.evaluate(() => { const b = document.getElementById('syncBtn'); return [b.dataset.s, document.getElementById('syncTx').textContent, b.title]; });
    await until(async () => (await sync())[0] !== 'busy', 'the sync to end');
    assert.deepEqual(await sync(), ['offline', 'Offline', 'Offline: your changes are kept here and go to Drive when you’re back'], 'a dropped connection reads as a failed sync');
    await wait(450);
    await page.click('#setBtn');
    assert.match(await page.textContent('#driveSect'), /You’re offline\. Changes made here wait on this device and go to Drive when you’re back online\./);
    assert.equal(await page.locator('#driveSect .err').count(), 0, 'Settings shows an error for being offline');
    await page.click('#stx');
    // Back online, it syncs straight away rather than waiting for the minute's timer.
    await ctx.unroute('https://www.googleapis.com/upload/drive/v3/files/**');
    await ctx.setOffline(true);
    await ctx.setOffline(false);
    await until(() => (driveBook('b03') || {}).status === 'read', 'the change to reach Drive once back online', 8000);
    await until(async () => (await sync())[1] === 'Synced', 'the button to say Synced', 5000);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a link opened on a device behind Drive checks its books against Drive, and the sheet catches up as a sync lands', async () => {
  // A laptop and a phone share a Drive. The phone falls behind (its tab closed, then Google's hour up), and opens
  // links for books the laptop has added meanwhile.
  const g = fakeGoogle();
  const driveBooks = () => { const f = g.files().find(f => f.appProperties && f.appProperties.shelfmark === 'library' && !f.trashed); return f && f.body ? JSON.parse(f.body).library.books : {}; };
  const idOf = title => Object.values(driveBooks()).find(b => b.title === title).id;
  const ca = await context(DESK), cb = await context(PHONE);
  await g.install(ca); await g.install(cb);
  const byHand = async (page, title, author) => {
    await page.click('#addBtn'); await page.fill('#f-title', title); await page.fill('#f-authors', author); await page.click('#f-add');
    await until(() => Object.values(driveBooks()).some(b => b.title === title), title + ' to reach Drive');
    await wait(450);
  };
  const rowOf = (page, i) => page.locator(`#rv li[data-i="${i}"]`);
  try {
    const a = await open(ca);
    await seed(a, [MIDDLEMARCH]);
    await connectDrive(a);
    await until(() => driveBooks().b04, 'the laptop\'s library to reach Drive');
    let b = await open(cb);
    await connectDrive(b);
    await until(() => storedBook(b, 'b04'), 'the phone to get it');
    await b.close();

    // The laptop adds two books from a link and leaves the third out.
    const den = linkTo({ name: 'Den shelf', room: 'Den', books: [
      { title: 'Walden', authors: ['Henry David Thoreau'], kind: 'nonfiction', pace: 'fast' },
      { title: 'Moby-Dick', authors: ['Herman Melville'] },
      { title: 'Emma', authors: ['Jane Austen'] },
    ] });
    await a.goto(den);
    await a.waitForSelector('#rv-add');
    await rowOf(a, 2).locator('.rv-tick').click();
    await a.click('#rv-add');
    await until(() => Object.values(driveBooks()).filter(x => !x.del).length === 3, 'the two books to reach Drive');

    // Still signed in, the phone opens the same link: the sheet waits for the sync under way, so it knows them. (Drive
    // takes a second and a half to answer, which the sheet waits out.)
    const slow = ms => async r => { await wait(ms); await r.fallback(); }, media = u => u.hostname === 'www.googleapis.com' && u.searchParams.get('alt') === 'media';
    await cb.route(media, slow(1500));
    b = await open(cb, den);
    await b.waitForSelector('#rv-add');
    await cb.unroute(media);
    assert.equal(await b.textContent('.lede'), 'Den shelf · 3 books · 2 you already have', 'the phone checked the link against its old copy');
    assert.match(await b.textContent('#rv-head'), /You added from this link (just now|\d+ min ago)\. Books you already have are unticked\./);
    assert.deepEqual(await b.$$eval('#rv .rv-tick input', els => els.map(e => e.checked)), [false, false, true]);
    assert.equal(await b.textContent('#rv-add'), 'Add 1 book', 'the phone would add a second Walden and Moby-Dick');
    assert.equal(await b.locator('#behind').count(), 0, 'a phone in step with Drive says it may not be');
    await b.click('#rvx');
    await b.close();

    // The laptop adds two more by hand, and the phone's sign-in runs out (Google's hour).
    await byHand(a, 'Bleak House', 'Charles Dickens');
    await byHand(a, 'Sense and Sensibility', 'Jane Austen');
    const lapsed = await open(cb, base + 'privacy.html');
    await lapsed.evaluate(() => { for (const k of ['junkdrawer.google', 'shelfmark.drive']) localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)), exp: Date.now() - 1000 })); });
    await lapsed.close();
    b = await open(cb, linkTo({ name: 'Hall shelf', books: [
      { title: 'Bleak House', authors: ['Charles Dickens'] },
      { title: 'Persuasion', authors: ['Jane Austen'] },
      { title: 'Sense and Sensibility', authors: ['Jane Austen'] },
    ] }));
    await b.waitForSelector('#rv-add');
    assert.equal(await b.textContent('.lede'), 'Hall shelf · 3 books');
    assert.match(await b.textContent('#behind'), /^This device last synced with Drive (just now|\d+ min ago), so books added on your other devices may not show here yet\.Sync now$/);
    // The person unticks one and corrects a title, then syncs.
    await rowOf(b, 1).locator('.rv-tick').click();
    await rowOf(b, 2).locator('input[data-f="title"]').fill('Sense and Sensibility: A Novel');
    await b.waitForFunction(() => window.google && window.google.accounts);
    await b.click('#behindGo');
    await until(async () => (await b.locator('#behind').count()) === 0, 'the sync to land and the flag to go');
    await until(async () => (await b.textContent('.lede')) === 'Hall shelf · 3 books · 2 you already have', 'the sheet to check the books again');
    assert.deepEqual(await b.$$eval('#rv .rv-tick input', els => els.map(e => e.checked)), [false, false, true], 'a row the person touched changed its tick, or a book found in Drive stayed ticked');
    assert.match(await rowOf(b, 0).textContent(), /Already in your library\. Tick it to add another copy\./);
    assert.equal(await rowOf(b, 0).getAttribute('class'), 'off');
    assert.equal(await rowOf(b, 2).locator('input[data-f="title"]').inputValue(), 'Sense and Sensibility: A Novel', 'the corrected title was undone');
    assert.match(await rowOf(b, 2).textContent(), /Already in your library/, 'the corrected title wasn\'t checked against Drive');
    assert.equal(await b.textContent('#rv-add'), 'Add 1 book');
    await b.click('#rvx');
    await b.close();

    // A details link, while a slow Drive keeps the sync going past the few seconds the sheet waits.
    await byHand(a, 'Ivanhoe', 'Walter Scott');
    await cb.route(media, slow(8000));
    b = await open(cb, detailsLink([
      { id: idOf('Walden'), title: 'Walden', authors: ['Henry David Thoreau'], kind: 'nonfiction', genres: ['nature'], pace: 'slow' },
      { id: idOf('Moby-Dick'), title: 'Moby-Dick', authors: ['Herman Melville'], kind: 'fiction', moods: ['adventurous'] },
      { id: idOf('Ivanhoe'), title: 'Ivanhoe', authors: ['Walter Scott'], kind: 'fiction', genres: ['historical-fiction'] },
    ]));
    await b.waitForSelector('#dtgo');
    assert.equal(await b.textContent('.lede'), 'Reading details · 3 books · 1 not in your library');
    assert.equal(await b.textContent('#behind'), 'Checking Drive for books added on your other devices…');
    assert.equal(await b.textContent('#dt-n'), 'Add the 1 book not in your library first, then open this link again. It fills in only what’s missing.');
    await b.check('#dtRe');
    await until(async () => (await b.textContent('.lede')) === 'Reading details · 3 books', 'the sheet to match the books again once the sync lands', 15000);
    assert.equal(await b.locator('#behind').count(), 0);
    assert.equal(await b.isChecked('#dtRe'), true, 'Replace was unticked');
    assert.equal(await b.textContent('#dtgo'), 'Add details to 3 books');
    assert.equal(await b.textContent('#dt-n'), '');
    await b.click('#dtgo');
    assert.match(await b.textContent('#toastTx'), /Added reading details to 3 books/);
    const mine = Object.values((await stored(b)).library.books);
    const got = t => mine.find(x => x.title === t);
    assert.deepEqual([got('Walden').pace, got('Walden').genres, got('Moby-Dick').moods, got('Ivanhoe').genres], ['slow', ['nature'], ['adventurous'], ['historical-fiction']]);
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');
    assert.deepEqual([...a.problems, ...b.problems], []);
  } finally { await ca.close(); await cb.close(); }
});

step('a details link fills in reading details, and a book\'s card shows and changes them', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    // Two copies of Middlemarch, one named by id and one found by its title and author.
    await seed(page, [PIRANESI, MIDDLEMARCH, { ...CRADLE, kind: 'fiction', moods: ['funny'] }, { ...MIDDLEMARCH, id: 'b06', room: 'Study', shelf: 'Desk' }]);
    await page.goto(detailsLink([
      { id: 'b03', title: 'Piranesi', authors: ['Susanna Clarke'], kind: 'fiction', genres: ['fantasy'], moods: ['mysterious', 'reflective'], pace: 'medium', chapters: 'short', way: 'through', pages: 272, blurb: 'A man keeps a journal in an endless house of statues and tides.' },
      { id: 'zz', title: 'Middlemarch', authors: ['George Eliot'], kind: 'fiction', genres: ['classics'], moods: ['reflective'], pace: 'slow' },
      { id: 'b05', title: 'Cat’s Cradle', authors: ['Kurt Vonnegut, Jr.'], kind: 'fiction', moods: ['dark'], genres: ['sf'] },
      { id: 'b99', title: 'A Book Not Here', authors: ['Nobody'], kind: 'poetry' },
      { id: 'b06', title: 'Middlemarch', authors: ['George Eliot'], kind: 'fiction', genres: ['classics', 'romance'], pace: 'slow' },
    ]));
    await page.waitForSelector('#dtgo');
    assert.equal(await page.textContent('.lede'), 'Reading details · 5 books · 1 not in your library');
    assert.equal(await page.textContent('#dtgo'), 'Add details to 4 books');
    assert.match(await page.textContent('.rv.dt'), /Fiction · Fantasy · Mysterious, reflective · Medium pace · Short chapters · 272 pages/);
    assert.deepEqual(await page.$$eval('.rv.dt .rv-by', els => els.map(e => e.textContent)), ['Susanna Clarke', 'George Eliot · Den', 'Kurt Vonnegut, Jr.', 'George Eliot · Study › Desk'], 'two Middlemarch rows don\'t say which copy each is');
    await page.check('#dtRe');
    assert.equal(await page.textContent('#dtgo'), 'Add details to 4 books', 'replacing changes Cat’s Cradle’s mood too, still four books');
    await page.uncheck('#dtRe');
    await page.click('#dtgo');
    assert.match(await page.textContent('#toastTx'), /Added reading details to 4 books/);
    const p = await storedBook(page, 'b03'), m = await storedBook(page, 'b04'), c = await storedBook(page, 'b05'), m2 = await storedBook(page, 'b06');
    assert.deepEqual([p.kind, p.genres, p.moods, p.chapters, p.pages, p.room, p.notes], ['fiction', ['fantasy'], ['mysterious', 'reflective'], 'short', 272, 'Hall', 'Sam says start here']);
    assert.deepEqual([m.genres, m.pace, m.moods], [['classics'], 'slow', ['reflective']], 'Middlemarch was found by its title and author');
    assert.deepEqual([m2.genres, m2.moods], [['classics', 'romance'], undefined], 'the copy named by id got the other entry\'s details too');
    assert.deepEqual([c.moods, c.genres], [['funny'], ['sf']], 'Cat’s Cradle kept its own mood and gained a genre');

    // The book's card shows them, and a change there is saved.
    await page.click('#list .bk[data-id="b03"]');
    assert.equal(await page.textContent('#f-rdsum'), 'Fiction · Fantasy · Mysterious');
    await page.click('#f-rdsum');
    assert.equal(await page.getAttribute('#f-chapters button[data-v="short"]', 'aria-pressed'), 'true');
    await page.click('#f-moods button[data-m="reflective"]');
    await page.click('#f-moods button[data-m="hopeful"]');
    await page.selectOption('#f-genre', 'literary');
    await page.click('#f-kind button[data-v="fiction"]');
    await page.click('#bkx2');
    const p2 = await storedBook(page, 'b03');
    assert.deepEqual([p2.kind, p2.moods, p2.genres], [undefined, ['mysterious', 'hopeful'], ['fantasy', 'literary']], 'tapping the chosen kind again clears it');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('What to read next chooses by fiction or not, mood and chapters, and leaves cookbooks out', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    await page.click('#nextBtn');
    assert.match(await page.textContent('#nxCrit'), /Ask Claude to add reading details/, 'before any book has details, it says how to get them');
    assert.equal(await page.locator('#nxCrit [data-k="kind"]').count(), 0);
    await page.click('#nxx');
    await seed(page, [
      { ...PIRANESI, kind: 'fiction', moods: ['mysterious', 'reflective'], chapters: 'short', blurb: 'An endless house of statues and tides.' },
      { ...MIDDLEMARCH, kind: 'fiction', moods: ['reflective'], chapters: 'long' },
      { id: 'b06', t: 1000, title: 'Becoming', authors: ['Michelle Obama'], kind: 'nonfiction', moods: ['inspiring'], genres: ['biography'] },
      { id: 'b07', t: 1000, title: 'Salt Fat Acid Heat', authors: ['Samin Nosrat'], kind: 'nonfiction', genres: ['food'], way: 'browse' },
      { id: 'b08', t: 1000, title: 'Not Described', authors: ['Ann Lee'] },
    ]);
    await page.click('#nextBtn');
    assert.equal(await page.textContent('#nxOut > .note'), 'From 4 unread books on hand.', 'the cookbook is left out');
    await page.click('#nxCrit [data-k="kind"][data-v="fiction"]');
    await page.click('#nxCrit [data-mood="mysterious"]');
    assert.equal(await page.textContent('.nx-pick .nx-t'), 'Piranesi');
    assert.equal(await page.textContent('.nx-pick .nx-blurb'), 'An endless house of statues and tides.');
    assert.match(await page.textContent('#nxOut > .note'), /From 1 unread book that matches\. 1 book without reading details can’t match/);
    await page.click('#nxCrit [data-mood="mysterious"]');
    await page.check('#nxShort');
    assert.equal(await page.textContent('.nx-pick .nx-t'), 'Piranesi', 'short chapters leave Middlemarch out');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the mood row scrolls inside the sheet, not the page');
    // The choices are kept for next time; More choices brings the cookbook back.
    await page.click('#nxx');
    await page.click('#nextBtn');
    assert.equal(await page.isChecked('#nxShort'), true);
    await page.uncheck('#nxShort');
    await page.click('#nxCrit [data-k="kind"][data-v="nonfiction"]');
    await page.click('#nxMore summary');
    await page.check('#nxBrowse');
    assert.equal(await page.textContent('#nxOut > .note'), 'From 2 unread books that match. 1 book without reading details can’t match fiction or not, mood, genre, pace or chapters yet.');
    assert.match(await page.textContent('#nxMore summary'), /1 set/);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
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
