// МОКАП: съёмка страницы программы в трёх вариантах подачи даты. Скрипт временный,
// в merge не уезжает.
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2', '.json': 'application/json' };

const serve = (root) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const clean = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = join(root, clean);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const PAGE = '/institut-barralya/visceralnye-tehniki';
const OUT = '../docs/design/mockups/program-page-dates';
const VIEWPORTS = [{ id: 'desktop', width: 1280, height: 800 }, { id: 'mobile', width: 375, height: 812 }];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const variant of ['ref', 'a', 'b', 'c']) {
  const { server, port } = await serve(`dist-${variant}`);
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}${PAGE}`, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    const list = page.locator('[data-testid="course-group-seminars"]');
    await list.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await list.screenshot({ path: `${OUT}/${variant}-${vp.id}-seminars.png` });
    const cards = await page.locator('[data-testid="course-group-seminar-card"]').count();
    const dated = await page.locator('[data-testid="seminar-nearest-date"]').count();
    const fallback = await page.locator('[data-testid="seminar-date-fallback"]').count();
    console.log(`${variant} ${vp.id}: карточек ${cards}, с датой ${dated}, фолбэк ${fallback}`);
    await ctx.close();
  }
  server.close();
}
await browser.close();
