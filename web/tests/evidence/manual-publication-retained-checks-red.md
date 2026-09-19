# Retained rollback check adapter and coordinator: independent RED

Base: `codex/manual-publication-implementation@249be0c8f1175ad4d71bbad9e6a7608968b24d04`.
Own worktree: `/Users/pgorbachev/projects/private/ikpk-retained-checks-red`.
No production changes are included. No GitHub writes or live CMS/payment/SSH calls.

Contract: `openspec/changes/manual-publication-only/specs/deploy-gating/spec.md:178`:
retained rollback checks destination modes, desktop/mobile smoke and the saved payment role;
it must not need a new capture, build or snapshot artifact. Every group is nonzero and successful.

## Proposed implementation boundary

- `publication-rollback-checks.ts`: `RollbackCheckInput` extends the existing publication
  input with `snapshotId`; `RollbackCheckContext` adds sanitized `env`, with no `snapshotDir`.
  `runRollbackChecks(input, ports)` produces `LocalChecks` with exactly `destination-mode`,
  `browser-smoke`, `payment-destination` and the original commit/snapshot/destination identity.
- `RollbackCheckPorts`: destination/browser/payment absence/readiness/preflight and digest.
  No capture/build/snapshot/build-content capability is needed.
- `createRollbackCheckPorts({ webRoot, treeDir, reportsDir, payment? }, runtime?)` in the
  installed adapter uses trusted fixed tools and suites from `webRoot`, pinning an absolute
  downloaded tree outside `web/dist`. It must not execute code carried by that tree.
- Existing fixed assertion helper must accept an absolute trusted retained directory.
  Browser selection can use a dedicated fixed retained suite or explicit trusted retained
  mode, but must not read a snapshot or derive routes from current CMS.

## Observed RED

Command from `web/`:

```sh
node_modules/.bin/vitest run tests/manual-publication-rollback-checks.test.ts tests/manual-publication-rollback-adapters.test.ts tests/manual-publication-retained-tree.test.ts --reporter=json --outputFile=tests/evidence/manual-publication-retained-checks-red.json
```

Original tree: exit 1. The new coordinator is absent, the adapter export is absent,
and the existing assertion helper independently rejects the absolute retained tree because
it compares it to `web/dist`. The latter is an actual behavior failure, not an import error.

To distinguish missing imports from missing behavior, a temporary coordinator returning
`undefined` and a bridge to the existing fresh-publication adapter were applied:

```ts
// Temporary new module; removed after the run.
export async function runRollbackChecks() { return undefined; }

// Temporarily appended to publication-check-adapters.ts; then restored byte-for-byte.
export function createRollbackCheckPorts(options, runtime) {
  return createPublicationCheckPorts({ ...options,
    snapshotDir: '/nonexistent-retained-snapshot',
    ledgerDir: '/nonexistent-retained-ledger', captureEnv: {},
  }, runtime);
}
```

Same Vitest command with output `manual-publication-retained-checks-noop-red.json`:
**20 tests, 17 failed, 3 passed, exit 1**. Positive coordinator cases and refusal cases
all reject the empty implementation. The bridged real adapter rejects the retained tree;
it also fails the retained-report containment and preview expectations. Passing refusal
cases under this bridge are not presented as implementation acceptance.

The tests cover exact three-group results and identities; no capture/build/snapshot;
ci absence without active probes; both active roles requiring readiness plus preflight;
zero/skipped/failed/missing/fractional evidence; tree mutation; direct and symlink report
containment; stale report; malformed identity; sanitized temporary home; partial-count
audit; fixed command selection; trusted process cwd; and preview cleanup.

All temporary production probes were removed. `git diff -- web/scripts/lib/publication-check-adapters.ts`
was empty, and `publication-rollback-checks.ts` did not exist after restoration.

## Real browser dependency diagnostic

An existing built artifact was copied to a fresh temporary `retained/` directory. The real
existing Playwright suite ran both desktop and mobile with `PUBLICATION_TREE_DIR` pointing
there, an explicit Chromium executable, stand/ci modes, `DEMO_FORMS=stub`,
`CHAT_LOADER_SRC=none`, and **no `CONTENT_SNAPSHOT_DIR`**:

```sh
node_modules/.bin/playwright test tests/publication-smoke.spec.ts --config playwright.publication.config.ts --project=desktop --project=mobile --reporter=json
```

Result in `manual-publication-retained-browser-red.json`: **8 executed, 8 failed, 0 skipped**,
all with `Error: owned publication context required`. This directly demonstrates the current
snapshot dependency. `PUBLICATION_BASE_URL=http://127.0.0.1:9` was deliberately unreachable:
all failures occurred at `context()` before navigation. This is a dependency diagnostic,
not a completed preview or browser acceptance run.

## GREEN handoff

`tests/helpers/publication-retained-real-smoke.ts` is the separate real acceptance harness.
It takes an absolute existing stand/ci artifact with `release.json`, copies it to a fresh
retained directory, runs the real adapter/coordinator and desktop/mobile checks, asserts
nonzero results for exactly three groups, and confirms the before/after tree digest. It
does not run a build. Run after implementation:

```sh
node_modules/.bin/tsx tests/helpers/publication-retained-real-smoke.ts /absolute/prebuilt/stand-ci-artifact
```

The source artifact used for the browser diagnostic lacked `release.json`, so it is not
misrepresented as a verified retained release or used as a positive coordinator fixture.
For the acceptance harness supply the artifact from a successful publication fixture run.

Targeted ESLint on all four added TypeScript files passed. Full typechecking is deferred
until the proposed production APIs exist; a missing-export error is expected in RED.
