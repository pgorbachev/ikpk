import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.SITEMAP_LASTMOD_TEST_BUILD !== '1') {
  throw new Error('This Astro config is restricted to the sitemap lastmod test build');
}

const outDir = process.env.SITEMAP_LASTMOD_TEST_OUT_DIR;
const cacheDir = process.env.SITEMAP_LASTMOD_TEST_CACHE_DIR;
if (!outDir || !cacheDir) throw new Error('test build output and cache directories are required');
const root = join(cacheDir, 'project');
mkdirSync(root, { recursive: true });

// Synthetic metadata exists only in this test-only configuration. It is deliberately
// not read from an environment variable, snapshot, CMS record, or production config.
const testDates = new Map([
  ['https://sitemap-lastmod.test/with-date', '2026-11-25T12:34:56.000Z'],
  ['https://sitemap-lastmod.test/invalid-date', '2026-02-30'],
]);
const { serializeSitemapEntry, omitSitemapIndexLastmod } = await import('../../../src/lib/sitemap-lastmod-serializer.mjs');

export default defineConfig({
  root,
  srcDir: fileURLToPath(new URL('./src/', import.meta.url)),
  site: 'https://sitemap-lastmod.test',
  outDir,
  cacheDir,
  trailingSlash: 'never',
  integrations: [
    sitemap({
      serialize(item) {
        return serializeSitemapEntry(item, testDates.get(item.url));
      },
    }),
    omitSitemapIndexLastmod(),
  ],
});
