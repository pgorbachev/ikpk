# Production publication effect adapters: contract and RED handoff

Source inspected: `31a26dce9aab0c484cab8495df00b644a3b40f1b`, root implementation.
Authoring branch: `codex/manual-publication-adapters-red`, isolated worktree created
from that exact commit by explicit delegation. No production adapter implementation
or publication assertion suites are included. This is the RED step for tasks 4.3–4.4.

## Boundary

`createPublicationCheckPorts(options, runtime?)` returns the existing
`PublicationCheckPorts` consumed by `runPublicationChecks`. It does not implement a
second coordinator, select groups from operator input, publish, or connect to SSH.

Trusted options: `webRoot`, `snapshotDir`, `reportsDir`, `ledgerDir`, `captureEnv`,
and optional payment `{ endpoint, readinessUrl, mode, shopId, siteOrigin }`.
`mode` is the service's `test|prod`, independently of CRM `DEPLOY_MODE` and client
`PAYMENT_ROLE`. The output is always this worktree's `web/dist`; reports live
outside it. The installed worker selects options and default effects; runtime DI
is available only to library tests, never CLI flags or operator JSON.

Test runtime has exactly two effects:

- `run({file,args,cwd,env}) -> {exitCode,signal?}`; arguments are arrays, not an
  interpolated shell command. Every child receives an explicit environment.
- `startPreview({treeDir,env}) -> {baseUrl,close}`; the production effect owns a
  local server for this exact artifact. It cannot attach to an unrelated server;
  `close()` is awaited in `finally`, including reporter/process failure.

The factory reads actual reporter files itself. Exit zero and stdout text never
stand in for a report or an executed test count. Digest uses the existing shared
artifact digest implementation, not a second hash format.

## Existing commands and libraries to reuse

All paths/lines below refer to the source SHA above.

| Effect | Existing implementation and production use |
|---|---|
| Capture | `web/scripts/capture-content-snapshot.ts:24,26,377`: run once through local `tsx`; set one explicit `CONTENT_SNAPSHOT_DIR`; require CMS_URL/STRAPI_URL, no pinned fallback. The existing script declares live origin but does not itself add journal provenance. |
| Snapshot validation | `web/scripts/lib/content-contract.ts`, `content-snapshot.ts`, `content-media-store.ts`: contract/references, recomputed fingerprint and snapshot ID, media content integrity. Exact latest journal fingerprint must match: `observe()` alone can assign a revision to an unknown fingerprint and is insufficient. |
| Journal observation | `web/scripts/lib/provenance-ledger.ts:154`: use the separately supplied `createLedger({initialize:false})` read-only mode. No `recordEvent`/`acceptState` during capture/checks. Bind observed entry/revision/high-water mark to the captured snapshot before the coordinator hashes it. Unknown, stale, or unaccepted restored state refuses. |
| One build | `web/package.json:10,38`: `npm run build` in web invokes preparation, derivatives, media check, exactly one Astro build, then Pagefind. Set captured snapshot path throughout. Do not call `test:build`, `test:demo`, or `test:stand` afterward: those rebuild. |
| Artifact checks | Reuse `media-migration.test.ts` logic, rich-content `hazard-scan.ts`/`closed-matrix-validate.ts`, local link and redirect validators, and role checks on the actual artifact. `tests/helpers/dist-pages.ts:7` hardcodes web/dist, motivating the fixed output path. |
| Destination/payment assertions | Source only `scripts/lib/deploy-checks.sh`: `form_links_match_mode` (572), `chat_widget_matches_mode` (241), `payment_endpoint_matches` (93), `payment_readiness_matches` (391), `payment_cors_allows` (440), `payment_endpoint_reachable` (477). Call inside fixed Vitest assertions so counts represent executed checks. Do not invoke deploy-web.sh: it performs transport and couples payment role to CRM mode. |
| Browser | Existing Playwright and attached-config pattern. `playwright.config.ts:106` starts the preview wrapper, **not a build**; `playwright.attached.config.ts` does not start a server. Reuse the wrapper/own equivalent local serving effect, and select the live publication suite on desktop/mobile against its returned URL. |

The full existing `vitest.build.config.ts` and `site.spec.ts` are not the publication
selection. They include fixture-specific article/video routes, inventory or
migration expectations, skipped viewport cases, and configuration-probe builds.
Those remain CI checks. Adapt their reusable assertions to the captured content
rather than treating a pinned fixture or hardcoded route as live acceptance.

## Fixed suites using existing runners

No new test runner. Implementation supplies `vitest.publication.config.ts` and
these fixed assertion files, called with JSON reporting:

