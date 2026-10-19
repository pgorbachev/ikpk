## Why

Staging194 rehearsal (`194.226.99.10`) must pair CMS code, SQLite/media state, and static output from one admitted source and keep writers fenced until both sides are accepted. The already-approved first production operation extends the same engine with one fixed `initial-prod` profile for exact current `main`; it does not establish a reusable production publication path. Production paths and units come from read-only host inventory, and production uses its own state and off-host backup namespace.

## What Changes

- Remove automatic calendar/content publication. Successful CI is evidence, not a deployment trigger; only an explicit local operator command may publish.
- Require exact source SHA and canonical push `Tests` run, with every mandatory job successful and none skipped or cancelled. CI receives no host credentials.
- Build separate CMS and static payloads from the same SHA; record separate digests and check the same candidate bytes before and after activation.
- Coordinate CMS update and static publication under one durable fence and operation ID. Verify actual DB/media backup bytes off-host before mutation; commit only after CMS and served static acceptance.
- Keep the ordinary production publisher and provenance/high-water-mark gates unchanged. The one fixed initial-prod operation uses a truthful, separate production `server-db` proof, a single protected operation ID, exact current `main` SHA and its canonical `Tests` run; it cannot create another production operation after commit.
- Build the initial production candidate with the accepted production origin and payment runtime. Run browser checks against the same frozen candidate with network side effects disabled; verify the served `/release.json`, required routes, and images before commit.
- Commit the operation and release evidence before reopening writers. This exception supplies no recovery acceptance: failures remain fenced for separate owner-directed handling, and recovery of unknown or pre-journal state requires distinct explicit owner confirmation.

## Capabilities

### Modified

- `deploy-gating`: make publication operator initiated, remove calendar/content automatic publication, retain exact CI admission and explicit rollback proof.
- `cms-content-source`: add only the staging194 sealed-capture exception and coordinated fence/recovery contract.

## Scope

This prepares the existing three staging194 acceptance scenarios and one single-use initial production operation. It does not add recovery acceptance, CMS editor workflows, or reusable production publication, and it does not create a GitHub Release or archive tag.
