# Independent remote readiness review

Reviewed `codex/manual-publication-implementation` at full SHA
`d5188cef083ba9c82b3074398ea8d5da3b7d0485`, including remote wiring commit
`fd7a625eeb0a223c2b29f54b452832419bd34776`. Reviewer: independent Codex GPT-6
executor, separate worktree `ikpk-publication-remote-review`. No implementation edits,
real SSH, payment requests, GitHub writes, full build, or production configuration changes.

## P1: accepted payment role does not constrain service identity

At the reviewed SHA, `web/scripts/publication-worker.ts:99` accepts either service
mode and any nonempty shop ID for either active role. The adapter passes these values
through at `web/scripts/lib/publication-check-adapters.ts:157`; the final assertion
at `web/tests/publication/payment-readiness.test.ts:19` compares the remote body only
with these configurable values. Therefore configuration and service can agree on a
wrong identity, and the gate is green. This defeats the payment-contour mix-up guard.

The contract in `openspec/specs/online-payment/spec.md:1608` specifies the exhaustive
readiness body and concrete identities; scenarios at lines 1856 and 1862 require
`stand -> test / 1440249`, `prod -> prod / 409285`. Payment role remains independent
of CRM `DEPLOY_MODE` under the manual-publication delta. Trusted configuration is
trusted input, but cannot redefine those normative identities.

Independent RED: `web/tests/manual-publication-payment-identity-review.test.ts` runs
the actual fixed assertion suite in a miniature artifact, with no replacement
assertions or HTTP effects. Each fixture gives the opposite CRM mode so role binding
cannot accidentally be replaced by CRM binding. Both canonical identities pass. Both
roles incorrectly pass when config and response agree on the other service mode, and
both incorrectly pass with shop `9999999`.

Reproduction from `web/`:

```sh
node node_modules/vitest/vitest.mjs run tests/manual-publication-payment-identity-review.test.ts --reporter=json --outputFile=tests/evidence/manual-publication-payment-identity-review-red.json
```

Result: exit 1; 6 tests, 2 pass, 4 fail. Each of the four failed outer tests records
both actual inner assertions as `passed`, exit 0. This is the defect, not a missing
fixture or unsuccessful subprocess. Raw evidence is the adjacent RED JSON report.
No GREEN is claimed because this task changes no implementation.

Fix direction: bind expected mode/shop to accepted `PAYMENT_ROLE` using the normative
mapping; reject contradictory installed configuration or remove those redundant
configuration fields. Preserve independent `DEPLOY_MODE` and the `ci` no-API branch.

## Remaining bounded pass

No other confirmed P0/P1 found in worker callback scope, fixed destination VPS
selection, protected observation file, exact body field checks, secret-free assertion
reporting, or readiness/preflight separation. The worker's callback permits only
`connect` and `payment-readiness` for its destination, expires on completion, and has
no full publication proof. The remote probe uses fixed VPS loopback GET, suppresses
proxy environment, refuses redirects, and limits the response. The public probe is
OPTIONS, and `ci` with production CRM executes neither readiness nor preflight.

Existing targeted checks: 57/57 pass in
`manual-publication-remote-readiness-{worker,adapter,suite}.test.ts` plus
`manual-publication-worker.test.ts`; result saved in
`manual-publication-remote-review-existing.json`. `node --test
scripts/tests/publication-serving-probes.test.mjs`: 16/16 pass. Existing success
fixtures use arbitrary `shop-42`, explaining why their green result did not cover the
normative identity mapping. Full build and unrelated gates were not run.

For the repair handoff, the existing real assertion-suite fixtures were migrated from
`shop-42` to the canonical shop for each role. Its 20 cases still pass before any
implementation change. The four new refusal scenarios remain RED.

## Separate simplification pass

Remove the unused `payment_readiness_matches` alternative from the `DeployCheck`
union in `web/tests/publication/helpers.ts:38`: readiness now consumes only the remote
observation file, and allowing the obsolete local HTTP helper in that suite obscures
the intended boundary. This is optional cleanup, not a correctness blocker. Do not
delete the shared shell helper as part of this small cleanup: existing legacy tests
still exercise it, so removing that implementation requires separate caller review.

Known unfinished redirect delivery, runtime CLI, retention, and production
configuration work are outside this bounded verdict. No overall change completion
or production readiness is claimed.
