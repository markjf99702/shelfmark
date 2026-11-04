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
// The list's titles, in order (a book being read is in Reading now too, at the top: not counted here).
const titles = page => page.$$eval('#list .bk:not([data-now]) .bk-t', els => els.map(e => e.firstChild.textContent));
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
// take `slow` ms to answer, to have lookups on their way at a chosen moment. Look it up's /api/books answers from
// ol.isbns after ol.lookupMs (never, for Infinity; ol.lookupFail drops the connection). ol.referers has the Referer
// each request carried.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function fakeOpenLibrary(ctx, slow = 0) {
  const ol = { searches: 0, isbns: {}, lookupMs: 0, lookupFail: false, lookups: 0, referers: [] };
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await ctx.route('https://openlibrary.org/**', async r => {
    const u = new URL(r.request().url());
    ol.referers.push(r.request().headers()['referer'] || '');
    try {
      if (u.pathname === '/api/books') {
        const key = u.searchParams.get('bibkeys') || '', x = ol.isbns[key.replace('ISBN:', '')];
        ol.lookups++;
        if (ol.lookupFail) return await r.abort();
        await (ol.lookupMs === Infinity ? new Promise(() => {}) : wait(ol.lookupMs));
        return await r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(x ? { [key]: x } : {}) });
      }
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

step('the review screen shows what the batch says of each book, and a long title whole on a phone', async () => {
  const ctx = await context();
  try {
    const long = 'Middlemarch: A Study of Provincial Life, with an Introduction and Notes by the Editor';
    const page = await open(ctx, linkTo({ name: 'Den', books: [
      { title: long, authors: ['George Eliot'], status: 'read', rating: 4, signed: true, first: true, format: 'hardcover' },
      { title: 'Gilead', authors: ['Marilynne Robinson'], status: 'reading', loan: { to: 'Sam' }, format: 'paperback', kind: 'fiction', chapters: 'short', way: 'dip' },
      { title: 'The Overstory', authors: ['Richard Powers'], kind: 'fiction', genres: ['literary'], moods: ['reflective'], pace: 'slow', blurb: 'Nine strangers and the trees that bring them together.' },
    ] }));
    await page.waitForSelector('#rv-add');
    const rows = () => page.$$eval('#rv > li', els => els.map(li => {
      const q = s => li.querySelector(s), st = q('.rv-st');
      return [st.hidden ? '' : [...st.children].map(x => x.getAttribute('aria-label') || x.textContent).join(' | '), (q('.rv-det') || {}).textContent?.replace(/\u00a0/g, ' ') || '', (q('.rv-blurb') || {}).textContent || ''];
    }));
    assert.deepEqual(await rows(), [
      ['Read | 4 of 5 stars | Signed · First edition · Hardcover', '', ''],
      ['Reading | Lent to Sam | Paperback', 'Fiction · Short chapters · Dip in and out', ''],
      ['', 'Fiction · Literary fiction · Reflective · Slow pace', 'Nine strangers and the trees that bring them together.'],
    ]);
    await page.check('#rv-read');
    assert.deepEqual((await rows()).map(r => r[0]), ['Read | 4 of 5 stars | Signed · First edition · Hardcover', 'Reading | Lent to Sam | Paperback', 'Read'], 'I’ve read all of these doesn\'t show which books it marks Read');
    await page.uncheck('#rv-read');
    // The long title shows whole, over three lines, and keeps growing as it's typed into; Enter finishes it.
    const title = page.locator('#rv li').first().locator('[data-f="title"]');
    const box = () => title.evaluate(t => ({ h: t.clientHeight, all: t.scrollHeight <= t.clientHeight + 1, line: parseFloat(getComputedStyle(t).lineHeight) }));
    let b = await box();
    assert.ok(b.all && b.h > 2.5 * b.line, 'the long title isn\'t whole: ' + JSON.stringify(b));
    await title.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(', Volume One of Three, Revised and Expanded, with a New Preface');
    b = await box();
    assert.ok(b.all && b.h > 3.5 * b.line, 'the title didn\'t grow as it was typed: ' + JSON.stringify(b));
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.f || ''), '', 'Enter didn\'t finish the title');
    assert.equal(await title.inputValue(), long + ', Volume One of Three, Revised and Expanded, with a New Preface');
    assert.equal(await page.locator('#rv li').first().locator('.rv-tick input').getAttribute('aria-label'), 'Add “' + long + ', Volume One of Three, Revised and Expanded, with a New Preface”', 'the tick box doesn\'t say the title as it is now');
    assert.equal((await page.locator('#rv li').nth(1).boundingBox()).y > (await page.locator('#rv li').first().boundingBox()).y + 4 * b.line, true, 'the next row is under the title');
    const third = page.locator('#rv li').nth(2).locator('[data-f="title"]');
    await third.fill('The Overstory\nA Novel');
    assert.equal(await third.inputValue(), 'The Overstory A Novel', 'a line break pasted into a title stays');
    await page.click('#rv-add');
    const lib = await stored(page);
    assert.ok(Object.values(lib.library.books).some(x => x.title === long + ', Volume One of Three, Revised and Expanded, with a New Preface' && x.status === 'read' && x.signed), 'the edited title wasn\'t added');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('the review screen\'s place lines follow Shelve them in, to where Add puts each book', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx, linkTo({ name: 'Hall console table', room: 'Hall', shelf: 'Console table', books: [
      { title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Gilead', authors: ['Marilynne Robinson'], shelf: 'Top' },
      { title: 'Emma', authors: ['Jane Austen'], room: 'Bedroom', shelf: 'Nightstand', isbn: '9780141439587' },
    ] }));
    await page.waitForSelector('#rv-add');
    const lines = () => page.$$eval('#rv .rv-meta', els => els.map(e => e.hidden ? '' : e.textContent));
    // A book going where Shelve them in says has no line of its own.
    assert.deepEqual(await lines(), ['', 'Hall › Top', '9780141439587 · Bedroom › Nightstand']);
    await page.fill('#rv-room', 'Study');
    await until(async () => (await lines())[1] === 'Study › Top', 'the place lines to follow the room');
    assert.deepEqual(await lines(), ['', 'Study › Top', '9780141439587 · Study › Nightstand']);
    await page.fill('#rv-shelf', '');
    await until(async () => (await lines())[0] === '' && (await lines())[2] === '9780141439587 · Study › Nightstand', 'the place lines to follow the shelf');
    await page.click('#rv-add');
    const lib = await stored(page);
    assert.deepEqual(Object.values(lib.library.books).map(b => b.title + ' @ ' + [b.room, b.shelf].filter(Boolean).join(' › ')).sort(),
      ['Emma @ Study › Nightstand', 'Gilead @ Study › Top', 'Middlemarch @ Study'], 'Add put a book somewhere its line didn\'t say');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a title or author changed on the review screen is checked against the library again, never unticking a book ticked by hand', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ id: 'bl', t: 1000, title: 'Beloved', authors: ['Toni Morrison'], room: 'Den', added: '2026-10-01' }, PIRANESI]);
    await page.goto(linkTo({ name: 'Den', books: [
      { title: 'Belovd', authors: ['Toni Morrison'] }, { title: 'Belovde', authors: ['Toni Morrison'] }, { title: 'Piranesi', authors: ['Susanna Clarke'] },
    ] }));
    await page.waitForSelector('#rv-add');
    const rows = () => page.$$eval('#rv > li', els => els.map(li => [li.querySelector('.rv-tick input').checked, li.classList.contains('off'), li.querySelector('.rv-have').hidden ? '' : li.querySelector('.rv-have').textContent]));
    assert.deepEqual((await rows()).map(r => r[0]), [true, true, false]);
    // The second row is ticked by hand (off and on again) before its title is put right.
    const tick = i => page.locator('#rv li').nth(i).locator('.rv-tick input');
    await tick(1).uncheck(); await tick(1).check();
    await page.locator('#rv li').nth(0).locator('[data-f="title"]').fill('Beloved');
    await page.locator('#rv li').nth(1).locator('[data-f="title"]').fill('Beloved');
    await page.locator('#rv li').nth(2).locator('[data-f="title"]').fill('Jazz');
    await page.locator('#rv li').nth(2).locator('[data-f="authors"]').fill('Toni Morrison');
    await until(async () => (await rows())[0][2] !== '', 'the edited row to be checked again');
    assert.deepEqual(await rows(), [
      [false, true, 'Already in your library — Den. Tick it to add another copy.'],
      [true, false, 'Already in your library — Den. Tick it to add another copy.'],
      [true, false, ''],
    ]);
    assert.equal(await page.textContent('#rv-add'), 'Add 2 books');
    assert.equal(await page.textContent('.lede'), 'Den · 3 books · 2 you already have');
    // Each tick box names its book, as the title now says, and is described by the row's notes.
    const named = await page.$$eval('#rv .rv-tick input', els => els.map(e => [e.getAttribute('aria-label'), e.getAttribute('aria-describedby').split(' ').map(id => document.getElementById(id).textContent).join(' ').trim()]));
    assert.deepEqual(named, [
      ['Add “Beloved”', 'Already in your library — Den. Tick it to add another copy.'],
      ['Add “Beloved”', 'Already in your library — Den. Tick it to add another copy.'],
      ['Add “Jazz”', ''],
    ]);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('I’ve read all of these marks Read the books added that the batch doesn\'t say are being read', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await page.goto(linkTo({ name: 'Den', room: 'Den', books: [
      { title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Gilead', authors: ['Marilynne Robinson'], status: 'reading' },
      { title: 'Piranesi', authors: ['Susanna Clarke'] }, { title: 'Emma', authors: ['Jane Austen'], status: 'unread' }, { title: 'Walden', authors: ['Henry David Thoreau'] },
    ] }));
    await page.waitForSelector('#rv-add');
    assert.equal(await page.isChecked('#rv-read'), false, 'it starts ticked');
    await page.locator('#rv li').nth(4).locator('.rv-tick input').uncheck();
    await page.check('#rv-read');
    await page.click('#rv-add');
    const got = Object.values((await stored(page)).library.books).filter(b => b.id !== PIRANESI.id).map(b => b.title + ': ' + (b.status || 'unread')).sort();
    assert.deepEqual(got, ['Emma: read', 'Gilead: reading', 'Middlemarch: read'], 'the one already here, and the one unticked, aren\'t added');
    assert.equal((await storedBook(page, PIRANESI.id)).status, undefined, 'the copy already here was marked Read');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('the review screen ticks the next volume of a set, and says when a book here is another edition', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [
      { id: 'v1', t: 1000, title: 'The Lantern Cycle: First Light', authors: ['Ada Quill'], room: 'Den', shelf: 'Top', added: '2026-10-01' },
      { ...MIDDLEMARCH, isbn: '9780141439549' }, { ...PIRANESI }
    ]);
    await page.goto(linkTo({ name: 'Den', books: [
      { title: 'The Lantern Cycle: Second Dark', authors: ['Ada Quill'] }, { title: 'The Lantern Cycle: Third Fire', authors: ['Ada Quill'] },
      { title: 'Middlemarch', authors: ['George Eliot'], isbn: '9780140449136' }, { title: 'Piranesi', authors: ['Susanna Clarke'] },
    ] }));
    await page.waitForSelector('#rv-add');
    const rows = await page.$$eval('#rv > li', els => els.map(li => [li.querySelector('.rv-tick input').checked, [...li.querySelectorAll('.rv-dup')].filter(x => !x.hidden).map(x => x.textContent).join(' / ')]));
    assert.deepEqual(rows, [
      [true, 'You have “The Lantern Cycle: First Light” in Den › Top — another volume?'],
      [true, 'You have “The Lantern Cycle: First Light” in Den › Top — another volume?'],
      [false, 'Another edition is in your library — Den. Tick it to add this one too.'],
      [false, 'Already in your library — Hall. Tick it to add another copy.'],
    ]);
    assert.equal(await page.textContent('.lede'), 'Den · 4 books · 2 you already have');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a book on the review screen that\'s here on another shelf can be moved here instead of added again, with Undo', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...PIRANESI, room: 'Hall', shelf: 'Console table' }, { ...MIDDLEMARCH, room: 'Den', shelf: 'Top' }]);
    const link = linkTo({ name: 'Desk shelf', room: 'Study', shelf: 'Desk', books: [
      { title: 'Piranesi', authors: ['Susanna Clarke'] }, { title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Gilead', authors: ['Marilynne Robinson'] }] });
    const li = n => page.locator('#rv > li').nth(n);
    const places = async () => { const l = (await stored(page)).library.books; return ['b03', 'b04'].map(id => [l[id].room, l[id].shelf].join(' › ')); };
    await page.goto(link);
    await page.waitForSelector('#rv-add');
    assert.equal(await page.textContent('#rv-add'), 'Add 1 book');
    assert.equal(await li(0).locator('.rv-have').textContent(), 'Already in your library — Hall › Console table. Tick it to add another copy. Move it here');
    await li(0).locator('.rv-mv').click();
    assert.equal(await li(0).locator('.rv-mv').getAttribute('aria-pressed'), 'true');
    assert.equal(await li(0).locator('.rv-have').textContent(), 'Moves here from Hall › Console table. Move it here');
    assert.equal(await li(0).evaluate(e => e.classList.contains('off')), false, 'a book moving here reads as left out');
    assert.deepEqual(await tapBoxes(page, '.rv-mv'), [], 'Move it here');
    await li(1).locator('.rv-mv').click();
    assert.equal(await page.textContent('#rv-add'), 'Add 1 book, move 2');
    // Ticked, it's another copy instead; Move it here again unticks it.
    await li(1).locator('.rv-tick input').check();
    assert.deepEqual([await li(1).locator('.rv-mv').getAttribute('aria-pressed'), await page.textContent('#rv-add')], ['false', 'Add 2 books, move 1']);
    await li(1).locator('.rv-mv').click();
    assert.deepEqual([await li(1).locator('.rv-tick input').isChecked(), await page.textContent('#rv-add')], [false, 'Add 1 book, move 2']);
    // Shelved where a book already is, it isn't offered for that one.
    await page.fill('#rv-room', 'Den'); await page.fill('#rv-shelf', 'Top');
    await until(async () => await li(1).locator('.rv-mv').count() === 0, 'Move it here to go from the book already there');
    assert.equal(await page.textContent('#rv-add'), 'Add 1 book, move 1');
    await page.fill('#rv-room', 'Study'); await page.fill('#rv-shelf', 'Desk');
    await until(async () => await li(1).locator('.rv-mv').count() === 1, 'Move it here to come back');
    await li(1).locator('.rv-mv').click();
    await page.click('#rv-add');
    assert.equal(await page.textContent('#toastTx'), 'Added 1 book, moved 2 — newest first');
    assert.deepEqual(await places(), ['Study › Desk', 'Study › Desk']);
    assert.equal((await storedBook(page, 'b03')).notes, 'Sam says start here', 'moving it changed more than its place');
    assert.equal((await titles(page)).length, 3);
    await page.click('#toastBtn');
    assert.equal(await page.textContent('#toastTx'), 'Took it back out, and moved 2 books back');
    assert.deepEqual(await places(), ['Hall › Console table', 'Den › Top']);
    // Only moving: the list stays as it was, and the toast says where they went.
    await wait(450);
    await page.goto(link);
    await page.waitForSelector('#rv-add');
    await li(2).locator('.rv-tick input').uncheck();
    await li(0).locator('.rv-mv').click();
    assert.equal(await page.textContent('#rv-add'), 'Move 1 book');
    await page.click('#rv-add');
    assert.equal(await page.textContent('#toastTx'), 'Moved 1 book to Study › Desk');
    assert.deepEqual(await places(), ['Study › Desk', 'Den › Top']);
    // Here already, it isn't offered again.
    await page.goto(link);
    await page.waitForSelector('#rv-add');
    assert.equal(await li(0).locator('.rv-mv').count(), 0);
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
    const whole = 'This link from Claude didn’t come through whole, so nothing was added. Copy Claude’s whole message and paste it here, or open the file Claude gave you.';
    // Cut to a length atob refuses outright, cut where it decodes but doesn't inflate, and with a character changed:
    // each says so, and opens Import with the keyboard in the paste box, ready for Claude's whole message.
    let n = data.length - 6; while (n % 4 !== 1) n--;
    const page = await open(ctx);
    for (const bad of [data.slice(0, n), data.slice(0, n - 1), data.slice(0, 30) + (data[30] === 'A' ? 'B' : 'A') + data.slice(31)]) {
      await page.goto(base + '#s1z' + bad);
      await until(() => page.evaluate(() => document.getElementById('toast').classList.contains('show')), 'a message');
      assert.equal(await page.textContent('#toastTx'), whole);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'impaste', 'Import isn\'t open with the paste box ready');
      assert.equal(await page.evaluate(() => location.hash), '');
      await page.click('#imx');
      await page.evaluate(() => { document.getElementById('toast').classList.remove('show'); });
    }
    assert.deepEqual(await stored(page), null, 'something was saved');
    await page.goto(base + '#batch={"books":[{"title":"100% Fun"}]}');
    await page.waitForSelector('#rv-add');
    assert.equal(await page.inputValue('#rv [data-f="title"]'), '100% Fun');
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
    assert.equal(await page.inputValue('#rv [data-f="title"]'), 'Middlemarch');
    await page.click('#rvx');
    await wait(450);
    // Without code tools, Claude writes the JSON by hand, in a code block between two lines of its own.
    await page.click('#importBtn');
    await page.fill('#impaste', 'Here are the 2 books from the den:\n\n```json\n' + JSON.stringify({ shelfmark: 1, batch: { name: 'Den', books: [{ title: 'Walden', authors: ['Henry David Thoreau'] }, { title: 'Emma', authors: ['Jane Austen'] }] } }, null, 2) + '\n```\n\nPaste it into Shelfmark (Import › paste box).');
    await page.click('#imgo');
    await page.waitForSelector('#rv-add');
    assert.deepEqual(await page.$$eval('#rv [data-f="title"]', els => els.map(e => e.value)), ['Walden', 'Emma']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('pasting a link or Claude\'s JSON into Import opens it, with no need for Read it under the keyboard', async () => {
  const ctx = await context();
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await open(ctx);
    const paste = async text => { await page.evaluate(t => navigator.clipboard.writeText(t), text); await page.focus('#impaste'); await page.keyboard.press('ControlOrMeta+V'); };
    await page.click('#importBtn');
    await paste('Here are your books: ' + linkTo({ name: 'Den', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }] }));
    await page.waitForSelector('#rv-add');
    assert.equal(await page.inputValue('#rv [data-f="title"]'), 'Middlemarch');
    await page.click('#rvx');
    await wait(450);
    await page.click('#importBtn');
    await paste(JSON.stringify({ shelfmark: 1, batch: { name: 'Hall', books: [{ title: 'Walden', authors: ['Henry David Thoreau'] }] } }, null, 2));
    await page.waitForSelector('#rv-add');
    assert.equal(await page.inputValue('#rv [data-f="title"]'), 'Walden');
    await page.click('#rvx');
    await wait(450);
    // Words that are neither wait for Read it, with nothing said meanwhile.
    await page.click('#importBtn');
    await paste('Middlemarch');
    await wait(400);
    assert.equal(await page.inputValue('#impaste'), 'Middlemarch');
    assert.equal(await page.evaluate(() => document.getElementById('toast').classList.contains('show')), false, 'a word pasted was read as a link');
    assert.equal(await page.isVisible('#imgo'), true);
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

step('a long list draws rows out of sight only as they come near, and the last one still opens and takes focus back', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, Array.from({ length: 150 }, (_, i) => ({ id: 'n' + i, t: 1000 + i, title: 'Book number ' + (i + 1), authors: ['Ann Lee'], added: '2026-10-01' })));
    // (Find-in-page can't be tried here: headless Chromium's window.find finds nothing, even on screen.)
    assert.equal(await page.$eval('#list .bk', e => getComputedStyle(e).contentVisibility), 'auto');
    const last = page.locator('#list .bk >> nth=-1');
    await last.click();
    assert.equal(await sheetOpen(page), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.id), await last.getAttribute('data-id'), 'focus didn\'t come back to the row');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

// A long made-up library whose rows are of every height: titles of one to three lines, and some with a place,
// a status or a loan under them.
function longList(n) {
  const words = ['Lantern', 'Harbor', 'Orchard', 'Winter', 'Glass', 'River', 'Meadow', 'Signal', 'Copper', 'Thistle', 'Ember', 'Quarry'];
  return Array.from({ length: n }, (_, i) => ({
    id: 'p' + String(i).padStart(3, '0'), t: 1000 + i, added: '2026-10-01',
    title: 'The ' + words[i % 12] + ' ' + words[(i * 5) % 12] + (i % 3 ? '' : ' and the Long Road Back to ' + words[(i * 7) % 12]) + (i % 7 ? '' : ': A Story of the Far North, the Sea and the Years Between'),
    authors: [['Ann Lee'], ['Maria Delgado-Fernández', 'Tomasz Wiśniewski'], ['B. Okafor']][i % 3],
    ...(i % 2 ? { room: 'Living room', shelf: 'Tall bookcase by the window, second from the top' } : {}),
    ...(i % 5 ? {} : { status: 'read', rating: 4 }), ...(i % 11 ? {} : { loan: { to: 'Sam', since: '2026-10-02' } }),
  }));
}

step('the list keeps its place when it\'s drawn again: a chip, a book marked Read, another tab', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, longList(260));
    // The first row wholly below the top bar (and clear of the room kept for the keyboard under it), and where it is.
    const first = () => page.evaluate(() => {
      const bar = document.querySelector('.top').getBoundingClientRect().bottom;
      const r = [...document.querySelectorAll('#list .bk')].find(e => e.getBoundingClientRect().top >= bar + 16);
      return { id: r.dataset.id, top: r.getBoundingClientRect().top };
    });
    const topOf = id => page.$eval(`#list .bk[data-id="${id}"]`, e => e.getBoundingClientRect().top);
    const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100)))));
    await page.evaluate(() => scrollTo(0, 6000));
    await settle();
    const at = await first();
    // A tap on the chip already chosen draws the list again, with nothing changed (the chips are scrolled off, so it's clicked from the page).
    await page.$eval('#chips .chip[data-s=""]', e => e.click());
    await settle();
    assert.ok(Math.abs(await topOf(at.id) - at.top) <= 2, 'a redraw moved the row in view from ' + at.top + ' to ' + await topOf(at.id));
    // Opening the row, marking it Read and closing its card saves it, which draws the list again behind the card.
    await page.click(`#list .bk[data-id="${at.id}"]`);
    await page.click('#f-status button[data-v="read"]');
    await wait(700);
    await page.click('#bkx2');
    await settle();
    assert.equal((await storedBook(page, at.id)).status, 'read');
    assert.ok(Math.abs(await topOf(at.id) - at.top) <= 2, 'marking a book Read moved it from ' + at.top + ' to ' + await topOf(at.id));
    // Another tab changes a book far down the list.
    const other = await open(ctx);
    await other.evaluate(() => { const d = JSON.parse(localStorage.getItem('shelfmark.library')); const b = d.library.books.p250; b.title += ' (Revised)'; b.t = Date.now(); localStorage.setItem('shelfmark.library', JSON.stringify(d)); });
    await until(async () => (await page.textContent('#list .bk[data-id="p250"] .bk-t')).includes('Revised'), 'the other tab\'s change');
    await settle();
    assert.ok(Math.abs(await topOf(at.id) - at.top) <= 2, 'another tab\'s change moved the row in view from ' + at.top + ' to ' + await topOf(at.id));
    assert.deepEqual([...page.problems, ...other.problems], []);
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

