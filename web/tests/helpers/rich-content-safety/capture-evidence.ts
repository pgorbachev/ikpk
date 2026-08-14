/**
 * Maintainer evidence for tasks 4.3/4.4: /oplata computed-style + screenshots,
 * fingerprint summary, RUTUBE stand screenshot. Not invoked by CI.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';
import { FIXTURES_DIR, WEB_ROOT } from './paths.js';
import { exactRutubeIframe } from './closed-matrix.js';
import { buildFingerprintComparison } from './compare-fingerprints.js';
import { fingerprintHtml } from './fingerprint.js';
import { buildMigrationPageInventory } from './migration-page-inventory.js';
import type { MigrationRow } from './migration.js';

const EVIDENCE = join(FIXTURES_DIR, 'evidence');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function serveDir(root: string, port: number): Promise<{ close: () => Promise<void>; origin: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file)) {
      send(res, 404, 'not found', 'text/plain');
      return;
    }
    send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function migrationInventory(): void {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'migration-manifest.json'), 'utf-8'),
  ) as MigrationRow[];
  const dist = join(WEB_ROOT, 'dist');
  writeFileSync(
    join(EVIDENCE, 'migration-page-inventory.json'),
    `${JSON.stringify(buildMigrationPageInventory(manifest, dist), null, 2)}\n`,
  );
}

function fingerprintSummary(): void {
  const fingerprints = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'source-fingerprints.json'), 'utf-8'),
  ) as Array<{
    selectorId: string;
    headings: unknown[];
    tables: unknown[];
    rutube: unknown[];
    svgCount: number;
    markers: unknown[];
  }>;
  const rendered = JSON.parse(readFileSync(join(FIXTURES_DIR, 'rendered-registry.json'), 'utf-8')) as {
    sinks: Array<{ id: string; production: { count: number; paths: string[] } }>;
  };
  const dist = join(WEB_ROOT, 'dist');
  const markerCounts: Record<string, number> = {};
  const renderedRows: Array<{
    route: string;
    sinkId: string;
    headings: number;
    lists: number;
    tables: number;
    links: number;
    images: number;
    details: number;
    checkboxes: number;
    rutube: number;
  }> = [];
  let remainingSvgInRich = 0;
  let remainingInlineStyleInRich = 0;
  if (existsSync(dist)) {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === 'pagefind') continue;
          out.push(...walk(full));
        } else if (name.endsWith('.html')) out.push(full);
      }
      return out;
    };
    for (const file of walk(dist)) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/data-safe-rich-content="([^"]+)"/g)) {
        markerCounts[m[1]] = (markerCounts[m[1]] ?? 0) + 1;
      }
      for (const block of html.matchAll(/data-safe-rich-content="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)) {
        if (/<svg[\s>]/i.test(block[2])) remainingSvgInRich += 1;
        if (/\sstyle="/i.test(block[2])) remainingInlineStyleInRich += 1;
        const fp = fingerprintHtml(block[2], {
          jsonPath: file,
          selectorId: block[1],
          entityId: htmlFileRoute(file),
        });
        renderedRows.push({
          route: htmlFileRoute(file),
          sinkId: block[1],
          headings: fp.headings.length,
          lists: fp.lists.length,
          tables: fp.tables.length,
          links: fp.links.length,
          images: fp.images.length,
          details: fp.details.length,
          checkboxes: fp.checkboxes.length,
          rutube: fp.rutube.length,
        });
      }
    }
  }
  const comparison = buildFingerprintComparison();
  writeFileSync(
    join(EVIDENCE, 'fingerprint-comparison.json'),
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      compared: comparison.compared,
      records: comparison.records,
      withLosses: comparison.withLosses,
      withErrors: comparison.withErrors,
      comparisons: comparison.comparisons,
      sourceAggregates: {
        records: fingerprints.length,
        withHeadings: fingerprints.filter((f) => f.headings.length > 0).length,
        withTables: fingerprints.filter((f) => f.tables.length > 0).length,
        withRutube: fingerprints.filter((f) => f.rutube.length > 0).length,
        withSvg: fingerprints.filter((f) => f.svgCount > 0).length,
      },
      renderedRegistryProduction: Object.fromEntries(
        rendered.sinks.map((s) => [s.id, { count: s.production.count, paths: s.production.paths.length }]),
      ),
      distMarkers: markerCounts,
      renderedFingerprints: renderedRows,
      remainingSvgInRichRoots: remainingSvgInRich,
      remainingInlineStyleInRichRoots: remainingInlineStyleInRich,
    }, null, 2)}\n`,
  );
}

function htmlFileRoute(file: string): string {
  const dist = join(WEB_ROOT, 'dist');
  const rel = file.slice(dist.length).replace(/\\/g, '/');
  if (rel === '/index.html') return '/';
  return rel.replace(/\/index\.html$/, '') || rel;
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  fingerprintSummary();
  migrationInventory();

  const dist = join(WEB_ROOT, 'dist');
  if (!existsSync(join(dist, 'oplata', 'index.html'))) {
    throw new Error('нет dist/oplata — сначала npm run build');
  }
  const site = await serveDir(dist, 4177);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${site.origin}/oplata/`, { waitUntil: 'networkidle' });
    const styles = await page.evaluate(`(() => {
      function pick(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          selector: sel,
          display: cs.display,
          flexDirection: cs.flexDirection,
          gap: cs.gap,
          marginLeft: cs.marginLeft,
          textAlign: cs.textAlign,
          color: cs.color,
          fontSize: cs.fontSize,
        };
      }
      return {
        flex: pick('.rc-display-flex'),
        column: pick('.rc-flex-column'),
        gap: pick('.rc-gap-24'),
        ml: pick('.rc-ml-15'),
        markers: [...document.querySelectorAll('[data-safe-rich-content]')].map((el) => el.getAttribute('data-safe-rich-content')),
      };
    })()`);
    writeFileSync(join(EVIDENCE, 'oplata-computed-style.json'), `${JSON.stringify(styles, null, 2)}\n`);
    await page.screenshot({ path: join(EVIDENCE, 'oplata-desktop.png'), fullPage: true });

    const extraPages = [
      ['/sotrudnichestvo-s-nami/', 'sotrudnichestvo-desktop.png'],
      ['/statyi/prikladnaya-kineziologiya-chto-eto-takoe-prostymi-slovami/', 'article-style-desktop.png'],
      ['/institut-barralya/visceralnye-tehniki/bryushnaya-polost-1/', 'seminar-svg-desktop.png'],
    ] as const;
    for (const [path, name] of extraPages) {
      await page.goto(`${site.origin}${path}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
    }

    const standServer = await serveDir(EVIDENCE, 4178);
    await page.goto(`${standServer.origin}/rutube-stand.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const attrs = await page.evaluate(`(() => {
      const el = document.querySelector('iframe');
      if (!el) return { iframeCount: 0 };
      return {
        src: el.getAttribute('src'),
        sandbox: el.getAttribute('sandbox'),
        allow: el.getAttribute('allow'),
        referrerpolicy: el.getAttribute('referrerpolicy'),
        loading: el.getAttribute('loading'),
        title: el.getAttribute('title'),
        allowfullscreen: el.hasAttribute('allowfullscreen'),
        iframeCount: document.querySelectorAll('iframe').length,
      };
    })()`) as Record<string, unknown>;
    writeFileSync(join(EVIDENCE, 'rutube-stand-attrs.json'), `${JSON.stringify({ ...attrs, reconstructed: exactRutubeIframe() }, null, 2)}\n`);
    await page.screenshot({ path: join(EVIDENCE, 'rutube-stand.png'), fullPage: true });
    writeFileSync(
      join(EVIDENCE, 'manual-rutube.md'),
      [
        '# Source-only RUTUBE stand (task 4.4)',
        '',
        `- URL: ${standServer.origin}/rutube-stand.html`,
        `- Source entity: discovery/entities/course_groups.json description_html, embed id 4a1e6023bd7a3716d8ff56bf98c96e97`,
        '- This HTML is source-only: course-group pages render additional_html, not description_html.',
        '- Stand reconstructs the exact system iframe (sandbox/allow/referrerpolicy/loading/title/allowfullscreen).',
        `- Captured attrs: ${JSON.stringify(attrs)}`,
        '- Screenshot: web/tests/fixtures/rich-content-safety/evidence/rutube-stand.png',
        '- HTML: web/tests/fixtures/rich-content-safety/evidence/rutube-stand.html',
        '',
      ].join('\n'),
    );
    await standServer.close();
  } finally {
    await browser.close();
    await site.close();
  }
}

if (process.argv[1]?.includes('capture-evidence')) {
  if (process.argv.includes('--machine-only')) {
    mkdirSync(EVIDENCE, { recursive: true });
    fingerprintSummary();
    migrationInventory();
  } else {
    await main();
  }
  console.log(`wrote evidence to ${EVIDENCE}`);
}
