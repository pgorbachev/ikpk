# Dependabot policy status implementation

Approved change: dependabot-policy-status. Base origin/main: 7afc15c01485524c9eb9dd4bb3dcd5b95f387473.

Implementation: coordinator GPT-6; independent test session GPT-5.5 because the local CLI rejected GPT-6 as requiring a newer client. Independent code reviewers are separate GPT-6 executors. No production workflow or PR check has been manually rewritten during local verification.

## Behavior

Fresh authenticated non-Dependabot PRs exit before metadata, file, signature, registry and evidence API calls, with skipped checks and no marker action. Valid manual Dependabot classes produce neutral eligibility with independently positive provenance. Invalid provenance and mandatory assessment errors remain failure. Jobs' successful execution does not authorize merge: explicit positive eligibility, provenance, gate and origin flags are required as well as the enable decision. Payments manifests are recognized for manual classification, without widening the allow table.

## Verification

- Original baseline: 143 Dependabot tests passed.
- Independent RED: see dependabot-policy-status-tests.md, including exact test-only revision and commands. Corrected run: 33 failed / 84 passed.
- Final relevant suite: `cd web && npx vitest run tests/dependabot-auto-merge tests/dependabot-grouping`: 174 tests passed, 11 files.
- `npm run lint`, `npm run typecheck` (0 errors, 0 warnings; existing hints), `npm run build`, `npm run audit:prod` (0 vulnerabilities) passed in web.
- `./bin/openspec validate dependabot-policy-status --strict`, `./bin/check-openspec-integration`, `./bin/check-spec-refs` passed.
- MODIFIED applicability was verified by actual archive application in a disposable worktree during spec preparation; the working change remains active until rollout acceptance.

Mutation commands use `cd web && npx vitest run <test-file> -t <pattern>`. Each mutation was reverted before the final green run:

| Mutation | Test and pattern | Result |
|---|---|---|
| Remove eligibility conclusion guard from enable job | dependabot-auto-merge-policy-status.test.ts, authorizes only | 4 failed |
| Remove provenance conclusion guard from enable job | dependabot-auto-merge-policy-status.test.ts, authorizes only | 4 failed |
| Publisher reports success instead of explicit neutral | dependabot-auto-merge-policy-status.test.ts, publishes the explicit | 1 failed |
| Bypass human early exit | dependabot-auto-merge-policy-status.test.ts, skips a fresh human | 1 failed |
| Missing metadata classified as manual instead of error | dependabot-auto-merge-classification.test.ts, metadata is unavailable | 1 failed |
| Evidence accepts mismatched immutable producer SHA and external id | dependabot-auto-merge-policy-status.test.ts, old producer evidence | 1 failed |

The enable matrix includes a positive control and varies eligibility and provenance independently with all other permission flags true, so rejection cannot pass merely because another input was absent.

## Read-only live assessment

The new local policy queried the real current PR #216 on head 0710e4d0e155a6859c09c2681c92a354fd330916: classification not-applicable, gate skipped, enable=false, disable=false. This proves the fresh API assessment only; published live checks still require deploying the reviewed dispatcher pin.

## Rollout remaining

Publish the reviewed engine commit with a durable immutable reference and switch the dispatcher pin via PR. After merge, inspect actual check conclusions on new human PR events and genuinely new Dependabot heads; old engine evidence is intentionally rejected. Existing checks on old heads are not rewritten. Native marker race risk remains as documented in the approved spec. Related PR #198 implements a conflicting negative-verdict policy and must be reconciled before any later merge.

## Independent reviews

Both independent GPT-6 correctness/completeness reviewers reported no actionable findings for ba82534af0e41d06debcb9ee8ca1f3ae9bb9497b against origin/main ae66800a9fb2c55b5550794b2ec3028d03b2cf4d. They independently confirmed the pinned e93daae650dd40b7d26232af6925239e2a96cf55 workflow and scripts match the reviewed head. Remote availability of that engine has since been checked through GitHub API.

The newly required ponytail-review pass found a duplicate configurable forbidden-call guard in the test API fixture. Accepted: removed the guard and its sole configuration, retaining the actual call-log assertion. Its normal 22-test control passed; bypassing the human early exit still failed specifically on the recorded extra API calls. No findings were rejected. Runtime code is unchanged by this simplification.

After syncing the newly merged AGENTS.md-only change from main before review, exact-pin regression tests, specification references and strict change validation passed again. MODIFIED applicability was rechecked by actual archive application in another disposable worktree; all 10 resulting main specs validated strictly.
