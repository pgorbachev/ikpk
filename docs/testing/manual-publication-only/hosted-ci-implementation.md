# Hosted CI migration: implementation and evidence

Scope: manual-publication-only tasks 3.1–3.5 and hosted configuration tests. No local
launcher, transport, CLI or core implementation was changed. The full change is not complete.

Implementation under verification: `fae07813aa4a5d60d3f7a58016d2f9bb45539991`.
Planning base: `2fb57519cc7f44482c2940cd5650ee11e61b3f35`.

- Removed the Pages workflow and its hosted publication capabilities.
- Removed publication-record, release reconciliation and the live publication gate from Tests.
- Kept all five required jobs and their checks. The snapshot producer explicitly reads the
  pinned fixture; a separate directory receives its artifact for consumers.
- Kept event/schedule verification without treating success as publication.
- Kept demo/browser/social and payment invariants, migrated their CI contract.
- Added publication-ci-counts from the existing Vitest unit/render/build JSON reports, after
  successful checks, with missing artifacts treated as failure. No count is invented from jobs.

## Verification

The adjacent logs include exact commands, source SHA, individual names and exit status:

- `hosted-pipeline-extra-red.log`: **4 failed / 20 passed**, before workflow changes.
- `event-and-counts-red.log`: **3 failed / 25 passed**, before the counts artifact was added;
  two failures belong to the intentionally unmodified old core.
- `hosted-workflows-final-green.log`: **147 passed**, 12 relevant files, exit 0.
- `event-core-handoff-red.log`: **2 failed / 13 passed**, intentional handoff to the core
  implementer: event success must not publish; stale snapshot must not schedule publication.

ESLint passed on the nine changed test/helper files. Astro typecheck after the initial
workflow migration returned 0 errors, 0 warnings, 7 hints. check-spec-refs passed after four
current source line references were repaired and the removed Pages file was explicitly
recorded as deleted-deliberately. No requirement text was changed by that repair.

`npm run audit:prod` on this branch's original dependency base reported 3 vulnerabilities
(1 moderate, 2 high, including js-yaml and svgo). This delivery changes no dependencies.
The parent integration has a newer main dependency update; its audit must be rerun there.
Build/browser execution and full repository gates belong to integration; this verification
covers the changed workflow structure, snapshot artifact handling and existing metadata gates.

## Targeted mutations

`hosted-workflows-negative.log` records the exact mutation and test command for each case.
All mutations ran after committing the implementation at the SHA above:

1. Replace the pinned CONTENT_SNAPSHOT_DIR with the output artifact directory:
   target `единственный подготовитель` **0 failures → 1 failure**.
2. Remove the publication-ci-counts upload block:
   target `успешный Tests сохраняет` **0 failures → 1 failure**.
3. Restore deploy.yml from the planning base:
   target `all parsed workflows` **0 failures → 1 failure**.

After all mutations: `git status --porcelain` was empty and `git diff --exit-code` against
that implementation SHA returned 0. The logs/evidence were copied into the tree afterward.

## Integration

The old cached-pair manual selection suite was removed at the parent's explicit request:
its replacement is the independent manual-publication-core suite in the integration branch.
Ledger/regression tests remain. The remaining two RED core cases are not silently skipped.

The initial scope and the later counts/core-test supplement have separate RED-before-code
commits. Cherry-pick the branch commits after the planning base in order; do not duplicate
its already supplied initial meta-gate commits if they are already in the integration branch.
