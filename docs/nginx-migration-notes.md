# Заметки для Этапа 1: перенос _redirects/_headers в Nginx

Файлы `web/public/_redirects` и `web/public/_headers` (формат Netlify/Cloudflare Pages)
удалены в Этапе 0 — они мертвы и на GitHub Pages, и на VPS. Их содержимое должно быть
воспроизведено в Nginx-конфигах Этапа 1 (`infra/`).

## Редиректы (301), которых НЕТ в discovery/url_map.csv

Генератор Nginx-map из url_map.csv покрывает `/contacts` и `/promotions`
(строки english_alias), но короткий алиас ниже в карте отсутствует —
добавить в Nginx-map вручную или отдельной строкой генератора:

| Откуда | Куда | Код |
|---|---|---|
| `/sotrudnichestvo` | `/sotrudnichestvo-s-nami` | 301 |

## Политика кеш-заголовков (перенести в Nginx)

| Паттерн | Cache-Control |
|---|---|
| `/_astro/*` | `public, max-age=31536000, immutable` |
| `/favicon.*` | `public, max-age=86400` |
| `*.html` | `public, max-age=0, must-revalidate` — план 004 (Этап 1) уточняет: короткий public max-age, не no-store |
| `/sitemap*.xml` | `public, max-age=3600` |

Плюс требования Этапа 1 сверху: gzip+brotli, security headers
(X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy),
CSP сначала в Report-Only.
