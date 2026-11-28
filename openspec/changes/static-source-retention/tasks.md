## 1. Specification

- [x] 1.1 Owner approves proposal, design and spec (delegated by the owner on 2026-11-28; independent spec review incorporated).

## 2. Tests (separate session, red first)

- [ ] 2.1 Production: terminal operations' sources removed including the just-committed one; unfinished operation → refusal, nothing removed; unknown entry kept and listed in `retainedUnknownStaticSources`; rolled-back/expired terminal; corrupt or unsafe journal → no removal, `cleanupPending`; symlink and mount not followed; idempotent.
- [ ] 2.1a Committed retry: repeating `static-main` for a committed operation whose source is gone reports committed (red now).
- [ ] 2.2 Staging194: exactly the capture referent of the latest eligible operation is kept on post-commit (paired and static) and timer cleanup; reuse of it still verifies; other static sources and CMS releases cleaned as before; referent already absent → nothing extra protected.
- [ ] 2.3 Negative checks recorded for each new guard.

## 3. Implementation

- [ ] 3.1 Production static-source retention on the post-commit path of the static profile.
- [ ] 3.1a Committed short-circuit in `_static_main_prepare`.
- [ ] 3.2 Staging194 protection of the capture referent in CMS release cleanup.
- [ ] 3.3 `docs/deploy-vps.md`: what the static source root holds per profile and when it is cleaned.

## 4. Verification and release

- [ ] 4.1 Local gates, two independent code reviews and the simplification review.
- [ ] 4.2 Install the helper on staging194, run a static publication with reuse of the latest capture, confirm retention.
- [ ] 4.3 Install on production, run a static publication, confirm only unfinished sources remain and the site, CMS and refresh work.
