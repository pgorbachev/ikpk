# CI reader and local publication coordinator: independent RED evidence

Base: `a083846f7ac4f75559d4e31e231a5489352bc934`.
Measured on 2026-09-19, Node.js v24.13.0, in the dedicated
`codex/manual-publication-readers-red` worktree.

This delivery contains two typed RED stubs, behavioral tests and injected fixtures.
It does not implement the production reader, capture, Astro build, browser or SSH
adapters and does not claim production acceptance.

## Reproduce

Run in `web/`, with its dependencies installed:

```sh
node_modules/.bin/vitest run \
  tests/manual-publication-ci-reader.test.ts \
  tests/manual-publication-local-checks.test.ts \
  tests/manual-publication-readers-fixtures.test.ts \
  --reporter=verbose --reporter=json \
  --outputFile.json=/tmp/ikpk-publication-readers-red.json
```

| File | Tests | Passed | Failed |
| --- | --- | --- | --- |
| `manual-publication-ci-reader.test.ts` | 15 | 0 | 15 |
| `manual-publication-local-checks.test.ts` | 15 | 0 | 15 |
| `manual-publication-readers-fixtures.test.ts` | 2 | 2 | 0 |
| Total | **32** | **2** | **30** |

Exit **1**, zero pending/skipped tests, no import/fixture failures. Recorded duration:
528 ms. The RED failures are assertions that the stub returned no evidence, failed
to reject invalid inputs, or invoked none of the expected effects. Several named
tests contain negative matrices; the number above is the test runner's case count,
not a claim that every matrix row is reached while the first row is still red.

Both positive fixture controls pass independently of the production stubs:

- CI fixture: three real `Response` objects, pagination through all five jobs,
  exactly three named reports and 31 passed tests; three measured mocked HTTP calls
  and one report read. No network connection occurs.
- Local fixture: one capture, snapshot check and fixture build; actual temporary
  file writes/reads and a digest that changes when bytes change. This is a tiny
  fixture artifact, not a successful Astro build or browser run.

Focused lint and TypeScript checks both exited **0**:

```sh
node_modules/.bin/eslint \
  scripts/lib/publication-ci.ts scripts/lib/publication-checks.ts \
  tests/manual-publication-ci-reader.test.ts \
  tests/manual-publication-local-checks.test.ts \
  tests/manual-publication-readers-fixtures.test.ts \
  tests/helpers/publication-readers-fixtures.ts

node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext \
  --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck \
  scripts/lib/publication-ci.ts scripts/lib/publication-checks.ts \
  tests/manual-publication-ci-reader.test.ts \
  tests/manual-publication-local-checks.test.ts \
  tests/manual-publication-readers-fixtures.test.ts \
  tests/helpers/publication-readers-fixtures.ts
```

## Agreed boundaries

`readCiEvidence({ commit, token?, fetch?, readReports? })` returns `CiEvidence`.
The production policy is fixed by `PUBLICATION_CI_POLICY`; callers cannot substitute
a repository, workflow or required job subset. Evidence is read with GET requests
for the main ref, workflow runs, run jobs and run artifacts, following pagination.
Only a completed successful push/schedule for the exact current main SHA qualifies.
All five required jobs must occur once and pass.

The exact run's unexpired, unambiguous `publication-ci-counts` artifact supplies
`web-unit-head.json`, `web-render-head.json`, and `web-build-head.json`. Each must
have a positive integer `numPassedTests` and zero `numFailedTests`; jobs, steps and
`numTotalTests` are not executed-test counts. Missing/malformed reports or metadata
fail closed. `readReports(artifact, { fetch, token? })` is the injected archive
reader boundary. Production CLI configuration does not expose these injected ports.

`runPublicationChecks(input, ports)` returns `LocalChecks` and writes its report
outside the checked tree. Input fixes commit, destination, independent deployment
and payment roles, tree/report paths and the source environment. Capture returns
`snapshotId` and `snapshotDir`; every effect receives that same snapshot context.

The fixed effects are capture once, snapshot/provenance check before build, build
once, build/content check, destination check, browser check and payment checks.
The runner writes `release.json` after build and before artifact checks/digest,
compares the tree digest across checks, and rejects empty, missing or failed groups.
Build and browser receive an environment allowlist; arbitrary secret variable
names, original operator HOME and deployment/CMS credentials cannot leak through.
The `ci` payment role requires a positive absence check and no readiness/preflight
effects; both active roles require successful nonempty readiness and preflight.

## Separate production-adapter work remains required

The real implementation must connect fixed production readers/effects to these
boundaries: GitHub REST plus artifact archive parsing; live snapshot capture and
provenance validation; one actual build; actual content/destination checks; browser
smoke against the existing tree with isolated HOME and no deployment credentials;
and read-only payment readiness/preflight or positive absence checks. It must not
replace those adapters with the fixtures supplied here, nor expose arbitrary
commands or port overrides through operator configuration.

The three test files are included by the existing `tests/**/*.test.ts` Vitest
discovery. After implementation: GREEN, targeted negative mutations and separate
production-adapter verification are still required. No CMS writes, real GitHub
requests, SSH sessions or GitHub comments were made for this delivery.
