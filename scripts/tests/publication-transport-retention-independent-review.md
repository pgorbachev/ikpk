# Independent transport and retention correctness review

Reviewed revision: `codex/manual-publication-implementation@ca183a5c81f9f40d78d8d254f228973360b2507a`.
Reviewer: independent Codex agent, strongest inherited model. Review and test execution used
an isolated worktree; no implementation changes, dependency installation, real SSH, production
access, or GitHub comments were performed.

## Confirmed finding

**P1 — Cancelled candidates can delete every usable previous rollback target.**
At the reviewed revision, `scripts/lib/publication-remote.py:669-676` counts every directory
under `releases`, then prunes by mtime while protecting only the new current release. A normal
final provenance refusal leaves its completely staged but never activated/indexed candidate
directory behind. Five such refusals followed by one successful publication delete all five
previously published releases, including the immediately preceding active release. The retained
set is the new current plus four unindexed cancelled candidates; the index still contains the
historical operations but none of their trees remain available for rollback.

This violates the existing guarantee that return to the previous release remains possible
(`openspec/specs/deploy-gating/spec.md:681-683`) and the retained, verified target requirement
(`openspec/changes/manual-publication-only/specs/deploy-gating/spec.md:398-401`). The independent
test deliberately requires only preservation of the immediately preceding active release; it
does not invent a new policy of keeping five successfully published releases or prescribe a
durable registry.

Reproduction executes the real Python remote through the existing isolated fake-SSH boundary:

```sh
node --test scripts/tests/publication-retention-independent-review.test.mjs
```

Result on the reviewed revision: **1 named RED, 0 PASS**. Failure reports
`retained published releases: ["accepted-new"]`. Full output is saved in
`publication-retention-independent-review-red.log`. The fixture first verifies that all five
refused attempts leave `current` and publication history unchanged, then that the sixth attempt
actually switches and records the new release. The failure is therefore deletion after successful
publication, not missing setup or an authorization refusal.

Possible focused remedies should use the existing transaction evidence or cancelled-candidate
lifecycle to protect the preceding valid release. No additional registry, cleanup command, or
change to the accepted retention measure is requested by this finding.

## Completed review and verification

The full `scripts/publication-transport.mjs` and `scripts/lib/publication-remote.py` were reviewed:
scoped authorization, pinned SSH invocation, locking, upload/tree identity, bounded retained
download, read-only probes, preparation and activation, redirect include isolation, reload/index
ordering, prepared and committed recovery, and retention under acknowledgement and pruning failure.
The earlier wildcard/wrapper cross-destination redirect defect is covered by passing tests on
this revision; no further confirmed transport or redirect correctness defect was found.

```sh
node --test scripts/tests/publication-transport*.test.mjs scripts/tests/publication-serving-probes.test.mjs scripts/tests/publication-redirect-transaction.test.mjs
```

Existing native checks: **133/133 PASS**, zero skipped/cancelled. This excludes launcher recovery
tests, which belong to another executor. `git diff --check` passes. The new test remains RED as
required for an independent review delivery; production code was not modified.

The separate read-only simplification pass found no warranted deletion or standard replacement
that outweighs the demonstrated authorization, crash recovery, bounds, and path-isolation needs.
This is not a new gate. Installer privileges and actual production prerequisites remain outside
this review. The previously named committing-intent/old-current manual-repair refusal is unchanged.
