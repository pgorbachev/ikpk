# Dependabot policy status rollout

## Reviewed implementation

Implementation PR: https://github.com/pgorbachev/ikpk/pull/218
Reviewed head: c3e303baee07ba9b701baee54d24b35fdedbc2c5.
Base at review: b8117c0d3cc39ba50e09223f9cc4fc49bdb2353d.
Two independent GPT-6 code reviewers confirmed no actionable findings on that exact final head. The separate ponytail-review finding was accepted and verified before their final confirmation.

Dispatcher engine: e93daae650dd40b7d26232af6925239e2a96cf55.
Durable published tag: dependabot-auto-merge-policy-v7-pin.
Both reviewers verified the pinned reusable workflow and scripts match the reviewed implementation. GitHub commit API confirmed the engine is remotely accessible.

## Deployment

PR #218 merged at 2026-09-05T06:24:57Z as f4496cd6b2ccffeb7d2eca023d5293868664ed20. All required CI checks were green before merge. The live main dispatcher blob from GitHub contents API matches the locally verified blob a763799046ae6f858ff801b7accc47a5d300685c.

## Acceptance status

Local matrix and mutation checks passed (see dependabot-policy-status-implementation.md). Live human opened/synchronize and valid manual-bot evidence is recorded below. Historical results on old heads are left intact. A new event is required for new published conclusions.

Dependabot rebase commands require explicit owner permission under AGENTS.md. Requested permission covers PR #212 (manual payments major) and #214 (eligible scripts minor/patch). No bot commands have been sent as of this report preparation.

## Existing Dependabot heads before deployment

These heads were observed on 2026-09-05. New-engine consumers intentionally reject old-engine evidence. Marker state is observational and does not imply a fresh permission from the new engine.

| PR | Head | Native auto-merge before deployment |
| --- | --- | --- |
| 214 | b6e768f65b6f7b89b24eabc6b3a36868661d0cae | enabled |
| 213 | 4a9592230779e2c9bcf561d278ab0ac888ecefd1 | enabled |
| 212 | abc057d7f2cccc6df1df8a46ea44fe0dc6f7b7fc | absent |
| 211 | e09273fd3926ff5347d4489a0230cc42adda7888 | enabled |
| 210 | d565846621a3ae8b12c4ce80c111d4ecfbc0a6a7 | absent |
| 209 | 3fb61a39561551a896333e988a464346b4a27c72 | absent |
| 179 | 43afd7e506b0b1de07bf5a23fb8b55b048b23fbf | absent |
| 144 | 1b28026215449d36c212f122e1214624e6659ee6 | absent |
| 143 | 703bdd9a5cf9a3922359438fcd763a3ddeab6154 | absent |
| 141 | 41a63e4e3965feac3caff7d92b35b342657de8f4 | absent |
| 130 | c405131247d760dc5b662ce3e62f10436ebc1181 | absent |
| 122 | 9ea06bec03cb03ebe2c9f0884624c5378e95e71d | absent |
| 121 | f9d78aa58c5fc07320f8431738e56c9655995136 | absent |

The accepted native auto-merge race remains; eligibility/provenance are not required branch checks. This rollout does not promise to intercept every manually enabled or stale marker. PR #198 contains a conflicting older policy proposal and must be reconciled before any subsequent merge.

## Final synchronization

Main advanced during CI with PR #204, containing process documentation and the published change-flow journal. The implementation was rebased before renewed review. Journal conflict resolution retained main exactly and appended only this change activation; runtime, tests and dependency-policy specs remained unchanged. Both independent reviewers confirmed the new exact head. All 174 relevant tests, OpenSpec integration, reference checks and strict validation passed again. Actual trial archive in a disposable worktree applied both MODIFIED requirements; all 10 resulting main specs validated. The actual change remains active for rollout acceptance.

## Live human opened acceptance

