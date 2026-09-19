# Bounded release retention implementation evidence

Implementation: `codex/publication-retention-implementation@218c51a02b054ff2dd455b5b59f31deaedfb6d17`.
Base: `1101d2ece528c5d67b10ecbe39e0f6ce37323abe`.
Worktree: `/Users/pgorbachev/projects/private/ikpk-publication-retention-implementation`.

## Behavior

Transport defaults an omitted keepReleases to five and rejects non-integer, unsafe,
null/string/boolean and below-five values before SSH. The remote finish command
receives and independently validates the limit. After durable index acknowledgement,
the same locked finish operation prunes oldest actual directories by mtime until the
configured total remains, excluding current from deletion even for an oldest rollback.
Index records are untouched. Pending is cleared only after pruning succeeds, so a
failed cleanup reports activeOperation and recovery can repeat an idempotent index
acknowledgement and retry cleanup. Recursive removal uses descriptor-relative opens,
O_NOFOLLOW and regular-member checks; no retained release code executes.

## Executed checks

- Before implementation: original independent suite **3 PASS / 8 FAIL**, exit 1.
- Original independent suite after implementation: **11/11 PASS**.
- Expanded native suite: **134/134 PASS**, exit 0, log `/tmp/ikpk-retention-native-green.log`.
  Command: `node --test $(rg --files scripts/tests -g 'publication-*.test.mjs' | rg -v 'publication-launcher-rollback.test.mjs$')`.
  Launcher rollback is excluded because that independent implementation is owned by coordinator.
- ESLint on changed transport and retention tests, Node syntax check, Python AST parse,
  `scripts/tsconfig.json` tsc --noEmit and git diff --check: PASS.
  Dependencies were read from the existing coordinator checkout; no installation.

## Negative mutations

All mutations ran in a separate detached worktree of committed implementation SHA
218c51a02b054ff2dd455b5b59f31deaedfb6d17. Every replacement below is in
`scripts/lib/publication-remote.py`; the original is restored between mutations.

1. Delete the exact line `        self.prune_releases(operation, keep)` in finish.
   Command: `node --test scripts/tests/publication-transport-retention.test.mjs`.
   GREEN **22/22** becomes **11 PASS / 11 FAIL**, exit 1. Target failures include
   configured/default total, recovery, oldest rollback, nested deletion and actual
   filesystem-failure reporting. Log: `/tmp/ikpk-retention-mutation.log`.
2. Replace `previous = sorted((mtime, name) for mtime, name in releases if name != current)`
   with `previous = sorted(((mtime, name) for mtime, name in releases if name != current), reverse=True)`.
   Command: `node --test --test-name-pattern='retention keeps 5 total releases after acknowledged activation$' scripts/tests/publication-transport-retention.test.mjs`.
   Target **1 PASS** becomes **1 FAIL**, exit 1. Log: `/tmp/ikpk-retention-order-mutation.log`.
3. Replace the same original sorted expression with `previous = sorted(releases)`.
   Command: `node --test --test-name-pattern='retention after rollback preserves the oldest active target' scripts/tests/publication-transport-retention.test.mjs`.
   Target **1 PASS** becomes **1 FAIL**, exit 1. Log: `/tmp/ikpk-retention-current-mutation.log`.

Restoration: `git restore --source=218c51a02b054ff2dd455b5b59f31deaedfb6d17 -- scripts/lib/publication-remote.py`;
`git status --porcelain` empty and `git diff --exit-code 218c51a02b054ff2dd455b5b59f31deaedfb6d17`
exit 0. Restored retention suite **22/22 PASS**, exit 0:
`/tmp/ikpk-retention-restored-green.log`. Mutation worktree removed after checks.

No real SSH, production, deployment, dependency changes, specification edits or GitHub
operations were performed. Worker config and launcher changes remain coordinator-owned.

## Independent cancellation finding and correction

Independent RED at `6dcfa3ec` (author commit
`a1e1d4a806214ef777d4207456bcb7617c6e110b`) demonstrated that cancelled candidates
could displace every previously published release. The correction protects the
immediately preceding active release recorded in durable preparation metadata, as
well as the current release; it adds no separate history registry.

Command: `node --test scripts/tests/publication-transport-retention.test.mjs scripts/tests/publication-retention-independent-review.test.mjs scripts/tests/publication-redirect-transaction.test.mjs`.
Result: **50 PASS / 0 FAIL**. The independent previously failing assertion now passes;
configured retention, old rollback targets, cancellation and redirect restoration remain green.
