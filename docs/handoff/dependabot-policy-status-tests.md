# dependabot-policy-status Test Evidence

Test commit: `48d9cfbb003b79815d1b9d6ba229c9f1ccf5fb85`

Correction working tree after this report: internal `StoredResult` provenance is `positive`/`negative`/`skipped`; external check-run/CLI conclusions remain `success`/`failure`/`neutral`/`skipped`. The correction could not be committed in this sandbox because git index writes target `/Users/pgorbachev/projects/private/ikpk/.git/worktrees/ikpk-dependabot-status-tests/index.lock`, which is outside the writable roots for this turn.

Base approved spec commit present in this worktree: `8f5ef0a48ceecdb91eb2a022cc98ec2ba6213f0c`

Command run from `web/`:

```bash
npx vitest run tests/dependabot-auto-merge-classification.test.ts tests/dependabot-auto-merge-provenance.test.ts tests/dependabot-auto-merge-policy-status.test.ts tests/dependabot-auto-merge-target-producer.test.ts tests/dependabot-auto-merge-security-regressions.test.ts tests/dependabot-auto-merge-topology-cli.test.ts tests/dependabot-auto-merge-workflow-run-producer.test.ts
```

Original result on `48d9cfbb003b79815d1b9d6ba229c9f1ccf5fb85`: RED, exit code `1`.

Summary:

```text
Test Files  3 failed | 4 passed (7)
Tests       30 failed | 84 passed (114)
```

Fresh corrected working-tree RED after resolving internal/external conclusion inconsistency: RED, exit code `1`.

```text
Test Files  3 failed | 4 passed (7)
Tests       33 failed | 84 passed (117)
```

Expected RED groups:

- `dependabot-auto-merge-classification.test.ts`: 14 failures because classification still returns only `eligible: false`, without `status: manual-review` versus `status: error` and `conclusion: failure`.
- `dependabot-auto-merge-provenance.test.ts`: 9 failures because `evaluateHead` still returns boolean gate results without explicit external gate conclusions and still treats human PRs as failed instead of `skipped`; bot provenance evidence remains the internal `positive`/`negative` representation.
- `dependabot-auto-merge-policy-status.test.ts`: 10 failures because the CLI still calls signature GraphQL on a human PR, does not emit `eligibility-conclusion`/`provenance-conclusion`, the eligibility shell still fails normal `neutral`/`skipped` paths, the enable job condition still allows successful jobs with explicit nonpositive conclusions, and publisher shell derives `success`/`failure` from job results instead of publishing explicit `neutral`/`skipped`.

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
| Neutral/skipped cannot authorize merge or positive provenance | CLI manual/skipped enable assertions; direct executed `enable-auto-merge` job-condition test with successful upstream jobs and nonpositive explicit conclusions; `isTrustedPositiveEvidence` neutral/skipped/failure test |
| Trusted immutable pin and old/new producer evidence transition | Existing immutable pin tests; new old/new `reusablePolicySha` evidence transition test |
| PR/SHA/run/attempt substitution | Existing `dependabot-auto-merge-target-producer.test.ts`, `dependabot-auto-merge-security-regressions.test.ts`, `dependabot-auto-merge-topology-cli.test.ts`, and `dependabot-auto-merge-workflow-run-producer.test.ts` |
| Publisher and workflow conclusions | New workflow-shell tests execute real `eligibility-gate` and `publish-checks` snippets from `.github/workflows/dependabot-auto-merge-policy.yml` |
| Branch protection non-change | Updated `repository-policy-plan.json` fixture and security-regression assertions: no Dependabot policy status is required by branch protection |

Post-GREEN mutation checks still required:

- Temporarily allow `neutral` or `skipped` to drive `enable-auto-merge` and verify the forbidden-action test fails, then revert.
- Temporarily let publisher derive conclusions from job result instead of explicit status and verify the publisher shell test fails, then revert.
- Temporarily accept stale producer SHA evidence across a pin change and verify the old/new transition test fails, then revert.

Material ambiguity found: none. I interpreted normal `neutral` and `skipped` as successful workflow/job execution with non-success check conclusions, while mandatory data/provenance errors remain red.

Correction integration: the independent author completed the test-only correction; its CLI resume could not stage outside its sandbox. The coordinator committed the delivered tests without implementation edits as b64838da1b34ef343e3049806a072940e9879fef and reran RED on that exact commit. Command from repository root: `npx --prefix web vitest run --root web tests/dependabot-auto-merge-classification.test.ts tests/dependabot-auto-merge-provenance.test.ts tests/dependabot-auto-merge-policy-status.test.ts tests/dependabot-auto-merge-target-producer.test.ts tests/dependabot-auto-merge-security-regressions.test.ts tests/dependabot-auto-merge-topology-cli.test.ts tests/dependabot-auto-merge-workflow-run-producer.test.ts`. Result: exit 1, 33 failed and 84 passed, 3 failed files and 4 passed files.
