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

Local matrix and mutation checks passed (see dependabot-policy-status-implementation.md). Live human opened evidence is recorded below. Historical results on old heads are left intact. A new event is required for new published conclusions.

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

This report update introduces a normal synchronize event on the same human PR. Its resulting checks will be inspected separately. Live bot scenarios still await a genuine new Dependabot head; no historical checks have been rewritten.
