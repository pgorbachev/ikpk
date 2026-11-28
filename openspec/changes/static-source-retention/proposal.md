## Why

Every `static-main` publication unpacks a full source tree (~1.3 GB) into the static profile's `releaseRoot`. On production (`production-static`) nothing ever deletes these trees, so they fill the host disk within weeks and have already been removed by hand. On staging194 the same trees share a root with CMS releases and are deleted by CMS release cleanup, including the newest one, which makes sealed-capture reuse unavailable.

## What Changes

- Add a retention rule for static-main source trees, applied by the existing post-commit cleanup path of the static profile.
- Production (`production-static`): after each commit delete the sources of all terminally finished static-main operations, because nothing reads them afterwards (reuse is staging194-only); the existing refusal applies while any operation is unfinished.
- Staging194: keep exactly one source tree, the capture used by the most recent eligible operation; other static sources remain removable as today.
- A retry of an already committed static-main operation reports committed without reading the removed source.
- Classify only by the profile's operation journal; never by age or modification time; never touch unrecognized entries on production.

## Capabilities

### New Capabilities

- `static-source-retention`: bounded, journal-driven retention of static-main source trees per profile.

### Modified Capabilities

None. `cms-workspace-cleanup` excludes static-main storage from its own deletion scope; this capability is separate and does not change that one.

## Impact

`scripts/lib/rehearsal_host.py` cleanup of CMS/static release roots and its tests; `docs/deploy-vps.md`. No systemd unit, installer or timer change: cleanup runs on the existing post-commit path. On staging194, reuse of a capture older than the retained one becomes unavailable (owner decision 2026-11-28); the existing reuse refusal for a missing capture applies.
