import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { pathToFileURL } from 'node:url';

if (process.env.SITEMAP_LASTMOD_TEST_BUILD !== '1') {
  throw new Error('This Astro config is restricted to the sitemap lastmod test build');
}

const outDir = process.env.SITEMAP_LASTMOD_TEST_OUT_DIR;
const cacheDir = process.env.SITEMAP_LASTMOD_TEST_CACHE_DIR;
if (!outDir || !cacheDir) throw new Error('test build output and cache directories are required');

// Synthetic metadata exists only in this test-only configuration. It is deliberately
// not read from an environment variable, snapshot, CMS record, or production config.
const testDates = new Map([
  ['https://sitemap-lastmod.test/with-date', '2026-11-25T12:34:56.000Z'],
]);
const { serializeSitemapEntry } = await import('../../../src/lib/sitemap-lastmod-serializer.mjs');

export default defineConfig({
  root: new URL('./', import.meta.url),
  srcDir: new URL('./src/', import.meta.url),
  site: 'https://sitemap-lastmod.test',
  outDir: pathToFileURL(`${outDir.replace(/\/$/, '')}/`),
  cacheDir: pathToFileURL(`${cacheDir.replace(/\/$/, '')}/`),
  trailingSlash: 'never',
  integrations: [
    sitemap({
      serialize(item) {
        return serializeSitemapEntry(item, testDates.get(item.url));
      },
    }),
  ],
});
