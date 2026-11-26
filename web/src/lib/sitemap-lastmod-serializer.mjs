import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** @template {{ url: string, lastmod?: string }} T
 * @param {T} item
 * @param {string} [trustedLastmod]
 * @returns {T} */
export function serializeSitemapEntry(item, trustedLastmod) {
  const result = { ...item, url: item.url.replace(/(.)\/+$/, '$1') };
  delete result.lastmod;
  if (trustedLastmod) result.lastmod = trustedLastmod;
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
