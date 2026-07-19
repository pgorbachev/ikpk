# WBS: ikpk.su Website Rebuild

Work Breakdown Structure — task decomposition mapped to FR/NFR from [PRD](prd.md),
restructured around the accepted **static-first MVP plan** ([004-mvp-plan.md](../plans/004-mvp-plan.md)).
The original Strapi-first phase breakdown is superseded; Strapi/YooKassa work moved to Post-MVP.

Statuses: ✅ done | 🔧 partial | ⬜ not started

**Canonical counts** (single source of truth for all gates and docs):

| Metric | Value | Definition |
|---|---|---|
| Built pages | **256** | 255 content pages + 404 (`astro build` output) |
| Redirect map | **1022** | data rows in `discovery/url_map.csv` (1023 lines incl. header) |
| Old sitemap URLs | 253 | historical count from the legacy site's sitemap.xml |

## Этап 0: Реанимация репо и CI-фундамент *(критический путь)*

| # | Task | Status | FR/NFR | Artifact |
|---|------|--------|--------|----------|
| 0.1 | Commit 404.astro + serve.sh | ✅ | FR-12 | `web/src/pages/404.astro` |
| 0.2 | Remove React 19 + @astrojs/react (0 islands) | ✅ | NFR-01 | commit a7e2171 |
| 0.3 | Delete dead `_redirects`/`_headers`, capture content for Nginx | ✅ | NFR-02 | `docs/nginx-migration-notes.md` |
| 0.4 | CI PR gate: vitest unit + build tests, Playwright smoke | ✅ | — | `.github/workflows/test.yml` |
| 0.5 | Nightly: compat (7 projects) + parity vs live ikpk.su | ✅ | NFR-05 | `.github/workflows/nightly.yml` |
| 0.6 | axe-core a11y gate (0 critical/serious, 4 templates) | ✅ | NFR-04 | `web/tests/a11y.spec.ts` |
| 0.7 | Lighthouse CI budgets (median 5×, 4 templates) | ✅* | NFR-01 | `.github/workflows/lighthouse.yml` |
| 0.8 | WCAG AA contrast fix (gray-500, info-500 tokens) | ✅ | NFR-04 | `web/src/styles/tokens.css` |
| 0.9 | Rewrite README, actualize WBS, unify page counts | ✅ | — | this file, `web/README.md` |
| 0.10 | Related-domains backlog file | ✅ | — | `docs/backlog-related-domains.md` |
| 0.11 | Client request list with deadlines (день 1!) | ✅ | — | `docs/client-requests.md` |
| 0.12 | Branch protection on main (required checks) | ⬜ | — | needs repo admin |

\* LHCI is intentionally **not a required check** until Этап 2: the article template
expectedly fails LCP (5.7s > 2.5s) because hero images are hotlinked from
storage.yandexcloud.net. Flip to required together with the "0 hotlinks" grep gate.

## Этап 1: Инфраструктура — VPS, staging, редиректы как код *(∥ 2–4)*

| # | Task | Status | FR/NFR | Depends on |
|---|------|--------|--------|------------|
| 1.1 | Fix VPS provider (ДЦ Москва/СПб, RF-only) | ⬜ | NFR-08 | client decision |
| 1.2 | `infra/` in repo: Nginx configs, idempotent bootstrap, deploy script | ⬜ | — | 1.1; reuse `scripts/bootstrap-vps.sh`, `scripts/deploy-web.sh` |
| 1.3 | Nginx 301 map generator from url_map.csv (1022 rows, 1-hop) | ⬜ | NFR-02 | see `docs/nginx-migration-notes.md` for extra aliases |
| 1.4 | HTTPS (Certbot), gzip+brotli, security/cache headers | ⬜ | NFR-03 | 1.2 |
| 1.5 | CSP in Report-Only mode (enforce — Этап 5) | ⬜ | NFR-03 | 1.4 |
| 1.6 | GH Actions: main → auto-staging; prod — workflow_dispatch | ⬜ | — | 1.2 |
| 1.7 | UptimeRobot + daily backups | ⬜ | — | 1.2 |

