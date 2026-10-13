// Renders the README screenshots (docs/*.png) and the link preview (og.png) from a sample library:
//   node tools/screenshots.mjs   (needs Playwright)
// Math.random is seeded and the clock is set to 13 October 2026, so the same pictures come out every time.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const SEED = 6; // change it until the pictures look good
const NOW = new Date('2026-10-13T10:00:00');

// A house's books, newest first: [title, author, room, shelf, extra fields].
const SAMPLE = [
  ['To Kill a Mockingbird', 'Harper Lee', 'Bedroom', 'Nightstand', { pages: 281 }],
  ['The Road', 'Cormac McCarthy', 'Living room', 'By the window', { pages: 287 }],
  ['Middlemarch', 'George Eliot', 'Living room', 'Tall bookcase', { status: 'read', rating: 3, pages: 880 }],
  ['The Remains of the Day', 'Kazuo Ishiguro', 'Living room', 'Tall bookcase', { status: 'reading', pages: 245 }],
  ['Station Eleven', 'Emily St. John Mandel', 'Living room', 'Tall bookcase', { pages: 333 }],
  ['Jane Eyre', 'Charlotte Brontë', 'Living room', 'Tall bookcase', { pages: 532 }],
  ['A Wizard of Earthsea', 'Ursula K. Le Guin', 'Bedroom', 'Nightstand', { status: 'read', rating: 3, pages: 183 }],
  ['Gilead', 'Marilynne Robinson', 'Study', 'Desk shelf', { pages: 247, notes: 'Mum says read this one slowly.' }],
  ['The Hobbit', 'J. R. R. Tolkien', 'Bedroom', 'Nightstand', { pages: 310, tags: ['fantasy'] }],
  ['The Count of Monte Cristo', 'Alexandre Dumas', 'Living room', 'By the window', { pages: 1276 }],
  ['Dune', 'Frank Herbert', 'Study', 'Desk shelf', { pages: 617, tags: ['sf'] }],
  ['Moby-Dick', 'Herman Melville', 'Living room', 'By the window', { pages: 635 }],
  ['Beloved', 'Toni Morrison', 'Living room', 'Tall bookcase', { status: 'read', rating: 5, pages: 324 }],
  ['Piranesi', 'Susanna Clarke', 'Hall', 'Console table', { status: 'read', rating: 5, pages: 272 }],
  ['Housekeeping', 'Marilynne Robinson', 'Study', 'Desk shelf', { status: 'read', rating: 5, pages: 219 }],
  ['The Dispossessed', 'Ursula K. Le Guin', 'Study', 'Desk shelf', { pages: 387, tags: ['sf'], loan: { to: 'Sam', since: '2026-10-02' } }],
  ['Cien años de soledad', 'Gabriel García Márquez', 'Living room', 'By the window', { status: 'read', rating: 4, pages: 417 }],
  ['Pride and Prejudice', 'Jane Austen', 'Bedroom', 'Nightstand', { status: 'read', rating: 4, pages: 279 }],
  ['Never Let Me Go', 'Kazuo Ishiguro', 'Living room', 'Tall bookcase', { status: 'read', rating: 4, pages: 288 }],
  ['The Left Hand of Darkness', 'Ursula K. Le Guin', 'Study', 'Desk shelf', { pages: 304, tags: ['sf'] }],
  ['Matilda', 'Roald Dahl', 'Kids room', 'Low shelf', { pages: 240, tags: ['kids'] }],
  ['Charlotte’s Web', 'E. B. White', 'Kids room', 'Low shelf', { pages: 184, tags: ['kids'] }],
  ['The Name of the Wind', 'Patrick Rothfuss', 'Bedroom', 'Nightstand', { pages: 662, tags: ['fantasy'], check: 'spine cut off at the top; could be the second book' }],
  ['War and Peace', 'Leo Tolstoy', 'Living room', 'Tall bookcase', { pages: 1225 }],
];
const ADDED = ['2026-10-11', '2026-08-30', '2026-06-14', '2025-12-02', '2025-04-19', '2024-09-07']; // four books each
const books = {};
SAMPLE.forEach(([title, author, room, shelf, more], i) => {
  const id = 'sample' + String(i + 1).padStart(2, '0');
  books[id] = { id, t: NOW.getTime() - 86400000 - i * 60000, title, authors: [author], room, shelf, added: ADDED[Math.floor(i / 4)], ...more };
});
const LIBRARY = JSON.stringify({ shelfmark: 1, library: { books, seen: {} } });

// A batch from Claude: one shelf's photo, with one book already on the shelves and one it wasn't sure of.
const BATCH = { shelfmark: 1, batch: { id: 'c20261013-sample', name: 'Hall, console table', made: '2026-10-13', room: 'Hall', shelf: 'Console table', books: [
  { title: 'Circe', authors: ['Madeline Miller'], isbn: '9780316556347', publisher: 'Little, Brown', year: 2018, format: 'hardcover' },
  { title: 'The Overstory', authors: ['Richard Powers'], unsure: 'glare over the author; could be Orfeo' },
  { title: 'Homegoing', authors: ['Yaa Gyasi'] },
  { title: 'Piranesi', authors: ['Susanna Clarke'] },
  { title: 'Hamnet', authors: ['Maggie O’Farrell'], year: 2020 },
] } };

const browser = await pw.chromium.launch();
await mkdir(join(root, 'docs'), { recursive: true });

async function open(viewport, deviceScaleFactor, prefs) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: true, isMobile: deviceScaleFactor > 1, serviceWorkers: 'block' });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(([seed, lib, prefs]) => {
    let a = seed; // mulberry32
    Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    if (!localStorage.getItem('shelfmark.library')) { localStorage.setItem('shelfmark.library', lib); localStorage.setItem('shelfmark.prefs', JSON.stringify(prefs)); }
  }, [SEED, LIBRARY, prefs]);
  await page.goto(base);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const settle = page => page.evaluate(() => new Promise(r => { document.activeElement && document.activeElement.blur(); setTimeout(r, 450); }));

// Phone screenshots for the README.
{
  const page = await open({ width: 390, height: 844 }, 2, { sort: 'shelf', lookups: false });
  await settle(page);
  await page.screenshot({ path: join(root, 'docs/phone-shelves.png') });

  await page.goto(base + '#s1j' + Buffer.from(JSON.stringify(BATCH)).toString('base64url'));
  await page.waitForSelector('#rv-add');
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  await page.screenshot({ path: join(root, 'docs/phone-review.png') });
  await page.click('#rvx');
  await page.waitForTimeout(500); // a tap just after a sheet closes is ignored

  await page.click('#nextBtn');
  await page.click('[data-lean="loved"]');
  await settle(page);
  await page.screenshot({ path: join(root, 'docs/phone-next.png') });
  await page.context().close();
}

// Link preview, 1200 x 630: the app itself, newest books first.
{
  const page = await open({ width: 1200, height: 630 }, 1, { sort: 'added', lookups: false });
  await settle(page);
  await page.screenshot({ path: join(root, 'og.png') });
  await page.context().close();
}

await browser.close();
server.close();
console.log('screenshots written');