```
vitest run --config vitest.publication.config.ts tests/publication/<stage>.test.ts --reporter=json --outputFile=<reportsDir>/<stage>.json
```

Stages are `snapshot`, `build`, `destination`, `payment-absence`,
`payment-readiness`, and `payment-preflight`. They map to the coordinator's five
fixed groups; active payment combines readiness and preflight counts.

Required suite content:

1. Snapshot: nonempty required content contract and links, present/valid media,
   recomputed identity, exact latest journal match and no unaccepted regression.
2. Build: rich-content safety, local image/internal URL/redirect resolution over
   the sole completed artifact, including its existing `release.json`. No rebuild.
3. Destination: CRM forms, analytics, robots, chat, independently declared payment
   role. Missing configuration must fail, never mean integration absent.
4. Browser: main pages, navigation, schedule and registration links on both
   desktop/mobile. Discover content-dependent routes from the snapshot/artifact;
   do not submit CRM forms, create payments, or execute fixture-only expectations.
5. Payment: `ci` positively checks absence of form and endpoint, without readiness
   options or API requests. Active roles verify declared artifact endpoint against
   trusted destination options, read-only readiness mode/shop and OPTIONS preflight;
   production cross-origin preflight checks the actual origin/header response.

Vitest environment includes fixed `PUBLICATION_TREE_DIR`, `CONTENT_SNAPSHOT_DIR`,
`PUBLICATION_LEDGER_DIR`, `PUBLICATION_DESTINATION_ID` and context modes. Active
payment adds `PUBLICATION_PAYMENT_ENDPOINT`, `PUBLICATION_PAYMENT_READY_URL`,
`PUBLICATION_PAYMENT_MODE`, `PUBLICATION_PAYMENT_SHOP_ID`,
`PUBLICATION_PAYMENT_SITE_ORIGIN`. The active build's PAYMENT_ENDPOINT_STAND/PROD
comes from trusted destination options, overriding untrusted context values.

Browser command:

```
playwright test tests/publication-smoke.spec.ts --config playwright.publication.config.ts --project=desktop --project=mobile --reporter=json
```

Set `PUBLICATION_BASE_URL` to the owned preview and
`PLAYWRIGHT_JSON_OUTPUT_NAME=<reportsDir>/browser.json`. The config has no webServer
or build hook. Browser outputs/traces stay outside the artifact. Build and browser
use an allowlist, preserve only the coordinator's temporary HOME/TMPDIR, and do not
merge ambient process.env. CMS credentials are present only in the capture child;
SSH/GitHub/arbitrarily named secret canaries are excluded even from capture.

All report paths are fixed and must be fresh for this invocation. An existing
report is refused before reuse. Vitest requires success, positive integer passed
count, zero failures/pending/todo, and matching completed assertion results.
Playwright requires actual passed results in each project, no skipped/interrupted/
failed/flaky tests or runner errors, and agreement with its summary. Collected
items and retry attempts are not counted as additional completed tests. Exit
failure/signal, malformed/missing reports, or inconsistent summaries refuse.

The coordinator already owns one capture/build ordering, pre-build snapshot
checking, writing release.json before artifact checks/digest, immutable tree and
snapshot verification, and the final report outside the artifact. Those are not
reimplemented here. Production suites/configs, default process/preview effects,
and actual live-pair acceptance remain the next implementation delivery.

## Validation

Node v24.13.0, isolated worktree. Targeted command:

```
npx vitest run tests/manual-publication-adapters.test.ts tests/manual-publication-adapter-fixtures.test.ts --reporter=json --outputFile=/tmp/ikpk-adapters-red.json
```

Observed 2026-09-19: **25 tests = 23 behavioral RED against the no-op adapter stub
and 2 GREEN fixture controls**, zero pending. Adapter assertion duration 479 ms;
fixture controls 203 ms. The RED command exits 1 as intended. Every failure is a
behavior assertion or a missing expected rejection, not an import/harness error.
Targeted ESLint and TypeScript (`--noEmit --allowImportingTsExtensions --module
esnext --moduleResolution bundler --target es2022 --strict --skipLibCheck
--allowJs`, four new TS files) pass with exit 0. `git diff --check` passes. One control validates a live-shaped snapshot and
real temporary journal; the other sends counted JSON fixtures through two actual
local Node subprocesses, stdin/stdout, and filesystem. Neither claims that an
Astro build, browser suite, or live CMS acceptance passed. No network/SSH/CMS
mutation, GitHub messages, or production effects were performed.
