# Retained-release rollback: independent RED evidence

Tests revision: `codex/publication-rollback-red@e1d3ed02d69fd255fd7ebb7bafc09df74e5630c8`.
Implementation base: `codex/manual-publication-implementation@9a60ed175678635f20b9924b21f5bb6894d53c89`.
Date: 2026-09-19. Production code and OpenSpec artifacts are unchanged.

Scope: approved `manual-publication-only`, design 3a and tasks 2.6, 5.2a, 5.3.
This delivery tests the installed coordinator and index-only state access. SSH retained-tree
extraction, browser isolation, real smoke/payment adapters, CLI integration and stand acceptance
remain separate deliveries. Fake transport/check effects establish ordering and argument binding;
they do not claim successful real SSH, browser, payment or CMS integration. The fixture uses actual
files and byte hashes; its stored evidence is accepted by the existing real publication gate and
immutable-index implementation. The state tests use real local Git repositories.

Run from `web/` at the tests revision:

```sh
./node_modules/.bin/vitest run tests/manual-publication-rollback.test.ts tests/publication-state-store.test.ts
```

Exit 1; 39 executed, 25 passed and 14 failed, no skipped tests. Raw output:
`manual-publication-rollback-red.log`.

- Ten coordinator cases fail because the coordinator module is absent. Import occurs before any
  rejection expectation, so missing implementation cannot masquerade as a successful refusal.
- Two new state cases fail because `readHistory()` is absent.
- The third new state case reaches the real `appendPublication` and fails with
  `provenance ledger unavailable or unsafe`: rollback cannot yet append using only its index.
- One additional failure is the pre-existing stale-snapshot diagnostic RED at the base SHA;
  the parent task's uncommitted diagnostic fix was deliberately not copied into this worktree.

For a behavioral negative control, temporarily add only this no-op module at
`web/scripts/lib/publication-rollback.ts`, without committing it:

```ts
export async function runPublicationRollback() { return undefined; }
```

Then run from `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-rollback.test.ts
```

Exit 1; 11 executed, 1 real gate/index fixture control passed and all 10 coordinator cases
failed on behavior (resolved refusal paths, absent restored/audited result, absent authorization),
not import/collection errors. Raw output: `manual-publication-rollback-noop-red.log`.
The temporary no-op was removed after the run; production paths have no diff from the base.
This proves a no-op cannot satisfy the tests. Full per-invariant mutations await actual GREEN
implementation; no claim that these orchestration tests already proved production effects is made.

Covered boundaries: explicit actor/confirmation/reason; original complete CI and five local
checks; selected destination and retained previous release; missing retention/current target;
real-byte digest before and after the fresh three groups; stored deploy/payment roles; exact
retained-release read authorization; scoped rollback-only authorization and revocation; immutable
original/fresh audit evidence; whole retained/check/switch/health/append lock; existing pending
operation; release identity/health before index append; changed callback identity; post-switch
failure/pending propagation. No live CMS, current main, remote CI, capture, rebuild or acceptance
is available to the happy path.

Validation: targeted ESLint exit 0; `npm run typecheck` exit 0, 0 errors and 7 existing hints
(raw output in `manual-publication-rollback-typecheck.log`); `git diff --check` exit 0;
`./bin/check-spec-refs` exit 0, no discrepancies. Site build was not run: tests-only delivery,
with publication GREEN/build/adapter acceptance belonging to the implementation task.
