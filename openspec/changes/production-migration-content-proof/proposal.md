## Why

The approved `repeatable-production-cms-deploy` change requires the production candidate content fingerprint to equal the verified pre-migration backup fingerprint. A reviewed migration that intentionally changes public content can therefore be refused even when its changes are correct. The price 0→NULL effect was measured on a disposable backup copy; a fresh production baseline remains unmeasured.

## What Changes

- Preserve exact backup-to-candidate fingerprint equality for unchanged content under identical semantics; require version-bound semantic comparison if semantics differ.
- For a reviewed content-changing migration, independently audit the complete before/after difference between the verified backup and exact candidate against the approved migration composition and compare their public projections; no second migration replay is required.
- Preserve the original backup identity and restore checks, fail closed on missing or mismatched evidence, and retain all existing publication and recovery guards.
- Reconcile both overlapping requirements in `repeatable-production-cms-deploy` before either change is archived or merged; this proposal does not authorize implementation or production deployment.

## Capabilities

### New Capabilities

### Modified Capabilities

- `cms-content-source`: production paired backup, migration proof, and restore identity.
- `repeatable-production-cms-deploy`: production paired candidate acceptance for reviewed content transformations.

## Impact

Production paired operator, migration verification, snapshot comparison, tests and existing operation evidence. No new infrastructure, staging behavior, or post-commit rollback is introduced.
