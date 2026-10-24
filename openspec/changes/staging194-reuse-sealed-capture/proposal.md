## Why

Each staging194 static-only publication currently creates a fresh CMS content capture even when the already sealed content snapshot is still identical to the live CMS. This repeats slow SQLite/media work and consumes disk; a later code-only publication should be able to reuse that verified snapshot while recording its original provenance.

## What Changes

- Allow the staging194 static-only operator to select an immutable content capture from a completed or recovered terminal operation.
- Reuse only after fail-closed checks of operation state, profile, ownership, confined path, existing `captureProof.bundleDigest` and file digests, schema compatibility, and exact equality with the recorded current CMS fingerprint; no new capture registry is introduced.
- Keep the capture's original source SHA and operation ID, and bind the new build to its own exact `main` SHA, CI evidence, operation ID, browser-accepted tree digest, and rollback record.
- Preserve the existing static-only boundary, CMS fingerprint check, exact `main` and four green CI gates, desktop/mobile browser acceptance, and explicit rollback. Production and CMS migration flows do not change.

## Capabilities

### New Capabilities

### Modified Capabilities

- `cms-content-source`: permit reuse of a verified staging194 capture while distinguishing capture provenance from the current build provenance.

## Impact

`scripts/rehearsal/staging193.py`, the installed staging194 host helper and its manifest/journal checks, focused operator tests, and the `cms-content-source` OpenSpec delta. No CMS write, migration, service/config change, or production path is introduced.
