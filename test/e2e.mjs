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

async function context(opts = PHONE) {
  const ctx = await browser.newContext(opts);
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  return ctx;
}
// A page with its errors collected in page.problems. Failed loads of refused outside requests and of anything
// while offline are expected; any other error, or a failed load from the site itself, is a problem.
async function open(ctx, url = base) {
  const page = await ctx.newPage();
  page.problems = [];
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
