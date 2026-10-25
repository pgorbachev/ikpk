## ADDED Requirements

### Requirement: Fixed rehearsal and initial-production profiles use truthful sealed captures

Only the owner-designated staging194 rehearsal (`194.226.99.10`, `https://194.226.99.10`, `deployMode=stand`, `paymentRole=ci`) may use `sourcePolicy=demo-publication-only`, profile `demo-dev`, `recordKind=publication-snapshot`, `sourceAge=untracked`, `origin=server-db`, and `sourceId=demo193-cms`. The source ID is a retained legacy machine identifier. A separate fixed `initial-prod` profile may perform exactly one owner-approved initial production operation with `sourcePolicy=initial-production`, `recordKind=initial-production-snapshot`, `origin=server-db`, and a distinct proof type bound to the production target, exact `main` SHA, fixed operation ID, run, and sealed DB/media capture. That proof SHALL NOT be accepted as the staging demo proof or by the ordinary production snapshot reader. Neither scoped capture is an edit, restore, or canonical journal event; both leave ordinary production journal and high-water-mark rules unchanged.

The staging194 and production-static main modes SHALL use a fresh read-only sealed capture of the currently installed CMS, content, SQLite, and media solely as static build input. They SHALL NOT prepare or activate a CMS candidate, fence CMS writers, migrate or write the database, or change the CMS release/symlink, service, environment, uploads, roles, or users. Their static output is bound to exact current canonical `main` and the four successful required CI workflows; production-static uses a separate config, journal, and capture proof namespace; the paired `dev` rehearsal remains unchanged.

Fix the destination and admitted full source SHA before executing candidate code. For paired `dev` rehearsal and fixed `initial-prod` operations, the operation manifest SHALL record its ID, old/new CMS code, DB, media, static and config identities, canonical ref, full SHA, exact CI run/attempt, and separate CMS/static payload digests; the CMS and static outputs SHALL derive from that one SHA. CI receives no host credentials. The first new command SHALL hold the host flock, check admission and operation availability, and refuse if a maintenance marker exists, an unfinished operation exists, or the operation ID has already been used. Journal-tail repair may occur during this check, but it does not start an operation. For paired `dev` and fixed `initial-prod` operations, before creating the operation's journal or marker, the command SHALL validate and extract the admitted source archive, install CMS and web npm dependencies, and build the CMS artifact as the configured unprivileged user while existing writers remain open. CMS build dependencies SHALL come from a complete immutable generation keyed by the source lock hash and build profile, using the existing lock-hash dependency layout; reuse requires compatible identity and completeness, and preparation SHALL NOT mutate or replace an existing generation. The CMS artifact build SHALL see the canonical dependency generation read-only in its transient unit. Build caches SHALL remain in the operation source tree. A preparation failure SHALL leave existing writers open and create no new journal or marker or change live DB/release state. After preparation, acquisition records the old pair, appends `start`, creates the marker, then fences and verifies closure of CMS writers. The off-host-confirmed follow-up SHALL validate the same operation owner and structurally verify and reuse the complete prepared output bound to the same source and CI provenance; it SHALL NOT rerun npm or the CMS artifact build under the fence. After capture, build static output from the same SHA and sealed snapshot using the already prepared web dependencies. The snapshot proof SHALL bind a quiesced SQLite image, schema/content inventory, every referenced media byte, original media names and permissions, and one sealed bundle digest. REST reads alone are insufficient. The staging194 and production-static main modes are separately scoped below and do not inherit these paired CMS build requirements.

