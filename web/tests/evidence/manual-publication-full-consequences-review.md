# Independent complete publication review: failure consequences

Reviewed `codex/manual-publication-implementation@4a60049865e6506376b3fd40a8f7e792520c77e0`
against `origin/main@062044082bb17188e8cb683f6c750959f253a2d9`.
This is an independent full-subject review, not a recheck limited to preceding fixes.
No production or external SSH changes were made. All executing checks used the separate
`codex/publication-consequences-review` worktree.

## P1: cancelled and abandoned uploads consume promised rollback depth

At the reviewed revision, `scripts/lib/publication-remote.py:673` protects only the active
release and its immediately preceding current target. Lines 681–682 then select deletions
from every other directory by mtime, counting unpublished uploads as retained releases.
Five cancelled candidates followed by one accepted publication leave only the new and
immediately preceding published releases; the second, third and fourth preceding published
releases have disappeared even though no corresponding replacement publications occurred.

This violates the existing `openspec/specs/deploy-gating/spec.md:660` and `:673` contract:
five retained releases means active plus four previous releases. The unchanged requirement
also names the fourth preceding release explicitly. The earlier narrow independent test
asserts only the immediately preceding target and therefore stays green with this failure.

Independent regression: `scripts/tests/publication-retention-depth-review.test.mjs`.
It uses the actual JS transport and Python remote session over fixture SSH, five initially
published release directories, a real current symlink, then five actual uploads and finally
an accepted indexed activation. It asserts current and index history throughout, before
asserting all four previous published release slots. Both cases fail:

- final-check cancellation after prepare;
- successful stage whose connection ends before prepare.

Command: `node --test scripts/tests/publication-retention-depth-review.test.mjs`.
Result before implementation: **0 PASS / 2 FAIL**. In both cases actual retained published
IDs are `accepted-new, published-5`; expected is
`accepted-new, published-2, published-3, published-4, published-5`.
Raw output is `scripts/tests/publication-retention-depth-review-red.log`.

Removing a new candidate during cancel alone cannot fix this: stage renames its directory
before any pending operation exists (`publication-remote.py:546`), and the connection can
end there. Prepare can also refuse before writing pending, e.g. on redirect binding failure.
Use the already existing publication index to distinguish published releases while holding
the destination lock, after index acknowledgement; no second durable registry is required.
Implementation belongs to root, not this review delivery.

The old nginx asset-fallback limitation predates this diff and is not presented as a new
finding. This finding concerns deletion of promised rollback directories itself.

## Full review coverage and validation

Inspected approved delta requirements and the entire executable publication chain:
external launcher/source validation and credential delivery; native worker/operator context;
strict main CI workflow/jobs/report provenance; capture and immutable snapshot/tree checks;
fixed five-group and retained three-group adapters, destination/payment/browser assertions;
append-only Git state, retries and acceptance; authorization lifetimes; remote upload,
prepare, final source checks, switch/reload, pending recovery and index acknowledgement;
retained transfer and pruning; check-only CLI path isolation; hosted/local inventory,
workflow migration, rollout dependencies and runbook.

No other new P0/P1/P2 correctness finding was confirmed in this pass.
Known `scripts/restore-server-state.sh` bypass remains a merge blocker and is not accepted
as an exception. Missing real installation/deploy-user/CMS writer prerequisites and known
43 legacy content links still prevent operational acceptance.

*Postscript 2026-09-19:* the restore bypass named above was resolved by the owner's decision
(restore stages into `restored/`, never switches serving); the P1 retention depth loss is fixed
by candidate markers. See `manual-publication-entrypoints-implementation.md`, section
«Contract conflict resolved». The prerequisites and the 43 legacy links remain open.

Independent native command:

```sh
node --test scripts/tests/publication-transport*.test.mjs scripts/tests/publication-retention-independent-review.test.mjs scripts/tests/publication-redirect-transaction.test.mjs scripts/tests/publication-launcher-recovery.test.mjs scripts/tests/publication-launcher-rollback.test.mjs
```

Result: **155 PASS / 0 FAIL**, before adding the two new depth regressions.

Independent web command from `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-{core,ci-reader,local-checks,runner,runner-review,rollback,rollback-checks,operator-rollback,operator-recovery,recovery-audit,worker,check-command,workflows,entrypoints}.test.ts tests/publication-state-store.test.ts --reporter=json --outputFile=/tmp/ikpk-consequences-web.json
```

Result: **336 PASS / 1 FAIL / 0 skipped**, 15 files. The sole failure is the already known
actual-repository entrypoint inventory detecting `restore-server-state.sh: current-write`.
It is not a new failure or an approved skip. Independent logs are
`/tmp/ikpk-consequences-native.log`, `/tmp/ikpk-consequences-web.log` and the JSON path above.

## Separate simplification pass

One nonblocking removal recommendation, already identified by the earlier core review:
remove unused `now` and `retentionDays` inputs from `chooseManualPublication`
(`web/scripts/lib/publish-gate.ts:140`), and remove `reasonHeadNotPublished` alias
(`:145`, `:157`, `:173`) once migrated tests use the actual `reason` contract.
The two production coordinators pass dummy `retentionDays: 0`; these values have no role in
any decision. Keeping the obsolete knobs suggests an age policy that no longer exists.
No additional abstraction or new durable registry is recommended.

This report is not merge readiness: the new P1 and the known restore bypass must be resolved,
and any changed revision requires proportionate independent recheck.
