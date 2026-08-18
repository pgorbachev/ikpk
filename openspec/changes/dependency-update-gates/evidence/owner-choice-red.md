# RED evidence for the approved grouping and publication choices

The tests were written from the updated OpenSpec artifacts at
`896a3c0ec72e0f009bdd7fd58253f5d04462349c`. The test-only branch was based on
that exact commit; no production code, workflow, or Dependabot configuration was
changed.

The RED run used the test-only commit
`eff77ac9b4b8342c82be6dded81257388bcdc5a5`:

```sh
cd web
git rev-parse HEAD
npx vitest run tests/dependabot-grouping.test.ts \
  tests/dependency-published-head.test.ts \
  tests/dependency-publish-monitor.test.ts --reporter=verbose
```

Result: exit code **1**; **3 failed / 7 passed** tests across three files.

The expected failures were:

1. `uses one update scope for the same minor dependency in allowed web and scripts packages`
   — the shared group had no `group-by: dependency-name`.
2. `keeps different cms dependencies in separate pull requests`
   — the broad `cms-minor-patch` group still mixed dependency names.
3. `is scheduled, manually reproducible, and enforces the approved 30 minute lag`
   — no scheduled plus `workflow_dispatch` `published-head` monitor existed.

The pure boundary checks were already green: an unpublished head is allowed at
exactly **1,800,000 ms** and rejected at **1,800,001 ms**, with the full
40-character unpublished SHA in the failure message. The remaining RED therefore
belongs to the missing configuration and workflow orchestration, not to the
already implemented time comparison primitive.
