# Checked redirect transaction: implementation evidence

Branch: `codex/redirect-transaction`.
Implementation: `08b3b5809032236ab31d1a43b1e5304eaf8fce7a`.
Supplemental mutation-sensitive assertion: `9a5bd65d1fe7d6cca28da707c47487123df58d84`.
Independent RED cherry-pick: `3a982da921826ecfba06a642da9a4a7d28a3cd1c`
(original delivery `cebaa6126df0085b4b83d7fdb71c0c1a36c1f5ed`).

The independent 22-case suite was rerun before implementation: **2 pass / 20 fail**.
The existing 83 tests were positive controls. No production host or GitHub write occurred.
The inherited strongest available Codex model implemented this bounded delivery; independent
code review is a separate parent-owned step, not claimed by this report.

## Behavior

`activate` and `rollback` accept only the optional fixed selector
`redirectsPath: 'deploy/nginx-redirects.conf'`. Its bytes belong to the verified full tree.
Without the selector the library preserves its previous behavior; worker wiring remains a
separate parent delivery and must supply it on the routine publication path.

Preparation checks the loaded nginx configuration for a destination server whose direct
root is the configured `current`, and an actual direct include of that destination's
existing `shared/nginx-redirects.conf`. Comments, other paths and another server's include
cannot establish that binding. Old/new bytes and digests, operation and previous-current
identity are durable before the shared fragment changes. Descriptor-relative replacement
refuses symlink components and unexpected bytes. Candidate validation precedes the final
provenance/main check; activation then records committing intent, switches current and
reloads nginx before indexing. A bounded fragment equality check also refuses drift
between validation and switching.

Failed validation and prepared cancellation/recovery restore recognized old bytes, keeping
both journals if restoration fails. Committing plus old current remains blocked. New-current
recovery obtains authorization before completing configuration restoration/validation/reload
and then indexing. A reload or index failure names `activeOperation` and keeps pending;
there is no automatic rollback. The only subprocess commands are fixed inspection,
validation and reload commands, with no shell, installer or vhost writes.

The test harness still executes the actual shipped Python. Its restore fault was extended
to recognize descriptor-relative `os.replace`; the fault still happens at the real filesystem
boundary. Three supplemental tests check post-validation drift, recognized-old config on
committed recovery, and manual config drift on committed recovery. The latter counts index
calls explicitly: a thrown assertion inside the callback must not masquerade as refusal.

## Verification

```sh
node --test scripts/tests/publication-redirect-transaction.test.mjs \
  scripts/tests/publication-serving-probes.test.mjs \
  scripts/tests/publication-transport.test.mjs \
  scripts/tests/publication-transport-retained.test.mjs \
  scripts/tests/publication-transport-review.test.mjs \
  scripts/tests/publication-transport-authorization.test.mjs
```

Result: **108 pass / 0 fail** (25 redirect cases + 83 historical controls).
After strengthening the supplemental assertion, its entire suite was rerun: **25 pass / 0 fail**.
`git diff --check` passed.

Negative verification used a separate disposable worktree after committing the fix:

```sh
git worktree add /Users/pgorbachev/projects/private/ikpk-redirect-mutation --detach 9a5bd65d1fe7d6cca28da707c47487123df58d84
cd /Users/pgorbachev/projects/private/ikpk-redirect-mutation
git restore --source=3a982da921826ecfba06a642da9a4a7d28a3cd1c -- scripts/publication-transport.mjs scripts/lib/publication-remote.py
node --test scripts/tests/publication-redirect-transaction.test.mjs
git restore --source=9a5bd65d1fe7d6cca28da707c47487123df58d84 -- scripts/publication-transport.mjs scripts/lib/publication-remote.py
git status --porcelain
git diff --exit-code 9a5bd65d1fe7d6cca28da707c47487123df58d84 --
```

Mutation: **25/25 green → 2 pass / 23 fail**. All 20 independent RED cases and all three
supplemental cases fail by their intended names. The existing digest-tampering and
committing-plus-old-current positive controls remain green. Restoration had an empty
status and zero diff against the fixed SHA. The temporary worktree was then removed.
An earlier complete restore rerun also returned **25 pass / 0 fail**.

## Remaining boundary

This is the existing redirect-include transaction, not production provisioning or full-vhost
migration. Full production-vhost artifact, drift/previous-config evidence, first-confirm
prerequisites, real-host permissions and actual service behavior remain operational acceptance
requirements owned by the parent change. The parser deliberately requires the direct,
fixed root/include binding; indirect or dynamic layouts require explicit preparation outside
this routine path. No new privileges, installer path or automatic health-failure rollback
were introduced.
