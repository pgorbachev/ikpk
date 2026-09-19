# Installed rollback CLI and concrete binding — RED

Base: `codex/manual-publication-implementation@014dc87715184f41815fc394a3c42e86cb576362`, with retained-check implementation `7a2e6591c974b3c85f9fd0f13267f9fa87bb2d71` cherry-picked as `5142fb4786e0dddc32e3eb0eeba265f7ef6daaed` for the real coordinator/check positive control. This delivery changes tests/evidence only.

## Agreed implementation contract

- `launch(['rollback', '--config', protectedConfig, '--release-id', retainedId, '--confirm', '--reason', reason])` validates arguments, protected adjacent configuration and fixed repositoryless `runtime/` installation before the credential broker.
- Identity: adjacent `runtime/runtime.json` is `{ version: 1, commit: <40 lowercase hex> }`; native entry is `runtime/web/scripts/publication-operator.ts`. No source URL/ref, worker, report, authorize callback or command override.
- Invocation: `process.execPath [entry, 'rollback', '--release-id', retainedId, '--confirm', '--reason', reason]`, cwd `runtime/`. Context includes existing config/launcher/destination/mode and `PUBLICATION_RUNTIME_SHA`. No cloning current main or installing dependencies. Installation, owner/parent hardening and dependency provisioning belong to server-hardening.
- Entry exports `runPublicationOperator({ argv, env, cwd })`, validates protected context before loading installed dependencies/fixed modules, then binds real rollback coordinator to existing state store, retained transport, fixed rollback adapters and real three-group checks. Actor, site origin and connection come from protected config; original deploy/payment roles come from indexed publication. No current CMS/snapshot/main/old Actions query or old release script execution.
- Existing builtin-only `createWorkerAudit({ operation })` understands rollback: code `rolled-back`, `releaseId` equal to selected target, original indexed commit (not runtime SHA), fresh `rollbackChecks` count, original stored CI count. Success requires valid identity/digest/operation ID, positive revision and positive fresh local/original CI counts. Original valid records need not have observedEntry/highWaterMark.
- Launcher extends typed FD3 schema for `releaseId`, `rolled-back`, `rollback-failed` while preserving typed `checks-failed`/`active-unindexed`. Only the fixed installed worker selects the original index record; no second index reader in launcher. Failure before selection may omit commit. Raw stdout/stderr/free error text are not audit data.
- Refusal codes tested: `invalid-arguments`, `untrusted-runtime`, `invalid-worker-audit`, existing `hosted-publication-forbidden`.

## Commands and results

From worktree root:

```sh
node --test scripts/tests/publication-launcher-rollback.test.mjs
```

19 executed: **2 pass, 17 fail**. Broker/native installed-worker positive control and hosted-CI denial pass. Missing rollback dispatch yields `untrusted-ref`; audit tests require a worker marker before accepting refusal, preventing earlier failures from masquerading as schema checks.

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-operator-rollback.test.ts --reporter=json --outputFile=tests/evidence/manual-publication-operator-rollback-red.json
```

19 executed: **1 pass, 18 fail**. Positive control runs real rollback coordinator and retained-check runner over external-effect fixtures, reaching switch and durable index append. Seventeen cases fail at the explicit missing-operator assertion outside rejection assertions. Audit case fails because current code emits `published`, omits releaseId and counts original publication checks instead of fresh rollback checks.

Artifacts: `scripts/tests/publication-launcher-rollback-red.log`, `web/tests/evidence/manual-publication-operator-rollback-red.json` and corresponding `.log`.

Additional checks: focused web ESLint and focused TypeScript typecheck pass. No GitHub operation, remote host, CMS or payment API contacted.

## Boundaries

Native launcher tests execute a copied installed launcher, local broker and native fake fixed worker. Binding tests import the exported operator through Vitest with protected temporary runtime context, mocking only external state/transport/check-adapter modules; coordinator, authorizer, check aggregation, gate and served-pair verification remain real. These are complementary tests, not a fully provisioned production installation. Recovery/accept-state and installer work are outside this delivery.
