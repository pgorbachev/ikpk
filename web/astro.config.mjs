// @ts-check
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// lastmod для sitemap (Этап 3, план 004):
// - /statyi/<slug> — реальная дата публикации статьи (published_at);
// - остальные страницы — дата снапшота данных (максимальный published_at
//   по всем статьям): стабильна между пересборками и меняется только
//   при реальном обновлении контента (не даёт ложных сигналов краулерам).
/** @type {Array<{ slug: string; published_at?: string }>} */
const articles = JSON.parse(
  readFileSync(new URL('../discovery/entities/articles.json', import.meta.url), 'utf-8')
);
const articleDates = new Map(
  articles.filter((a) => a.published_at).map((a) => [a.slug, /** @type {string} */ (a.published_at)])
);
const snapshotDate = [...articleDates.values()].sort().at(-1) ?? new Date(0).toISOString();

export default defineConfig({
  site: 'https://ikpk.su',
  integrations: [
    sitemap({
      // /preview/* — noindex-черновики вариантов, вне карты сайта
      filter: (page) => !page.includes('/sitemap') && !page.includes('/preview/'),
      serialize(item) {
        const slugMatch = item.url.match(/\/statyi\/([^/]+)\/?$/);
        const lastmod = (slugMatch && articleDates.get(slugMatch[1])) || snapshotDate;
        return { ...item, lastmod };
      },
    }),
  ],
  output: 'static',
  vite: {
    build: {
      // Vite 8 минифицирует CSS через lightningcss, который по умолчанию
      // переписывает медиазапросы в range-синтаксис: (max-width:640px) →
      // (width<=640px). Он требует Safari 16.4+ / Chrome 104+ / Firefox 63+,
      // то есть на старых iOS (iPhone 6s/7 доживают на iOS 15) ВСЕ брейкпоинты
      // молча перестают применяться и телефон получает десктопную вёрстку.
      // Playwright-compat это не ловит: у него всегда свежий WebKit независимо
      // от имени профиля устройства. Поэтому явно фиксируем целевые браузеры.
      cssTarget: ['chrome90', 'edge90', 'firefox90', 'safari14'],
    },
  },
});
