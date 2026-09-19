# Independent transport review: operation binding

Reviewed full revision: `feat/manual-publication-transport@f5d0d434d6d651cdbee3e1dcc2c0fd79153924c4`.

Baseline command (repository root):

```sh
node --test --test-reporter=tap scripts/tests/publication-transport-authorization.test.mjs scripts/tests/publication-transport.test.mjs scripts/tests/publication-transport-harness.test.mjs
```

Baseline: **41 passed, 0 failed**, exit 0.

Independent probes:

```sh
node --test --test-reporter=tap scripts/tests/publication-transport-review.test.mjs
```

Result: **3 passed, 3 failed**, exit 1. Full output: `publication-transport-review-red.log`.

## Confirmed P1: operation identity is lost after authorization

`publication-transport.mjs` sends only publicationId for activate, finish and cancel-recovery. `publication-remote.py:258` reads the sidecar against the in-memory preparation but does not compare pending; `:297` finishes by publicationId/current release alone; `:293` cancels whichever current pending/sidecar pair has that ID. The independent probes replace pending.commit after prepare, pending.snapshotId during the index callback, and both pending/sidecar snapshotId after recovery authorization. All three operations return success and clear pending instead of preserving the blocking evidence. A replaced identity has never been authorized or recorded.

The test's file changes model an out-of-band modification at each externally controlled callback boundary; no production code is changed. A full operation must remain bound across every later effect, even when publicationId and releaseId happen to match. The index callback itself receives a copy; the defect is acceptance of changed durable metadata after that callback.

Three positive/negative controls pass: committing+old-current refuses without deleting evidence; full sidecar mismatch (same publicationId, different actor) refuses before indexing; completed committing+new-current recovers the original complete operation. The prepared cancellation probe preserves the authoritative sidecar as raw JSON, avoiding precision loss in Python ctimeNs through a JavaScript number round trip.

## Limits and simplification pass

No P0 found. The acknowledged committing+old-current repair procedure remains operationally incomplete; a fail-closed probe is not delivery of that repair. Real SSH authentication and the fixed production worker policy are not established by these local fake-SSH runs.

No substantial unnecessary mechanism warrants removal: a single SSH session, host flock and durable phases serve distinct crash/serialization requirements. Minor cleanup candidate: `PublicationSession.previous_current` is used only while preparing the immediate sidecar write and can be a local variable. Do not replace the sidecar protocol merely to save lines; legacy pending compatibility and prepared recovery explain it.