step('a search under a filter says the book is in the library, and Search all books finds it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH, { id: 'b06', t: 1000, title: 'The Hobbit', authors: ['J. R. R. Tolkien'], status: 'read', room: 'Den' }]);
    await page.click('#chips .chip[data-s="unread"]');
    await page.fill('#q', 'hobbit');
    await until(async () => /Nothing here/.test(await page.textContent('#list')), 'the search');
    assert.equal(await page.textContent('#list .empty p'), 'Nothing here matches “hobbit”, but 1 book in your whole library does.', 'the Unread chip hides the book, not the search');
    await page.click('#list [data-act="all"]');
    assert.deepEqual(await titles(page), ['The Hobbit']);
    assert.equal(await page.inputValue('#q'), 'hobbit', 'the search is kept');
    assert.equal(await page.getAttribute('#chips .chip[data-s=""]', 'aria-pressed'), 'true');
    // A room chosen does the same; a search nothing in the library matches still says so.
    await page.selectOption('#roomSel', 'Hall');
    await until(async () => /Nothing here/.test(await page.textContent('#list')), 'the room');
    await page.fill('#q', 'dragonflight');
    await until(async () => /No book matches/.test(await page.textContent('#list')), 'the second search');
    assert.equal(await page.textContent('#list .empty p'), 'No book matches “dragonflight”.');
    assert.equal(await page.locator('#list [data-act="all"]').count(), 0);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a room typed with other capitals is one room: one By shelf heading, one Room option', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    const left = { room: 'Living room', shelf: 'Left bookcase' };
    await seed(page, [{ ...PIRANESI, ...left }, { ...MIDDLEMARCH, ...left }, { id: 'b06', t: 1000, title: 'The Hobbit', authors: ['J. R. R. Tolkien'], ...left },
      // Saved before with other capitals: shown with the rest, and left as it was saved.
      { ...CRADLE, room: 'living Room', shelf: 'left bookcase' }]);
    await page.selectOption('#sortSel', 'shelf');
    const heads = () => page.$$eval('#list .grp', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    const rooms = () => page.$$eval('#roomSel option', els => els.map(e => e.textContent));
    assert.equal((await heads()).length, 1, 'By shelf splits one shelf: ' + await heads());
    assert.equal(await page.getByRole('heading', { name: /^Living room › Left bookcase ?, 4 books$/i }).count(), 1, 'the shelf heading\'s count runs into its name: ' + await heads());
    assert.deepEqual(await rooms(), ['All rooms', 'Living room']);
    await page.selectOption('#roomSel', 'Living room');
    assert.equal((await titles(page)).length, 4, 'the room menu leaves out a book saved with other capitals');
    await page.selectOption('#roomSel', '');
    // Typed on a card, the room and shelf are saved as the library spells them.
    await page.click('#list .bk[data-id="b06"]');
    await page.fill('#f-room', 'LIVING  ROOM ');
    await page.fill('#f-shelf', 'Left Bookcase');
    await page.click('#bkx2');
    assert.deepEqual([(await storedBook(page, 'b06')).room, (await storedBook(page, 'b06')).shelf], ['Living room', 'Left bookcase']);
    assert.deepEqual([(await storedBook(page, 'b05')).room, (await storedBook(page, 'b05')).shelf], ['living Room', 'left bookcase'], 'a book saved before was rewritten');
    assert.equal((await heads()).length, 1);
    // So is a book added by hand, and a batch from a new chat with Claude, its Shelve them in fields included.
    await wait(450); // a tap where Done was is ignored for a moment after (see tapGuard), and + is near it
    await page.click('#addBtn');
    await page.fill('#f-title', 'Walden');
    await page.fill('#f-room', 'living room');
    await page.click('#f-add');
    await page.goto(linkTo({ name: 'Living room', room: 'LIVING ROOM', shelf: 'left BOOKCASE', books: [{ title: 'Emma', authors: ['Jane Austen'] }, { title: 'Dracula', authors: ['Bram Stoker'], room: 'Living Room', shelf: 'Left Bookcase' }] }));
    await page.waitForSelector('#rv-add');
    assert.deepEqual([await page.inputValue('#rv-room'), await page.inputValue('#rv-shelf')], ['Living room', 'Left bookcase']);
    await page.click('#rv-add');
    const lib = Object.values((await stored(page)).library.books).filter(b => !b.del);
    assert.deepEqual(lib.filter(b => ['Walden', 'Emma', 'Dracula'].includes(b.title)).map(b => [b.title, b.room, b.shelf || '']).sort(),
      [['Dracula', 'Living room', 'Left bookcase'], ['Emma', 'Living room', 'Left bookcase'], ['Walden', 'Living room', '']]);
    await page.selectOption('#sortSel', 'shelf');
    assert.equal((await heads()).length, 2, 'Walden has no shelf, so it has its own heading: ' + await heads());
    assert.deepEqual(await rooms(), ['All rooms', 'Living room']);
    // What to read next's room menu has it once too.
    await page.click('#nextBtn');
    await page.click('#nxMore summary');
    assert.deepEqual(await page.$$eval('#nxRoom option', els => els.map(e => e.textContent)), ['Any room', 'Living room']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('by shelf, a row doesn\'t repeat the room and shelf over it, and the heading counts its books in words', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...PIRANESI, room: 'Porch', shelf: '1', status: 'read', rating: 4 }, { ...MIDDLEMARCH, room: 'Porch', shelf: '1', check: 'glare' },
      { ...CRADLE, room: 'Bedroom', loan: { to: 'Sam' } }]);
    await page.selectOption('#sortSel', 'shelf');
    assert.equal(await page.locator('#list .loc').count(), 0, 'rows under a shelf heading say its place again');
    assert.equal(await page.locator('#list .bk[data-id="b03"] .bdg.read').count(), 1, 'the Read badge went with the place');
    assert.equal(await page.locator('#list .bk[data-id="b04"] .bdg.check').count(), 1);
    assert.match(await page.textContent('#list .bk[data-id="b05"] .bdg.lent'), /Lent to Sam/);
    const counts = await page.$$eval('#list .grp .n', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    for (const c of counts) assert.match(c, /\d+ books?$/);
    assert.deepEqual(counts.map(c => c.replace(/^, /, '')), ['1 book', '2 books']);
    // The count reads as a count, not as part of the shelf's name ("Porch › 1 2"): not in capitals, and not in the name's type.
    const [name, n] = await page.$eval('#list .grp >> nth=1', h => [getComputedStyle(h), getComputedStyle(h.querySelector('.n'))].map(c => [c.textTransform, c.fontFamily]));
    assert.notDeepEqual(n, name, 'the count looks like the shelf\'s name');
    assert.equal(n[0], 'none');
    // Any other sort still says where each book is.
    await page.selectOption('#sortSel', 'author');
    assert.equal(await page.locator('#list .loc').count(), 3);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('by shelf, a shelf\'s heading stays under the top bar while its books go by, on a phone and in columns', async () => {
  for (const opts of [PHONE, DESK]) {
    const ctx = await context(opts);
    try {
      const page = await open(ctx);
      const many = Array.from({ length: 70 }, (_, i) => ({ id: 'q' + String(i).padStart(2, '0'), t: 1000 + i, title: 'Book ' + String(i + 1).padStart(2, '0'), authors: ['Ann Lee'],
        room: i < 40 ? 'Living room' : 'Study', shelf: i < 40 ? 'Tall bookcase' : 'Desk shelf' }));
      await seed(page, many);
      await page.selectOption('#sortSel', 'shelf');
      const at = () => page.evaluate(() => {
        const bar = document.querySelector('.top').getBoundingClientRect().bottom, h = [...document.querySelectorAll('#list .grp')].map(e => e.getBoundingClientRect());
        return { bar, first: h[0].top, firstBottom: h[0].bottom, second: h[1].top };
      });
      await page.evaluate(() => scrollTo(0, innerWidth > 720 ? 500 : 1500));
      const mid = await at();
      assert.ok(Math.abs(mid.first - mid.bar) <= 1, 'mid-shelf, its heading is at ' + mid.first + ', not under the top bar at ' + mid.bar);
      // The heading goes with its shelf once the shelf has gone by, and the next one takes its place.
      // (Rows out of sight have no height of their own until they come near, so this takes a few goes.)
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => scrollBy(0, document.querySelectorAll('#list .grp')[1].getBoundingClientRect().top - document.querySelector('.top').getBoundingClientRect().bottom - 20));
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      }
      const late = await at();
      assert.ok(late.first < late.bar, 'the first shelf\'s heading stayed after its books had gone');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'a heading\'s rule runs off the side');
      // The keyboard, going up the list, keeps the book it's on clear of the heading.
      await page.evaluate(() => scrollTo(0, innerWidth > 720 ? 500 : 1500));
      await page.focus('#list .bk[data-id="q30"]');
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Shift+Tab');
        const [top, under] = await page.evaluate(() => [document.activeElement.getBoundingClientRect().top, document.querySelector('#list .grp').getBoundingClientRect().bottom]);
        assert.ok(top >= under - 0.5, 'Shift+Tab left a book under the shelf heading: its top at ' + top + ', the heading\'s bottom at ' + under);
      }
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('by shelf, Move on a shelf\'s heading moves or renames the whole shelf at once, with Undo', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...PIRANESI, room: 'Living room', shelf: 'Left bookcase' }, { ...MIDDLEMARCH, room: 'Living room', shelf: 'left bookcase', status: 'read' },
      { ...CRADLE, room: 'Living room', shelf: 'Left bookcase' }, { id: 'b06', t: 1000, title: 'Emma', authors: ['Jane Austen'], room: 'Study', shelf: 'Desk' },
      { id: 'b07', t: 1000, title: 'Moby-Dick', authors: ['Herman Melville'], wanted: true }]);
    await page.selectOption('#sortSel', 'shelf');
    const heads = () => page.$$eval('#list .shelf .grp', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    const places = async () => { const l = (await stored(page)).library.books; return ['b03', 'b04', 'b05', 'b06'].map(id => [l[id].room, l[id].shelf].join(' › ')); };
    // With Unread chosen the heading counts 2 of the shelf's 3 books; Move moves all 3, and says so.
    await page.click('#chips .chip[data-s="unread"]');
    assert.deepEqual(await heads(), ['Living room › Left bookcase, 2 books', 'Study › Desk, 1 book']);
    assert.equal(await page.getAttribute('#list [data-mv] >> nth=0', 'aria-label'), 'Move or rename Living room › Left bookcase');
    await page.click('#list [data-mv] >> nth=0');
    assert.equal(await page.textContent('#sheetTitle'), 'Move 3 books');
    assert.equal(await page.textContent('#sheet .lede'), 'Every book on Living room › Left bookcase, the one your filters hide too. Change the room to move them all, or only the shelf to rename it.');
    assert.deepEqual([await page.inputValue('#mv-room'), await page.inputValue('#mv-shelf'), await page.isDisabled('#mvgo')], ['Living room', 'Left bookcase', true], 'the boxes don\'t start as where the books are');
    await page.fill('#mv-room', 'study');
    await page.fill('#mv-shelf', 'desk');
    assert.equal(await page.textContent('#mv-n'), 'They join the book on Study › Desk.');
    await page.click('#mvgo');
    assert.equal(await sheetOpen(page), false);
    assert.equal(await page.textContent('#toastTx'), 'Moved 3 books to Study › Desk');
    assert.deepEqual(await places(), ['Study › Desk', 'Study › Desk', 'Study › Desk', 'Study › Desk'], 'the books aren\'t spelled as the shelf they joined');
    assert.deepEqual(await heads(), ['Study › Desk, 3 books']);
    // Undo puts each back as it was spelled.
    await page.click('#toastBtn');
    assert.deepEqual(await places(), ['Living room › Left bookcase', 'Living room › left bookcase', 'Living room › Left bookcase', 'Study › Desk']);
    // Only the shelf changed renames it; Enter in Shelf is Move. The wishlist's heading has no Move.
    await wait(450);
    await page.click('#chips .chip[data-s=""]');
    await page.click('#list [data-mv] >> nth=0');
    await page.fill('#mv-shelf', 'Tall bookcase');
    await page.press('#mv-shelf', 'Enter');
    assert.equal(await page.textContent('#toastTx'), 'Moved 3 books to Living room › Tall bookcase');
    assert.deepEqual(await places(), ['Living room › Tall bookcase', 'Living room › Tall bookcase', 'Living room › Tall bookcase', 'Study › Desk']);
    await page.fill('#q', 'm');
    await until(async () => (await heads()).some(h => /wishlist/.test(h)), 'the search');
    assert.deepEqual(await page.$$eval('#list .shelf', els => els.map(e => e.querySelector('.grp').textContent.replace(/\s+/g, ' ') + ': ' + e.querySelectorAll('[data-mv]').length)),
      ['Living room › Tall bookcase, 1 book: 1', 'On your wishlist, 1 book: 0'], 'the wishlist has a Move');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('on a phone a shelf\'s Move answers a tap 44px tall inside its heading, and the heading stays under the top bar with it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, Array.from({ length: 30 }, (_, i) => ({ id: 'q' + i, t: 1000, title: 'Book ' + i, authors: ['Ann Lee'], room: 'Living room', shelf: i < 20 ? 'Tall bookcase' : 'Window' })));
    await page.selectOption('#sortSel', 'shelf');
    await page.evaluate(() => scrollTo(0, 1200));
    // (the invisible box is placed from inside the button's border)
    const [gh, top, bottom, bar] = await page.evaluate(() => {
      const g = document.querySelectorAll('#list .gh')[0], b = g.querySelector('[data-mv]'), a = getComputedStyle(b, '::after'), c = getComputedStyle(b), r = b.getBoundingClientRect();
      return [g.getBoundingClientRect().toJSON(), r.top + parseFloat(c.borderTopWidth) + parseFloat(a.top), r.bottom - parseFloat(c.borderBottomWidth) - parseFloat(a.bottom), document.querySelector('.top').getBoundingClientRect().bottom];
    });
    assert.ok(Math.abs(gh.top - bar) <= 1, 'the heading isn\'t under the top bar: ' + gh.top + ' and ' + bar);
    assert.ok(bottom - top >= 43.5, 'Move answers a tap only ' + (bottom - top) + 'px tall');
    assert.ok(top >= gh.top - 0.5 && bottom <= gh.bottom + 0.5, 'Move\'s taps reach past its heading');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a book to check says To check, and the To check view says what to check', async () => {
  for (const width of [390, 320]) {
    const ctx = await context({ ...PHONE, viewport: { width, height: 760 } });
    try {
      const page = await open(ctx);
      const long = 'The spine shows a publication date, which usually means an advance reading copy, so check it isn’t a proof; and there are two volumes, and the spine doesn’t show which one this is';
      await seed(page, [{ ...PIRANESI, check: 'glare on the spine' }, { ...MIDDLEMARCH, check: long }, CRADLE]);
      assert.equal(await page.textContent('#list .bk[data-id="b03"] .bdg.check'), 'To check', 'the badge reads like a tick of approval');
      await page.click('#chips .chip[data-s="check"]');
      assert.deepEqual(await titles(page), ['Piranesi', 'Middlemarch']);
      assert.equal(await page.textContent('#list .bk[data-id="b03"] .bk-ck'), 'Check: glare on the spine');
      assert.equal(await page.locator('#list .bdg.check').count(), 0, 'the reason takes the badge\'s place');
      // A long reason is two lines at most, and nothing runs off the side.
      const [h, lh] = await page.$eval('#list .bk[data-id="b04"] .bk-ck', e => [e.getBoundingClientRect().height, parseFloat(getComputedStyle(e).lineHeight)]);
      assert.ok(h <= 2 * lh + 1, 'the reason runs to ' + h + 'px, more than two lines of ' + lh);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('settling the last book to check, or the last loan, says so, and the chip chosen instead is in view', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...PIRANESI, check: 'glare on the spine' }, { ...MIDDLEMARCH, check: 'two volumes?' }, CRADLE,
      { id: 'b06', t: 1000, title: 'The Hobbit', authors: ['J. R. R. Tolkien'], status: 'reading' },
      { id: 'b07', t: 1000, title: 'Emma', authors: ['Jane Austen'], status: 'read' },
      { id: 'b08', t: 1000, title: 'Dracula', authors: ['Bram Stoker'], loan: { to: 'Sam', since: '2026-10-02' } }]);
    const inView = sel => page.evaluate(q => { const c = document.getElementById('chips').getBoundingClientRect(), r = document.querySelector(q).getBoundingClientRect(); return r.left >= c.left - 0.5 && r.right <= c.right + 0.5; }, sel);
    const settle = async (id, ok) => { await page.click(`#list .bk[data-id="${id}"]`); await page.click(ok); await page.click('#bkx2'); };
    await page.click('#chips .chip[data-s="check"]');
    assert.ok(await page.$eval('#chips', e => e.scrollLeft > 0), 'the chip row doesn\'t scroll here, so this checks nothing');
    await settle('b03', '#f-ok');
    assert.equal(await page.textContent('#toastTx'), 'Checked “Piranesi”. 1 left to check.');
    await wait(450);
    await settle('b04', '#f-ok');
    assert.equal(await page.textContent('#toastTx'), 'Checked “Middlemarch”. That was the last one to check.');
    assert.equal(await page.getAttribute('#chips .chip[data-s=""]', 'aria-pressed'), 'true');
    assert.equal(await inView('#chips .chip[data-s=""]'), true, 'All is chosen, but scrolled out of sight');
    // The last loan, given back with It's back: its toast says so too, and keeps its Undo.
    await wait(450);
    await page.click('#chips .chip[data-s="lent"]');
    await settle('b08', '#f-back');
    assert.equal(await page.textContent('#toastTx'), 'Back from Sam. That was the last book out.');
    assert.equal(await inView('#chips .chip[data-s=""]'), true);
    await page.click('#toastBtn');
    assert.deepEqual((await storedBook(page, 'b08')).loan, { to: 'Sam', since: '2026-10-02' });
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a toast\'s Undo goes with the toast, and from the keyboard Undo takes the keyboard while it shows', async () => {
  const ctx = await context(DESK);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH, CRADLE]);
    const shown = () => page.evaluate(() => document.getElementById('toast').classList.contains('show'));
    const focused = () => page.evaluate(() => document.activeElement.id || document.activeElement.dataset.id || document.activeElement.tagName);
    // With a mouse: once the toast has gone, its Undo can't be reached or used, and its words don't linger.
    await page.click('#list .bk[data-id="b04"]');
    await page.click('#f-del');
    assert.match(await page.textContent('#toastTx'), /Removed “Middlemarch”/);
    await page.mouse.move(5, 5);
    await until(async () => !(await shown()), 'the toast to go', 9000);
    await wait(500);
    assert.equal(await page.isHidden('#toastBtn'), true, 'the gone toast\'s Undo can still be reached');
    assert.equal(await page.textContent('#toastTx'), '', 'the gone toast\'s words stay in the page');
    await page.focus('.foot a >> nth=-1');
    await page.keyboard.press('Tab');
    assert.notEqual(await focused(), 'toastBtn', 'Tab past the footer reaches the gone Undo');
    await page.keyboard.press('Enter');
    await page.evaluate(() => document.getElementById('toastBtn').click());
    assert.deepEqual(await titles(page), ['Piranesi', 'Cat’s Cradle'], 'Undo brought the book back after its toast had gone');
    // From the keyboard: Remove puts the keyboard on Undo, and the toast stays while it's there; Undo brings the book
    // back and the keyboard to it.
    await page.focus('#list .bk[data-id="b03"]');
    await page.keyboard.press('Enter');
    await page.focus('#f-del');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'toastBtn', 'Remove from the keyboard leaves Undo out of reach');
    await wait(6500);
    assert.equal(await shown(), true, 'the toast went with the keyboard on its Undo');
    await page.keyboard.press('Enter');
    assert.deepEqual(await titles(page), ['Piranesi', 'Cat’s Cradle']);
    assert.equal(await focused(), 'b03', 'the keyboard didn\'t go to the book brought back');
    // When the toast goes with the keyboard on it (Escape here), the keyboard goes to the book that took the removed one's place.
    await page.keyboard.press('Enter');
    await page.focus('#f-del');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'toastBtn');
    await page.keyboard.press('Escape');
    assert.equal(await shown(), false);
    assert.equal(await focused(), 'b05', 'the keyboard didn\'t go to the next book');
    assert.deepEqual(page.problems, []);
    // Start reading from the keyboard goes to Undo too, and back to What to read next? after.
    await page.close();
    const next = await open(ctx);
    await seed(next, [PIRANESI, MIDDLEMARCH, CRADLE]);
    await next.focus('#nextBtn');
    await next.keyboard.press('Enter');
    await next.focus('#nxGo');
    await next.keyboard.press('Enter');
    const on = () => next.evaluate(() => document.activeElement.id);
    assert.equal(await on(), 'toastBtn');
    await next.keyboard.press('Escape');
    assert.equal(await on(), 'nextBtn');
    assert.deepEqual(next.problems, []);
  } finally { await ctx.close(); }
});

