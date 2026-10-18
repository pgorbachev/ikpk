# Rehearsal193 curated source candidate

This document records the source composition under review. It is not production
acceptance, a CI admission, or authorization to publish. The candidate starts at
`origin/main@09347070ceb5634cf4b46774934238c0eac306d1`; its planned destination is
the canonical `dev` branch after review and required CI. No host, CMS, remote ref,
tag, or release was changed while preparing it.

## Source list

| Source | Decision in this candidate |
| --- | --- |
| Main fixes #316, #317, #318, #319, #324, #325 | Kept from the fresh main base: `f6bede12074ed4a3a256c5756616247a1aefba9e`, `cce44f0f81ac59862cc6ffab043a7ae140e63d08`, `a681f057d84a70007cc27da6259ee0e0710c74fd`, `27a6b8f75fccb15d863b7dce873c2ddf815e49c7`, `09347070ceb5634cf4b46774934238c0eac306d1`, `19769003464a28536eb3242c8732a32e02a1542a`. In particular, #318's refusal on missing or unmapped source data remains authoritative. |
| #186, #305, #313, #315 | Kept from `origin/dev`: `a49c82c2bc6d920d6a7fdb7a65168f4f15d93252`, `fe21e81e2e381912d29c21bd6f817ac88dd2c442`, `f4302d3ef628c292b5a27de9f34f700575b8c10a`, `95890a8ff72e0c5b294eaf4b30d6a91ab96ba7d5`. Conflicts were reconciled against current main; #318 fail-closed checks and #324's live-route policy were retained. |
| #306, #308, #309, #310 | Kept: pinned CI action updates and scripts ESLint/TypeScript-ESLint updates: `dd1d29d0d5b8304f0544387bb1703b3fa09027a7`, `df9f844652fc3573ee35c37df247493661b77d9e`, `0fd858b19f7656b3bdf9f6b8099280a8a2e96c03`, `4c1da58c3a6dafe9410f1d58a7954c5103b6b218`. The scripts lockfile preserves current-main packages. |
| #329 authoring integration | Kept the externally consumed Strapi-to-snapshot field map, capture contract and content/render changes. It covers `image`, `isEventCollection`, `promotions.type`, `institute.slug`, teacher trait, multiple photos, seminar document/learning fields, and compatible snapshot proof. `cms/src/lib/demo193-source-empty-fields.json` remains because live lifecycle and migration planning consume it. `web/scripts/capture-content-snapshot.ts` still fails closed for missing/unmapped data; content accepted by the field map is covered by capture/render tests. |
| #329 SQL importer prototype | Excluded the closed standalone `scripts/prototype-sql-demo.ts` → `scripts/lib/sql-demo-*` / `scripts/lib/sql-public-*` graph and its tests. Its reader is for PostgreSQL `psql` plus a legacy dump, with no caller from the rehearsal's Strapi SQLite migration path. The rehearsal starts from a Strapi SQLite baseline via `run-data-migrations.prepare`. |
| #329 dependencies used by #331 | Kept `cms/scripts/institute-method-author-classification.mjs`, `cms/scripts/normalize-null-documents-state.mjs`, and their focused tests: #331 migration steps import these helpers. This runtime dependency does not imply that the standalone SQL importer is required. |
| #330 and #331 | Kept the migration workflow documentation and the unified data-migration runner, plan, audit tools and tests. Fresh-main `AGENTS.md` stays in place. |
| #332 product files | Kept only `web/astro.config.mjs`, `web/src/components/topnav/TopNav.astro`, `web/src/components/Footer.astro`, `web/src/components/home/sections/CtaBand.astro`, `web/src/lib/home.ts`, and `web/src/styles/base.css`. |
| #332 product regression evidence | Kept `web/tests/home-snapshot-clock.test.ts`, `web/tests/footer-snapshot-clock.render.test.ts`, their `vitest.render.config.ts` registration, and `web/tests/evidence/home-snapshot-clock.md`; these prove home and footer dates use the captured snapshot date under an advanced build clock. Kept `web/tests/evidence/visual-baseline-reconciliation.md` as the recorded visual review for the product layout/content deltas. These were omitted by the six-source-file extraction and are restored because they are product regression gates/evidence, not deployment machinery. |
| #335 narrow runner correction | Kept only `cms/scripts/run-data-migrations.mjs`, `cms/database/migrations/plan.json`, and `cms/tests/data-migration-runner-behavior.test.js`: closed-load random secrets, loopback/ephemeral port, capture-token bootstrap disabled, ambient environment restoration, and source preflight before dependency fingerprinting. Plan integrity records the runner's exact hash. No release-artifact or CI attachment machinery came with it. |
| #332–#335 release/deploy machinery | Excluded wholesale except the six #332 product files and the three #335 runner files above. In particular, no `scripts/deploy*`, publication gateway/lifecycle, `scripts/build-cms-artifact.sh`, or `.github/workflows/release-tests.yml` was carried over. The separate SQLite reader in #332 (`scripts/lib/server-capture-sqlite.mjs`) and its bundle proof are not in this source candidate. A future minimal operator publication bridge for the frozen Strapi SQLite snapshot must retain the read-only/quiescence and snapshot-metadata proof that this helper supplies; that dependency needs its own approved concise plan. It does not imply taking the #332 gateway or lifecycle wholesale. |

The old `web/tests/publication-{catalog,content,schedule,widgets}.spec.ts` tests are
excluded with their publication-candidate harness. They import `helpers/publication-candidate`,
which assembled a deploy-only candidate and was removed with that retired release path;
they are not in the active Playwright `testMatch` or required `Tests` workflow. Their
product assertions overlap current source/build gates for article controls, seminar
schedule fields and filters, external-widget output/configuration, SEO and navigation.
This does not provide a browser-level assertion over a future frozen SQLite publication
candidate; add that bounded check only with the separately approved capture bridge plan.

`.github/workflows/test.yml` retains the current unit/build checks, runs on pushes to
`main` and `dev`, and includes the excluded-from-parallel Docker provisioning tests as
one serialized, time-bounded step with retained diagnostics. This keeps the #313
isolation without dropping the tests from required CI. Other workflows are inherited
from current main unchanged; `.github/workflows/release-tests.yml` was not carried over.

## Validation boundary

`CHAT_LOADER_SRC=none npm run build` succeeded in this worktree. The focused CMS
migration/audit/helper run passed 63/63 tests, and payment listener/startup/persistence
tests passed 76/76 after installing the declared payments dependencies. The
provisioning container suite could not run locally because the Colima Docker socket is
absent; that is reported as unmeasured, not green. The initial broad web run also found
stale occurrence/source-slot fixtures after the selected product changes; these are
being regenerated through the repository's established pinned-fixture → reviewed-dist
maintainer generators, with the #324 policy tests kept as gates.

This revision remains a source candidate pending full review and canonical `Tests`
workflow on its exact SHA. It does not yet include the operator commands or frozen-DB
capture bridge needed to rehearse. Local tests and a static build do not admit it for
rehearsal or production. Production CMS, site, and hosts remain untouched.
