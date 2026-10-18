## Why

Staging193 rehearsal must pair CMS code, SQLite/media state, and static output from one admitted source and keep writers fenced until both sides are accepted. Current candidate admission and recovery proof remain outstanding.

## What Changes

- Remove automatic calendar/content publication. Successful CI is evidence, not a deployment trigger; only an explicit local operator command may publish.
- Require exact source SHA and canonical push `Tests` run, with every mandatory job successful and none skipped or cancelled. CI receives no host credentials.
- Build separate CMS and static payloads from the same SHA; record separate digests and check the same candidate bytes before and after activation.
- Coordinate CMS update and static publication under one durable fence and operation ID. Verify actual DB/media backup bytes off-host before mutation; commit only after CMS and served static acceptance.
- Keep one trusted local production publication entrypoint; verify target serving identity before retiring the prior route. Operator browser checks use the same sealed bytes that will be served and carry no deployment credentials into CI.
- Keep the `sourceAge=untracked` publication snapshot rule strictly scoped to staging193; production provenance journal rules remain unchanged.
- Production remains a later step: curated tree equality through squash, a new exact `main` SHA and its own canonical `Tests` run, then GitHub Release after deployment. Archive tag and `dev` retirement are later work.

## Capabilities

### Modified

- `deploy-gating`: make publication operator initiated, remove calendar/content automatic publication, retain exact CI admission and explicit rollback proof.
- `cms-content-source`: add only the staging193 sealed-capture exception and coordinated fence/recovery contract.

## Scope

This prepares three staging193 acceptance scenarios: first release, explicit pre-commit recovery, and second release preserving a new editor record. It performs no production deployment or release/tag operation.
