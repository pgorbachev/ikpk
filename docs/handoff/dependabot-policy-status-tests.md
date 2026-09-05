# dependabot-policy-status Test Evidence

Test commit: `48d9cfbb003b79815d1b9d6ba229c9f1ccf5fb85`

Base approved spec commit present in this worktree: `8f5ef0a48ceecdb91eb2a022cc98ec2ba6213f0c`

Command run from `web/`:

```bash
npx vitest run tests/dependabot-auto-merge-classification.test.ts tests/dependabot-auto-merge-provenance.test.ts tests/dependabot-auto-merge-policy-status.test.ts tests/dependabot-auto-merge-target-producer.test.ts tests/dependabot-auto-merge-security-regressions.test.ts tests/dependabot-auto-merge-topology-cli.test.ts tests/dependabot-auto-merge-workflow-run-producer.test.ts
```

Result on `48d9cfbb003b79815d1b9d6ba229c9f1ccf5fb85`: RED, exit code `1`.

Summary:

```text
Test Files  3 failed | 4 passed (7)
Tests       30 failed | 84 passed (114)
```

Expected RED groups:

- `dependabot-auto-merge-classification.test.ts`: 14 failures because classification still returns only `eligible: false`, without `status: manual-review` versus `status: error` and `conclusion: failure`.
- `dependabot-auto-merge-provenance.test.ts`: 9 failures because `evaluateHead` still returns boolean gate/provenance with old `positive`/`negative` vocabulary and still treats human PRs as failed instead of `skipped`.
- `dependabot-auto-merge-policy-status.test.ts`: 7 failures because the CLI still calls signature GraphQL on a human PR, does not emit `eligibility-conclusion`/`provenance-conclusion`, the eligibility shell still fails normal `neutral`/`skipped` paths, and publisher shell derives `success`/`failure` from job results instead of publishing explicit `neutral`/`skipped`.

Scenario coverage map:

| Approved scenario | Test coverage |
|---|---|
| Human `skipped/skipped`, native marker preserved, no metadata/signature/registry access | `dependabot-auto-merge-provenance.test.ts`; CLI test `skips a fresh human PR...`; mock forbids `/graphql`, `/contents/`, `/check-runs` |
| Manual Dependabot `neutral/success` and no enable | `dependabot-auto-merge-provenance.test.ts`; CLI test `returns neutral eligibility...`; workflow shell neutral test |
| Manual class with invalid provenance is failure-priority | `dependabot-auto-merge-provenance.test.ts`; CLI test `prioritizes invalid provenance...` |
| Missing/malformed metadata or required registry failure | Updated `dependabot-auto-merge-classification.test.ts` status assertions |
| Stale/malformed PR snapshot failure | CLI stale-head test; existing fresh snapshot malformed tests in `dependabot-auto-merge-review-regressions.test.ts` |
| Eligible bot positive path | Updated positive assertions in `dependabot-auto-merge-provenance.test.ts`; existing topology positive tests |
| Marker/reopened evidence not overwritten | Existing `dependabot-auto-merge-workflow-run-producer.test.ts` opened/synchronize-only test; CLI `reopened` no-record test |
| Neutral/skipped cannot authorize merge or positive provenance | CLI manual/skipped enable assertions; `isTrustedPositiveEvidence` neutral/skipped/failure test |
| Trusted immutable pin and old/new producer evidence transition | Existing immutable pin tests; new old/new `reusablePolicySha` evidence transition test |
| PR/SHA/run/attempt substitution | Existing `dependabot-auto-merge-target-producer.test.ts`, `dependabot-auto-merge-security-regressions.test.ts`, `dependabot-auto-merge-topology-cli.test.ts`, and `dependabot-auto-merge-workflow-run-producer.test.ts` |
| Publisher and workflow conclusions | New workflow-shell tests execute real `eligibility-gate` and `publish-checks` snippets from `.github/workflows/dependabot-auto-merge-policy.yml` |
| Branch protection non-change | Updated `repository-policy-plan.json` fixture and security-regression assertions: no Dependabot policy status is required by branch protection |

Post-GREEN mutation checks still required:

- Temporarily allow `neutral` or `skipped` to drive `enable-auto-merge` and verify the forbidden-action test fails, then revert.
- Temporarily let publisher derive conclusions from job result instead of explicit status and verify the publisher shell test fails, then revert.
- Temporarily accept stale producer SHA evidence across a pin change and verify the old/new transition test fails, then revert.

Material ambiguity found: none. I interpreted normal `neutral` and `skipped` as successful workflow/job execution with non-success check conclusions, while mandatory data/provenance errors remain red.
