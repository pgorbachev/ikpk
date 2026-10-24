## Context

The static-main operation already journals a complete CMS fingerprint, seals source-specific captures, and checks CMS inputs again at commit. The current static release points to a prior committed operation, whose source tree retains its capture.

## Decision

Resolve only the current static release's operation. Require its committed journal and exact release tree digest; compare its start fingerprint with the current one. Anchor the new capture manifest and database digests in the root-owned prepared journal. On reuse, require those anchors and verify the retained capture's manifest, database/media-manifest digests, and SQLite integrity. Pass its database file to the existing source-specific capture builder, then compare the resulting copy against the verified old digest. If any reuse condition fails, including missing anchors on older releases, use the existing live read-only snapshot path. Record `captureSource` and `reusedCaptureOperationId` in the start journal row. Keep existing CI, browser acceptance, CMS fingerprint, and pointer compare-and-swap checks.

## Verification

Unit tests cover matching reuse, changed fingerprint, and tampered capture; existing static-main tests cover fallback and no early pointer switch. Install the reviewed helper revision on 194 before publication and inspect its durable journal and current pointer after publication.