Each process SHALL acquire a host flock and verify the same persistent journal operation ID; the OS lock is process-scoped and is not held between commands. The durable journal and verified writer fence preserve operation ownership across commands. For paired `dev` and fixed `initial-prod` operations, after prefence preparation acquisition SHALL record the old pair, append `start`, create the marker, fence and stop all CMS writers, and verify closure before any DB or live-code mutation; a persistent marker alone does not prove closure. The fence blocks admin, content-manager, upload, API write, and custom write routes while preserving payment/status routes and GET/HEAD media. Use existing Nginx locations; validate changes with `nginx -t` and restore the prior gate file on failure. If acquisition stops before verified closure, do not mutate DB or live release. Staging194 uses its explicit recovery contract; initial-prod faults remain fenced and may retry only the same source-bound operation, while restoring DB or reopening from unknown/pre-journal state requires separate explicit owner approval. After closure, checkpoint SQLite WAL, prove no CMS process holds a DB handle, and make an integrity-checked DB/media backup whose actual bytes are verified off-host before migration or activation. Preserve media names, permissions, and DB references. CMS migration/audit and static snapshot/build run as `ikpk-cms`; root performs only bounded configured path, unit, gate, and atomic switch operations. The static-only main mode has no CMS writer fence or mutation.

For paired `dev` and fixed `initial-prod` operations, after CMS activation poll health for up to 20 minutes and prove the running DB using process environment and open FD. After static activation verify served `/release.json`, required routes, and images against the same candidate. Keep one readable append-only journal file: success records are `start` (old bundle), `new-bundle`, `committed`. Commit follows CMS and static acceptance and precedes writer reopen. After initial-prod commit, the protected fixed operation ID is consumed permanently and no new source or production operation is admitted by this profile. DB restore after commit is forbidden. The static-only main mode uses its own static journal and rollback contract; it does not enter the CMS release journal.

#### Scenario: staging first release is accepted as one pair

- **WHEN** admitted source and run pass, off-host DB/media bytes verify, and CMS plus static candidate checks pass
- **THEN** health, process DB proof, media, and served release/routes/images identify the operation and source
- **AND** the three journal records end in durable commit before writer reopen, without production journal writes

#### Scenario: initial production uses its own one-time proof

- **WHEN** exact current `main` and its canonical successful `Tests` run are admitted under the fixed initial-prod profile
- **THEN** the production server DB/media capture and proof bind the production target, source SHA, run, operation ID, and actual bytes without using the staging demo proof or claiming canonical journal/HWM state
- **AND** the production build uses `DEPLOY_MODE=prod` and `PAYMENT_ROLE=prod`, and the same frozen candidate passes offline browser checks and served release/routes/images before durable commit and writer reopen
- **AND** after commit the profile refuses reuse with any source; ordinary production publication still refuses the one-off proof

#### Scenario: staging194 pre-commit recovery

- **WHEN** staging194 fails after writer fencing and before durable commit
- **THEN** recovery closes and verifies writers before restoring the old pair; initial-prod does not restore DB under this exception

#### Scenario: staging194 failure before commit is recovered explicitly

- **WHEN** acquisition stops early or CMS/static acceptance fails before commit
- **THEN** no mutation occurs before verified fence closure and the fence persists after closure
- **AND** staging194 retry uses the same operation ID or explicit recovery verifies/restores the old pair before reopening
- **AND** recovery refuses DB restore after commit

#### Scenario: second release retains an editor write

- **WHEN** a new editor record and media are saved after the first release and a second operation runs
- **THEN** that record and media remain served, migrations are not repeated, and mutable DB/WAL is checked by lineage and integrity rather than equality to the first backup

#### Scenario: main static-only capture preserves live CMS

- **WHEN** a staging194 or production-static main operation captures current CMS/content/media and builds a static candidate from the exact admitted `main` SHA
- **THEN** capture and build read the CMS artifact, DB/WAL, and uploads without changing their bytes or CMS service/environment state
- **AND** only the static release pointer may change after candidate acceptance; the paired `dev` rehearsal still uses one SHA for CMS and static output

#### Scenario: production-static capture has a separate source-bound proof

- **WHEN** production-static captures the current production database and media for a reusable static-only main operation
- **THEN** its fresh sealed capture binds the production target, exact source SHA, run/attempt, operation ID, and captured bytes
- **AND** the initial-prod one-time proof and ordinary publication snapshot reader do not accept this proof
