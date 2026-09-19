# Independent runner/state and launcher review, 2026-09-19

Runner/state full pass: d32a6533865c6ef0ff007b401e18f0f0b10417ff.
Independent tests: 0e96219f3cbfddd26ba0dfda7ac848c9bc25adfd.
Diagnostic fix: 77ee1d4feaf95087b2a7ce6de41e7f9c9b44dc10.

The reviewer covered the state store, ledger, runner, publication gate and immutable
history. No new P0/P1; two P2 findings were confirmed:

- Stale/regressed snapshot refusals omitted observedEntry, latestEntry, revision and
  highWaterMark. Three independent RED tests cover a late event, captured regression,
  and a real Git state-store mismatch. Refusals now retain that evidence; the runner
  adds captured values to the typed store mismatch without another remote read.
- The original authorization test ran after permission expiry. Removing all binding
  checks while retaining expiry left its ten negative assertions green. The new
  test exercises positive connect/activate controls and eleven forged requests while
  authorization is live. The old test remains useful for expiry only.

Independent RED: seven focused files, 147 passed / 2 failed; after adding the real
Git diagnostic case, two focused files, 25 passed / 3 failed. Integrated GREEN:

```
cd web
npx vitest run tests/publication-state-store.test.ts tests/manual-publication-runner.test.ts tests/manual-publication-runner-review.test.ts tests/prepare-snapshot-source.test.ts tests/manual-publication-workflows.test.ts tests/demo-gate.test.ts tests/browser-test-gating.test.ts --maxWorkers=2
```

94 passed, 0 failed. Focused ESLint also passed. These are local contract tests,
not evidence of a real CMS journal, CI verdict, installation or deployment.

Simplification suggestion: remove the runner's repeated pure publication-gate call.
Retained deliberately: it keeps the executable coordinator subject to the same
central authorization policy as other callers; the nearby checks establish factual
snapshot, artifact and journal identity before invoking that policy. No additional
framework was introduced.

## Launcher source regression

Independent review found that Git clone --branch main accepts a tag when the branch
is absent. The isolated native probe executed the worker and credential broker.
Tests-only commit c22deddcdc11008db59b19cc3d445831acb82072 reproduced the failure;
fix f5cd955a7a9161541dc272ba46b319f81de96013 requires symbolic HEAD refs/heads/main and the exact origin/main ref.

Full independent re-review at 9a60ed175678635f20b9924b21f5bb6894d53c89 found no new
P0/P1 in launcher, transport or remote Python. Node publication tests: 48/48;
launcher Vitest tests: 32/32. This revision includes main PR #252. The subsequent
runner diagnostic change does not modify the reviewed transport/launcher scope.
