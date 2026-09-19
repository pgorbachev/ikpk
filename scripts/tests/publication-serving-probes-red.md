# Serving/readiness SSH probes: independent RED delivery

Base: `codex/manual-publication-implementation@4f673b2aac1982f5ef1aafda27a3674e36c2d8af`.
Tests only; no production code, package installation, host writes, GitHub actions or deployment.
The isolated worktree was created after fetching origin, from the parent's explicitly assigned implementation HEAD.

Run with Node 24.13.0 and Python 3.9.6:

```sh
node --test scripts/tests/publication-serving-probes.test.mjs
```

Result: 15 tests, 1 passing harness control, 14 failing behavioral assertions, exit 1.
Result log (trailing whitespace removed) is `scripts/tests/publication-serving-probes-red.log`.

The approved parent handoff scoped this delivery to prerequisite read-only observations:

- `session.inspectServing()` takes no input. It returns `{ nginxDump, redirects }` read on the destination: fixed `/usr/bin/sudo -n /usr/sbin/nginx -T` without a shell, and the existing `root/shared/nginx-redirects.conf` regular file. Limits: 2 MiB dump and 1 MiB fragment. These raw values are internal evidence, never operator/audit output; selecting allowed audit fields belongs to the integration follow-up.
- `session.paymentReadiness()` takes no input. It returns `{ status, contentType, body }`, where body is parsed JSON from fixed `GET http://127.0.0.1:8787/readyz` inside the same SSH destination. Limit: 64 KiB. Non-200 is either rejected or preserved for the common gate to reject; it must never become an HTTP 200 success. No operator URL changes the target.
- `connect`, `inspect-serving`, and `payment-readiness` can be authorized with `{ commit, destinationId }` before snapshot/report creation. Each probe rechecks its own authorization. Upload and activation still require the existing full common proof. The upload test requires that the read-only session was actually entered before refusing incomplete proof.

The requirements motivating the observations are `static-serving/spec.md:765-795` (configuration evidence and drift before activation), `online-payment/spec.md:1631-1652,1782-1804` (VPS-local readiness separate from public OPTIONS), and active `server-hardening/specs/server-hardening/spec.md:148-185` (actual nginx inspection and bounded privileges). Exact return types and size limits are the parent-approved integration design, not a claim that these identifiers occur in the specs.

The new fake SSH executes the actual Python source uploaded by the real Node transport. It does not implement the JSON protocol or publication operations. Test-only Python boundary stubs substitute `subprocess.run` and urllib HTTP calls, log the exact command/URL, and reject unexpected subprocess or network activity. The passing control stages actual bytes using the production remote protocol and proves that no nginx or HTTP action occurred. The new fixture files are independent of existing transport harnesses.

For absent methods, the test-only `probe` seam returns undefined. Positive tests fail on missing evidence and negative tests fail on missing refusal, rather than a missing-method TypeError. Once production methods exist, the seam calls them directly. The two partial-proof tests already exercise existing authorization behavior and fail because connect requires the not-yet-produced complete proof.

Out of this delivery: worker/adapter wiring, production vhost artifact refusal, the serving parser and whitelist audit summary, redirect staging/application with pending transaction and rollback, and nginx test/reload recovery. These remain required integration work; this RED set does not claim publication serving parity by itself.
