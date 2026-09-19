# Independent installed recovery / acceptance review

Reviewed revision: `codex/manual-publication-implementation@1794d8f7b0b5ad8231e98bf159636e8d54ec678f`.
The reviewer did not implement the installed operator. Review and tests used a separate
worktree. Git writes targeted temporary fixture repositories; no real SSH host,
GitHub state, deployed release, or CMS was changed.

## P2 — recovery does not validate the pending rollback's own check report

At `web/scripts/publication-operator.ts:102-107`, recovery authorizes a pending
operation using its original publication's `localChecks`. An operation carrying
`rollbackOfPublicationId` and `rollbackChecks` still takes exactly that branch:
the rollback-specific report is never validated. The shared append boundary at
`web/scripts/lib/publication-state-store.ts:121-124` likewise checks only
`localChecks`.

Consequently a pending rollback with a report for another tree, a missing required
group, or a failed required group is accepted, appended to the real immutable Git
index, cleared from pending, and returned as `recovered`. Positive test counts in
these malformed reports also pass the native success audit schema. This violates
the rollback evidence requirement: all three fresh rollback groups must succeed
for this exact pair and destination (`manual-publication-only`, deploy-gating
specification, retained rollback checks).

This concerns invalid stored pending evidence during recovery, not the normal
rollback coordinator, which already checks `ROLLBACK_GROUPS` before switching.
Validate the pending rollback report with `localChecksProblem(..., ROLLBACK_GROUPS)`
before any recovery effect; preserve pending and the existing index on refusal.

Independent regression cases were added to
`web/tests/manual-publication-operator-recovery.test.ts`. They first append the
valid original publication to a real temporary Git state remote. A complete
pending rollback succeeds; three variants change only the pending rollback report.

```sh
cd web
node_modules/.bin/vitest run tests/manual-publication-operator-recovery.test.ts -t 'independent review'
```

Reviewed implementation: **1 passed / 3 failed / 17 deselected**. All three failures
are the intended unexpected resolution of `runPublicationOperator(['recover'])`,
not fixture setup, dependency failures, or missing modules. The returned operations
retain the malformed `rollbackChecks`. No implementation fix is included here.

## Other verification

```sh
cd web
node_modules/.bin/vitest run tests/manual-publication-operator-recovery.test.ts tests/manual-publication-recovery-audit.test.ts tests/publication-state-store.test.ts tests/manual-publication-operator-rollback.test.ts
```

Before adding the new regressions: **71 passed / 0 failed** across four files.

```sh
node --test scripts/tests/publication-launcher-recovery.test.mjs scripts/tests/publication-transport.test.mjs scripts/tests/publication-redirect-transaction.test.mjs
node --test scripts/tests/publication-transport-review.test.mjs scripts/tests/publication-transport-authorization.test.mjs
```

**72 + 16 passed / 0 failed**. Reviewed fixed installed dispatch and argument
validation before credentials; isolated runtime trust boundaries; audit fd3
whitelisting and suppression of raw credentials; destination-scoped, expiring
recovery authorization; held-lock verification before index append; prepared
cancellation, committing-old refusal and idempotent recovery; immutable Git index
and non-force conflict retry; acceptance bound to observed entry, fingerprint and
protected actor; racing CMS events invalidating stale acceptance.

No additional P0/P1/P2 findings in this bounded subject. This is not a review of
the entire manual-publication-only change or of uncommitted root work.

## Separate simplification pass

No deletion is recommended in the acceptance/recovery state machine. The duplicated
stored-publication validation in the recovery authorizer and append boundary is a
small candidate for one shared validator while fixing the finding; a new registry,
generic command framework, or additional persistent state is unnecessary. Treat
this as a non-blocking maintenance suggestion, separate from the required check.
