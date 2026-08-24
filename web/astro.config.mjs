// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// lastmod для sitemap: из снимка контента, которым идёт сборка (не из материала переноса).
const webRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(webRoot, '..');
const snapshotCandidates = [
  process.env.CONTENT_SNAPSHOT_DIR,
  join(webRoot, '.snapshot'),
  join(repoRoot, 'fixtures', 'content-snapshot'),
].filter(Boolean);
const snapshotDir = snapshotCandidates.find((dir) => existsSync(join(/** @type {string} */ (dir), 'snapshot.json')));
if (!snapshotDir) {
  throw new Error('astro.config: снимок контента не найден');
}
/** @type {{ content: { types: { articles?: Array<{ slug: string; published_at?: string }> } } }} */
const snapshot = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf-8'));
/** @type {Array<{ slug: string; published_at?: string }>} */
const articles = snapshot.content.types.articles ?? [];
const articleDates = new Map(
  articles.filter((a) => a.published_at).map((a) => [a.slug, /** @type {string} */ (a.published_at)])
);
const snapshotDate = [...articleDates.values()].sort().at(-1) ?? new Date(0).toISOString();

/**
 * Детальные плоские страницы каталогов (`/instituty/<slug>` и парные под
 * programmy/seminary/specialisty) — noindex-дубли иерархических страниц (см.
 * `web/src/pages/instituty/[slug].astro`), а не отдельный индексируемый
 * контент. Сам каталог-список (`/instituty` без сегмента) под это правило не
 * попадает: он не noindex.
 *
 * Интеграция sitemap строит карту по маршрутам сборки и не читает мета-тег
 * `noindex` со страницы — без этого фильтра плоские noindex-адреса всё равно
 * оказались бы в карте.
 */
/** @param {string} page */
const isNoindexFlatDetail = (page) => /\/(instituty|programmy|seminary|specialisty)\/[^/]+\/?$/.test(page);

export default defineConfig({
  site: 'https://ikpk.su',
  integrations: [
    sitemap({
      // Вне карты сайта:
      // - /preview/* — noindex-черновики вариантов;
      // - /demo-zayavka — заглушка форм демо-стенда, существует только в сборке с
      //   DEMO_FORMS и помечена noindex. Приглашать краулера на noindex-страницу
      //   значит тратить его бюджет и подавать противоречивые сигналы.
      //
      // Иерархические подстраницы институтов (`/<институт>/<программа>` и
      // глубже) сюда НЕ добавлены, хотя у записей уже есть плоские адреса
      // (`/instituty/…`, `/programmy/…`, `/seminary/…`, `/specialisty/…`,
      // change `cms-content-authoring-and-migration`, D9): те плоские адреса
      // сегодня noindex-дубли (см. `web/src/pages/instituty/[slug].astro` и
      // парные файлы) — у них нет канонической замены до переключения
      // источника сборки (`cms-content-publication`). Убрать иерархический
      // адрес из карты раньше появления замены значило бы снять сигнал
      // sitemap с единственного индексируемого адреса записи без всякой
      // выгоды. Фильтр по институтам вернётся сюда, когда плоские адреса
      // перестанут быть noindex.
      filter: (page) =>
        !page.includes('/sitemap') &&
        !page.includes('/preview/') &&
        !page.includes('/demo-zayavka') &&
        !page.includes('/rich-content-canary') &&
        !isNoindexFlatDetail(page),
      serialize(item) {
        const slugMatch = item.url.match(/\/statyi\/([^/]+)\/?$/);
        const lastmod = (slugMatch && articleDates.get(slugMatch[1])) || snapshotDate;
        // адреса в карте — как на старом сайте, без завершающего слэша
        const url = item.url.replace(/(.)\/+$/, '$1');
        return { ...item, url, lastmod };
      },
    }),
  ],
  output: 'static',
  // Старый сайт адресует страницы без завершающего слэша (ikpk.su/kontakty).
  // Раскладку файлов оставляем каталогами: nginx отдаёт /kontakty напрямую из
  // /kontakty/index.html, если в try_files поставить $uri/index.html ПЕРЕД
  // $uri/ — иначе он редиректит на вариант со слэшем и смысл теряется.
  trailingSlash: 'never',
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
