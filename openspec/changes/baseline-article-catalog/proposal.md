## Why

`openspec/specs/` пуст, поэтому дельте не к чему прикладываться: первый change проекта
(`article-list-pagination`) описан целиком через `ADDED Requirements` — включая то, что
`/statyi` существует, отдаёт список и держит самоссылочный `canonical`. Это давно есть и
работает; в дельте это выглядит как новое.

Baseline фиксирует **принятый контракт каталога статей** — то, что система уже обязана
продолжать давать, — чтобы `article-list-pagination` можно было переписать относительно
него: часть его требований станет `MODIFIED`, часть исчезнет как уже существующая.

Область взята одной функциональной: baseline на всю систему невозможно ни проверить, ни
отревьюить (`AGENTS.md`, «Baseline: фиксация уже существующего поведения»).

## Исследуемое состояние

Фиксируется явно, иначе через неделю неясно, что описано.

- **Revision кода:** `feat/demo-mode-and-hero-photo@542151b` («feat(preview): редакционная
  подача события…»), опубликована как `origin/feat/demo-mode-and-hero-photo`. В `main`
  этого кода нет: там отсутствуют `web/tests/content-quality.test.ts`, визуальные эталоны,
  `web/scripts/gen-redirects.ts` и `deploy/nginx-redirects.conf`.
- **Рабочая ветка baseline:** `542151b` + процессные коммиты `main` (`291c6b2`, `4e8ab6a`,
  `2420a6d`) — иначе `openspec/` и `./bin/openspec` в ветке кода отсутствуют, и
  characterization-тесты негде запустить рядом со спекой.
- **Сборка, по которой снимались измерения:** `npm run build` из `web/` на этой ветке;
  268 страниц, `web/dist/statyi/index.html` = 184 320 байт, 68 каталогов статей в
  `web/dist/statyi/`.
- **Данные:** `discovery/entities/articles.json` — 68 записей, 68 уникальных slug.
- **Production:** живой `https://ikpk.su`, снят GET-запросами 2026-08-03 (только чтение).
  `/statyi` → 200, `canonical` = `https://ikpk.su/statyi`; `/statyi/` → 308 на адрес без
  слэша; `/statyi/gipertenziya` → 200, со слэшем → 308; `/statyi/page/2` → 404;
  `https://ikpk.su/sitemap.xml` → 265 адресов, из них 68 статей и сам `/statyi`.

## What Changes

- **Ничего в продуктовом коде.** Baseline его не трогает: описывается то, что уже есть.
- **Появляется основная спецификация `article-catalog`** — принятый контракт каталога:
  адреса, состав списка, охват поиска и сортировки, индексные инварианты, целостность
  данных, связность.
- **Добавляются characterization-тесты** — `web/tests/article-catalog.test.ts`
  (по собранному `dist`) и `web/tests/article-catalog.spec.ts` (клиентское поведение
  в браузере). Они **зелёные** на существующем коде: RED здесь не нужен, это другая
  ветка процесса. Негативная проверка каждого нового гейта обязательна и выполнена.
- **Известные отклонения записываются как known deviations**, а не как требования.
  Главное: все 68 статей лежат в HTML `/statyi` внутри `<template>`, ссылками в основном
  контенте отдаются 6 (TD-2, TD-3). Строка «сайт SHALL держать все статьи в скрытом
  `<template>`» превратила бы дефект в норму — её здесь нет.
- **Область не включает** облик и вёрстку (это отдельная область, закреплённая
  визуальными эталонами и `parity-audit.spec.ts`), общесайтовый поиск Pagefind,
  редиректы вообще (только правило «со слэшем → без слэша» для адресов каталога) и
  видео-каталог `/video`, устроенный похоже, но отдельно.

## Следствие для активной дельты

`article-list-pagination` **пересекается** с этим baseline и после его архивирования
обязан быть переписан: требования об `canonical`, `sitemap`, полнокорпусном поиске и
уникальных `title` перестают быть `ADDED`. По `AGENTS.md` это делается **одним PR** с
архивом baseline, и там же — проверка применимости дельты в одноразовом worktree.
Строгой валидации дельты для этого недостаточно: до архива основной спеки не существует,
и её зелёный цвет ничего о совместимости не доказывает.

Здесь дельта **не переписывается**: это следующий шаг после ревью baseline.

## Capabilities

### New Capabilities

- `article-catalog`: каталог статей — страница списка `/statyi`, страницы статей
  `/statyi/<slug>`, клиентский поиск и сортировка, индексные и SEO-инварианты каталога,
  целостность источника данных.

### Modified Capabilities

<!-- Нет: openspec/specs/ пуст, основных спек ещё не существует. -->

## Impact

- **Код:** не меняется. Затронуты только `openspec/changes/baseline-article-catalog/**`,
  два новых тестовых файла и `web/vitest.build.config.ts` (новый dist-зависимый тест
  надо включить в набор — иначе он не запустится ни локально, ни в CI).
- **Описываемые файлы:** `web/src/pages/statyi/index.astro`,
  `web/src/pages/statyi/[slug].astro`, `web/src/components/ArticleCard.astro`,
  `web/src/components/articles/ArticleFilterBar.astro`, `web/src/lib/data.ts`
  (`getArticles`), `web/src/components/HeadMeta.astro` (`canonical`),
  `web/src/pages/sitemap.astro`, `web/astro.config.mjs` (`@astrojs/sitemap`),
  `deploy/nginx-redirects.conf`, `discovery/entities/articles.json`.
- **Существующие гейты, которые уже держат часть контракта:**
  `web/tests/seo-package.test.ts` (сироты, JSON-LD, уникальность `title`, непустые
  `title`/`description`, `sitemap`, цели редиректов), `web/tests/content-quality.test.ts`
  (адреса без завершающего слэша), `web/tests/parity-audit.spec.ts` (`/statyi`:
  пагинация, элементы управления), `web/tests/a11y.spec.ts`,
  `web/tests/visual-baseline.spec.ts` (эталоны `articles-desktop`, `articles-mobile`).
  Baseline на них ссылается и не дублирует их без нужды.
- **Долг:** ничего не закрывает и не заводит нового. TD-1, TD-2, TD-3 из
  `docs/tech-debt.md` перечислены как known deviations с адресом исправления —
  change `article-list-pagination`.
- **Зависимостей не добавляется.**
