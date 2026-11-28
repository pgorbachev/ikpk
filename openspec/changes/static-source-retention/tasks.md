## 1. Specification

- [x] 1.1 Owner approves proposal, design and spec (delegated by the owner on 2026-11-28; independent spec review incorporated).

## 2. Tests (separate session, red first)

- [x] 2.1 Production: terminal operations' sources removed including the just-committed one; unfinished operation → refusal, nothing removed; unknown entry kept and listed in `retainedUnknownStaticSources`; rolled-back/expired terminal; corrupt or unsafe journal → no removal, `cleanupPending`; symlink and mount not followed; idempotent.
- [x] 2.1a Committed retry: repeating `static-main` for a committed operation whose source is gone reports committed (red now).
- [x] 2.2 Staging194: exactly the capture referent of the latest eligible operation is kept on post-commit (paired and static) and timer cleanup; reuse of it still verifies; other static sources and CMS releases cleaned as before; referent already absent → nothing extra protected. (The journal predicate shared with reuse keeps its existing test; an actual reuse of the kept tree needs CMS-owned sealed trees and is verified in 4.2.)
- [x] 2.3 Negative checks recorded for each new guard (relevant test class before → after; tree restored and verified each time):
  - drop `result.update(_cleanup_static_sources(...))` in `_cleanup_after_commit` → `ReleaseCleanupTests` 0 → 5;
  - protect the latest operation's own tree instead of its `reusedCapture` referent → `Staging194CaptureRetentionTests` 0 → 2;
  - drop `_latest_capture_referent` from the protected set → 0 → 5;
  - remove unknown entries as well → `ReleaseCleanupTests` 0 → 2;
  - drop the committed short-circuit in `_static_main_prepare` → `test_static_main_committed_retry_reports_committed_after_source_removed` 0 → 1;
  - client: without the `committed` branch, `test_static_main_retry_of_committed_operation_succeeds_without_export` fails with a Refusal;
  - unfinished operation: refused twice, by journal history validation and by the explicit check. Dropping either one alone keeps `test_static_source_step_refuses_on_unfinished_operation` green; dropping both turns it red (0 → 1).

## 3. Implementation

- [x] 3.1 Production static-source retention on the post-commit path of the static profile.
- [x] 3.1a Committed short-circuit in `_static_main_prepare`.
- [x] 3.2 Staging194 protection of the capture referent in CMS release cleanup.
- [x] 3.3 `docs/deploy-vps.md`: what the static source root holds per profile and when it is cleaned.

## 4. Verification and release

- [ ] 4.1 Local gates, two independent code reviews and the simplification review.
- [ ] 4.2 Install the helper on staging194, run a static publication with reuse of the latest capture, confirm retention.
- [ ] 4.3 Install on production, run a static publication, confirm only unfinished sources remain and the site, CMS and refresh work.