## Этап 2: Миграция изображений *(∥, риск-приоритет — старт в день 1)*

| # | Task | Status | FR/NFR | Depends on |
|---|------|--------|--------|------------|
| 2.1 | Download all storage.yandexcloud.net assets (178), rewrite URLs (+width/height, downscale >1200px) | ✅ | NFR-01 | `scripts/download-media.ts` |
| 2.2 | astro:assets для изображений из полей данных | ✅* | NFR-01 | не нужно: после даунскейла и локализации все LHCI-бюджеты проходят без него |
| 2.3 | CI grep gate: 0 hotlinks in dist/ (forever) | ✅ | — | `web/tests/media-migration.test.ts` |
| 2.4 | Real OG-image 1200×630 (og:locale/type/site_name уже были) | ✅ | NFR-02 | `web/public/og-image.png` |
| 2.5 | Flip LHCI to required PR check | ✅ | NFR-01 | 9 required checks на main (2026-07-18) |

## Этап 3: SEO-пакет *(∥)*

| # | Task | Status | FR/NFR | Notes |
|---|------|--------|--------|------------|
| 3.1 | Sitemap: /statyi/*, lastmod everywhere; robots.txt Clean-Param | ✅ | NFR-02 | lastmod: статьи — published_at, прочие — дата снапшота; PDF: Disallow (осознанно); снят Disallow /_astro/ (блокировал CSS/JS от рендер-краулинга) |
| 3.2 | Orphans: crawl test in CI (обход dist от / по ссылкам) | ✅ | NFR-02 | 0 сирот — преподаватели/плейлисты уже слинкованы, тест закрепляет навсегда |
| 3.3 | Crawlable links; BreadcrumbList depth 1; excess ItemList | ✅ | NFR-02 | некликабельных якорей и ItemList в ребилде не было; крошки добавлены на 3 института + расписание |
| 3.4 | External links: nofollow per domain_strategy; grep gate | ✅ | NFR-02 | политика в html-cleaner: medshop/я.диск nofollow; корневые medshop-ссылки → kinezio.shop; продуктовые — nofollow (в kinezio нет зеркальных slug); 0 staging |
| 3.5 | JSON-LD validation in CI; H1→H2→H3; typo/title fixes; 404 <20KB | ✅ | NFR-02 | Event без даты → Course; футер-колонки не заголовки; расписание h3→h2; typo + дубль вебинаров + 6 пустых title плейлистов (имена из YouTube); 404 = 14KB без сайдбара |

## Этап 4: Конверсионный минимум *(∥, после Этапа 0)*

| # | Task | Status | FR/NFR | Depends on |
|---|------|--------|--------|------------|
| 4.1 | Pagefind search (build-time index, lazy load) | ✅ | FR-05 | индекс в `npm run build` (только `<main>`); UI лениво; шапочная форма «поиск только по статьям» заменена сайт-wide поиском — серверный фильтр /statyi?q= при этом жив; e2e с опечаткой |
| 4.2 | Bitrix24 Open Lines chat (requestIdleCallback) | ⬜ | FR-13 | client keys |
| 4.3 | Bitrix24 CRM form **embed** (не редирект) on schedule entries + seminar pages, UTM | ⬜ | FR-06 | client keys |
| 4.4 | NewsletterSignup → Bitrix24 form or hide (decision) | ⬜ | FR-07 | 152-ФЗ page |
| 4.5 | 152-ФЗ privacy policy page + links from forms/footer | ⬜ | NFR-03 | client text |
| 4.6a | Видео: RUTUBE-фасад + ссылка VK (вместо YouTube — замедлен в РФ) | ✅ | FR-04 | эмбед RUTUBE (RU-доступ), VK Видео @clubikpk основной канал; фикс пустого Rutube в футере |
| 4.6b | Ленивые Яндекс.Карты на /kontakty | ✅ | FR-08 | IntersectionObserver-фасад (кросс-браузерно, вкл. Safari без iframe lazy); noscript-fallback; build-гейт «нет eager-iframe» |
| 4.7 | Homepage quick-wins: offer H1, sticky CTA, trust bar, upcoming seminars, **сегментация «для кого»** | ⬜ | — | client numbers (сегментация — без контента заказчика) |
| 4.8 | Metrika goals on CTA/lead/subscribe | ⬜ | NFR-06 | — |

## Этап 5: Качественные гейты, контент-freeze, runbook *(критический путь)*

| # | Task | Status | Depends on |
|---|------|--------|------------|
| 5.1 | Full gate run on staging (LHCI mobile+desktop, axe, compat) | ⬜ | 1–4 |
| 5.2 | CSP report-only → enforce | ⬜ | 1.5, 4.2, 4.3 |
| 5.3 | Re-audit 003 (Must Match Before Go-Live) | ⬜ | 2, 4 |
| 5.4 | Дифф живого ikpk.su vs discovery-снапшот (re-scrape entities: новые статьи/семинары/акции); повторить перед go-live | ⬜ | — (автономно) |
| 5.5 | Content refresh + written confirmation; content-update.md; nightly rebuild cron | ⬜ | client |
| 5.6 | Rewrite migration-runbook.md + observability.md for VPS | ⬜ | 1 |
| 5.7 | Parity tests → snapshot mode | ⬜ | — |
| 5.8 | Baseline positions from Webmaster/GSC/Metrika | ⬜ | client accesses |

## Этап 6: UAT и go-live *(критический путь, +14 дней наблюдения)*

| # | Task | Status | Depends on |
|---|------|--------|------------|
| 6.1 | UAT sign-off (письменно) | ⬜ | 5 |
| 6.2 | DNS pre-flight: zone inventory, TTL 300s, A/AAAA only | ⬜ | client DNS access |
| 6.3 | Switch + post-switch checks (validate-urls, sitemap, Metrika, почта) | ⬜ | 6.2 |
| 6.4 | 14-day parallel period, rollback triggers | ⬜ | 6.3 |

## Post-MVP (см. план 004 §5)

1. **Strapi CMS (FR-11)** — дедлайн ≤6 недель после запуска; до этого JSON→PR→деплой (artifacts: `cms/`, `scripts/import.ts` 879 lines)
2. **YooKassa endpoint (FR-08)** — вместе со Strapi
3. Полный редизайн главной; лид-магнит (PDF запрошен у заказчика в Этапе 0); RUTUBE/VK-зеркала; SEO-долг (уникализация title); backlog связанных доменов; техдолг TD-1..TD-3

## Критический путь

```
Этап 0 ──▶ (1 ∥ 2 ∥ 3 ∥ 4) ──▶ 5 ──▶ 6
~15–19 раб. дней до DNS-switch + 14 дней параллельного периода
(календарно НЕ включает ожидание входов заказчика — см. docs/client-requests.md)
```

## Existing Artifacts

| Artifact | Lines | Role in MVP |
|----------|-------|-------------|
| `web/` (Astro frontend) | ~5100 | ядро; FR-01,02,03,04,09,10,12 done/partial |
| `discovery/entities/*.json` | 6.5 MB | источник данных до Strapi |
| `discovery/url_map.csv` | 1022 rows | Nginx 301 map (Этап 1) |
| `scripts/validate-urls.ts` | 266 | gate Этапов 1/6 |
| `scripts/bootstrap-vps.sh` | 66 | база для `infra/` (Этап 1) |
| `scripts/deploy-web.sh` | 75 | база для `infra/` (Этап 1) |
| `scripts/import.ts` | 879 | Post-MVP (Strapi) |
| `cms/` (Strapi) | — | Post-MVP, заморожен |
