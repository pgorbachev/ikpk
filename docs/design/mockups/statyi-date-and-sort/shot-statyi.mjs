import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const MIME = { '.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.woff2':'font/woff2','.json':'application/json' };
const serve = (root) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const clean = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = join(root, clean);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const [,, outDir, ...roots] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
for (const spec of roots) {
  const [label, root] = spec.split('=');
  const { server, port } = await serve(root);
  for (const vp of [{ id:'desktop', width:1280, height:900 }, { id:'mobile', width:375, height:812 }]) {
    const ctx = await browser.newContext({ viewport:{ width:vp.width, height:vp.height }, deviceScaleFactor:1, reducedMotion:'reduce' });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/statyi`, { waitUntil:'networkidle' });
    await page.addStyleTag({ content:'*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${outDir}/${label}-${vp.id}.png` });
    const options = await page.locator('[data-articles-sort] option').allTextContents();
    const times = await page.locator('[data-articles-grid] time').count();
    console.log(`${label} ${vp.id}: порядков ${options.length} (${options.join(' | ')}), <time> в карточках ${times}`);
    await ctx.close();
  }
  server.close();
}
await browser.close();
