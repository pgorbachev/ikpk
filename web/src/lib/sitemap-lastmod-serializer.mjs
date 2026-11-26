import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** @template {{ url: string, lastmod?: string }} T
 * @param {T} item
 * @param {string} [trustedLastmod]
 * @returns {T} */
export function serializeSitemapEntry(item, trustedLastmod) {
  const result = { ...item, url: item.url.replace(/(.)\/+$/, '$1') };
  delete result.lastmod;
  if (trustedLastmod && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(trustedLastmod)) {
    const day = trustedLastmod.slice(0, 10);
    const parsedDay = new Date(`${day}T00:00:00Z`);
    if (!Number.isNaN(Date.parse(trustedLastmod)) && !Number.isNaN(parsedDay.getTime()) && parsedDay.toISOString().slice(0, 10) === day) {
      result.lastmod = trustedLastmod;
    }
  }
  return result;
}

// The sitemap integration derives the index date from page dates. That is not
// the modification date of the sitemap file (e.g. when a URL is removed).
export function omitSitemapIndexLastmod() {
  return {
    name: 'omit-unverified-sitemap-index-lastmod',
    hooks: {
      async 'astro:build:done'({ dir }) {
        const path = fileURLToPath(new URL('sitemap-index.xml', dir));
        const xml = await readFile(path, 'utf8');
        const undated = xml.replace(/<lastmod>[^<]*<\/lastmod>/g, '');
        if (undated !== xml) await writeFile(path, undated);
      },
    },
  };
}
