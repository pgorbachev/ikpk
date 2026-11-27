## Why

Paired CMS releases leave build workspaces behind after site and CMS release cleanup. These accumulate on production, while the current and rollback workspaces and their dependencies remain necessary for refresh and recovery.

## What Changes

- Adopt the paired production workspace lifecycle on staging194, using staging-specific roots, settings and admission; support safe recovery to the legacy staging workspace during transition.
- Extend existing post-release and timer-driven `cleanup-site` to inventory and safely reclaim verified, unused direct-child paired CMS build workspaces in each explicitly configured environment.
- Retain workspaces referenced by running and next-start CMS, rollback, or unfinished operations, and fail closed on missing or ambiguous evidence. Log decisions and provide a current non-destructive production preview before first application.
- Verify locking, systemd sandbox permissions, dependency survival, repeated cleanup and end-to-end refresh, restart, and pre-commit recovery followed by refresh on a test environment.

## Capabilities

### New Capabilities

- `cms-workspace-cleanup`: safe lifecycle and auditable reclamation of paired CMS build workspaces.

### Modified Capabilities

None.

## Impact

Host cleanup and installer/systemd service, paired operation journal and CMS service environment, test environment release and recovery procedures. The fixed production build-workspace root and a separately fixed staging194 paired workspace root are the only new deletion scopes; static-main, databases, uploads, backups and dependency generations are excluded.
