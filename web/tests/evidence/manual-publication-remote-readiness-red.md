# Destination-local payment readiness — independent RED

Production base: `4cdb460599c4a91aa351415a6992230be534145a`.
Test revision: `test/remote-readiness-red@e252cc56bea77476b167824002ccb53d9417bfd9`.
No production source files changed in this delivery. No build, HTTP requests,
deployment, or GitHub writes were performed. Dependencies were installed in this
test agent's own worktree. Transport implementation commits were not needed: its
fixed SSH operation already has separate transport tests; this delivery owns wiring.

Contract source: `openspec/specs/online-payment/spec.md`, requirement
«Личность контура сообщается несекретным readiness-ответом» (lines 1608–1665 on base).
The response must originate from `GET http://127.0.0.1:8787/readyz` on the destination
VPS; HTTP 200, JSON Content-Type, and exactly the three matching body fields are
required. The public payment endpoint remains independently validated.

## Reproduction

From this worktree's `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-remote-readiness-adapter.test.ts tests/manual-publication-remote-readiness-suite.test.ts tests/manual-publication-remote-readiness-worker.test.ts tests/manual-publication-adapters.test.ts --reporter=json --outputFile=tests/evidence/manual-publication-remote-readiness-red.json
```

Exit **1**: **55 tests, 26 passed, 29 failed**, zero skipped/todo.
Full machine-readable output: `manual-publication-remote-readiness-red.json`.

| Boundary | Passed | Failed | RED reason |
| --- | ---: | ---: | --- |
| Existing adapters, minimally updated readiness expectation | 22 | 1 | Still forwards a URL instead of an observed-response file |
| New adapter boundary | 1 | 6 | Requires obsolete URL, never calls trusted probe, accepts missing/failed/oversized probe |
| Actual fixed assertion subprocess | 2 | 18 | Still needs operator URL and curls locally; ignores contradictory destination response |
| Actual worker and runner binding | 1 | 4 | Active config requires URL; trusted remote callback is never bound |

The actual-suite harness copies the current assertion suite and its existing
helpers into a temporary miniature artifact; assertions are not substituted.
A fake local `curl` provides a valid but contradictory operator response. The
positive control executes and passes both named assertions. An independently
wrong endpoint fails only `active artifact declares exactly the trusted payment
endpoint and role`, while readiness passes. Every malformed destination observation
keeps endpoint valid and requires failure specifically in
`read-only readiness reports the trusted service mode and shop`; on the base that
assertion incorrectly passes. This includes HTTP 503/302, bad/missing Content-Type,
string/null/array bodies, each missing field, wrong status/mode/shop, numeric shop,
and a fourth diagnostic field containing a secret canary. The output assertion
also forbids exposing that canary in reporter JSON/stdout/stderr after implementation.

Worker tests use the real worker and real publication runner with mocks only at
their effect/module seams. Successful `ci` with production CRM reaches staging,
activation and durable recording with no payment probe. Active roles must supply
the callback to the fixed adapter, call a parameterless destination-session probe
once before staging, and authorize that probe with only `{commit,destinationId}`.
The read-only authorizer must refuse mutation actions. The probe failure case keeps
the obsolete URL present so its RED cannot be explained by config rejection.

Adapter callback contract agreed with implementer:
`paymentReadiness(): Promise<{status:number,contentType:string,body:unknown}>` as a
runtime override. Its bounded response file lives under reports, outside artifact,
and is passed as `PUBLICATION_PAYMENT_READY_RESPONSE_FILE`. Unknown obsolete
`readinessUrl` and ambient URL/file variables must not choose or replace the probe.

ESLint passed on all five changed test/fixture files. No GREEN implementation or
post-implementation mutation claim is made by this RED-only delivery.
