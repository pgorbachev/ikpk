## Why

The agreed static-only staging194 path uses a verified immutable content snapshot when CMS inputs have not changed. The installed `static-main` helper currently creates a fresh SQLite snapshot for every frontend release, so it cannot meet that path without an operator update.

## What Changes

- Reuse the current static release's sealed database capture only after checking its committed journal proof, journal-anchored capture digests, SQLite integrity, and equality of the complete live CMS fingerprint.
- Seal a new capture for the new source SHA, verify the copied database, and record whether the capture was reused.
- When a suitable prior capture is unavailable or CMS inputs changed, create and check one fresh read-only snapshot.

## Impact

The staging194 static-only host helper and its tests change. CMS, database, uploads, permissions, production publication, and the existing CI/browser/pointer admission remain unchanged. The helper must be reviewed and installed before the new path is used.
