// @ts-check
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// lastmod для sitemap (Этап 3, план 004):
// - /statyi/<slug> — реальная дата публикации статьи (published_at);
// - остальные страницы — дата снапшота данных (максимальный published_at
//   по всем статьям): стабильна между пересборками и меняется только
//   при реальном обновлении контента (не даёт ложных сигналов краулерам).
const articles = JSON.parse(
  readFileSync(new URL('../discovery/entities/articles.json', import.meta.url), 'utf-8')
);
/** @type {Map<string, string>} */
const articleDates = new Map(
  articles.filter((a) => a.published_at).map((a) => [a.slug, a.published_at])
);
const snapshotDate = [...articleDates.values()].sort().at(-1) ?? new Date(0).toISOString();

export default defineConfig({
  site: 'https://ikpk.su',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/sitemap'),
      serialize(item) {
        const slugMatch = item.url.match(/\/statyi\/([^/]+)\/?$/);
        const lastmod = (slugMatch && articleDates.get(slugMatch[1])) || snapshotDate;
        return { ...item, lastmod };
      },
    }),
  ],
  output: 'static',
});
