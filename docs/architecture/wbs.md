# WBS: ikpk.su Website Rebuild

Work Breakdown Structure — task decomposition mapped to FR/NFR from [PRD](prd.md).

Statuses: ✅ done | 🔧 partial | ⬜ not started

## Phase 0: Discovery and Prototype

| # | Task | Status | Effort | FR/NFR | Artifact |
|---|------|--------|--------|--------|----------|
| 0.1 | Current site analysis (stack, API, sitemap) | ✅ | 2 h | — | `docs/architecture/current-architecture.md` |
| 0.2 | Content scraping (10 entities, 253 URLs) | ✅ | 3 h | — | `discovery/entities/*.json` (6.5 MB) |
| 0.3 | URL map: old → new (1023 entries) | ✅ | 1 h | NFR-02 | `discovery/url_map.csv` |
| 0.4 | Frontend prototype on Astro (256 pages) | ✅ | 12 h | FR-01,03,04,08,09,10 | `web/` |
| 0.5 | Architecture documentation | ✅ | 3 h | — | `docs/architecture/` |

**Phase 0 total: ~21 h (completed)**

## Phase 1: Frontend Refinement

| # | Task | Status | Effort | FR/NFR | Depends on |
|---|------|--------|--------|--------|------------|
| 1.1 | Pagefind: integration + /search page | ⬜ | 2–3 h | FR-05 | — |
| 1.2 | React island: schedule filter (institute, city) | ⬜ | 2–3 h | FR-02 | — |
| 1.3 | React island: seminar enrollment form | ⬜ | 2–3 h | FR-06 | — |
| 1.4 | React island: payment modal (YooKassa redirect) | ⬜ | 2–3 h | FR-08 | — |
| 1.5 | Theme: light/dark/system toggle | ⬜ | 1–2 h | — | — |
| 1.6 | Image optimization (Astro `<Image>`) | ⬜ | 2–3 h | NFR-01 | — |
| 1.7 | Schema.org JSON-LD (Course, Event, Article, BreadcrumbList) | 🔧 | 2–3 h | NFR-02 | — |
| 1.8 | SEO: meta tags, canonical, Open Graph on all templates | 🔧 | 1–2 h | NFR-02 | — |
| 1.9 | 301 redirects: full map (253 URLs → `_redirects`) | 🔧 | 1–2 h | NFR-02 | 0.3 |
| 1.10 | UI polish: mobile menu, sidebar, breadcrumbs, 404 | 🔧 | 2–3 h | FR-09, FR-12 | — |
| 1.11 | Security headers (HSTS, X-Content-Type-Options, etc.) | ⬜ | 0.5 h | NFR-03 | — |
| 1.12 | Analytics: Yandex.Metrica + Mail.ru Top | 🔧 | 0.5 h | NFR-06 | — |

**Phase 1 total: ~20–32 h**

## Phase 2: CMS (Strapi)

| # | Task | Status | Effort | FR/NFR | Depends on |
|---|------|--------|--------|--------|------------|
| 2.1 | Content model: 10 entities in Strapi | 🔧 | 3–4 h | FR-11 | — |
| 2.2 | Roles and permissions (admin / editor) | ⬜ | 1 h | FR-11 | 2.1 |
| 2.3 | API tokens + RBAC configuration | ⬜ | 0.5 h | NFR-03 | 2.1 |
| 2.4 | Webhook: Strapi → Astro rebuild | ⬜ | 1–2 h | NFR-07 | 2.1, 3.1 |
| 2.5 | WYSIWYG configuration + media uploads | ⬜ | 1 h | FR-11 | 2.1 |
| 2.6 | YooKassa: payment creation endpoint (redirect only) | ⬜ | 1–2 h | FR-08 | 2.1 |

**Phase 2 total: ~8–12 h**

## Phase 3: Data Migration

| # | Task | Status | Effort | FR/NFR | Depends on |
|---|------|--------|--------|--------|------------|
| 3.1 | JSON structure mapping → Strapi content model | ⬜ | 2–3 h | — | 2.1 |
| 3.2 | Import script (JSON → Strapi API), idempotent | 🔧 | 2–3 h | — | 3.1 |
| 3.3 | Media migration: link Yandex Cloud URLs to entries | ⬜ | 1–2 h | — | 3.2 |
| 3.4 | Validation: slug uniqueness, relations, data completeness | ⬜ | 1–2 h | — | 3.2 |
| 3.5 | Run import on staging and manual verification | ⬜ | 1–2 h | — | 3.2, 3.3 |

Existing artifacts:
- `discovery/entities/*.json` — 10 entities, 6.5 MB (already scraped)
- `scripts/import.ts` — 879 lines, idempotent 4-phase import (scaffold ready)
- `scripts/validate-urls.ts` — 266 lines, URL validation after import

**Phase 3 total: ~7–12 h**

## Phase 4: Deployment and Infrastructure

