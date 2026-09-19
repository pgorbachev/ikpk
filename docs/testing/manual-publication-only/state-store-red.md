# Shared publication state store — RED delivery

Base implementation: `codex/manual-publication-implementation@5f197268a140647835bee2ef60801bfb4f8829ef`.
Scope: manual-publication-only tasks 5.1/5.2; tests and an explicitly unimplemented API stub only.

## Approved API

`createPublicationStateStore({ remote, workDir, gitEnv?, maxPushAttempts? })` returns:

- `read(fingerprint)` → `{ head, observation, entries, publications }`;
- `appendPublication(record)` → `{ head, changed }`;
- `acceptState({ expectedObservedEntry, fingerprint, actor })` → `{ head, entry }`.

The branch is fixed to `state/cms-provenance`. The caller provides an isolated working directory and credentials through `gitEnv`, not process arguments. Observations refresh the existing remote state without changing tracked data or remote history. The retry budget is a bounded positive integer.

## Exact verification

Commands from `web/`:

```sh
npx vitest run tests/publication-state-store.test.ts --reporter=verbose
npx eslint tests/publication-state-store.test.ts scripts/lib/publication-state-store.ts
npx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --allowImportingTsExtensions tests/publication-state-store.test.ts scripts/lib/publication-state-store.ts
```

Test result: exit 1; **17 failed, 1 passed, 18 executed**. Full output is `state-store-red.log`. ESLint and targeted TypeScript checks exit 0. Failures reach the declared API and its explicit `publication-state-store-not-implemented` stub; no missing import or fixture setup error accounts for RED.

The passing control uses two independent Git worktrees and an actual temporary bare remote. A one-shot server pre-receive hook pushes the second writer before the first update completes. The first real push is rejected, the remote retains the second writer's CMS event, and the publication index remains unchanged. That push uses the same local SSH adapter as the authentication test; the adapter observes the environment canary and records argv without it. There are no external network calls or injected publication callbacks.

## Contract coverage

The 18 black-box cases cover read-only refresh; absent branch and damaged journal; a clean index-only publication commit; immutable/idempotent operation identity; preservation of concurrent CMS events and publication records after non-fast-forward; exhausted and invalid retry budgets; actor-bearing acceptance with checksum verification; stale observations, unrelated fingerprints, blank actors and missing journal; cancellation of confirmation after a CMS race; retry after an unrelated publication race; rejection of an existing operator checkout; and real Git authentication passed through environment without appearing in argv, Git config or returned results.

The existing `provenance-ledger.ts` currently discards `confirmedBy`. The positive acceptance case requires this actor to be persisted and covered by the entry checksum, while old entries remain readable. Modifying the saved actor must invalidate integrity. This is an intentionally exposed implementation gap; the ledger implementation is unchanged in this delivery.

Targeted mutation evidence for each state-store behavior requires its implementation and belongs to the GREEN delivery. No publication, push to the project remote, GitHub comment, or production credential was used.
