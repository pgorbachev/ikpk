## Why

The production CMS currently has a one-time initial-install path and a separate reusable static-only path. Neither can safely deliver a later CMS release: the static path intentionally leaves CMS and its database untouched, while the initial operation ID is consumed. A repeatable path is needed to publish a tested CMS and site release without replacing production content with the staging database.

## What Changes

- Add a repeatable production profile to the existing paired CMS/site operator, with production-bound configuration, journal, and backup location.
- Admit only an explicitly requested exact current `main` revision represented by a stable published GitHub Release, with successful required CI and `release-preflight`; build the CMS and site from that same revision.
- Preserve production SQLite, uploads, users, roles, and grants; capture and verify a production-only off-host backup before database mutation.
- Apply the existing canonical content provenance journal and HWM checks to the captured production snapshot; missing/stale provenance or unconfirmed restore regression blocks publication.
- Keep writers fenced until CMS and production-mode static candidate checks pass; support safe pre-backup recovery when no mutation began and verified-backup recovery after mutation.
- Keep the target and CMS/data effects of the one-time `initial-prod` and reusable `production-static` profiles unchanged; the static-only path joins shared-lock serialization and fails closed until installed CMS compatibility is verified. Do not copy CMS data or media from staging194.

## Capabilities

### New Capabilities

- `repeatable-production-cms-deploy`: Repeatable paired CMS/site releases with a reusable production deployment while preserving production-owned content and recovery. The existing staging source admission is reconciled in `manual-publication-only`.

### Modified Capabilities

- `cms-content-source`: Bind a paired recovery restore event to its durable operation so retry cannot mistake another same-fingerprint restore for its own.

The intersecting staging source-admission change is coordinated in `manual-publication-only`.

## Impact

The existing operator client/host helper and their tests/configuration are extended; no new deployment service, dependency, or framework is introduced. The production database, media, CMS service, and static site are affected only when an operator explicitly runs the new profile after acceptance. The current release and production state are not changed by this proposal.