| # | Task | Status | Effort | FR/NFR | Depends on |
|---|------|--------|--------|--------|------------|
| 4.1 | VPS: provisioning + setup (Node, PostgreSQL, Nginx) | 🔧 | 1–2 h | — | — |
| 4.2 | Strapi: deploy to VPS + SSL (cms.ikpk.su) | ⬜ | 1–2 h | — | 4.1, 2.1 |
| 4.3 | Nginx: configuration for static files + reverse proxy for Strapi | ⬜ | 1 h | — | 4.1 |
| 4.4 | CI/CD: GitHub Actions → build → rsync to VPS | 🔧 | 1–2 h | — | 4.1 |
| 4.5 | DNS: switch ikpk.su to the new VPS | ⬜ | 0.5 h | — | 4.1, 4.2 |
| 4.6 | Backups: PostgreSQL daily + media | ⬜ | 1 h | — | 4.2 |
| 4.7 | Monitoring: UptimeRobot + alerts | ⬜ | 0.5 h | — | 4.2, 4.3 |

Existing artifacts:
- `scripts/bootstrap-vps.sh` — 66 lines, VPS provisioning
- `scripts/deploy-web.sh` — 75 lines, frontend deployment

**Phase 4 total: ~6–9 h**

## Phase 5: Testing and Acceptance

| # | Task | Status | Effort | FR/NFR | Depends on |
|---|------|--------|--------|--------|------------|
| 5.1 | E2E tests: key scenarios (Playwright) | ⬜ | 3–4 h | — | 1.*, 2.* |
| 5.2 | Lighthouse CI: 4 templates × mobile/desktop | ⬜ | 1 h | NFR-01 | 1.5 |
| 5.3 | 301 redirect validation (253 URLs) | ⬜ | 1 h | NFR-02 | 1.8, 4.5 |
| 5.4 | Form testing: enrollment, subscription, search | ⬜ | 1 h | FR-05,06,07 | 1.1, 1.3 |
| 5.5 | UAT with content manager | ⬜ | 2 h | FR-11 | 2.*, 3.* |
| 5.6 | Cross-browser testing (mobile + desktop) | ⬜ | 1–2 h | NFR-05 | 1.* |

**Phase 5 total: ~9–12 h**

## Phase 6: Production Migration

| # | Task | Status | Effort | FR/NFR | Depends on |
|---|------|--------|--------|--------|------------|
| 6.1 | Final data import into production Strapi | ⬜ | 1 h | — | 3.5, 4.2 |
| 6.2 | DNS switchover + SSL verification | ⬜ | 0.5 h | — | 4.5 |
| 6.3 | Smoke tests on production | ⬜ | 1 h | — | 6.2 |
| 6.4 | 404/error monitoring (first 48 h) | ⬜ | 2 h | — | 6.2 |
| 6.5 | Indexing verification (Yandex, Google) | ⬜ | 1 h | NFR-02 | 6.2 |

**Phase 6 total: ~5–6 h**

## Summary

| Phase | Description | Status | Hours |
|-------|-------------|--------|-------|
| 0 | Discovery and prototype | ✅ completed | ~21 |
| 1 | Frontend refinement | 🔧 in progress | 19–30 |
| 2 | CMS (Strapi) | 🔧 started | 8–12 |
| 3 | Data migration | 🔧 scaffold ready | 7–12 |
| 4 | Deployment and infrastructure | 🔧 started | 6–9 |
| 5 | Testing and acceptance | ⬜ | 9–12 |
| 6 | Production migration | ⬜ | 5–6 |
| | **TOTAL** | | **~75–102 h** |
| | Already completed | | **~21 h** |
| | **Remaining** | | **~54–81 h** |

## Dependency Graph

```
Phase 0 (✅ done)
  │
  ├──▶ Phase 1 (frontend)──────────────────┐
  │                                         │
  ├──▶ Phase 2 (CMS) ──▶ Phase 3 (migration) │
  │         │                    │          │
  │         ▼                    ▼          ▼
  └──▶ Phase 4 (deploy) ──▶ Phase 5 (testing)
                                  │
                                  ▼
                           Phase 6 (go-live)
```

Phases 1, 2, 4 can run in parallel. Phases 3, 5, 6 are sequential.

## Existing Artifacts (Prototype)

| Artifact | Lines | Coverage |
|----------|-------|----------|
| `web/` (Astro frontend) | ~5100 | FR-01, FR-03, FR-04, FR-08, FR-09, FR-10 |
| `discovery/entities/*.json` | ~5500 | 10 entities, ready for import |
| `discovery/url_map.csv` | 1023 | Full URL map for 301 redirects |
| `scripts/import.ts` | 879 | Idempotent import scaffold for Strapi |
| `scripts/validate-urls.ts` | 266 | URL validation after migration |
| `scripts/bootstrap-vps.sh` | 66 | VPS provisioning |
| `scripts/deploy-web.sh` | 75 | Frontend deployment |
| `cms/` (Strapi) | — | Initialized, content model partially done |
| `docs/architecture/` | 6 files | PRD, use cases, architecture, comparison, ops cost |