step('a tap on a toast\'s words doesn\'t keep it on a phone, and a mouse over it does', async () => {
  for (const opts of [PHONE, DESK]) {
    const ctx = await context(opts);
    try {
      const page = await open(ctx);
      await seed(page, [PIRANESI, MIDDLEMARCH, CRADLE]);
      const shown = () => page.evaluate(() => document.getElementById('toast').classList.contains('show'));
      await page.click('#list .bk[data-id="b04"]');
      await page.click('#f-del');
      assert.match(await page.textContent('#toastTx'), /Removed “Middlemarch”/);
      const ms = 6000; // a toast with a button shows for 6 seconds
      if (opts.hasTouch) {
        // A thumb on the words, to read them or by mistake: a phone sends a mouseenter for it, and no mouseleave after.
        const box = await page.locator('#toastTx').boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await wait(ms + 1000);
        assert.equal(await shown(), false, 'a tap on the toast kept it on screen');
        assert.equal(await page.isHidden('#toastBtn'), true, 'the toast\'s Undo stayed live');
      } else {
        await page.hover('#toastTx');
        await wait(ms + 1000);
        assert.equal(await shown(), true, 'the toast went with the mouse on it');
        await page.mouse.move(5, 5);
        await until(async () => !(await shown()), 'the toast to go once the mouse left it', ms + 2000);
      }
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('a redraw keeps the keyboard where it was: on a chip pressed, and on a book while another tab changes the library', async () => {
  const ctx = await context(DESK);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH, CRADLE]);
    const focused = () => page.evaluate(() => { const a = document.activeElement; return a.dataset.id || (a.classList.contains('chip') ? 'chip:' + a.dataset.s : a.tagName); });
    await page.focus('#chips .chip[data-s="unread"]');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'chip:unread', 'pressing a chip loses the keyboard');
    await page.focus('#list .bk[data-id="b04"]');
    const other = await open(ctx);
    await other.click('#list .bk[data-id="b03"]');
    await other.click('#f-status button[data-v="read"]');
    await other.click('#bkx2');
    await until(async () => !(await titles(page)).includes('Piranesi'), 'the other tab\'s change to show');
    assert.equal(await focused(), 'b04', 'another tab\'s change loses the keyboard\'s place in the list');
    assert.deepEqual([...page.problems, ...other.problems], []);
  } finally { await ctx.close(); }
});

step('on a phone Import says Import beside the sync button\'s dot, and nothing scrolls sideways in any sync state', async () => {
  // off: sync not turned on; ok: synced (a dot); tap: Google's hour is up (Sync); offline; err: Sync failed.
  const STATES = { off: null, ok: {}, tap: { token: '', exp: 0 }, offline: {}, err: {} };
  for (const width of [390, 360, 320]) {
    const g = fakeGoogle(), ctx = await context({ ...PHONE, viewport: { width, height: 740 } });
    let mode = 'ok';
    await g.install(ctx);
    await ctx.route('https://www.googleapis.com/**', r => mode === 'offline' ? r.abort('internetdisconnected')
      : mode === 'err' && r.request().method() !== 'OPTIONS' ? r.fulfill({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":{"message":"Backend Error"}}' }) : r.fallback());
    try {
      const page = await open(ctx);
      // Enough books that the search box goes up under the top bar, and the search button shows there too.
      await seed(page, [PIRANESI, MIDDLEMARCH, ...Array.from({ length: 20 }, (_, i) => ({ id: 'z' + i, t: 1000, title: 'Book ' + (i + 1), authors: ['Ann Lee'] }))]);
      for (const [state, drive] of Object.entries(STATES)) {
        mode = state;
        await page.evaluate(d => { if (d) localStorage.setItem('shelfmark.drive', JSON.stringify({ on: true, token: 'tok-mark', exp: Date.now() + 3e6, ...d })); else localStorage.removeItem('shelfmark.drive'); }, drive);
        await page.reload();
        if (drive) await until(() => page.evaluate(s => document.getElementById('syncBtn').dataset.s === s, state), 'the sync button to show ' + state, 10000);
        for (const down of [false, true]) {
          // (scrolled again until it holds: a reload puts the page back where it was a moment later)
          await until(() => page.evaluate(d => { scrollTo(0, d ? 900 : 0); return document.getElementById('findBtn').hidden === !d; }, down), 'the search button to ' + (down ? 'show' : 'go') + ' at ' + width + ' with sync ' + state, 5000);
          const at = width + ' with sync ' + state + (down ? ' and the search button' : '');
          const word = await page.locator('#importBtn .t').isVisible();
          assert.equal(word, (state === 'off' || width >= 360 && state === 'ok') && (!down || width >= 375), 'Import\'s word at ' + at);
          // The brand and the buttons stay in the bar, none over another, and nothing scrolls sideways.
          const boxes = await page.$$eval('.top-in > :not([hidden])', els => els.filter(e => getComputedStyle(e).position !== 'fixed').map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
          for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], 'the top bar\'s buttons overlap at ' + at + ': ' + JSON.stringify(boxes));
          assert.ok(boxes[boxes.length - 1][1] <= width, 'the top bar runs off the screen at ' + at);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways at ' + at);
        }
      }
      assert.deepEqual(page.problems.filter(p => !/500|Failed to load resource/.test(p)), []);
    } finally { await ctx.close(); }
  }
});

step('once the search box has gone up under the top bar, a search button there brings it back with the keyboard in it', async () => {
  for (const opts of [PHONE, DESK]) {
    const ctx = await context(opts);
    try {
      const page = await open(ctx);
      await seed(page, Array.from({ length: 40 }, (_, i) => ({ id: 'q' + i, t: 1000, title: 'Book ' + String(i + 1).padStart(2, '0'), authors: ['Ann Lee'] })));
      assert.equal(await page.isVisible('#findBtn'), false, 'the search button shows with the search box in sight');
      await page.evaluate(() => scrollTo(0, 2000));
      await until(() => page.isVisible('#findBtn'), 'the search button to show');
      assert.equal(await page.getByRole('button', { name: 'Search', exact: true }).getAttribute('id'), 'findBtn', 'the search button has no name');
      await page.click('#findBtn');
      assert.equal(await page.evaluate(() => scrollY), 0, 'the page didn\'t go back to the top');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'q', 'the keyboard isn\'t in the search box');
      await until(async () => !(await page.isVisible('#findBtn')), 'the search button to go at the top');
      // A search typed then is a search like any other.
      await page.keyboard.type('book 07');
      await until(async () => (await titles(page)).join() === 'Book 07', 'the search to find the book');
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('with a mouse at 200% zoom the chips and moods wrap, and the keyboard keeps the book it\'s on clear of the top bar and the + button', async () => {
  // A 1280 by 800 screen at 200% zoom is 640 by 400 CSS pixels: the phone's layout, with a mouse and no touch.
  const ctx = await context({ viewport: { width: 640, height: 400 } });
  try {
    const page = await open(ctx);
    const MOODS = ['adventurous', 'challenging', 'dark', 'emotional', 'funny', 'hopeful', 'informative', 'inspiring', 'lighthearted', 'mysterious', 'reflective', 'relaxing', 'sad', 'tense'];
    await seed(page, Array.from({ length: 30 }, (_, i) => ({ id: 'z' + i, t: 1000 + i, title: 'Book ' + String(i + 1).padStart(2, '0'), authors: ['Ann Lee'], kind: 'fiction', moods: [MOODS[i % 14]],
      status: i === 0 ? 'reading' : i === 1 ? 'read' : '', loan: i === 2 ? { to: 'Sam' } : null, check: i === 3 ? 'glare' : '' })));
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Your library', 'the page has no main heading');
    const fit = sel => page.$$eval(sel, els => els.filter(e => e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.textContent));
    assert.deepEqual(await fit('#chips .chip'), [], 'chips are cut off at the side, out of a mouse\'s reach');
    assert.deepEqual(await page.$eval('#chips', e => [e.classList.contains('fade-l'), e.classList.contains('fade-r')]), [false, false]);
    // Up the list with Shift+Tab, and down it with Tab: the book with the keyboard is never under the top bar or the + button.
    const where = () => page.evaluate(() => { const a = document.activeElement.getBoundingClientRect(); return [a.top, a.bottom, document.querySelector('.top').getBoundingClientRect().bottom, document.getElementById('addBtn').getBoundingClientRect().top]; });
    await page.focus('#list .bk[data-id="z20"]');
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab');
      const [top, , bar] = await where();
      assert.ok(top >= bar - 0.5, 'Shift+Tab left a book under the top bar: its top at ' + top + ', the bar\'s bottom at ' + bar);
    }
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      const [, bottom, , plus] = await where();
      assert.ok(bottom <= plus + 0.5, 'Tab left a book under the + button: its bottom at ' + bottom + ', the button\'s top at ' + plus);
    }
    await page.click('#nextBtn');
    assert.deepEqual(await fit('#nxCrit [data-mood]'), [], 'moods are cut off at the side of What to read next');
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

// Look it up, by a book's ISBN, with Open Library faked (lookups are on only when turned on in Settings).
const KARAMAZOV = { id: 'k1', t: 1000, title: 'The Brothers Karamazov', authors: ['Fyodor Dostoevsky'], isbn: '9780140449242', added: '2026-10-01', room: 'Study' };
const WALDEN = { id: 'w1', t: 1000, title: 'Walden', authors: ['Henry David Thoreau'], added: '2026-10-01', room: 'Study' };
const KARAMAZOV_OL = { title: 'The Brothers Karamazov: A Novel in Four Parts and an Epilogue, Translated with an Introduction and Notes', publishers: [{ name: 'Penguin Classics' }], publish_date: '2003', number_of_pages: 796, authors: [{ name: 'Fyodor Dostoevsky' }] };
async function withLookups(page, books) {
  await page.evaluate(() => localStorage.setItem('shelfmark.prefs', JSON.stringify({ sort: 'author', lookups: true })));
  await seed(page, books);
}

step('Look it up stays with its own card, fills in only what\'s blank and says what, and shows a long title whole', async () => {
  const ctx = await context();
  const ol = await fakeOpenLibrary(ctx);
  ol.isbns['9780140449242'] = KARAMAZOV_OL;
  try {
    const page = await open(ctx);
    await withLookups(page, [KARAMAZOV, WALDEN]);
    // The answer comes after the card was closed and another book's opened: it goes nowhere.
    ol.lookupMs = 1500;
    await page.click('#list .bk[data-id="k1"]');
    await page.click('details.more:has(#f-isbn) > summary');
    await page.click('#f-look');
    await page.keyboard.press('Escape');
    await page.click('#list .bk[data-id="w1"]');
    await page.click('details.more:has(#f-isbn) > summary');
    await until(() => ol.lookups === 1, 'the lookup to be asked');
    await wait(2200);
    assert.deepEqual(await page.evaluate(() => ['f-isbn', 'f-publisher', 'f-year', 'f-pages'].map(id => document.getElementById(id).value)), ['', '', '', ''], 'the other book\'s card was filled in');
    assert.doesNotMatch(await page.textContent('#toastTx'), /Filled/);
    await page.click('#bkx');
    await wait(500);
    assert.deepEqual(await storedBook(page, 'w1'), WALDEN, 'the answer was saved into another book');
    // A new book: the long title from Open Library shows whole, and the toast says what was filled in.
    ol.lookupMs = 100;
    await page.click('#addBtn');
    await page.fill('#f-isbn', '0140449248');
    await page.click('#f-look');
    await until(() => page.$eval('#f-title', e => e.value !== ''), 'the title to be filled in', 5000);
    assert.equal(await page.inputValue('#f-title'), KARAMAZOV_OL.title);
    assert.equal(await page.$eval('#f-title', e => e.scrollHeight <= e.clientHeight + 2), true, 'the long title is cut off');
    assert.equal(await page.textContent('#toastTx'), 'Filled in the title, author, publisher, year and pages');
    assert.equal(await page.inputValue('#f-isbn'), '9780140449242');
    // Asked again with every field filled, it says there was nothing to add.
    await page.fill('#f-pages', '800');
    await page.click('#f-look');
    await until(() => page.$eval('#f-look', e => !e.disabled), 'the lookup to finish', 5000);
    assert.equal(await page.textContent('#toastTx'), 'Open Library had nothing to add');
    assert.equal(await page.inputValue('#f-pages'), '800', 'a filled field was written over');
    // What goes to Open Library doesn't say where it came from.
    assert.ok(ol.referers.length >= 3, 'Open Library was asked ' + ol.referers.length + ' times');
    assert.deepEqual(ol.referers.filter(Boolean), [], 'a request to Open Library carried the page\'s address');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Look it up that gets no answer, or loses the connection, says so and gives the button back', async () => {
  const ctx = await context();
  await ctx.clock.install();
  const ol = await fakeOpenLibrary(ctx);
  try {
    const page = await open(ctx);
    await withLookups(page, [KARAMAZOV]);
    await page.click('#list .bk[data-id="k1"]');
    await page.click('details.more:has(#f-isbn) > summary');
    ol.lookupMs = Infinity;
    await page.click('#f-look');
    await until(() => ol.lookups === 1, 'the lookup to be asked');
    assert.deepEqual(await page.$eval('#f-look', e => [e.disabled, e.textContent]), [true, 'Looking…']);
    await ctx.clock.fastForward(21000);
    await until(() => page.$eval('#f-look', e => !e.disabled), 'the button to come back', 5000);
    assert.equal(await page.textContent('#f-look'), 'Look it up');
    assert.equal(await page.textContent('#toastTx'), 'Couldn’t reach Open Library. Try again in a moment.');
    ol.lookupFail = true;
    await page.click('#f-look');
    await until(() => page.$eval('#f-look', e => !e.disabled), 'the button to come back', 5000);
    assert.equal(await page.textContent('#toastTx'), 'Couldn’t reach Open Library. Try again in a moment.');
    assert.equal(await page.inputValue('#f-title'), 'The Brothers Karamazov');
    assert.deepEqual(page.problems.filter(p => !/ERR_FAILED|Failed to fetch/.test(p)), []);
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
    // The first time on a device, Google asks which account, not for permission all over again.
    assert.deepEqual(await page.evaluate(() => window.__prompts.map(p => p.prompt)), ['select_account', 'select_account']);
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

step('Disconnect keeps the library and the sign-in, sends what waits to Drive first, and says when it can\'t', async () => {
  const g = fakeGoogle();
  const ctx = await context();
  await g.install(ctx);
  try {
    const page = await open(ctx);
    await seed(page, [WALDEN, KARAMAZOV]);
    // A device that has never had Drive says nothing about Drive when it's erased, though books were changed here.
    await page.click('#list .bk[data-id="w1"]');
    await page.click('#f-status button[data-v="read"]');
    await page.click('#bkx2');
    await wait(450);
    await page.click('#setBtn');
    assert.equal(await page.textContent('#stEraseNote'), 'Erasing removes your library from this browser only. Download a backup first if you want to keep it.');
    await page.click('#stx');
    await wait(450);
    await connectDrive(page);
    await until(() => page.evaluate(() => document.getElementById('syncTx').textContent === 'Synced'), 'the first sync');
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('junkdrawer.google') || '{}').email === 'mark@gmail.com'), 'the account\'s email');
    const inDrive = id => { const f = g.files().find(f => f.name === 'Shelfmark library.json'); return f && JSON.parse(f.body).library.books[id]; };
    // A change still waiting when Disconnect is tapped goes to Drive first.
    await page.click('#list .bk[data-id="k1"]');
    await page.click('#f-status button[data-v="reading"]');
    await page.click('#bkx2');
    await wait(450);
    await page.click('#setBtn');
    await page.click('#dvOff');
    await until(() => page.evaluate(() => /Drive disconnected/.test(document.getElementById('toastTx').textContent)), 'Disconnect to finish', 10000);
    assert.equal(await page.textContent('#toastTx'), 'Drive disconnected on this device. Your library is still here and in Drive.');
    assert.equal(inDrive('k1').status, 'reading', 'the change didn\'t reach Drive before Disconnect');
    assert.equal((await titles(page)).length, 2, 'the books went with Drive');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('junkdrawer.google')).email), 'mark@gmail.com', 'the sign-in went with Drive');
    assert.equal(await page.isVisible('#dvGo'), true);
    // Connected again, with Google's hour up and a change made: Disconnect says it hasn't reached Drive, and Erase warns.
    await page.click('#dvGo');
    await until(() => page.evaluate(() => document.getElementById('syncTx').textContent === 'Synced'), 'the sync after connecting again');
    await page.click('#stx');
    await page.evaluate(() => {
      for (const k of ['junkdrawer.google', 'shelfmark.drive']) localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)), exp: Date.now() - 1000 }));
    });
    await page.reload();
    await page.click('#list .bk[data-id="k1"]');
    await page.click('#f-status button[data-v="read"]');
    await page.click('#bkx2');
    await wait(450);
    await page.click('#setBtn');
    await page.click('#dvOff');
    assert.equal(await page.textContent('#toastTx'), 'Drive disconnected on this device. Your latest changes haven’t reached Drive: they stay here, and go to Drive when you connect again.');
    assert.equal(inDrive('k1').status, 'reading');
    assert.equal(await page.textContent('#stEraseNote'), 'Erasing removes your library and your Google sign-in from this browser only. Your latest changes here haven’t reached Drive yet. Connect Google Drive first, or they’ll be lost.');
    await page.click('#stErase');
    assert.equal(await page.textContent('#stErase'), 'Tap again to erase, changes not in Drive included');
    assert.deepEqual(await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('shelfmark.drive')); return [d.on, d.pending, d.unsent]; }), [false, true, true]);
    // Connecting again takes the change to Drive, and Erase stops warning.
    await page.click('#stx');
    await wait(450);
    await page.click('#setBtn');
    await page.click('#dvGo');
    await until(() => inDrive('k1').status === 'read', 'the change to reach Drive on connecting again', 10000);
    await until(() => page.evaluate(() => /Drive is disconnected here/.test(document.getElementById('stEraseNote').textContent)), 'Erase to stop warning');
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

step('Download a spreadsheet gives a .csv with a byte-order mark and a header row, a book a row, removed books left out', async () => {
  const ctx = await context(DESK);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, { ...MIDDLEMARCH, status: 'read', rating: 5, finished: '2026-09-30', loan: { to: 'Sam', since: '2026-10-02' } }, { id: 'gone', t: 1000, del: 1 }]);
    await page.click('#setBtn');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#stCsv')]);
    assert.match(dl.suggestedFilename(), /^shelfmark-\d{4}-\d\d-\d\d\.csv$/);
    const csv = await readFile(await dl.path(), 'utf8'), lines = csv.split('\r\n');
    assert.equal(csv.charCodeAt(0), 0xFEFF, 'the spreadsheet doesn\'t start with a byte-order mark');
    assert.ok(lines[0].startsWith('\uFEFFtitle,subtitle,authors,'), 'the header row: ' + lines[0].slice(0, 40));
    assert.deepEqual(lines.slice(1).filter(Boolean).map(l => l.split(',')[0]), ['Piranesi', 'Middlemarch'], 'a row for each book, by author (Clarke, Eliot)');
    assert.match(lines[2], /,Read,5,2026-09-30,Sam,2026-10-02,/, 'the status, stars, the day it was finished and the loan');
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
    assert.equal(await other.textContent('#toastTx'), 'Merged: 2 books added');
    // A file that only changes books says how many it changed, not how many books there are now.
    await wait(450);
    const soon = Date.now() + 1000;
    await openFile(other, JSON.stringify({ shelfmark: 1, library: { books: { b03: { ...PIRANESI, t: soon, status: 'read' }, b04: { ...MIDDLEMARCH, t: soon, room: 'Study' } }, seen: {} } }));
    assert.deepEqual(await what(other), ['2 are already here, both with newer changes in the file']);
    await other.click('#lbgo');
    assert.equal(await other.textContent('#toastTx'), 'Merged: 2 books updated');
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
    assert.equal(await other.textContent('#toastTx'), 'Merged: 1 book added, 1 removed');
    assert.equal(await other.textContent('#toastTx'), 'Merged: 1 book added, 1 removed');
    assert.deepEqual([...page.problems, ...other.problems], []);
  } finally { await a.close(); await b.close(); }
});

