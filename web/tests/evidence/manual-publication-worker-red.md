# Publication worker integration: independent RED

Base: `codex/manual-publication-implementation@3215c8773b59a5e312a6664ec8e0f1a562b61ad8`.
Test branch: `codex/publication-worker-red`. Production files are not changed by this delivery.

The approved worker seam is `web/scripts/publication-worker.ts` exporting
`runPublicationWorker({ argv, env, cwd })`. Its concrete dependencies are fixed
imports, not operator-selected reports, callbacks or command paths. Tests mock
only effect modules; `runNewPublication` and its authorization logic remain real.
The protected config extends the launcher schema with `paymentRole`, `siteUrl`,
`actor`, `webRoot`, `knownHostsFile`, and `keepReleases`.

## Behavioral RED

The worker does not exist at the base. Missing-module assertions are not counted as
behavioral evidence. In this isolated test worktree, a temporary empty worker was
created, then deleted immediately after the run:

```sh
cat > web/scripts/publication-worker.ts <<'STUB'
// Temporary behavioral RED baseline; not part of the delivery.
export async function runPublicationWorker() { return undefined; }
STUB
node web/node_modules/vitest/vitest.mjs run --root web tests/manual-publication-worker.test.ts --reporter=verbose > web/tests/evidence/manual-publication-worker-red.log 2>&1
result=$?
rm web/scripts/publication-worker.ts
exit "$result"
```

Result: exit **1**, **14 failed / 0 passed**. Of these:

- 3 positive controls fail because CI, checks, installation, publication and index
  effects are absent; successful publication cannot pass vacuously.
- 9 refusal cases fail because the no-op resolves instead of rejecting missing or
  inconsistent trust inputs, missing CI evidence or caller-selected authorization.
- 2 actual shell runs fail because the existing `deploy-web.sh` invokes npm before
  protected context validation and before dispatching the fixed worker. A local
  npm probe writes a marker and exits 73; no SSH/network effect is possible.

The no-op source is not committed. The final test fixture explicitly checks worker
existence outside expected-rejection assertions, so absence cannot satisfy a
refusal test.

## Dynamic-import harness check

A second temporary worker registered `tsx/esm/api`, then dynamically imported the
real CI module path and called `readCiEvidence` with the process SHA/token. Running
only `-t 'CI read failure'` produced **1 passed / 13 filtered**: Vitest's effect
mock remained active after tsx registration, and the exact mocked CI refusal was
observed. That temporary worker was also removed. This checks the bootstrap test
seam; it is not a successful publication claim.

## Scope and verification

The positive control requires actual runner consumption of CI/local evidence,
stage, activation and index recording. The credential case requires a nonempty
installation command list and successful staging, then checks explicit child
environments, no credentials/startup hooks in installation or check inputs, and
CMS-only credential forwarding to capture. Ledger paths must match the concrete
state-store work directory.

`node node_modules/eslint/bin/eslint.js tests/manual-publication-worker.test.ts`
from `web/`: exit **0**. Full GREEN, targeted mutations of each implemented guard,
and real executable/bootstrap smoke remain the implementation/review delivery.
