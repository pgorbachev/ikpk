# manual-publication-only: independent RED for hosted configuration

Test source commit: `1ded81895fc23252a28e215747c9c40060c067b9`.
Planning/source base: `74df60098d58909f5ce3b3c712cc675469bb0046`.
No production code, workflow configuration or specification changed in this delivery.

The adjacent `hosted-workflows-red.log` records the exact command, test-source SHA,
individual test names and exit status. Run from `web/`:

```sh
npx vitest run tests/manual-publication-workflows.test.ts tests/deploy-gating.test.ts tests/demo-gate.test.ts tests/browser-test-gating.test.ts tests/social-accounts.test.ts --reporter=verbose
```

Result: **8 failed, 67 passed; exit 1** (5 files, 2 failed). These are intentional RED:

- Seven hosted-configuration cases identify the existing Pages actions, privileges,
  environment/concurrency, and/or publication-record/reconcile in Tests.
- The documentation inventory still encounters `Deploy to GitHub Pages` as a separate
  workflow outside Tests. Removing Pages removes this obsolete entry; the test retains
  the requirement to name all remaining workflows' relationship to the gate.

The preserved demo/browser/social invariants pass. Their source is now exactly one
nonempty `Tests`, independent of any publishing workflow. Generic origin guards for
remaining Dependabot workflow_run receivers and expression-parser tests are preserved.
Legacy positive assertions about hosted Pages publishing were replaced by prohibition;
local origin selection, serialized publication and rollback need their own tests.

## Negative fixtures

The new file contains 20 passing detector/fixture cases. The 15 table mutations
explicitly replace a valid check-only workflow with Pages action/rights/environment/
concurrency, direct or guarded transfer, remote reusable publisher, credential on three
levels, inherited credentials, renamed record-pair and renamed reconcile operations.
For every mutation the acceptance result is **1 before → 0 after**. The fixture names
appear individually in the log; the patches are the literal objects in `it.each`.

Additional cases reject empty/unparseable/no-job input, follow an npm lifecycle hook
into a shell transport, preserve unrelated workflow_run receivers, ignore shell comments,
and reject missing/duplicate/empty/renamed Tests. No mutation of production files was
used; fixtures are in memory and therefore require no working-tree restoration.

Targeted fixture reproduction:

```sh
npx vitest run tests/manual-publication-workflows.test.ts --reporter=verbose -t 'targeted negative fixtures'
```

ESLint on all six changed test/helper files passed. Dependencies were installed with
`npm ci --ignore-scripts` in this isolated worktree; npm reported existing dependency
advisories and engine warnings for the available Node 24.13.0. No dependency files changed.

## Boundaries and remaining independent checks

This delivery covers tasks 2.1/2.2, configuration nonemptiness in 2.5a, hosted side of
2.9, and migration of demo/browser/social/Tests bindings in 3.4. The static configuration
scanner follows YAML, npm lifecycle hooks and literal shell wrappers, and rejects
unreviewed external actions/secret references. It does not prove arbitrary JS/Python
program semantics or enumerate secrets stored in the remote GitHub settings.

Still needed: executable-wide transport inventory (exactly one implementation), trusted
local launcher, CI verdict authorization, local pair checks, checksum/switch behavior,
credentials at connection time, locking, rollback and serving verification. Two other
old test families still need migration: cms-publication-pipeline positive expectations
for record/reconcile/Pages and payment-contour-deploy-config's two Pages-specific tests.