step('It’s back says who the book is back from, and Undo puts the loan back, with the card open or closed', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    const loan = { to: 'Priya', since: '2026-10-02' };
    await seed(page, [{ ...PIRANESI, loan }, MIDDLEMARCH]);
    const fields = () => Promise.all([page.inputValue('#f-lent'), page.inputValue('#f-since')]);
    await page.click('#list .bk[data-id="b03"]');
    assert.equal(await page.textContent('#f-back'), 'It’s back');
    await page.click('#f-back');
    assert.deepEqual(await fields(), ['', '']);
    assert.equal(await page.textContent('#toastTx'), 'Back from Priya');
    await page.click('#toastBtn');
    assert.deepEqual(await fields(), ['Priya', '2026-10-02'], 'Undo in the card left the loan out');
    assert.equal(await page.isVisible('#f-back'), true);
    await page.click('#bkx2');
    assert.deepEqual((await storedBook(page, 'b03')).loan, loan);
    // Closed straight after, Undo puts the loan back on the saved book.
    await wait(450);
    await page.click('#list .bk[data-id="b03"]');
    await page.click('#f-back');
    await page.click('#bkx2');
    assert.equal((await storedBook(page, 'b03')).loan, undefined);
    await page.click('#toastBtn');
    assert.deepEqual((await storedBook(page, 'b03')).loan, loan, 'Undo after the card closed left the loan out');
    assert.match(await page.textContent('#list .bk[data-id="b03"] .bdg.lent'), /Lent to Priya/);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Lent out lists the longest out first, and a loan out a month or more says how long', async () => {
  const ctx = await context();
  await ctx.clock.setFixedTime(new Date('2026-11-04T10:00:00'));
  try {
    const page = await open(ctx);
    await seed(page, [{ ...PIRANESI, loan: { to: 'Priya', since: '2026-10-20' } }, { ...MIDDLEMARCH, loan: { to: 'Sam', since: '2025-03-04' } }, { ...CRADLE, loan: { to: 'Ana' } },
      { id: 'b06', t: 1000, title: 'Emma', authors: ['Jane Austen'], loan: { to: 'Lou', since: '2026-09-30' } }, { id: 'b07', t: 1000, title: 'Dracula', authors: ['Bram Stoker'] }]);
    const badges = () => page.$$eval('#list .bk .bdg.lent', els => els.map(e => e.textContent));
    await page.click('#chips .chip[data-s="lent"]');
    assert.deepEqual(await titles(page), ['Middlemarch', 'Emma', 'Piranesi', 'Cat’s Cradle'], 'the longest out isn\'t first');
    assert.deepEqual(await badges(), ['Lent to Sam · 20 months', 'Lent to Lou · 1 month', 'Lent to Priya · Oct 20', 'Lent to Ana']);
    assert.equal(await page.inputValue('#sortSel'), 'lent', 'the sort menu doesn\'t say how the list is sorted');
    // The card keeps the day it was lent.
    await page.click('#list .bk[data-id="b04"]');
    assert.equal(await page.inputValue('#f-since'), '2025-03-04');
    await page.click('#bkx2');
    // Leaving the view, the sort is as it was; chosen from the menu, Longest out first stays.
    await page.click('#chips .chip[data-s=""]');
    assert.equal(await page.inputValue('#sortSel'), 'author');
    assert.deepEqual(await titles(page), ['Emma', 'Piranesi', 'Middlemarch', 'Dracula', 'Cat’s Cradle']);
    await page.selectOption('#sortSel', 'lent');
    await page.reload();
    assert.deepEqual(await titles(page), ['Middlemarch', 'Emma', 'Piranesi', 'Cat’s Cradle', 'Dracula'], 'the books on the shelf come after the loans');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Share this list copies the list on screen on a computer, and hands it to the share sheet on a phone', async () => {
  const books = [{ ...PIRANESI, shelf: 'Console table' }, { ...MIDDLEMARCH, loan: { to: 'Sam', since: '2026-10-02' } }, { ...CRADLE, status: 'reading' }];
  // A computer: the clipboard, faked, keeps what's copied.
  {
    const ctx = await context(DESK);
    await ctx.addInitScript(() => { window.copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.copied.push(t); return Promise.resolve(); } } }); });
    try {
      const page = await open(ctx);
      await seed(page, books);
      const copy = async () => { await page.evaluate(() => { window.copied = []; }); await page.click('#shareBtn'); await until(() => page.evaluate(() => window.copied.length), 'the list to be copied'); return page.evaluate(() => window.copied[0]); };
      // Each book once, though Cat's Cradle is in Reading now too.
      assert.equal(await copy(), '3 books\n\nPiranesi — Susanna Clarke · Hall › Console table\nMiddlemarch — George Eliot · Den\nCat’s Cradle — Kurt Vonnegut, Jr.\n');
      assert.equal(await page.textContent('#toastTx'), 'Copied 3 books');
      await page.click('#chips .chip[data-s="lent"]');
      assert.equal(await copy(), 'Lent out · 1 book\n\nMiddlemarch — George Eliot · Den · lent to Sam\n', 'the Lent out view doesn\'t say who has the book');
      assert.equal(await page.textContent('#toastTx'), 'Copied 1 book');
      await page.click('#chips .chip[data-s=""]');
      await page.selectOption('#sortSel', 'shelf');
      assert.equal(await copy(), '3 books\n\nDen\nMiddlemarch — George Eliot\n\nHall › Console table\nPiranesi — Susanna Clarke\n\nNot shelved yet\nCat’s Cradle — Kurt Vonnegut, Jr.\n', 'sorted by shelf, the books aren\'t under their shelves');
      await page.fill('#q', 'clarke');
      await until(async () => (await titles(page)).length === 1, 'the search');
      assert.equal(await copy(), 'Search: clarke · 1 book\n\nHall › Console table\nPiranesi — Susanna Clarke\n');
      // Nothing found, nothing to share.
      await page.fill('#q', 'zzz');
      await until(async () => !(await page.isVisible('#shareBtn')), 'Share this list to go with nothing found');
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
  // A phone: the share sheet, faked, keeps what it's given; closing it copies nothing and says nothing.
  {
    const ctx = await context(PHONE);
    await ctx.addInitScript(() => { window.shared = []; window.copied = []; navigator.share = d => { window.shared.push(d); return window.cancel ? Promise.reject(new DOMException('Share canceled', 'AbortError')) : Promise.resolve(); };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.copied.push(t); return Promise.resolve(); } } }); });
    try {
      const page = await open(ctx);
      await seed(page, books);
      await page.click('#chips .chip[data-s="unread"]');
      await page.click('#shareBtn');
      await until(() => page.evaluate(() => window.shared.length), 'the share sheet');
      assert.deepEqual(await page.evaluate(() => window.shared), [{ text: 'Unread · 2 books\n\nPiranesi — Susanna Clarke · Hall › Console table\nMiddlemarch — George Eliot · Den\n' }]);
      await page.evaluate(() => { window.cancel = true; });
      await page.click('#shareBtn');
      await wait(300);
      assert.deepEqual([await page.evaluate(() => window.copied.length), await page.evaluate(() => document.getElementById('toast').classList.contains('show'))], [0, false], 'a share sheet closed copied the list, or said so');
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
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

step('a phone keyboard\'s Search puts it away over the results, and Next goes through a card\'s fields to Done', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [WALDEN, KARAMAZOV]);
    const at = () => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
    assert.equal(await page.getAttribute('#q', 'enterkeyhint'), 'search');
    await page.fill('#q', 'walden');
    await page.keyboard.press('Enter');
    assert.notEqual(await at(), 'q', 'Enter left the keyboard up over the results');
    assert.deepEqual(await titles(page), ['Walden']);
    await page.fill('#q', '');
    // A card's fields: Next goes on past dates, buttons and closed sections, and the last one puts the keyboard away.
    await page.click('#list .bk[data-id="w1"]');
    await page.focus('#f-authors');
    const order = [];
    for (let i = 0; i < 6 && /^f-/.test(await at()); i++) { await page.keyboard.press('Enter'); order.push(await at()); }
    assert.deepEqual(order.join(), ['f-room', 'f-shelf', 'f-lent', 'f-tags', 'BODY'].join());
    // While a word is being put together (a Chinese or Japanese keyboard, say), Enter finishes the word, not the field.
    await page.focus('#f-authors');
    await page.$eval('#f-authors', e => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await at(), 'f-authors');
    await page.click('#bkx');
    await wait(450);
    // Adding a book, Edition and details is open: Next goes through it to Edition, which is Done.
    await page.click('#addBtn');
    await page.focus('#f-tags');
    order.length = 0;
    for (let i = 0; i < 9 && /^f-/.test(await at()); i++) { await page.keyboard.press('Enter'); order.push(await at()); }
    assert.deepEqual(order, ['f-sub', 'f-isbn', 'f-publisher', 'f-year', 'f-pages', 'f-edition', 'BODY']);
    // Notes stay a box of lines.
    await page.focus('#f-notes');
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    assert.equal(await page.inputValue('#f-notes'), 'one\ntwo');
    const keys = await page.evaluate(() => Object.fromEntries(['f-authors', 'f-room', 'f-shelf', 'f-lent', 'f-tags', 'f-sub', 'f-publisher', 'f-year', 'f-pages', 'f-edition']
      .map(id => { const e = document.getElementById(id); return [id, [e.getAttribute('enterkeyhint'), e.getAttribute('autocapitalize'), e.getAttribute('autocorrect')].join(' ').trim()]; })));
    assert.deepEqual(keys, { 'f-authors': 'next words off', 'f-room': 'next', 'f-shelf': 'next', 'f-lent': 'next words off', 'f-tags': 'next none', 'f-sub': 'next', 'f-publisher': 'next  off', 'f-year': 'next', 'f-pages': 'next', 'f-edition': 'done' });
    // A name on the review screen isn't "corrected" either.
    await page.goto(linkTo({ name: 'Hall', books: [{ title: 'Cranford', authors: ['Elizabeth Gaskell'] }] }));
    await page.waitForSelector('#rv-add');
    assert.deepEqual(await page.$eval('.rv [data-f="authors"]', e => [e.getAttribute('autocapitalize'), e.getAttribute('autocorrect')]), ['words', 'off']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
  // With a mouse and keyboard there's no keyboard on screen to put away: Enter searches, and the keyboard stays in the box.
  const desk = await context(DESK);
  try {
    const page = await open(desk);
    await seed(page, [WALDEN, KARAMAZOV]);
    await page.fill('#q', 'walden');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'q', 'Enter took the keyboard out of the search box');
    assert.deepEqual(await titles(page), ['Walden']);
    assert.deepEqual(page.problems, []);
  } finally { await desk.close(); }
});