PR: https://github.com/pgorbachev/ikpk/pull/220
Head: fd18fbcf484f82456b15bec7d477ab14ffa6d789.
Trusted source: https://github.com/pgorbachev/ikpk/actions/runs/33949806533 (attempt 1).
Policy execution: https://github.com/pgorbachev/ikpk/actions/runs/33949815965 (success).

- Eligibility: skipped, https://github.com/pgorbachev/ikpk/runs/101262416090.
- Provenance: skipped, https://github.com/pgorbachev/ikpk/runs/101262417875.
- Both check summaries identify head fd18fbcf484f82456b15bec7d477ab14ffa6d789 and engine e93daae650dd40b7d26232af6925239e2a96cf55, explaining that this is not a Dependabot PR.
- Both native-marker mutation jobs (enable and disable) are skipped. Assessment and publisher jobs completed successfully.

The report update introduced a normal synchronize event on the same human PR; its results and additional bot events are recorded below. No historical checks have been rewritten.

## Live synchronize and manual-bot acceptance

All executions below completed successfully using engine e93daae650dd40b7d26232af6925239e2a96cf55. Each linked check summary contains its matching full head SHA and policy SHA.

| PR and head | Policy execution | Eligibility | Provenance |
| --- | --- | --- | --- |
| #220, ac8e196cc245a89a908529ec6d801e87abe3d7a2 | https://github.com/pgorbachev/ikpk/actions/runs/33949924964 | skipped, https://github.com/pgorbachev/ikpk/runs/101263031986 | skipped, https://github.com/pgorbachev/ikpk/runs/101263033174 |
| #219, b403ced196acc7c5f70f4f08b24c6aea9f348206 | https://github.com/pgorbachev/ikpk/actions/runs/33949934087 | skipped, https://github.com/pgorbachev/ikpk/runs/101263032679 | skipped, https://github.com/pgorbachev/ikpk/runs/101263034826 |
| #209, a7f09108f493aab877c313edd4d458281eeb60a8 | https://github.com/pgorbachev/ikpk/actions/runs/33949884333 | neutral, https://github.com/pgorbachev/ikpk/runs/101263042692 | success, https://github.com/pgorbachev/ikpk/runs/101263044425 |
| #144, 6beb2033d4fc4b84214f937c87e66e2d8718917e | https://github.com/pgorbachev/ikpk/actions/runs/33949883585 | neutral, https://github.com/pgorbachev/ikpk/runs/101263028512 | success, https://github.com/pgorbachev/ikpk/runs/101263030275 |
| #143, f9dbdb20301792dddf51ac5d1398710b6071980f | https://github.com/pgorbachev/ikpk/actions/runs/33949848750 | neutral, https://github.com/pgorbachev/ikpk/runs/101263031658 | success, https://github.com/pgorbachev/ikpk/runs/101263032955 |

PR #220 source is https://github.com/pgorbachev/ikpk/actions/runs/33949912406; PR #219 source is https://github.com/pgorbachev/ikpk/actions/runs/33949926956. The three bot heads arrived without any command comment from this task and supersede their corresponding predeployment rows above. They are major GitHub Actions updates outside the allow table. For #209 both native marker mutation jobs are skipped, confirming its neutral result does not enable auto-merge.

PR #216 still has its historical failure/failure checks on 0710e4d0e155a6859c09c2681c92a354fd330916; these were observed again and left intact. Its next ordinary synchronize will invoke the new dispatcher.

## Remaining acceptance

The eligible success/success scenario still requires a genuinely new Dependabot head, for example PR #214; its existing head and marker remain as listed before deployment. The remaining old bot heads have not yet been refreshed by this task. Engine-transition/rollback regressions passed locally, but the live eligible refresh and subsequent marker-event acceptance remain outstanding. No live rollback has been performed. Change is not archived.

Owner permission for bot command comments is still pending. Manual-bot status is now independently demonstrated without comments, so PR #214 is the outstanding representative for the eligible scenario.
