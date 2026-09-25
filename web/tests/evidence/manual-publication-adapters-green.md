# Publication adapters: implementation and executable acceptance

Implementation: `feat/manual-publication-adapters@f8b4d48ad5919a6c4101985ac6d250dec50cf604`.
Independent RED: `311f1f870b2af8f3a8e4f6caaa3c4d90147cf536`, contract in
`manual-publication-adapters-contract.md`. Base explicitly delegated by coordinator:
`a61cd7d639c605b687550f794478334640d14c54`. Node 24.13.0, macOS arm64,
2026-09-19. Isolated worktree; no production/GitHub effects.

## GREEN commands

From `web/`:

```sh
npx vitest run tests/manual-publication-adapters.test.ts tests/manual-publication-adapter-fixtures.test.ts tests/browser-test-gating.test.ts --reporter=json --outputFile=/tmp/ikpk-adapters-final-unit.json
npm run lint
npm run typecheck
npm run audit:prod
npx tsx tests/helpers/publication-real-fixture-smoke.ts
```

Contract 25/25 and browser inventory 6/6, no skipped tests. Full lint passes;
final targeted lint including all new suites/harness also passes. Typecheck:
388 files, zero errors/warnings, seven existing hints. Audit: zero vulnerabilities.
All commands exit 0. Fixed assertions are excluded from default unit/browser
selection and inventoried against the actual exported fixed local browser command.

Real fixture smoke uses the existing loopback CMS fixture and actual capture child,
actual npm/Astro build, actual Vitest and Playwright children, and adapter-owned
loopback serving of this worktree's `dist`. The temporary journal is written only
by fixture setup simulating the CMS writer. A setup capture first proves unknown
journal refusal; the publication coordinator then captures exactly once and builds
exactly once. No mocked runner result or attached arbitrary server is used.
Reports: snapshot 3, build 4, destination 4, browser 8 (four per desktop/mobile),
ci-payment absence 1: **20 executed assertions in five fixed groups**.
See `manual-publication-adapters-green.json` for the exact snapshot ID, tree digest,
counts and negative-probe record. Repeated smoke invocations during harness fixes
were independent attempts, each with one publication build; no hidden build occurs
inside any check. CMS fixture input maps full pinned content to the existing REST
field contract; its one uploaded image is actual repository image bytes.

## Original content refusal, separate from harness corrections

The first real build correctly refused **43 link occurrences / nine distinct
URLs** inherited from `fixtures/content-snapshot/collapsible_panels.json` via
`web/scripts/capture-content-snapshot.ts:424`. Snapshot, release marker,
rich-content and media checks passed. `manual-publication-legacy-links.json`
contains all 43 source page/panel/occurrence keys, exact URL and fixture-only mapping.
None of those pathname targets exists in the generated tree or accepted
`deploy/nginx-redirects.conf`. Query parameters cannot rescue the missing document;
these are not local anchors or valid accepted redirects. This is blocked inherited
content, not an adapter defect or a claim about today's old production server.

For the positive harness only, educational-organization links are mapped to the
existing svedeniya page; old programs-form links are mapped to the schedule. These
are deliberately synthetic fixture choices, **not approved production fixes**.
Normalization affects fixture CMS strings and its captured auxiliary panels before
the coordinator freezes/hashes them. Production adapter/assertions and historical
fixtures are unchanged. Intermediate browser execution exposed a harness selector
matching three legitimate navigation links; it now selects the exact visible
“Расписание” link, with no assertion removed.

**Resolution (2026-09-20, PR #258).** The 43 occurrences are closed in the three
tracked copies of `collapsible_panels.json`: seminar enrollment links → the seminar
page; Documents links → `/svedeniya-ob-obrazovatelnoy-organizatsii#section-N` with
`id="section-N"` emitted by `transformCollapsibles`. The paired JSON gained a
`resolution` field; this section keeps the original refusal as measured and records
the production decision separately from the harness’s synthetic mappings above.

## Negative probes after the implementation commit

Command: `cd web && npx tsx /tmp/ikpk-adapter-probes.mts` (exit 0 means every
expected rejection occurred). The local probe called the real adapter effects with
fresh report directories, using the successful smoke's snapshot/journal and
`web/dist`; no test or production source was mutated. Exact recipes/results:

| Mutation | Actual fixed suite | Failed assertions |
|---|---|---:|
| Replace captured media object's bytes with `corrupt` | snapshot | 1/3 |
| Wrong release pair; append missing local image with onerror handler and broken internal anchor to home HTML | build | 4/4 |
| Replace stand robots `Disallow: /` with `Allow: /` | destination | 1/4 |
| Replace home schedule hrefs with `/__broken_navigation__` | desktop/mobile browser | 2/8 |
| Add a form with data-payment-form and unexpected endpoint to ci payment page | payment-absence | 1/1 |

The four combined build mutations each trigger a different fixed assertion: marker,
rich-content safety, media resolution and links. All mutation runs have completed
reporter failures, not import/collection errors or exit status alone. Browser retries,
skips and flaky counts remain zero.

Active payment was separately exercised against an actual loopback HTTP server and
a temporary active-role/form variant of the same artifact (not a second active-role
build). Readiness plus cross-origin OPTIONS passed three assertions. Wrong shop
then failed one of two readiness assertions; foreign allow-origin failed the single
preflight assertion. The server observed only GET `/ready` and OPTIONS `/payments`
with the explicit site Origin; zero POST/payment creation. Each endpoint condition
has a positive control; this does not claim real payment-service readiness.

Every modified file was restored in `finally`. After every artifact probe, both
tree and snapshot digests equal their pre-mutation values. Final tree digest:
`b0b50e3f0bdb187cc31e2181d29d83a0fe2f9398917379c15326145be3ad8204`.
Snapshot-directory digest:
`57468ae9c063d853eeb017bc279d9b182408dd99de3e1fa38974357499ae090a`.
Tracked generated media manifest was restored before the implementation commit;
`git diff --check` and clean worktree were checked after probes.

## Boundary and remaining work

Adapters preserve the coordinator's lexical snapshotDir (including macOS `/var`
paths), while using canonical paths only for containment/identity comparisons.
The installed runtime derives Playwright's Chromium executable before spawning a
sanitized child with temporary HOME/TMPDIR; the existing oracle's default behavior
is unchanged when no explicit executable is supplied. No ambient HOME or credentials
are restored to build/browser children. Capture alone receives CMS credentials.

No real CMS, actual destination payment service, SSH transport or publication was
performed. Worker/orchestration, CLI/deploy integration and independent review are
separate deliveries. The 43 inherited content links that blocked the first real
build are resolved by PR #258 (see «Resolution» above and
`manual-publication-legacy-links.json` → `resolution`). Live publication may still
be blocked by other gates; this evidence does not mark the full OpenSpec change
complete. Production payment build/readiness and production mode analytics require
integrated acceptance.