step('a card\'s genres are buttons that take them off, and the keyboard stays where the person is as they go and come', async () => {
  const ctx = await context(DESK);
  try {
    const page = await open(ctx);
    await seed(page, [{ ...WALDEN, genres: ['philosophy', 'nature', 'biography'] }, { ...KARAMAZOV, tags: ['russian', 'gift'] }]);
    await page.click('#list .bk[data-id="w1"]');
    await page.click('details.more > summary >> nth=0');
    const at = () => page.evaluate(() => { const a = document.activeElement; return a.dataset.g || a.id || a.tagName; });
    assert.deepEqual(await page.$eval('#f-genres', e => [e.getAttribute('role'), e.getAttribute('aria-label')]), ['group', 'Genres']);
    assert.deepEqual(await page.$$eval('#f-genres button', bs => bs.map(b => [b.getAttribute('aria-label'), b.hasAttribute('aria-pressed')])),
      [['Remove Philosophy', false], ['Remove Nature and gardening', false], ['Remove Biography and memoir', false]]);
    // Taken off from the keyboard, the next genre has the keyboard; after the last one, Add a genre does.
    await page.focus('#f-genres button[data-g="nature"]');
    await page.keyboard.press('Enter');
    assert.equal(await at(), 'biography');
    await page.keyboard.press('Enter');
    assert.equal(await at(), 'f-genre');
    // Adding a fourth takes Add a genre away: the keyboard goes to the new genre.
    await page.selectOption('#f-genre', 'history');
    await page.selectOption('#f-genre', 'classics');
    await page.selectOption('#f-genre', 'travel');
    assert.equal(await page.isVisible('#f-genre'), false);
    assert.equal(await at(), 'travel');
    // A fifth mood says how to choose another.
    for (const m of ['funny', 'tense', 'dark', 'hopeful', 'sad']) await page.click('#f-moods button[data-m="' + m + '"]');
    assert.equal(await page.textContent('#toastTx'), 'Up to four moods. Take one off first.');
    await page.click('#bkx');
    await wait(450);
    // A tag picked from the keyboard leaves the keyboard in Tags; the button it was on has gone.
    await page.click('#list .bk[data-id="w1"]');
    await page.focus('#f-tagpicks button[data-t="gift"]');
    await page.keyboard.press('Enter');
    assert.equal(await at(), 'f-tags');
    assert.equal(await page.inputValue('#f-tags'), 'gift');
    await page.click('#bkx');
    // Settings names the lookups box in a few words, and says the rest after.
    await wait(450);
    await page.click('#setBtn');
    const box = page.getByRole('checkbox', { name: 'Show covers and look up details on Open Library', exact: true });
    assert.equal(await box.count(), 1);
    assert.match(await page.evaluate(() => document.getElementById(document.getElementById('stLook').getAttribute('aria-describedby')).textContent), /^Show covers, and look up a book’s details by its ISBN\..*openlibrary\.org/);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a card keeps notes to the 4,000 characters Shelfmark saves, says how many near that, and every field to its limit', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [WALDEN]);
    await page.click('#list .bk[data-id="w1"]');
    assert.equal(await page.locator('#f-notes-n').isVisible(), false, 'a count shows under short notes');
    await page.fill('#f-notes', 'Simplify, simplify. '.repeat(195)); // 3,900
    assert.equal(await page.textContent('#f-notes-n'), '4,000 characters at most: 3,900 used');
    await page.focus('#f-notes');
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('x'.repeat(300));
    assert.equal((await page.inputValue('#f-notes')).length, 4000, 'the notes box took more than is kept');
    assert.equal(await page.textContent('#f-notes-n'), '4,000 characters at most: 4,000 used');
    await page.click('#bkx');
    assert.equal((await storedBook(page, 'w1')).notes.length, 4000);
    await page.click('#list .bk[data-id="w1"]');
    const limits = await page.evaluate(() => Object.fromEntries(['f-title', 'f-sub', 'f-publisher', 'f-edition', 'f-room', 'f-shelf', 'f-lent', 'f-notes', 'f-blurb'].map(id => [id, document.getElementById(id).maxLength])));
    assert.deepEqual(limits, { 'f-title': 300, 'f-sub': 300, 'f-publisher': 120, 'f-edition': 120, 'f-room': 60, 'f-shelf': 60, 'f-lent': 80, 'f-notes': 4000, 'f-blurb': 300 });
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

step('small grey text, the Reading badge, chip counts, placeholders and stars reach WCAG AA contrast, light and dark', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await context({ ...PHONE, colorScheme });
    try {
      // ink2 on surface2 is the Set aside badge, ink2 on green-soft an author in a row ticked to mark read, brass the Reading
      // and Wanted badges and the note on a book on the wishlist.
      for (const [url, pairs] of [[base, [['ink3', 'ground'], ['ink3', 'surface'], ['ink3', 'surface2'], ['brass', 'brass-soft'], ['brass', 'surface'], ['ink2', 'surface2'], ['ink2', 'green-soft']]], [base + 'privacy.html', [['ink3', 'ground']]]]) {
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
      // As drawn: a chip's count, chosen or not, and a field's placeholder are text (4.5:1, WCAG 2.2 SC 1.4.3); a star
      // not given is a control's look (3:1, SC 1.4.11 Non-text Contrast).
      const page = await open(ctx);
      await seed(page, [WALDEN, { ...KARAMAZOV, status: 'read', rating: 2 }]);
      const drawn = () => page.evaluate(() => {
        const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number), lum = c => { const l = c.map(x => x / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
        const ratio = (fg, bg) => { const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x); return +((a + 0.05) / (b + 0.05)).toFixed(2); };
        const css = (q, pseudo) => { const e = document.querySelector(q); return e && getComputedStyle(e, pseudo); }, bg = q => css(q).backgroundColor, out = {};
        const n = css('#chips .chip[aria-pressed="false"] .n'), on = css('#chips .chip[aria-pressed="true"] .n');
        out.count = [ratio(n.color, bg('#chips .chip[aria-pressed="false"]')), n.opacity];
        out.chosenCount = [ratio(on.color, bg('#chips .chip[aria-pressed="true"]')), on.opacity];
        if (css('#f-room')) {
          const ph = css('#f-room', '::placeholder');
          out.placeholder = [ratio(ph.color, bg('#f-room')), ph.opacity];
          out.star = [ratio(css('#f-rating button:not(.on)').color, bg('.panel')), document.querySelector('#f-rating button:not(.on)').textContent, document.querySelector('#f-rating button.on').textContent];
        }
        return out;
      });
      const list = await drawn();
      await page.click('#list .bk[data-id="k1"]');
      const card = await drawn();
      const what = colorScheme + ': ';
      assert.ok(list.count[0] >= 4.5 && list.count[1] === '1', what + 'a chip\'s count is ' + list.count);
      assert.ok(list.chosenCount[0] >= 4.5 && list.chosenCount[1] === '1', what + 'the chosen chip\'s count is ' + list.chosenCount);
      assert.ok(card.placeholder[0] >= 4.5 && card.placeholder[1] === '1', what + 'a placeholder is ' + card.placeholder);
      assert.ok(card.star[0] >= 3, what + 'a star not given is ' + card.star[0] + ':1 against the card');
      assert.deepEqual(card.star.slice(1), ['☆', '★'], what + 'a star not given looks like one given');
      // A book left out on the review screen (one already here), and on the details sheet (one not in the library), is
      // text like any other: its title, author, place and notes, unfaded, against the row.
      const offRow = sel => page.$$eval(sel, els => els.map(e => {
        const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number), lum = c => { const l = c.map(x => x / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
        const li = e.closest('li'), [a, b] = [lum(rgb(getComputedStyle(e).color)), lum(rgb(getComputedStyle(li).backgroundColor))].sort((x, y) => y - x);
        let op = 1; for (let x = e; x && x !== li.parentNode; x = x.parentElement) op *= +getComputedStyle(x).opacity;
        return [e.className || e.tagName.toLowerCase(), +((a + 0.05) / (b + 0.05)).toFixed(2), op];
      }));
      await page.click('#sheet .scrim').catch(() => {});
      await page.goto(linkTo({ name: 'Study', books: [{ title: 'Walden', authors: ['Henry David Thoreau'], isbn: '9780141439549' }, { title: 'Emma', authors: ['Jane Austen'] }] }));
      await page.waitForSelector('#rv li.off');
      const review = await offRow('#rv li.off .rt, #rv li.off input[data-f="authors"], #rv li.off .rv-meta, #rv li.off .rv-have, #rv li.off .rv-have b');
      await page.click('#rvx');
      await page.goto(detailsLink([{ id: 'w1', title: 'Walden', kind: 'nonfiction' }, { id: 'zz', title: 'A Book Not Here', kind: 'poetry' }]));
      await page.waitForSelector('.rv.dt li.off');
      const details = await offRow('.rv.dt li.off .rt, .rv.dt li.off .rv-dup');
      assert.equal(review.length, 5, what + 'the review\'s left-out row is missing a part: ' + JSON.stringify(review));
      for (const [part, ratio, op] of [...review, ...details]) assert.ok(ratio >= 4.5 && op === 1, what + 'a left-out row\'s ' + part + ' is ' + ratio + ':1 at opacity ' + op);
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('in dark, a sheet has an edge that stands off the page behind it', async () => {
  const ctx = await context({ ...PHONE, colorScheme: 'dark' });
  try {
    const page = await open(ctx);
    await page.click('#importBtn');
    const [edge, sheet, behind] = await page.evaluate(() => {
      const rgb = s => (s.match(/rgba?\(([^)]*)\)/) || [, '0,0,0,0'])[1].split(',').map(Number);
      const panel = getComputedStyle(document.querySelector('#sheet .panel')), scrim = rgb(getComputedStyle(document.querySelector('#sheet .scrim')).backgroundColor);
      const ground = rgb(getComputedStyle(document.body).backgroundColor), a = scrim[3] ?? 1;
      return [rgb(panel.boxShadow), rgb(panel.backgroundColor), ground.slice(0, 3).map((g, i) => g * (1 - a) + scrim[i] * a)];
    });
    const lum = c => { const v = c.slice(0, 3).map(x => x / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
    assert.ok(edge.length === 3 || edge[3] > 0, 'the sheet has no edge in dark: ' + edge);
    for (const [what, c] of [['the sheet', sheet], ['the page behind', behind]]) assert.ok(ratio(edge, c) >= 1.5, 'the sheet\'s edge is ' + ratio(edge, c).toFixed(2) + ':1 against ' + what);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('on a phone, a narrow one too, the menus and the search box show their words whole', async () => {
  const narrow = width => ({ ...PHONE, viewport: { width, height: 760 } });
  for (const [size, placeholder] of [[PHONE, 'Search your books'], [narrow(360), 'Search your books'], [narrow(320), 'Search your books'], [DESK, 'Search titles, authors, shelves, tags, borrowers…']]) {
    const ctx = await context(size);
    try {
      const page = await open(ctx);
      await seed(page, [{ ...PIRANESI, tags: ['sf'], status: 'read', finished: '2026-10-03' }, { ...MIDDLEMARCH, room: 'Living room', tags: ['classics', 'signed first'] }]);
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
      // A room and a tag chosen, on any phone (not only an iPhone): the sort menu makes room for them.
      await page.selectOption('#roomSel', 'Living room');
      await page.selectOption('#tagSel', 'signed first');
      assert.deepEqual(await fits('#roomSel'), ['Living room', true], 'the room chosen is cut short at ' + size.viewport.width);
      assert.deepEqual(await fits('#tagSel'), ['signed first', true], 'the tag chosen is cut short at ' + size.viewport.width);
      // The longest sort, offered once a book has the day it was finished.
      await page.selectOption('#sortSel', 'finished');
      for (const id of ['#roomSel', '#tagSel', '#sortSel']) assert.equal((await fits(id))[1], true, (await fits(id))[0] + ' is cut short at ' + size.viewport.width + ', sorted Recently finished');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('on a small phone a sheet\'s title stays on one line, a card keeps its arrows and its loan fields in line', async () => {
  for (const width of [360, 320]) {
    const ctx = await context({ ...PHONE, viewport: { width, height: 700 } });
    try {
      const page = await open(ctx);
      await seed(page, [{ ...PIRANESI, kind: 'fiction', way: 'dip', genres: ['fantasy'], moods: ['mysterious'] }, MIDDLEMARCH]);
      const oneLine = () => page.$eval('#sheetTitle', h => h.getBoundingClientRect().height <= parseFloat(getComputedStyle(h).lineHeight) * 1.5);
      await page.goto(detailsLink([{ id: 'b04', title: 'Middlemarch', authors: ['George Eliot'], kind: 'fiction', moods: ['reflective'] }]));
      await page.waitForSelector('#dtgo');
      // (At 320 it wraps, evenly: "Reading details / from Claude".)
      if (width > 320) assert.equal(await oneLine(), true, '“Reading details from Claude” wraps at ' + width);
      await page.click('#dtx');
      await page.goto(linkTo({ name: 'Hall', books: [{ title: 'Emma', authors: ['Jane Austen'] }] }));
      await page.waitForSelector('#rv-add');
      assert.equal(await oneLine(), true, '“Add books from Claude” wraps at ' + width);
      await page.click('#rvx');
      await page.click('#list .bk[data-id="b03"]');
      assert.equal(await page.getAttribute('#f-authors', 'placeholder'), 'Separate with commas');
      await page.click('details.more > summary >> nth=0');
      const arrow = await page.$eval('details.more > summary', s => getComputedStyle(s, '::before').width);
      assert.equal(arrow, '7px', 'the open Reading details arrow is squeezed to ' + arrow + ' at ' + width);
      const [lent, since] = await page.evaluate(() => ['#f-lent', '#f-since'].map(q => document.querySelector(q).previousElementSibling.getBoundingClientRect().top));
      if (width > 340) assert.ok(Math.abs(lent - since) <= 0.5, 'Since sits ' + (lent - since) + 'px above Lent to'); // narrower, one is under the other
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('on a phone, every field in a sheet is 16px or more, so Safari on an iPhone doesn\'t zoom in on it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    // Safari zooms the page in when a field with text under 16px gets focus, and leaves it zoomed. Checkboxes don't count.
    const small = () => page.$$eval('#sheet input, #sheet select, #sheet textarea', els => els.filter(e => e.type !== 'checkbox' && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
      .map(e => [e.id || e.dataset.f || e.className, getComputedStyle(e).fontSize]).filter(x => parseFloat(x[1]) < 16));
    const lib = [{ ...PIRANESI, tags: ['sf'], kind: 'fiction', genres: ['fantasy'], moods: ['mysterious'], pace: 'medium' }, { ...MIDDLEMARCH, tags: ['classics'], kind: 'fiction', genres: ['classics'], pace: 'slow' }];
    await seed(page, lib);
    await page.click('#list .bk[data-id="b03"]');
    await page.click('details.more > summary >> nth=0');
    await page.click('details.more > summary >> nth=1');
    assert.deepEqual(await small(), [], 'the card');
    await page.click('#bkx');
    await wait(450); // Import is near Done, and a tap there just after a sheet closes is taken for a second tap
    await page.click('#importBtn');
    assert.deepEqual(await small(), [], 'Import');
    await page.click('#imx');
    await page.click('#nextBtn');
    await page.click('#nxMore summary');
    assert.deepEqual(await small(), [], 'What to read next');
    await page.click('#nxx');
    await wait(450);
    await page.click('#setBtn');
    await page.click('#stMark');
    assert.deepEqual(await small(), [], 'Mark what you\'ve read');
    await page.click('#mrx');
    await page.goto(linkTo({ name: 'Den', books: [{ title: 'Gilead', authors: ['Marilynne Robinson'] }] }));
    await page.waitForSelector('#rv-add');
    assert.deepEqual(await small(), [], 'the review');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('on an iPhone, nothing sits under the home indicator or the notch', async () => {
  // An iPhone 15's safe areas: 34px for the home indicator in portrait, 59px each side for the notch in landscape.
  const inset = async (page, insets) => { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets }); };
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    await inset(page, { top: 0, bottom: 34, left: 0, right: 0 });
    for (const [open, last] of [['#setBtn', '#stErase'], ['#importBtn', '#imgo']]) {
      await page.click(open);
      await page.evaluate(() => { const b = document.querySelector('#sheet .bd'); b.scrollTop = b.scrollHeight; });
      const end = await page.evaluate(q => document.querySelector(q).getBoundingClientRect().bottom, last);
      assert.ok(end <= await page.evaluate(() => innerHeight) - 34, last + ' ends at ' + end + ', under the home indicator');
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 844, height: 390 });
    await inset(page, { top: 0, bottom: 21, left: 59, right: 59 });
    const [brand, add, card] = await page.evaluate(() => ['.top .brand', '#addBtn', '#list .bk'].map(q => { const r = document.querySelector(q).getBoundingClientRect(); return [r.left, r.right]; }));
    assert.ok(brand[0] >= 59 && card[0] >= 59, 'the logo or the first book sits under the notch on the left: ' + JSON.stringify([brand, card]));
    assert.ok(add[1] <= 844 - 59 && card[1] <= 844 - 59, 'Add or a book sits under the notch on the right: ' + JSON.stringify([add, card]));
    // Sideways, a sheet comes up from the bottom as it does upright, its full height, clear of the notch either side.
    await page.click('#nextBtn');
    const sheet = await page.evaluate(() => { const r = document.querySelector('#sheet .panel').getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; });
    assert.ok(sheet[3] >= 390 - 0.5 && sheet[2] <= 40, 'sideways, What to read next is a box in the middle, not a sheet from the bottom: ' + JSON.stringify(sheet));
    assert.ok(sheet[0] >= 59 && sheet[1] <= 844 - 59, 'sideways, the sheet runs under the notch: ' + JSON.stringify(sheet));
    await page.click('#nxGo');
    const t = await page.evaluate(() => { const r = document.getElementById('toast').getBoundingClientRect(); return [r.left, r.right]; });
    assert.ok(t[0] >= 59 && t[1] <= 844 - 59, 'sideways, the toast runs under the notch: ' + JSON.stringify(t));
    // An iPad's sheet is a box in the middle, so its footer doesn't keep room for the home indicator under its buttons.
    await page.click('#toastBtn');
    await page.setViewportSize({ width: 1024, height: 768 });
    await inset(page, { top: 24, bottom: 20, left: 0, right: 0 });
    await page.click('#list .bk[data-id="b03"]');
    assert.equal(await page.$eval('#sheet .ft', e => getComputedStyle(e).paddingBottom), '12px', 'a sheet in the middle of an iPad keeps room for the home indicator');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('on a phone To check is in view after a first batch, and the sideways rows fade where there\'s more', async () => {
  for (const width of [390, 375]) {
    const ctx = await context({ ...PHONE, viewport: { width, height: 812 } });
    try {
      const page = await open(ctx);
      await page.goto(linkTo({ name: 'Hall', books: [
        { title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Piranesi', authors: ['Susanna Clarke'], unsure: 'glare on the spine' }, { title: 'Walden', authors: ['Henry David Thoreau'] },
      ] }));
      await page.click('#rv-add');
      assert.equal(await page.textContent('#toastTx'), 'Added 3 books — newest first · 1 to check');
      // Nothing is being read or read yet, so those chips wait until something is.
      assert.deepEqual(await page.$$eval('#chips .chip', els => els.map(e => e.dataset.s)), ['', 'unread', 'check']);
      const chk = await page.locator('#chips .chip[data-s="check"]').boundingBox();
      assert.ok(chk.x + chk.width <= width, 'To check is past the edge at ' + width);
      // A chip that's chosen stays while it's chosen, though its count drops to nothing.
      await page.click('#list .bk >> nth=0');
      await page.click('#f-status button[data-v="reading"]');
      await page.click('#bkx2');
      await page.click('#chips .chip[data-s="reading"]');
      await page.click('#list .bk >> nth=0');
      await page.click('#f-status button[data-v="unread"]');
      await page.click('#bkx2');
      assert.deepEqual(await page.$$eval('#chips .chip', els => els.map(e => e.dataset.s)), ['', 'unread', 'reading', 'check']);

      // The mood row in What to read next runs off the edge: it fades there, and at the start once scrolled.
      const MOODS = ['adventurous', 'challenging', 'dark', 'emotional', 'funny', 'hopeful', 'informative', 'inspiring', 'lighthearted', 'mysterious', 'reflective', 'relaxing', 'sad', 'tense'];
      await seed(page, MOODS.map((m, i) => ({ id: 'm' + i, t: 1000, title: 'Book ' + i, authors: ['Ann Lee'], kind: 'fiction', moods: [m] })));
      await page.click('#nextBtn');
      const fade = () => page.$eval('.nx-moods', el => [el.classList.contains('fade-l'), el.classList.contains('fade-r')]);
      assert.deepEqual(await fade(), [false, true]);
      await page.$eval('.nx-moods', el => { el.scrollLeft = el.scrollWidth; });
      await until(async () => (await fade()).join() === 'true,false', 'the mood row to fade at its start only');
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

// Each control answers a tap over its whole box, the invisible part included: at every edge of that box, 1px in, the
// control is what's there, so none reaches over a neighbour's. h is the height the box must have, at least.
async function tapBoxes(page, q, h = 44) {
  return page.evaluate(([q, h]) => [...document.querySelectorAll(q)].filter(e => e.getClientRects().length).map(e => {
    e.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = e.getBoundingClientRect(), c = getComputedStyle(e), a = getComputedStyle(e, '::after'), ext = a.content !== 'none' && a.position === 'absolute';
    // the invisible box is placed from inside the control's border
    const top = Math.min(r.top, ext ? r.top + parseFloat(c.borderTopWidth) + parseFloat(a.top) : r.top), bottom = Math.max(r.bottom, ext ? r.bottom - parseFloat(c.borderBottomWidth) - parseFloat(a.bottom) : r.bottom);
    const name = (e.id || e.dataset.v || e.dataset.m || e.dataset.mood || e.dataset.s || e.dataset.t || e.textContent.trim()).slice(0, 20);
    if (bottom - top < h - 0.5) return name + ' answers ' + Math.round(bottom - top) + 'px tall';
    const cx = (r.left + r.right) / 2, cy = (top + bottom) / 2;
    for (const [x, y] of [[cx, top + 1], [cx, bottom - 1], [r.left + 1, cy], [r.right - 1, cy]]) {
      if (y < 0 || y > innerHeight) continue;
      const hit = document.elementFromPoint(x, y), own = hit && (hit === e || e.contains(hit) || (hit.closest('label') === e));
      if (!own) return name + ' loses a tap at ' + Math.round(x) + ',' + Math.round(y) + ' to ' + (hit ? hit.tagName + (hit.id ? '#' + hit.id : '') + ' ' + hit.textContent.trim().slice(0, 20) : 'nothing');
    }
    return '';
  }).concat(document.querySelector(q) ? [] : ['nothing matches ' + q]).filter(Boolean), [q, h]);
}

step('on a phone the small controls answer a tap 44px tall, and none takes another\'s taps', async () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const ctx = await context({ ...PHONE, viewport });
    try {
      const page = await open(ctx);
      await seed(page, [{ ...PIRANESI, kind: 'fiction', moods: ['mysterious'], genres: ['fantasy', 'literary'], chapters: 'short', tags: ['sf'] }, { ...MIDDLEMARCH, kind: 'fiction', moods: ['reflective'], chapters: 'long', pages: 880, tags: ['classics'] },
        { ...CRADLE, room: 'Den', status: 'reading' }, { id: 'b09', t: 1000, title: 'Emma', authors: ['Jane Austen'], status: 'read', rating: 5, added: '2026-09-01', room: 'Den' }]);
      const w = viewport.width + 'px: ';
      const size = q => page.$eval(q, e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
      // The list: its chips, menus, What to read next and the top bar's buttons.
      for (const q of ['#chips .chip', '.selects select:not([hidden])', '#nextBtn', '.top .tbtn:not([hidden])', '.now-acts .btn', '#shareBtn']) assert.deepEqual(await tapBoxes(page, q), [], w + q);
      await page.click('#list .bk[data-id="b03"]');
      // The card: status, stars, tag picks; with its sections open, the reading details, genres, Signed and First edition.
      await page.evaluate(() => document.querySelectorAll('.panel details').forEach(d => d.open = true));
      for (const q of ['#f-status button', '#f-rating button', '.seg button', '#f-moods button', '#f-genres button', '.checks label']) assert.deepEqual(await tapBoxes(page, q), [], w + q);
      assert.deepEqual(await tapBoxes(page, '#f-tagpicks button', 28), [], w + 'the tag picks');
      const stars = await page.$$eval('#f-rating button', els => els.map(e => Math.round(e.getBoundingClientRect().left)));
      assert.deepEqual(stars.slice(1).map((x, i) => x - stars[i]), [44, 44, 44, 44], w + 'the stars aren\'t 44px apart');
      assert.ok((await size('#bkx'))[1] >= 44, 'Done at the top is ' + (await size('#bkx'))[1] + ' tall');
      // Done's box is no taller in the header than before, and the card's fields are where they were.
      const look = () => page.evaluate(() => ['#sheet .hd', '#f-title'].map(q => document.querySelector(q).getBoundingClientRect().bottom));
      const now = await look(), tight = await page.addStyleTag({ content: '.hd .btn{min-height:0!important;margin:0!important}' });
      assert.deepEqual(now, await look(), 'the card moved');
      await tight.evaluate(e => e.remove());
      await page.click('#f-del');
      assert.ok((await size('#toastBtn'))[1] >= 40, 'Undo is ' + (await size('#toastBtn'))[1] + ' tall');
      assert.ok((await size('#toast'))[1] < 60, 'the toast grew');
      await page.click('#toastBtn');
      await page.click('#nextBtn');
      await page.click('#nxMore > summary');
      for (const q of ['#nxCrit .seg button', '#nxCrit .nx-moods .chip']) assert.deepEqual(await tapBoxes(page, q), [], w + q);
      assert.ok((await size('#nxMore > summary'))[1] >= 40, 'More choices is ' + (await size('#nxMore > summary'))[1] + ' tall');
      assert.ok((await size('#nxCrit .opt'))[1] >= 40, 'Short chapters is ' + (await size('#nxCrit .opt'))[1] + ' tall');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, w + 'the page scrolls sideways');
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('with a mouse the small controls look as they did, and a focused choice\'s ring isn\'t cut off', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await context({ ...DESK, colorScheme });
    try {
      const page = await open(ctx);
      await seed(page, [{ ...PIRANESI, status: 'read', rating: 3, moods: ['mysterious'], aside: true }, MIDDLEMARCH]);
      const box = q => page.$eval(q, e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
      assert.deepEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#chips .chip'), '::after').content), 'none', 'a chip has a tap box with a mouse');
      assert.ok((await box('.selects select:not([hidden])'))[1] < 40, 'a menu is ' + (await box('.selects select:not([hidden])'))[1] + ' tall with a mouse');
      await page.click('#list .bk[data-id="b03"]');
      assert.ok((await box('#f-status button'))[1] < 34, 'a status button is ' + (await box('#f-status button'))[1] + ' tall with a mouse');
      const stars = await page.$$eval('#f-rating button', els => els.map(e => Math.round(e.getBoundingClientRect().left)));
      assert.ok(stars.slice(1).every((x, i) => x - stars[i] < 34), 'the stars moved apart with a mouse: ' + stars);
      // From the keyboard, the chosen status (Set aside, the row's last) shows its ring whole, inside its round end.
      await page.focus('#f-status button[data-v="aside"]');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const ring = await page.$eval('#f-status button[data-v="aside"]', e => { const c = getComputedStyle(e), seg = getComputedStyle(e.parentNode); return [e.matches(':focus-visible'), c.boxShadow, seg.overflow, c.borderTopRightRadius]; });
      assert.equal(ring[0], true, 'the button isn\'t focused from the keyboard');
      assert.match(ring[1], /inset.*inset/, 'no ring inside the button: ' + ring[1]);
      assert.equal(ring[2], 'visible', 'the row cuts its choices off');
      assert.equal(ring[3], '999px');
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('on a phone a tap leaves no hover look behind, and no grey-blue flash', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#list .bk')).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)', 'a tap flashes the browser\'s own box over a row');
    await page.tap('#list .bk[data-id="b03"]');
    await page.tap('details.more > summary >> nth=0');
    const look = m => page.$eval(`#f-moods button[data-m="${m}"]`, e => { const c = getComputedStyle(e); return [c.borderColor, c.color, c.backgroundColor]; });
    await page.tap('#f-moods button[data-m="funny"]');
    await page.tap('#f-moods button[data-m="funny"]');
    assert.equal(await page.getAttribute('#f-moods button[data-m="funny"]', 'aria-pressed'), 'false');
    // A phone leaves the last place tapped hovered until the next tap, which Chromium's taps here don't: the mouse stands in.
    assert.equal(await page.evaluate(() => matchMedia('(hover: hover)').matches), false);
    await page.hover('#f-moods button[data-m="funny"]');
    assert.deepEqual(await look('funny'), await look('dark'), 'a mood tapped off still looks half chosen');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('with a mouse, a sheet\'s Done keeps its own size, so its hover border isn\'t a tall box', async () => {
  const ctx = await context(DESK);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await page.click('#list .bk[data-id="b03"]');
    await page.hover('#bkx');
    const h = await page.$eval('#bkx', e => Math.round(e.getBoundingClientRect().height));
    assert.ok(h < 40, 'Done at the top is ' + h + ' tall with a mouse');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a long title shows whole in the card on a phone, and Enter there finishes it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    const long = 'The Life and Strange Surprizing Adventures of Robinson Crusoe, of York, Mariner, Who Lived Eight and Twenty Years All Alone';
    await seed(page, [{ id: 'T1', t: 1000, title: long, authors: ['Daniel Defoe'] }]);
    await page.click('#list .bk[data-id="T1"]');
    const shows = () => page.$eval('#f-title', e => [e.value, e.scrollHeight <= e.clientHeight + 1, e.scrollWidth <= e.clientWidth + 1]);
    assert.deepEqual(await shows(), [long, true, true], 'the title is cut short');
    // Turned or resized narrower while the card is open, the box grows to the title's new number of lines.
    await page.setViewportSize({ width: 320, height: 844 });
    await until(async () => (await shows())[1], 'the title box to grow on a narrower screen', 3000).catch(() => {});
    assert.deepEqual(await shows(), [long, true, true], 'the title is cut short once the screen is narrower');
    await page.setViewportSize({ width: 390, height: 844 });
    // A keyboard that puts words together (Chinese or Japanese, say) takes Enter to finish the word, not the title.
    await page.focus('#f-title');
    await page.$eval('#f-title', e => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'f-title', 'Enter while a word was being put together finished the title');
    await page.click('#f-title');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(', Volume 2');
    await page.keyboard.press('Enter');
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'f-title', 'Enter didn\'t finish the title');
    assert.deepEqual(await shows(), [long + ', Volume 2', true, true]);
    await page.click('#bkx');
    assert.equal((await storedBook(page, 'T1')).title, long + ', Volume 2');
    // A short title is one line, the height of the author field under it.
    await page.click('#list .bk[data-id="T1"]');
    await page.fill('#f-title', 'Emma');
    const [t, a] = await page.evaluate(() => ['#f-title', '#f-authors'].map(q => Math.round(document.querySelector(q).getBoundingClientRect().height)));
    assert.ok(t <= a + 2, 'a one-line title is ' + t + 'px tall, the author ' + a);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('the big stand-in cover ends a long title with its … instead of showing more lines under it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ id: 'g1', t: 1000, title: 'The History of the Decline and Fall of the Roman Empire', authors: ['Edward Gibbon'] }]);
    await page.click('#list .bk[data-id="g1"]');
    // Where the title can show: below its top padding, down to the bottom of its box (a line in the bottom padding shows too).
    const [h, lh] = await page.$eval('.cv.lg .cv-t', e => { const c = getComputedStyle(e); return [e.clientHeight - parseFloat(c.paddingTop), parseFloat(c.lineHeight)]; });
    assert.ok(h <= 5 * lh + 1, 'the title has ' + h + 'px to show in on the cover, more than five lines of ' + lh);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
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
    // An old ISBN can end in X, which a phone's number pad hasn't got.
    assert.deepEqual(await page.$eval('#f-isbn', e => [e.inputMode, e.getAttribute('autocapitalize'), e.spellcheck]), ['text', 'characters', false]);
    // The big stand-in cover breaks a word too long for it rather than cutting its end off.
    await page.fill('#f-title', 'Middlemarch');
    assert.equal(await page.$eval('#bkcv .cv-t', e => e.scrollWidth <= e.clientWidth), true, 'the cover cuts "Middlemarch" short');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('What to read next counts one match in the singular', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...PIRANESI, pages: 272 }, { ...MIDDLEMARCH, pages: 880 }, CRADLE]);
    await page.click('#nextBtn');
    await page.click('[data-len="long"]');
    // The book with no page count is left out, and the note says so though something matches.
    assert.equal(await page.textContent('#nxOut .note'), 'From 1 unread book that matches. 1 book has no page count, so it only comes up under Any length.');
    await page.click('[data-len=""]');
    assert.equal(await page.textContent('#nxOut .note'), 'From 3 unread books on hand.');
    assert.equal(await page.isDisabled('#nxAgain'), true, 'Pick again with every match already showing');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('What to read next offers only choices that can change something', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    // Catalogued in one go over two years ago, nothing read, no page counts: Length and the leans couldn't change a
    // thing, and when each was added tells them apart not at all. A lean saved before goes back to Surprise me.
    const batch = ['Middlemarch', 'Walden', 'Persuasion', 'Ivanhoe'].map((title, i) => ({ id: 'o' + i, t: 1000, title, authors: ['Ann Lee'], added: '2024-01-01', room: 'Den' }));
    await page.evaluate(() => localStorage.setItem('shelfmark.prefs', JSON.stringify({ next: { lean: 'oldest', len: 'short' } })));
    await seed(page, batch);
    await page.click('#nextBtn');
    assert.equal(await page.locator('#nxCrit [data-lean]').count(), 0, 'Lean toward is offered');
    assert.equal(await page.locator('#nxCrit [data-len]').count(), 0, 'Length is offered');
    for (let k = 0; k < 4; k++) {
      assert.doesNotMatch(await page.textContent('#nxOut'), /In your library since|New arrival|random pick/);
      await page.click('#nxAgain');
    }
    assert.match(await page.textContent('#nxOut > .note'), /^From 4 unread books on hand\./);
    // Another day's books, a page count and a book read by one of the authors bring them back.
    await page.click('#nxx');
    await seed(page, [...batch, { ...PIRANESI, status: 'read', authors: ['Ann Lee'] }, { ...CRADLE, pages: 304, added: '2026-10-01' }]);
    await page.click('#nextBtn');
    assert.deepEqual(await page.$$eval('#nxCrit [data-lean]', els => els.map(e => e.textContent)), ['Surprise me', 'Waiting longest', 'Newest arrivals', 'Favorite authors']);
    assert.deepEqual(await page.$$eval('#nxCrit [data-len]', els => els.map(e => e.textContent)), ['Any', 'Medium'], 'Length offers only the lengths the books have');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('on a phone What to read next keeps its height, so a choice tapped stays under the finger', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, ['Middlemarch', 'Walden', 'Persuasion', 'Ivanhoe', 'Emma'].map((title, i) => ({ id: 'h' + i, t: 1000, title, authors: ['Ann Lee'], pages: i ? 500 + i : 120, moods: [i ? 'funny' : 'dark'], room: 'Den' })));
    await page.click('#nextBtn');
    await page.click('#nxCrit [data-mood="dark"]');
    const at = () => page.$eval('#nxCrit [data-len="long"]', e => Math.round(e.getBoundingClientRect().top));
    const before = await at();
    await page.click('#nxCrit [data-len="long"]'); // nothing dark is that long: the result shrinks to a line or two
    assert.match(await page.textContent('#nxOut'), /Nothing matches/);
    assert.equal(await at(), before, 'Long moved from under the finger');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Pick again says it\'s going round again on every repeat, and a tap on another book puts the keyboard on it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, ['Middlemarch', 'Walden', 'Persuasion', 'Ivanhoe', 'Emma'].map((title, i) => ({ id: 'g' + i, t: 1000, title, authors: ['Ann Lee'] })));
    await page.click('#nextBtn');
    const note = () => page.textContent('#nxOut > .note');
    assert.doesNotMatch(await note(), /round again/);
    await page.click('#nxAgain'); // the two not shown yet, and one again
    assert.doesNotMatch(await note(), /round again/);
    for (let k = 0; k < 8; k++) {
      const was = await page.textContent('.nx-pick .nx-t');
      await page.click('#nxAgain');
      assert.match(await note(), /Going round again: you’ve seen all 5\./, 'deal ' + (k + 3) + ' is a repeat and doesn\'t say so');
      assert.notEqual(await page.textContent('.nx-pick .nx-t'), was, 'deal ' + (k + 3) + ' kept the same pick');
    }
    await page.click('.nx-alt >> nth=0');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.className), 'nx-t');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('when nothing matches, a button puts the choice in the way back to Any, and Clear these choices brings a pick', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [['Middlemarch', 880, 'reflective'], ['Walden', 352, 'reflective'], ['Persuasion', 249, 'emotional'], ['Ivanhoe', 520, 'adventurous'], ['Emma', 474, 'funny']]
      .map(([title, pages, mood], i) => ({ id: 'e' + i, t: 1000, title, authors: ['Ann Lee'], kind: 'fiction', moods: [mood], pages, room: 'Den' })));
    await page.click('#nextBtn');
    await page.click('#nxCrit [data-mood="reflective"]');
    await page.click('#nxCrit [data-len="short"]'); // the one short book isn't reflective
    assert.equal(await page.textContent('.nx-none h3'), 'Nothing matches all of these');
    assert.deepEqual(await page.$$eval('#nxOut [data-ease]', els => els.map(e => e.textContent)), ['Any length · 2 books', 'Any mood · 1 book']);
    await page.click('#nxOut [data-ease="len"]');
    assert.match(await page.textContent('.nx-pick .nx-t'), /^(Middlemarch|Walden)$/);
    assert.equal(await page.getAttribute('#nxCrit [data-len=""]', 'aria-pressed'), 'true', 'Length isn\'t back at Any');
    assert.equal(await page.getAttribute('#nxCrit [data-mood="reflective"]', 'aria-pressed'), 'true', 'the mood didn\'t stay');
    // Clear these choices from the keyboard: a pick, and the keyboard on the first choice.
    await page.click('#nxCrit [data-len="short"]');
    await page.focus('#nxClear');
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('#nxOut > .note'), 'From 5 unread books on hand.');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#nxCrit')), true, 'the keyboard didn\'t go to the first choice');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('shelfmark.prefs')).next.len), '');
    // One choice, saved before, that only a five-star read has: it says so, and how to bring it.
    await page.click('#nxx');
    await page.evaluate(() => localStorage.setItem('shelfmark.prefs', JSON.stringify({ next: { moods: ['funny'] } })));
    await seed(page, [MIDDLEMARCH, { ...PIRANESI, status: 'read', rating: 5, moods: ['funny'] }]);
    await page.click('#nextBtn');
    assert.equal(await page.textContent('.nx-none h3'), 'Nothing matches that');
    assert.match(await page.textContent('.nx-none p'), /1 of your 4- and 5-star reads matches: tick Include rereads under More choices\.$/);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('What to read next says each pick in a line for screen readers, and Pick again from the keyboard goes to the new pick', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...MIDDLEMARCH, shelf: 'Tall bookcase' }, PIRANESI, CRADLE, { id: 'b09', t: 1000, title: 'Walden', authors: ['Henry David Thoreau'], room: 'Den', shelf: 'Tall bookcase' }]);
    await page.click('#nextBtn');
    const said = { Middlemarch: 'Middlemarch by George Eliot, on Den › Tall bookcase', Piranesi: 'Piranesi by Susanna Clarke, on Hall', 'Cat\u2019s Cradle': 'Cat\u2019s Cradle by Kurt Vonnegut, Jr.',
      Walden: 'Walden by Henry David Thoreau, on Den › Tall bookcase' };
    assert.equal(await page.getAttribute('#nxOut', 'aria-live'), null, 'the whole pick is read out with every change');
    await until(async () => (await page.textContent('#nxSay')) !== '', 'the first line to be said', 3000);
    assert.equal(await page.textContent('#nxSay'), 'Try ' + said[await page.textContent('.nx-pick .nx-t')] + '. From 4 unread books on hand.');
    assert.equal(await page.evaluate(() => document.querySelector('.nx-pick .nx-t').tagName + document.querySelector('.nx-alts h3').textContent), 'H3Or one of these');
    await page.focus('#nxAgain');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'nx-t', 'the keyboard stayed on Pick again');
    assert.equal(await page.textContent('#nxSay'), 'Try ' + said[await page.textContent('.nx-pick .nx-t')] + '. From 4 unread books on hand.');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Already read it marks the pick Read and deals again, and Undo puts it back', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [MIDDLEMARCH, PIRANESI, CRADLE, { id: 'b09', t: 1000, title: 'Walden', authors: ['Henry David Thoreau'], room: 'Den' }, { id: 'b10', t: 1000, title: 'Emma', authors: ['Jane Austen'] }]);
    await page.click('#nextBtn');
    const ids = { Middlemarch: 'b04', Piranesi: 'b03', 'Cat\u2019s Cradle': 'b05', Walden: 'b09', Emma: 'b10' };
    const was = await page.textContent('.nx-pick .nx-t'), id = ids[was];
    await page.focus('#nxRead');
    await page.keyboard.press('Enter');
    assert.equal((await storedBook(page, id)).status, 'read');
    assert.equal(await sheetOpen(page), true, 'the sheet closed');
    const now = await page.textContent('.nx-pick .nx-t');
    assert.notEqual(now, was, 'the same book is still the pick');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'nx-t', 'the keyboard isn\'t on the new pick');
    assert.match(await page.textContent('#toastTx'), new RegExp('^Marked \u201c' + was + '\u201d as read$'));
    assert.match(await page.textContent('#nxOut > .note'), /^From 4 unread books on hand\./);
    await page.click('#toastBtn');
    assert.equal((await storedBook(page, id)).status, undefined, 'Undo didn\'t make it unread again');
    // Read with a tap this time: deal after deal, the book read never comes back.
    const gone = await page.textContent('.nx-pick .nx-t');
    await page.click('#nxRead');
    for (let k = 0; k < 6; k++) { assert.ok(!(await page.$$eval('#nxOut .nx-t, #nxOut .nx-alt .bk-t', els => els.map(e => e.textContent))).includes(gone)); await page.click('#nxAgain'); }
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Pick again brings the new pick into view, with More choices open on a narrow phone', async () => {
  const ctx = await context({ ...PHONE, viewport: { width: 360, height: 740 } });
  try {
    const page = await open(ctx);
    await page.evaluate(() => localStorage.setItem('shelfmark.prefs', JSON.stringify({ next: { more: true } })));
    const kinds = ['fiction', 'nonfiction', 'poetry'], moods = ['reflective', 'funny', 'dark', 'hopeful', 'tense'], genres = ['classics', 'history', 'science', 'fantasy'];
    await seed(page, Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, t: 1000, title: 'Book ' + (i + 1), authors: ['Ann Lee'], kind: kinds[i % 3], moods: [moods[i % 5]], genres: [genres[i % 4]],
      pace: ['slow', 'medium', 'fast'][i % 3], chapters: i % 3 ? 'short' : 'long', tags: ['t' + (i % 2)], room: ['Den', 'Hall'][i % 2], pages: 150 + i * 60, added: '2026-0' + (1 + i % 5) + '-01' })));
    await page.click('#nextBtn');
    assert.equal(await page.evaluate(() => document.getElementById('nxMore').open), true);
    const inView = () => page.evaluate(() => {
      const t = document.querySelector('.nx-pick .nx-t').getBoundingClientRect(), b = document.querySelector('#sheet .bd').getBoundingClientRect();
      return t.top >= b.top && t.bottom <= b.bottom;
    });
    assert.equal(await inView(), false, 'the pick is in view from the start, so this proves nothing');
    const was = await page.textContent('.nx-pick .nx-t');
    await page.click('#nxAgain');
    assert.notEqual(await page.textContent('.nx-pick .nx-t'), was);
    await until(inView, 'the new pick to come into view', 5000);
    // A tap on one of the others doesn't move the sheet: the person is choosing there.
    const scrolled = () => page.evaluate(() => document.querySelector('#sheet .bd').scrollTop);
    let top = -1;
    await until(async () => { const y = await scrolled(), still = y === top; top = y; return still; }, 'the sheet to stop scrolling', 5000);
    await page.click('.nx-alt >> nth=0');
    await wait(400);
    assert.equal(await scrolled(), top);
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

step('stars given to an unread book mark it Read, in a card and in Add a book, and taking them off leaves it Read', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [MIDDLEMARCH, { ...PIRANESI, status: 'reading' }]);
    await page.click('#list .bk[data-id="b04"]');
    await page.click('#f-rating button[data-v="4"]');
    assert.equal(await page.getAttribute('#f-status button[data-v="read"]', 'aria-pressed'), 'true', 'Read isn\'t pressed');
    await page.click('#bkx');
    assert.deepEqual([(await storedBook(page, 'b04')).status, (await storedBook(page, 'b04')).rating], ['read', 4]);
    await page.click('#list .bk[data-id="b04"]');
    await page.click('#f-rating button[data-v="4"]'); // off again
    await page.click('#bkx');
    assert.deepEqual([(await storedBook(page, 'b04')).status, (await storedBook(page, 'b04')).rating], ['read', undefined]);
    // A book being read stays Reading: stars there are a rating so far.
    await page.click('#list .bk[data-id="b03"]');
    await page.click('#f-rating button[data-v="5"]');
    await page.click('#bkx');
    assert.equal((await storedBook(page, 'b03')).status, 'reading');
    await page.click('#addBtn');
    await page.fill('#f-title', 'Ivanhoe');
    await page.click('#f-rating button[data-v="3"]');
    await page.click('#f-add');
    assert.equal(Object.values((await stored(page)).library.books).find(b => b.title === 'Ivanhoe').status, 'read');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

const todayIn = page => page.evaluate(() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); });
step('Read on a card fills in today as the day it was finished, to change or empty, and another status drops it', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [MIDDLEMARCH, PIRANESI]);
    const today = await todayIn(page);
    await page.click('#list .bk[data-id="b04"]');
    assert.equal(await page.isVisible('#f-finished'), false, 'an unread book shows a Finished day');
    await page.click('#f-status button[data-v="read"]');
    assert.equal(await page.inputValue('#f-finished'), today, 'Read didn\'t fill in today');
    await page.fill('#f-finished', '2025-01-05');
    await page.click('#bkx');
    assert.deepEqual([(await storedBook(page, 'b04')).status, (await storedBook(page, 'b04')).finished], ['read', '2025-01-05']);
    assert.match(await page.textContent('#list .bk[data-id="b04"] .bdg.read'), /^Read · Jan 5, 2025$/, 'the Read badge doesn\'t say when');
    // Unread drops the day; Read again starts from today. Emptied, a book is read with no day.
    await page.click('#list .bk[data-id="b04"]');
    await page.click('#f-status button[data-v="unread"]');
    assert.equal(await page.isVisible('#f-finished'), false);
    await page.click('#bkx');
    assert.equal((await storedBook(page, 'b04')).finished, undefined, 'Unread kept the finished day');
    await page.click('#list .bk[data-id="b04"]');
    await page.click('#f-status button[data-v="read"]');
    assert.equal(await page.inputValue('#f-finished'), today);
    await page.fill('#f-finished', '');
    await page.click('#bkx');
    assert.deepEqual([(await storedBook(page, 'b04')).status, (await storedBook(page, 'b04')).finished], ['read', undefined]);
    // Stars mark an unread book Read without a day: it may have been read years ago.
    await page.click('#list .bk[data-id="b03"]');
    await page.click('#f-rating button[data-v="4"]');
    assert.equal(await page.inputValue('#f-finished'), '', 'stars filled in a finished day');
    await page.click('#bkx');
    assert.deepEqual([(await storedBook(page, 'b03')).status, (await storedBook(page, 'b03')).finished], ['read', undefined]);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Set aside on a card gives up a book: its own chip and badge, out of What to read next, and back with another status', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [MIDDLEMARCH, { ...PIRANESI, status: 'reading' }]);
    await page.click('#list .bk[data-id="b03"]');
    await page.click('#f-status button[data-v="aside"]');
    await page.click('#bkx');
    assert.deepEqual([(await storedBook(page, 'b03')).status, (await storedBook(page, 'b03')).aside], ['reading', true], 'a book set aside keeps its status under it, for an older Shelfmark');
    assert.equal(await page.textContent('#list .bk[data-id="b03"] .bdg'), 'Set aside');
    assert.deepEqual(await page.$$eval('#chips .chip', els => els.map(e => e.getAttribute('aria-label'))), ['All, 2', 'Unread, 1', 'Set aside, 1'], 'the chips don\'t count it as set aside');
    await page.click('#chips [data-s="aside"]');
    assert.deepEqual(await titles(page), ['Piranesi']);
    await page.click('#chips [data-s=""]');
    await page.click('#nextBtn');
    assert.equal(await page.textContent('#nxOut > .note'), 'From 1 unread book on hand.', 'What to read next counts the book set aside');
    await page.click('#nxx');
    await page.waitForTimeout(450);
    await page.click('#list .bk[data-id="b03"]');
    assert.equal(await page.getAttribute('#f-status button[data-v="aside"]', 'aria-pressed'), 'true');
    await page.click('#f-status button[data-v="unread"]');
    await page.click('#bkx');
    assert.deepEqual([(await storedBook(page, 'b03')).status, (await storedBook(page, 'b03')).aside], [undefined, undefined], 'Unread didn\'t take it back');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('the count says how many were read this year, and the Read list is in the order they were finished', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx), y = new Date().getFullYear();
    await seed(page, [MIDDLEMARCH, { ...PIRANESI, status: 'read', finished: y + '-01-02' }, { ...CRADLE, status: 'read', finished: y + '-02-01' },
      { id: 'b07', t: 1000, title: 'Emma', authors: ['Jane Austen'], status: 'read', finished: (y - 1) + '-12-30' }, { id: 'b08', t: 1000, title: 'Persuasion', authors: ['Jane Austen'], status: 'read' }]);
    assert.equal(await page.textContent('#count'), '5 books · 4 read, 2 this year');
    await page.click('#chips [data-s="read"]');
    assert.deepEqual(await titles(page), ['Cat’s Cradle', 'Piranesi', 'Emma', 'Persuasion'], 'the Read list isn\'t latest finished first, then the rest by author');
    assert.equal(await page.inputValue('#sortSel'), 'finished');
    assert.equal(await page.textContent('#sortSel option[value="finished"]'), 'Recently finished');
    await page.click('#chips [data-s=""]');
    assert.equal(await page.inputValue('#sortSel'), 'author', 'leaving Read didn\'t put the sort back');
    assert.equal((await titles(page))[0], 'Emma', 'the list isn\'t by author again');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Reading now comes first: Finished marks a book read today, with Undo and Rate it, and Set aside gives one up', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx), today = await todayIn(page);
    await seed(page, [MIDDLEMARCH, { ...PIRANESI, status: 'reading' }, { ...CRADLE, status: 'reading', room: 'Den' }]);
    const nowTitles = () => page.$$eval('#list .now .bk .bk-t', els => els.map(e => e.firstChild.textContent));
    assert.match(await page.textContent('#list .now .grp'), /^Reading now,\s2\sbooks$/);
    assert.deepEqual(await nowTitles(), ['Piranesi', 'Cat\u2019s Cradle']);
    assert.deepEqual(await page.$$eval('#list .rest .bk .bk-t', els => els.map(e => e.firstChild.textContent)), ['Piranesi', 'Middlemarch', 'Cat\u2019s Cradle'], 'All books below has every book, the two being read too');
    // A search or a filter shows only what it finds.
    await page.fill('#q', 'eliot');
    await until(async () => (await titles(page)).length === 1, 'the search');
    assert.equal(await page.$('#list .now'), null, 'Reading now shows with a search on');
    await page.fill('#q', '');
    await until(async () => (await nowTitles()).length === 2, 'Reading now again');
    // Finished: read today. The toast's Rate it opens the card at its stars.
    await page.click('[data-fin="b03"]');
    assert.deepEqual([(await storedBook(page, 'b03')).status, (await storedBook(page, 'b03')).finished], ['read', today]);
    assert.equal(await page.textContent('#toastTx'), 'Marked \u201cPiranesi\u201d as read');
    assert.deepEqual([await page.textContent('#toastBtn'), await page.textContent('#toastBtn2')], ['Undo', 'Rate it']);
    assert.deepEqual(await nowTitles(), ['Cat\u2019s Cradle']);
    await page.click('#toastBtn2');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#f-rating')), true, 'Rate it didn\'t put the keyboard on the stars');
    await page.click('#f-rating button[data-v="4"]');
    await page.click('#bkx');
    assert.deepEqual([(await storedBook(page, 'b03')).status, (await storedBook(page, 'b03')).rating, (await storedBook(page, 'b03')).finished], ['read', 4, today]);
    // From the keyboard: Finished, then Undo, which puts it back and the keyboard on its Finished again.
    await page.waitForTimeout(450);
    // Closed, the card Rate it opened gives the keyboard to the book's row, not to the page's start.
    assert.deepEqual(await page.evaluate(() => [document.activeElement.dataset.id, !!document.activeElement.dataset.now]), ['b03', false], 'closing the card from Rate it lost the keyboard');
    await page.focus('[data-fin="b05"]');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'toastBtn', 'the keyboard isn\'t on Undo');
    assert.equal(await page.$('#list .now'), null, 'Reading now stays with nothing being read');
    await page.keyboard.press('Enter');
    assert.deepEqual([(await storedBook(page, 'b05')).status, (await storedBook(page, 'b05')).finished], ['reading', undefined], 'Undo didn\'t put it back');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.fin), 'b05', 'Undo didn\'t put the keyboard back on Finished');
    // Set aside gives it up, with Undo.
    await page.click('[data-aside="b05"]');
    assert.deepEqual([(await storedBook(page, 'b05')).status, (await storedBook(page, 'b05')).aside], ['reading', true]);
    assert.equal(await page.textContent('#toastTx'), 'Set aside \u201cCat\u2019s Cradle\u201d');
    assert.equal(await page.$('#list .now'), null);
    await page.click('#toastBtn');
    assert.deepEqual(await nowTitles(), ['Cat\u2019s Cradle'], 'Undo didn\'t bring it back to Reading now');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Mark what you\'ve read lists the unread books shelf by shelf, narrows to a shelf, and marks the ticked ones read at once, with Undo', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...MIDDLEMARCH, shelf: 'Top' }, PIRANESI, { ...CRADLE, room: 'Den', shelf: 'Top' }, { id: 'b07', t: 1000, title: 'Emma', authors: ['Jane Austen'], room: 'Den', shelf: 'Low' }]);
    // No book is marked read yet, so the note under the pick offers it.
    await page.click('#nextBtn');
    assert.equal(await page.textContent('.nx-mark .note'), 'No book here is marked read yet, so this could be one you’ve read.');
    await page.click('#nxMark');
    assert.equal(await page.textContent('#sheetTitle'), 'Mark what you’ve read');
    assert.equal(await page.textContent('#mr-lede'), '4 unread books, on 3 shelves. Tick the ones you’ve read.');
    assert.deepEqual(await page.$$eval('#mrShelf option', os => os.map(o => o.textContent)), ['All shelves · 4', 'Den › Low · 1', 'Den › Top · 2', 'Hall · 1']);
    const rows = () => page.$$eval('#mrList .rt', els => els.map(e => e.textContent));
    await page.selectOption('#mrShelf', { label: 'Den › Top · 2' });
    assert.deepEqual(await rows(), ['Middlemarch', 'Cat\u2019s Cradle'], 'the Shelf menu doesn\'t narrow it to that shelf');
    assert.equal(await page.isDisabled('#mrGo'), true);
    await page.click('#mrList .mr-row:has-text("Middlemarch") .rt'); // a tap on the title ticks it
    assert.equal(await page.textContent('#mrGo'), 'Mark 1 as read');
    await page.selectOption('#mrShelf', '');
    assert.equal(await page.isChecked('#mrList input[data-id="b04"]'), true, 'a tick went when the shelf changed');
    await page.click('#mrList .mr-row:has-text("Piranesi")');
    await page.selectOption('#mrShelf', { label: 'Hall · 1' });
    assert.deepEqual([await page.textContent('#mrGo'), await page.textContent('#mr-n')], ['Mark 2 as read', '1 book ticked on other shelves']);
    await page.click('#mrGo');
    assert.equal(await sheetOpen(page), false);
    const st = async id => { const b = await storedBook(page, id); return [b.status, b.finished]; };
    assert.deepEqual([await st('b04'), await st('b03'), await st('b05')], [['read', undefined], ['read', undefined], [undefined, undefined]], 'marked read with no finished day, only the ticked ones');
    assert.equal(await page.textContent('#toastTx'), 'Marked 2 books as read');
    await page.click('#toastBtn');
    assert.deepEqual([await st('b04'), await st('b03')], [[undefined, undefined], [undefined, undefined]], 'Undo didn\'t put them back');
    // Settings opens it too, on the shelf chosen before.
    await page.click('#setBtn');
    await page.click('#stMark');
    assert.equal(await page.inputValue('#mrShelf') !== '', true, 'the shelf chosen before wasn\'t kept');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('the wishlist: its own chip, out of the counts and What to read next, found by a search with a Wanted badge, and Got it brings a book home', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx), today = await todayIn(page);
    const CIRCE = { id: 'w1', t: 1000, title: 'Circe', authors: ['Madeline Miller'], wanted: true, added: '2026-10-01', notes: 'Sam says read it' };
    await seed(page, [MIDDLEMARCH, PIRANESI, CIRCE]);
    assert.deepEqual(await titles(page), ['Piranesi', 'Middlemarch'], 'a book on the wishlist is in the list');
    assert.equal(await page.textContent('#count'), '2 books');
    assert.deepEqual(await page.$$eval('#chips .chip', els => els.map(e => e.getAttribute('aria-label'))), ['All, 2', 'Unread, 2', 'Wishlist, 1']);
    await page.click('#setBtn');
    assert.match(await page.locator('#sheet p', { hasText: 'in this browser' }).textContent(), /^2 books and 1 on your wishlist in this browser\./);
    await page.click('#stx');
    await page.waitForTimeout(450);
    // A search, as in a shop: does Shelfmark have it, or was it meant to be bought?
    await page.fill('#q', 'circe');
    await until(async () => (await titles(page)).length === 1, 'the search');
    assert.equal(await page.textContent('#list .bk[data-id="w1"] .bdg.wanted'), 'Wanted');
    assert.equal(await page.textContent('#count'), '0 of 2 books · 1 on your wishlist');
    await page.fill('#q', '');
    await page.click('#chips [data-s="wanted"]');
    assert.deepEqual(await titles(page), ['Circe']);
    assert.equal(await page.$('#list .bdg.wanted'), null, 'the Wishlist view badges every book Wanted');
    assert.equal(await page.textContent('#count'), '1 book on your wishlist');
    // What to read next leaves it out.
    await page.click('#nextBtn');
    assert.equal(await page.textContent('#nxOut > .note'), 'From 2 unread books on hand.');
    await page.click('#nxx');
    await page.waitForTimeout(450);
    // Add a book from the Wishlist chip: it's wanted, with no place.
    await page.click('#addBtn');
    assert.equal(await page.isChecked('#f-wantbox'), true, 'Add a book from the Wishlist isn\'t wanted');
    assert.equal(await page.isVisible('#f-room'), false, 'a book wanted asks for a room');
    await page.fill('#f-title', 'Hamnet');
    await page.click('#f-add');
    assert.equal(await page.textContent('#toastTx'), 'Added \u201cHamnet\u201d to your wishlist');
    assert.deepEqual(await titles(page), ['Circe', 'Hamnet'], 'the book added isn\'t on the wishlist');
    // Got it: the book is in the house, added today, and its room and shelf come back to fill in.
    await page.waitForTimeout(450);
    await page.click('#list .bk[data-id="w1"]');
    assert.equal(await page.isVisible('#f-want'), true);
    assert.equal(await page.textContent('#callno'), 'On your wishlist');
    await page.click('#f-got');
    assert.equal(await page.isVisible('#f-want'), false);
    await page.fill('#f-room', 'Hall');
    await page.click('#bkx');
    const w = await storedBook(page, 'w1');
    assert.deepEqual([w.wanted, w.added, w.room, w.notes], [undefined, today, 'Hall', 'Sam says read it'], 'Got it didn\'t bring the book home, added today');
    assert.deepEqual(await titles(page), ['Hamnet'], 'the book got is still on the wishlist');
    await page.click('#chips [data-s=""]');
    assert.equal(await page.textContent('#count'), '3 books');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a batch of books wanted goes on the wishlist, and a book from the wishlist added from a shelf comes off it, with Undo', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [{ ...MIDDLEMARCH, shelf: 'Low' }, { id: 'w1', t: 1000, title: 'Circe', authors: ['Madeline Miller'], wanted: true, added: '2026-10-01', notes: 'Sam says read it' }]);
    await page.goto(linkTo({ name: 'Bookshop table', wanted: true, books: [{ title: 'Hamnet', authors: ['Maggie O\u2019Farrell'] }, { title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Circe', authors: ['Madeline Miller'] }] }));
    await page.waitForSelector('#rv-add');
    assert.equal(await page.textContent('#sheetTitle'), 'Add to your wishlist');
    assert.equal(await page.isVisible('#rv-room'), false, 'books wanted are asked for a shelf');
    assert.deepEqual(await page.$$eval('#rv > li', lis => lis.map(li => li.querySelector('.rv-tick input').checked)), [true, false, false], 'only the book neither here nor wanted is ticked');
    assert.match(await page.textContent('#rv-n-1'), /^Already in your library — Den › Low\. Tick it to add it to your wishlist anyway\.$/);
    assert.match(await page.textContent('#rv-n-2'), /^Already on your wishlist/);
    assert.equal(await page.textContent('#rv-add'), 'Add 1 to your wishlist');
    await page.click('#rv-add');
    assert.equal(await page.textContent('#toastTx'), 'Added 1 to your wishlist');
    assert.deepEqual(await titles(page), ['Hamnet', 'Circe'], 'the wishlist doesn\'t show, newest first');
    assert.equal((await stored(page)).library.books[await newId(page, 'Hamnet')].wanted, true);
    // A shelf's photo with a book that was on the wishlist: it comes off the list into the house, keeping its notes.
    await page.goto(linkTo({ name: 'Hall', room: 'Hall', books: [{ title: 'Circe', authors: ['Madeline Miller'], isbn: '9780316556347' }] }));
    await page.waitForSelector('#rv-add');
    assert.equal(await page.textContent('#rv-n-0'), 'On your wishlist. Adding it takes it off the list.');
    assert.equal(await page.isChecked('#rv > li .rv-tick input'), true);
    await page.click('#rv-add');
    const c = await storedBook(page, 'w1');
    assert.deepEqual([c.wanted, c.room, c.isbn, c.notes], [undefined, 'Hall', '9780316556347', 'Sam says read it'], 'the book on the wishlist didn\'t become the one in the house');
    assert.equal(Object.values((await stored(page)).library.books).filter(b => b.title === 'Circe' && !b.del).length, 1, 'a second Circe was added');
    await page.click('#toastBtn');
    const back = await storedBook(page, 'w1');
    assert.deepEqual([back.wanted, back.room, back.isbn], [true, undefined, undefined], 'Undo didn\'t put it back on the wishlist as it was');
    // Added by hand, the same: the card says it's on the wishlist, and adding it takes it off.
    await page.waitForTimeout(450);
    await page.click('#chips [data-s=""]');
    await page.click('#addBtn');
    await page.fill('#f-title', 'Circe');
    await page.fill('#f-authors', 'Madeline Miller');
    await until(async () => (await page.textContent('#f-dup')) !== '', 'the note on a book on the wishlist');
    assert.equal(await page.textContent('#f-dup'), 'It’s on your wishlist. Adding it here takes it off the list.');
    await page.fill('#f-room', 'Den');
    await page.click('#f-add');
    assert.equal(await page.textContent('#toastTx'), 'Added \u201cCirce\u201d to Den, off your wishlist');
    assert.deepEqual([(await storedBook(page, 'w1')).wanted, (await storedBook(page, 'w1')).room], [undefined, 'Den']);
    await page.click('#toastBtn');
    assert.equal((await storedBook(page, 'w1')).wanted, true, 'Undo didn\'t put it back on the wishlist');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

// Made-up books, by made-up authors, for a list long enough to scroll a long way.
const MANY = Array.from({ length: 60 }, (_, i) => ({ id: 'm' + i, t: 1000, title: 'Volume of Tales ' + (i + 1), authors: ['Author ' + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + i % 26) + ' Quill'], added: '2026-10-01', room: 'Study', shelf: 'Shelf ' + (1 + i % 5) }));
const inView = (page, id) => page.evaluate(id => {
  const r = document.querySelector('#list .bk[data-id="' + id + '"]'); if (!r) return 'not in the list';
  const g = r.getBoundingClientRect(), top = document.querySelector('.top').getBoundingClientRect().bottom;
  return g.top >= top && g.bottom <= innerHeight ? true : 'at ' + Math.round(g.top) + '-' + Math.round(g.bottom) + ', the screen ' + Math.round(top) + '-' + innerHeight;
}, id);
const newId = async (page, title) => Object.values((await stored(page)).library.books).filter(b => b.title === title && !b.del).map(b => b.id)[0];

step('Add a book starts from the chip and the search, and the book added is shown in the list, with Undo', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [...MANY, { ...WALDEN, status: 'read' }]);
    // With Read chosen, a new book starts at Read; added, it's in view and tinted, the toast saying where it went.
    await page.click('#chips .chip[data-s="read"]');
    await page.click('#addBtn');
    assert.equal(await page.getAttribute('#f-status button[data-v="read"]', 'aria-pressed'), 'true', 'Add a book didn\'t start at Read');
    await page.fill('#f-title', 'An Almanac of Small Rooms');
    await page.fill('#f-authors', 'Zelda Zimmer');
    await page.fill('#f-room', 'Hall');
    await page.fill('#f-shelf', 'Console table');
    await page.click('#f-add');
    const id = await newId(page, 'An Almanac of Small Rooms');
    assert.equal((await storedBook(page, id)).status, 'read');
    await wait(1000);
    assert.equal(await inView(page, id), true, 'the new book is out of sight');
    assert.equal(await page.textContent('#toastTx'), 'Added “An Almanac of Small Rooms” to Hall › Console table');
    assert.equal(await page.textContent('#toastBtn'), 'Undo');
    // Undo takes it back out, as a removal that a sync carries to other devices.
    await page.click('#toastBtn');
    assert.deepEqual(Object.keys(await storedBook(page, id)).sort(), ['del', 'id', 't']);
    assert.equal(await page.textContent('#toastTx'), 'Took it back out');
    assert.equal(await page.locator('#list .bk[data-id="' + id + '"]').count(), 0);
    // The next book starts on the shelf the last one went to. A room chosen in the menu that's another room wins.
    await wait(450);
    await page.click('#addBtn');
    assert.deepEqual([await page.inputValue('#f-room'), await page.inputValue('#f-shelf')], ['Hall', 'Console table'], 'the shelf isn\'t remembered');
    await page.click('#bkx2');
    await wait(450);
    await page.click('#chips .chip[data-s=""]');
    await page.selectOption('#roomSel', 'Study');
    await page.click('#addBtn');
    assert.deepEqual([await page.inputValue('#f-room'), await page.inputValue('#f-shelf')], ['Study', '']);
    assert.equal(await page.getAttribute('#f-status button[data-v="unread"]', 'aria-pressed'), 'true');
    await page.click('#bkx2');
    // A search that finds nothing offers to add that title. Added, the search and the room hiding it are cleared.
    await wait(450);
    await page.fill('#q', 'zzz');
    await page.click('#list [data-act="addq"]');
    assert.equal(await page.inputValue('#f-title'), 'zzz');
    await page.fill('#f-title', 'Zany Zoology');
    await page.fill('#f-room', 'Hall');
    await page.click('#f-add');
    const z = await newId(page, 'Zany Zoology');
    assert.deepEqual([await page.inputValue('#q'), await page.inputValue('#roomSel')], ['', ''], 'the search or the room still hides the new book');
    await wait(1000);
    assert.equal(await inView(page, z), true);
    // Typing a book that's here already says so, and where; added, the toast says where the first copy is.
    await wait(450);
    await page.click('#addBtn');
    assert.equal(await page.textContent('#f-dup'), '');
    await page.fill('#f-title', 'walden');
    await page.fill('#f-authors', 'Henry D. Thoreau');
    await until(() => page.$eval('#f-dup', e => e.textContent !== ''), 'the note that it\'s here already', 3000);
    assert.equal(await page.textContent('#f-dup'), 'You already have this — Study. Add another copy?');
    await page.click('#f-add');
    assert.equal(await page.textContent('#toastTx'), 'Added another copy. The first is in Study.');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a new book closed before Add keeps its typing for the next Add a book, and Cancel or Clear lets it go', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [WALDEN]);
    const kept = () => page.locator('.kept').count();
    // a sheet closed other than by Back leaves its history entry a moment later
    const gone = () => until(() => page.evaluate(() => !(history.state && history.state.sheet)), 'the card\'s history entry to go', 3000);
    // Escape keeps it, and the next Add a book opens with it, saying so.
    await page.click('#addBtn');
    assert.equal(await kept(), 0);
    await page.fill('#f-title', 'Half a Title');
    await page.fill('#f-authors', 'Ada Quill');
    await page.click('#f-status button[data-v="reading"]');
    await page.keyboard.press('Escape');
    assert.equal(await sheetOpen(page), false);
    await gone();
    assert.equal(Object.values((await stored(page)).library.books).length, 1, 'closing it added the book');
    await page.click('#addBtn');
    assert.equal(await page.textContent('.kept .note'), 'Kept from before');
    assert.deepEqual([await page.inputValue('#f-title'), await page.inputValue('#f-authors'), await page.getAttribute('#f-status button[data-v="reading"]', 'aria-pressed')], ['Half a Title', 'Ada Quill', 'true']);
    // So does Back, untouched; Clear starts afresh.
    await page.goBack();
    await until(async () => !(await sheetOpen(page)), 'Back to close the card', 3000);
    await wait(450); // a tap where the last one was is ignored for a moment after a sheet closes (see tapGuard)
    await page.click('#addBtn');
    assert.equal(await page.inputValue('#f-title'), 'Half a Title');
    await page.click('#f-clear');
    assert.deepEqual([await kept(), await page.inputValue('#f-title'), await page.inputValue('#f-authors')], [0, '', '']);
    // A tap beside the card keeps it too; Cancel lets it go.
    await page.fill('#f-title', 'Another Start');
    await page.mouse.click(195, 10); // the dimmed page above the sheet
    assert.equal(await sheetOpen(page), false);
    await gone();
    await page.click('#addBtn');
    assert.equal(await page.inputValue('#f-title'), 'Another Start');
    await page.click('#bkx2');
    await gone();
    await wait(450);
    await page.click('#addBtn');
    assert.deepEqual([await kept(), await page.inputValue('#f-title')], [0, '']);
    // Opened and closed with nothing typed, nothing is kept; added, nothing is kept either.
    await page.keyboard.press('Escape');
    await gone();
    await wait(450);
    await page.click('#addBtn');
    assert.equal(await kept(), 0);
    await page.fill('#f-title', 'Moby-Dick');
    await page.click('#f-add');
    await gone();
    await wait(450);
    await page.click('#addBtn');
    assert.deepEqual([await kept(), await page.inputValue('#f-title')], [0, '']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a book added by hand to a long list sorted by author is in view, on a phone and with a mouse', async () => {
  for (const opts of [PHONE, DESK, { ...PHONE, reducedMotion: 'reduce' }]) {
    const ctx = await context(opts);
    try {
      const page = await open(ctx);
      await seed(page, MANY);
      await page.click('#addBtn');
      await page.fill('#f-title', 'Nightingale Lane');
      await page.fill('#f-authors', 'Author CB Quill'); // near the end, by author
      await page.click('#f-add');
      const id = await newId(page, 'Nightingale Lane');
      await wait(opts.reducedMotion ? 100 : 1200);
      assert.equal(await inView(page, id), true, (opts.reducedMotion ? 'reduced motion: ' : '') + opts.viewport.width + 'px: the new book is out of sight');
      assert.equal(await page.$eval('#list .bk[data-id="' + id + '"]', e => e.classList.contains('new')), true, 'the new book isn\'t tinted');
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('Undo after Add a book takes it out of Drive too', async () => {
  const g = fakeGoogle();
  const ctx = await context();
  await g.install(ctx);
  try {
    const page = await open(ctx);
    await seed(page, [WALDEN]);
    await connectDrive(page);
    await until(() => page.evaluate(() => document.getElementById('syncTx').textContent === 'Synced'), 'the first sync');
    await page.click('#addBtn');
    await page.fill('#f-title', 'Moby-Dick');
    await page.fill('#f-authors', 'Herman Melville');
    await page.click('#f-add');
    const id = await newId(page, 'Moby-Dick');
    await page.focus('#toastBtn'); // the toast stays while Undo has the keyboard, however long the sync takes
    const inDrive = () => { const f = g.files().find(f => f.name === 'Shelfmark library.json'); return f && JSON.parse(f.body).library.books[id]; };
    await until(() => inDrive() && !inDrive().del, 'the new book to reach Drive', 15000);
    await page.click('#toastBtn');
    await until(() => inDrive() && inDrive().del === 1, 'the removal to reach Drive', 15000);
    assert.equal(await page.locator('#list .bk[data-id="' + id + '"]').count(), 0);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Undo after adding books from a link takes them all back out, and the link opens as new again', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [WALDEN]);
    const link = linkTo({ name: 'Hall', room: 'Hall', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Gilead', authors: ['Marilynne Robinson'] }, { title: 'Emma', authors: ['Jane Austen'] }] });
    await page.goto(link);
    await page.waitForSelector('#rv-add');
    await page.click('#rv-add');
    assert.equal(await page.textContent('#toastTx'), 'Added 3 books — newest first');
    assert.equal(await page.textContent('#toastBtn'), 'Undo');
    const before = await stored(page);
    assert.equal(Object.keys(before.library.seen).length, 1);
    await page.click('#toastBtn');
    assert.equal(await page.textContent('#toastTx'), 'Took them back out');
    assert.deepEqual(await titles(page), ['Walden']);
    const after = await stored(page), gone = Object.values(after.library.books).filter(b => b.id !== 'w1');
    assert.deepEqual(gone.map(b => Object.keys(b).sort().join()), ['del,id,t', 'del,id,t', 'del,id,t'], 'the books taken back out aren\'t kept as removals');
    assert.ok(gone.every(b => b.t > before.library.books[b.id].t), 'a removal isn\'t newer than the book');
    assert.deepEqual(after.library.seen, {}, 'the link is still remembered as added');
    // Opened again, it's a link not yet used: every book ticked, and nothing about having added them.
    await page.goto(base);
    await page.goto(link);
    await page.waitForSelector('#rv-add');
    assert.deepEqual(await page.$$eval('#rv .rv-tick input', els => els.map(e => e.checked)), [true, true, true]);
    assert.equal(await page.textContent('#rv-head'), 'Hall · 3 books');
    assert.equal(await page.textContent('#rv-add'), 'Add 3 books');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Undo after adding books from a link takes them out of Drive too', async () => {
  const g = fakeGoogle();
  const ctx = await context();
  await g.install(ctx);
  try {
    const page = await open(ctx);
    await seed(page, [WALDEN]);
    await connectDrive(page);
    await until(() => page.evaluate(() => document.getElementById('syncTx').textContent === 'Synced'), 'the first sync');
    await page.goto(linkTo({ name: 'Hall', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }, { title: 'Gilead', authors: ['Marilynne Robinson'] }] }));
    await page.waitForSelector('#rv-add');
    await page.click('#rv-add');
    const ids = Object.values((await stored(page)).library.books).filter(b => b.id !== 'w1').map(b => b.id);
    assert.equal(ids.length, 2);
    await page.focus('#toastBtn'); // the toast stays while Undo has the keyboard, however long the sync takes
    const inDrive = () => { const f = g.files().find(f => f.name === 'Shelfmark library.json'); return f ? ids.map(id => JSON.parse(f.body).library.books[id]) : []; };
    await until(() => inDrive().length && inDrive().every(b => b && !b.del), 'the new books to reach Drive', 15000);
    await page.click('#toastBtn');
    await until(() => inDrive().every(b => b && b.del === 1), 'the removals to reach Drive', 15000);
    assert.deepEqual(await titles(page), ['Walden']);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a link\'s books closed without adding say how to get them back: Not now, Back, or a tap beside them', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    const link = linkTo({ name: 'Hall', books: [{ title: 'Middlemarch', authors: ['George Eliot'] }] }), said = 'Nothing added. Tap the link in Claude again when you’re ready.';
    const toast = () => page.evaluate(() => document.getElementById('toast').classList.contains('show') ? document.getElementById('toastTx').textContent : '');
    for (const how of ['Not now', 'Back', 'beside']) {
      await page.goto(link);
      await page.waitForSelector('#rv-add');
      assert.equal(await toast(), '', how + ': a toast before closing');
      if (how === 'Not now') await page.click('#rvx');
      else if (how === 'Back') await page.goBack();
      else await page.touchscreen.tap(195, 20);
      await until(async () => await toast() === said, 'the toast after ' + how);
      assert.equal(await sheetOpen(page), false);
      await page.evaluate(() => { document.getElementById('toast').classList.remove('show'); });
    }
    assert.deepEqual(Object.keys((await stored(page))?.library.books || {}), [], 'something was added');
    // Pasted into Import, there's no link to tap again, so closing says nothing.
    await page.click('#importBtn');
    await page.fill('#impaste', link);
    await page.click('#imgo');
    await page.waitForSelector('#rv-add');
    await page.click('#rvx');
    await wait(400);
    assert.equal(await toast(), '');
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

step('a toast from the last thing done doesn\'t cover the next sheet: Start reading, then a book\'s Done', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    await page.click('#nextBtn');
    await page.click('#nxGo');
    assert.match(await page.textContent('#toastTx'), /as reading/);
    await page.tap('#list .bk[data-id="b04"]'); // well within the toast's six seconds
    assert.equal(await sheetOpen(page), true);
    const done = await page.locator('#bkx').boundingBox();
    await page.touchscreen.tap(done.x + done.width / 2, done.y + 4);
    assert.equal(await sheetOpen(page), false, 'a tap at the top of Done didn\'t close the card');
    // A toast raised inside a sheet on a phone sits above its footer, clear of its heading and buttons.
    await page.tap('#list .bk[data-id="b04"]');
    await page.click('details.more > summary >> nth=0');
    for (const m of ['adventurous', 'challenging', 'dark', 'emotional', 'funny']) await page.click('#f-moods button[data-m="' + m + '"]');
    assert.match(await page.textContent('#toastTx'), /Up to four moods/);
    await wait(300);
    const [t, hd, ft] = await page.evaluate(() => ['#toast', '#sheet .hd', '#sheet .ft'].map(q => { const r = document.querySelector(q).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    assert.ok(t.top >= hd.bottom && t.bottom <= ft.top, 'the toast lies over the sheet\'s heading or footer: ' + JSON.stringify([t, hd, ft]));
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Start reading says where the book is, its place cut short on a small phone', async () => {
  const ctx = await context({ ...PHONE, viewport: { width: 320, height: 640 } });
  try {
    const page = await open(ctx);
    await seed(page, [{ ...MIDDLEMARCH, room: 'Study', shelf: 'Window bookcase, brass owl bookend shelf' }]);
    await page.click('#nextBtn');
    await page.click('#nxGo');
    assert.equal(await page.textContent('#toastTx'), 'Marked \u201cMiddlemarch\u201d as reading. It\u2019s on Study \u203a Window bookcase, brass owl\u2026');
    assert.ok((await page.locator('#toast').boundingBox()).height < 90, 'the toast runs to four lines or more');
    await page.click('#toastBtn');
    await seed(page, [{ ...MIDDLEMARCH, room: '' }]);
    await page.click('#nextBtn');
    await page.click('#nxGo');
    assert.equal(await page.textContent('#toastTx'), 'Marked \u201cMiddlemarch\u201d as reading', 'a book with no place says only that');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('a toast quoting a long title stays two lines on a small phone', async () => {
  const ctx = await context({ ...PHONE, viewport: { width: 320, height: 640 } });
  try {
    const page = await open(ctx);
    await seed(page, [{ id: 'L1', t: 1000, title: 'The Interesting Narrative of the Life of Olaudah Equiano, or Gustavus Vassa, the African', authors: ['Olaudah Equiano'] }]);
    await page.click('#list .bk[data-id="L1"]');
    await page.click('#f-del');
    assert.equal(await page.textContent('#toastTx'), 'Removed “The Interesting Narrative of the Life of…”');
    assert.ok((await page.locator('#toast').boundingBox()).height < 60, 'the toast runs to three lines or more');
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

step('the sync button is named Saving while a change waits to go to Drive, not Synced', async () => {
  const g = fakeGoogle();
  const ctx = await context(DESK);
  await g.install(ctx);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    await connectDrive(page);
    // A change made while a sync is sending the one before waits for the next sync.
    let sending = 0;
    await ctx.route('https://www.googleapis.com/upload/drive/v3/files/**', async r => { if (r.request().method() === 'PATCH') { sending++; await wait(1500); } r.fallback(); });
    await page.click('#list .bk[data-id="b03"]');
    await page.click('#f-status button[data-v="read"]');
    await page.click('#bkx2');
    await until(() => sending > 0, 'the change to be sent');
    await wait(450);
    await page.click('#list .bk[data-id="b04"]');
    await page.click('#f-status button[data-v="read"]');
    await page.click('#bkx2');
    const sync = () => page.evaluate(() => { const b = document.getElementById('syncBtn'); return [b.dataset.s, document.getElementById('syncTx').textContent, b.title]; });
    await until(async () => (await sync())[1] === 'Saving', 'the button to say Saving', 8000);
    assert.deepEqual(await sync(), ['ok', 'Saving', 'Saving to Google Drive'], 'the button is named Synced while a change waits');
    await until(async () => (await sync())[1] === 'Synced', 'the next sync', 10000);
    assert.match((await sync())[2], /^Synced with Google Drive/);
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('Drive on a second device: the page shows it working, never says the shelves are empty meanwhile, and says what came in', async () => {
  const g = fakeGoogle();
  const driveBooks = () => { const f = g.files().find(f => f.appProperties && f.appProperties.shelfmark === 'library' && !f.trashed); return f && f.body ? Object.keys(JSON.parse(f.body).library.books) : []; };
  // The laptop has the library, in Drive.
  const a = await context(DESK);
  await g.install(a);
  try {
    const pa = await open(a);
    await seed(pa, [PIRANESI, MIDDLEMARCH, CRADLE]);
    await connectDrive(pa);
    await until(() => driveBooks().length === 3, 'the library to reach Drive');
  } finally { await a.close(); }
  // A new phone, on a slow connection: each answer from Drive takes a second and a half.
  const b = await context();
  await g.install(b);
  await b.route('https://www.googleapis.com/**', async r => { await wait(1500); r.fallback(); });
  try {
    const page = await open(b);
    assert.match(await page.textContent('#list'), /Your shelves are empty/);
    assert.equal(await page.textContent('#list .empty .away'), 'Use Shelfmark on another device? Connect Google Drive to bring your library here.');
    assert.deepEqual(page.outside, [], 'the empty page loads something from elsewhere (Google\'s sign-in loads only when Settings opens)');
    await page.click('#list [data-act="drive"]');
    assert.equal(await page.textContent('#sheetTitle'), 'Settings');
    await page.waitForFunction(() => window.google && window.google.accounts);
    await page.click('#dvGo');
    await until(async () => /Syncing now…/.test(await page.textContent('#driveSect')), 'Settings to say it\'s syncing', 3000);
    assert.deepEqual(await page.evaluate(() => { const s = document.getElementById('syncBtn'); return [s.hidden, s.dataset.s]; }), [false, 'busy'], 'the sync button doesn\'t show the sync under way');
    await page.click('#stx');
    assert.equal(await page.textContent('#list .empty h2'), 'Bringing your library from Google Drive…');
    await until(async () => (await titles(page)).length === 3, 'the library to come in', 20000);
    assert.equal(await page.textContent('#toastTx'), 'Brought in 3 books from your Google Drive');
    assert.deepEqual(page.problems, []);
  } finally { await b.close(); }
  // Sync turned on, but Google's hour is up and nothing has come in yet: it says where the library is, and Sync brings it.
  const c = await context();
  await g.install(c);
  try {
    const page = await open(c);
    await page.evaluate(() => localStorage.setItem('shelfmark.drive', JSON.stringify({ on: true })));
    await page.reload();
    assert.deepEqual([await page.textContent('#list .empty h2'), await page.textContent('#list .empty p')], ['Your library is in your Google Drive', 'Tap Sync to bring it here.']);
    await page.waitForFunction(() => window.google && window.google.accounts);
    await page.click('#list [data-act="sync"]');
    await until(async () => (await titles(page)).length === 3, 'the library to come in', 10000);
    assert.equal(await page.textContent('#toastTx'), 'Brought in 3 books from your Google Drive');
    assert.deepEqual(page.problems, []);
  } finally { await c.close(); }
});

step('Sync now pressed from the keyboard keeps the keyboard on it while Settings is drawn again', async () => {
  const g = fakeGoogle();
  const ctx = await context(DESK);
  await g.install(ctx);
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI]);
    await connectDrive(page);
    await page.click('#setBtn');
    await page.focus('#dvSync');
    await page.keyboard.press('Enter');
    await until(async () => /Last synced/.test(await page.textContent('#driveSect')), 'the sync to end');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dvSync', 'Settings drawn again loses the keyboard');
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
    assert.match(await b.textContent('#rv-head'), /You added these books (just now|\d+ min ago)\. Books you already have are unticked\./);
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
    await rowOf(b, 2).locator('[data-f="title"]').fill('Sense and Sensibility: A Novel');
    await b.waitForFunction(() => window.google && window.google.accounts);
    await b.click('#behindGo');
    await until(async () => (await b.locator('#behind').count()) === 0, 'the sync to land and the flag to go');
    await until(async () => (await b.textContent('.lede')) === 'Hall shelf · 3 books · 2 you already have', 'the sheet to check the books again');
    assert.deepEqual(await b.$$eval('#rv .rv-tick input', els => els.map(e => e.checked)), [false, false, true], 'a row the person touched changed its tick, or a book found in Drive stayed ticked');
    assert.match(await rowOf(b, 0).textContent(), /Already in your library\. Tick it to add another copy\./);
    assert.equal(await rowOf(b, 0).getAttribute('class'), 'off');
    assert.equal(await rowOf(b, 2).locator('[data-f="title"]').inputValue(), 'Sense and Sensibility: A Novel', 'the corrected title was undone');
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
    assert.equal(await b.textContent('.lede'), '3 books · 1 not in your library', 'the lede says “Reading details” again, under the sheet\'s title');
    assert.equal(await b.textContent('#behind'), 'Checking Drive for books added on your other devices…');
    assert.equal(await b.textContent('#dt-n'), 'Add the 1 book not in your library first, then open this link again. It fills in only what’s missing.');
    await b.check('#dtRe');
    await until(async () => (await b.textContent('.lede')) === '3 books', 'the sheet to match the books again once the sync lands', 15000);
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
    assert.equal(await page.textContent('.lede'), '5 books · 1 not in your library');
    assert.equal(await page.textContent('#dtgo'), 'Add details to 4 books');
    assert.match((await page.textContent('.rv.dt')).replace(/\u00a0/g, ' '), /Fiction · Fantasy · Mysterious, reflective · Medium pace · Short chapters · 272 pages/);
    assert.deepEqual(await page.$$eval('.rv.dt .rv-by', els => els.map(e => e.textContent)), ['Susanna Clarke', 'George Eliot · Den', 'Kurt Vonnegut, Jr.', 'George Eliot · Study › Desk'], 'two Middlemarch rows don\'t say which copy each is');
    await page.check('#dtRe');
    assert.equal(await page.textContent('#dtgo'), 'Add details to 4 books', 'replacing changes Cat’s Cradle’s mood too, still four books');
    await page.uncheck('#dtRe');
    await page.click('#dtgo');
    assert.match(await page.textContent('#toastTx'), /Added reading details to 4 books/);
    assert.equal(await page.textContent('#toastBtn'), 'What to read next', 'the toast points to where the details are used');
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

step('reading details wrap between facets on a narrow phone: a dot never starts a line, and Slow pace stays whole', async () => {
  for (const width of [320, 360, 390]) {
    const ctx = await context({ ...PHONE, viewport: { width, height: 740 } });
    try {
      const page = await open(ctx);
      const many = { kind: 'nonfiction', genres: ['biography', 'history', 'society', 'nature'], moods: ['reflective', 'informative', 'challenging', 'hopeful'], pace: 'slow', chapters: 'medium', way: 'dip' };
      await seed(page, [{ ...MIDDLEMARCH, ...many, pages: 300 }, { ...PIRANESI, id: 'b07' }]);
      // Each facet's lines, and the line each dot is on: the dot sits on the last line of the facet before it.
      const lines = sel => page.$$eval(sel + ' .df', els => els.map(el => {
        const rs = [...el.getClientRects()], dot = el.nextSibling, r = document.createRange();
        let dotTop = null; if (dot && dot.nodeType === 3) { r.setStart(dot, 1); r.setEnd(dot, 2); dotTop = Math.round(r.getBoundingClientRect().top); }
        return { tx: el.textContent, nw: el.classList.contains('nw'), lines: new Set(rs.map(x => Math.round(x.top))).size, last: Math.round(rs[rs.length - 1].top), dotTop };
      }));
      await page.click('#nextBtn');
      await page.click('#nxCrit [data-k="kind"][data-v="nonfiction"]');
      await page.waitForSelector('.nx-pick .nx-dl');
      const pick = await lines('.nx-pick');
      await page.click('#nxx');
      await page.goto(detailsLink([{ id: 'b07', title: 'Piranesi', authors: ['Susanna Clarke'], ...many, pages: 272 }]));
      await page.waitForSelector('#dtgo');
      const det = await lines('.rv.dt');
      for (const [where, fs] of [['the pick', pick], ['the details sheet', det]]) {
        assert.ok(fs.length >= 6, where + ' has ' + fs.length + ' facets');
        for (const f of fs) {
          if (f.nw) assert.equal(f.lines, 1, width + ', ' + where + ': “' + f.tx + '” splits over lines');
          if (f.dotTop != null) assert.equal(f.dotTop, f.last, width + ', ' + where + ': the dot after “' + f.tx + '” starts a line');
        }
        assert.ok(fs.some(f => f.dotTop != null && f.lines === 1) && new Set(fs.map(f => f.last)).size > 1, width + ', ' + where + ': the details didn\'t wrap, so this checks nothing');
      }
      assert.deepEqual(page.problems, []);
    } finally { await ctx.close(); }
  }
});

step('on a narrow phone the card\'s Reading details keep their words on one line, and say a book you browse isn\'t suggested', async () => {
  const ctx = await context({ ...PHONE, viewport: { width: 360, height: 740 } });
  try {
    const page = await open(ctx);
    await seed(page, [{ id: 'k1', t: 1000, title: 'The Gardener’s Year', authors: ['Karel Čapek'], kind: 'nonfiction', genres: ['nature'], moods: ['reflective', 'funny'], way: 'browse' }]);
    await page.click('#list .bk[data-id="k1"]');
    // One line of 14px text is under 28px tall; two are more.
    assert.ok(await page.$eval('details.more .sum-l', e => e.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(e).fontSize)), 'the Reading details heading wraps');
    assert.equal(await page.textContent('#f-rdsum'), 'Nonfiction · Browse · Nature and gardening · Reflective');
    await page.click('#f-rdsum');
    assert.ok((await page.$$eval('#f-way button', els => els.map(e => e.getBoundingClientRect().height))).every(h => h < 40), 'a How it reads button wraps onto two lines');
    assert.match(await page.textContent('#f-way + .note'), /aren’t suggested in What to read next unless you ask/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.$eval('#sheet .bd', e => e.scrollWidth <= e.clientWidth), true, 'the card scrolls sideways');
    assert.deepEqual(page.problems, []);
  } finally { await ctx.close(); }
});

step('What to read next chooses by fiction or not, mood and chapters, and leaves cookbooks out', async () => {
  const ctx = await context();
  try {
    const page = await open(ctx);
    await seed(page, [PIRANESI, MIDDLEMARCH]);
    await page.click('#nextBtn');
    // Before any book has details, a note under the pick says how to get them, with a backup to send Claude.
    assert.match(await page.textContent('#nxOut .nx-ask:not(.nx-mark)'), /Ask Claude, with the Shelfmark skill, to add reading details to your library\. It reads the library from a backup you send it/);
    assert.ok((await page.locator('.nx-pick').boundingBox()).y < (await page.locator('.nx-ask:not(.nx-mark)').boundingBox()).y, 'the note comes before the pick');
    const [file] = await Promise.all([page.waitForEvent('download'), page.click('#nxBackup')]);
    assert.match(file.suggestedFilename(), /^shelfmark-library-\d{4}-\d{2}-\d{2}\.json$/);
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
    assert.deepEqual(await page.$$eval('#nxCrit [data-mood]', els => els.map(e => e.dataset.mood)), ['mysterious', 'reflective'], 'with fiction chosen, a nonfiction mood is offered');
    await page.click('#nxCrit [data-mood="mysterious"]');
    assert.equal(await page.textContent('.nx-pick .nx-t'), 'Piranesi');
    assert.equal(await page.textContent('.nx-pick .nx-blurb'), 'An endless house of statues and tides.');
    assert.equal(await page.textContent('#nxOut > .note'), 'From 1 unread book that matches. 1 book without reading details is left out.');
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
    assert.equal(await page.textContent('#nxOut > .note'), 'From 2 unread books that match. 1 book without reading details is left out.');
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
