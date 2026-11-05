## ADDED Requirements

### Requirement: Fixed rehearsal and initial-production profiles use truthful sealed captures

Only the owner-designated staging194 rehearsal (`194.226.99.10`, `https://194.226.99.10`, `deployMode=stand`, `paymentRole=ci`) may use `sourcePolicy=demo-publication-only`, profile `demo-dev`, `recordKind=publication-snapshot`, `sourceAge=untracked`, `origin=server-db`, and `sourceId=demo193-cms`. The source ID is a retained legacy machine identifier. A separate fixed `initial-prod` profile may perform exactly one owner-approved initial production operation with `sourcePolicy=initial-production`, `recordKind=initial-production-snapshot`, `origin=server-db`, and a distinct proof type bound to the production target, exact `main` SHA, fixed operation ID, run, and sealed DB/media capture. That proof SHALL NOT be accepted as the staging demo proof or by the ordinary production snapshot reader. Neither scoped capture is an edit, restore, or canonical journal event; both leave ordinary production journal and high-water-mark rules unchanged.

The staging194 and production-static modes SHALL use a fresh read-only sealed capture of the currently installed CMS, content, SQLite, and media solely as static build input. They SHALL NOT prepare or activate a CMS candidate, fence CMS writers, migrate or write the database, or change the CMS release/symlink, service, environment, uploads, roles, or users. Staging194 static-only output remains bound to exact current canonical `main` and the four successful required CI workflows. The shared tag-based production-static operator workflow (`--release-tag` plus validated in-memory Release admission) defaults to the green exact SHA on canonical `main` at operation start and permits an operator-explicitly selected older stable GitHub Release only when the same four workflows pass for that exact SHA and existing compatibility checks pass. Its source SHA, applicable run/attempt, and Release identity are fixed and recorded at operation start; a later `main` advance SHALL NOT cancel or replace that tag-admitted SHA. The legacy direct production-static `static-main` path without `--release-tag` retains its current-main pre-switch check. Production-static uses a separate config, journal, and capture proof namespace. Paired staging194 rehearsal is a separate CMS-and-static operation admitted from the default canonical `main` head or an explicitly selected eligible main revision with required exact-SHA CI and no GitHub Release.

Fix the destination and admitted full source SHA before executing candidate code. For paired staging194 rehearsal and fixed `initial-prod` operations, the operation manifest SHALL record its ID, old/new CMS code, DB, media, static and config identities, canonical ref, full SHA, CI run/attempt, and separate CMS/static payload digests; staging194 records the selected revision and exact CI run/attempt without a Release requirement, while the historical fixed `initial-prod` operation retains its original CI run/attempt evidence; the CMS and static outputs SHALL derive from that one SHA. CI receives no host credentials. The first new command SHALL hold the host flock, check admission and operation availability, and refuse if a maintenance marker exists, an unfinished operation exists, or the operation ID has already been used. Journal-tail repair may occur during this check, but it does not start an operation. Before creating the operation's journal or marker, the command SHALL validate and extract the admitted source archive and prepare web npm dependencies while existing writers remain open. Paired staging194 SHALL validate the compatible CI-built CMS artifact and any required target dependencies under the CI-built CMS artifact requirements in this change and SHALL NOT build the CMS artifact on the destination. The fixed historical `initial-prod` operation retains its original host-built artifact and dependency-generation contract; its evidence is not rewritten. Any reused CMS dependency generation SHALL have compatible identity and completeness, and preparation SHALL NOT mutate or replace an existing generation. A preparation failure SHALL leave existing writers open and create no new journal or marker or change live DB/release state. After preparation, acquisition records the old pair, appends `start`, creates the marker, then fences and verifies closure of CMS writers. The off-host-confirmed follow-up SHALL validate the same operation owner and structurally verify and reuse the complete prepared output bound to the same source and CI provenance; for paired staging194 it SHALL additionally verify the exact admitted artifact digest under the CI-built CMS artifact requirements in this change. It SHALL NOT rerun npm or the CMS artifact build under the fence. After capture, build static output from the same SHA and sealed snapshot using the already prepared web dependencies. The snapshot proof SHALL bind a quiesced SQLite image, schema/content inventory, every referenced media byte, original media names and permissions, and one sealed bundle digest. REST reads alone are insufficient. The staging194 and production-static main modes are separately scoped below and do not inherit these paired CMS build requirements.

Each process SHALL acquire a host flock and verify the same persistent journal operation ID; the OS lock is process-scoped and is not held between commands. The durable journal and verified writer fence preserve operation ownership across commands. For paired staging194 and fixed `initial-prod` operations, after prefence preparation acquisition SHALL record the old pair, append `start`, create the marker, fence and stop all CMS writers, and verify closure before any DB or live-code mutation; a persistent marker alone does not prove closure. The fence blocks admin, content-manager, upload, API write, and custom write routes while preserving payment/status routes and GET/HEAD media. Use existing Nginx locations; validate changes with `nginx -t` and restore the prior gate file on failure. If acquisition stops before verified closure, do not mutate DB or live release. Staging194 uses its explicit recovery contract; initial-prod faults remain fenced and may retry only the same source-bound operation, while restoring DB or reopening from unknown/pre-journal state requires separate explicit owner approval. After closure, checkpoint SQLite WAL, prove no CMS process holds a DB handle, and make an integrity-checked DB/media backup whose actual bytes are verified off-host before migration or activation. Preserve media names, permissions, and DB references. CMS migration/audit and static snapshot/build run as `ikpk-cms`; root performs only bounded configured path, unit, gate, and atomic switch operations. The static-only main mode has no CMS writer fence or mutation.

For paired staging194 and fixed `initial-prod` operations, after CMS activation poll health for up to 20 minutes and prove the running DB using process environment and open FD. After static activation verify served `/release.json`, required routes, and images against the same candidate. Keep one readable append-only journal file: success records are `start` (old bundle), `new-bundle`, `committed`. Commit follows CMS and static acceptance and precedes writer reopen. After initial-prod commit, the protected fixed operation ID is consumed permanently and no new source or production operation is admitted by this profile. DB restore after commit is forbidden. The static-only main mode uses its own static journal and rollback contract; it does not enter the CMS release journal.

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

#### Scenario: static-only capture preserves live CMS

- **WHEN** a staging194 main operation or production-static operation captures current CMS/content/media and builds a static candidate from its fixed admitted SHA
- **THEN** capture and build read the CMS artifact, DB/WAL, and uploads without changing their bytes or CMS service/environment state
- **AND** only the static release pointer may change after candidate acceptance; the paired staging194 rehearsal separately uses one admitted SHA for CMS and static output

#### Scenario: production-static capture has a separate source-bound proof

- **WHEN** production-static captures the current production database and media for a reusable static-only operation admitted through the shared tag-based workflow, from either its admitted current-main SHA or an explicitly selected older stable Release SHA
- **THEN** its fresh sealed capture binds the production target, exact source SHA, run/attempt, operation ID, and captured bytes, plus the selected Release identity when applicable
- **AND** the initial-prod one-time proof and ordinary publication snapshot reader do not accept this proof

#### Scenario: production-static main advances after source admission

- **WHEN** canonical `main` advances after the shared tag-based production-static workflow fixes its source SHA at operation start
- **THEN** that workflow continues with the original tag-admitted SHA if its exact-SHA CI, compatibility, capture, and candidate checks pass
- **AND** the legacy direct no-tag `static-main` path retains its existing current-main pre-switch check


### Requirement: The CMS artifact is built without live inputs

For paired staging194 CMS deployment, the delivery process SHALL build the complete CMS candidate from the admitted source in a trusted CI run without access to live databases, uploads or production secrets. It SHALL include the configuration, migrations and migration-runner payload required by the existing artifact checks. Live media and host-specific paths SHALL remain outside the artifact. For paired staging194 CMS deployment, the destination SHALL NOT build the CMS candidate. The fixed historical initial production operation retains its original contract.

#### Scenario: CI build lacks production data
- **WHEN** the CMS candidate is built in CI
- **THEN** no production database, media or production secret is supplied to the build
- **AND** the existing artifact and migration payload checks pass on the produced candidate

### Requirement: Only a verified compatible artifact is admitted

For paired staging194 CMS deployment, the operator SHALL bind the artifact and its integrity evidence to the exact admitted source revision and trusted CI run and attempt. Before fencing writers or changing live state, it SHALL verify the artifact bytes, the lockfile identity and compatibility of the runtime and all native dependencies with the target. It SHALL bind the admitted artifact digest to the operation and ensure the exact verified bytes are consumed at migration, activation and retry, using revalidation or equivalent immutable staging. Missing, mismatched, untrusted or unverifiable evidence SHALL cause refusal before the relevant mutation.

#### Scenario: Artifact does not match the admitted source
- **WHEN** the artifact digest, source, CI run or lockfile identity differs from the admitted evidence
- **THEN** deployment refuses before fencing writers or changing live state

#### Scenario: Native runtime is incompatible
- **WHEN** the target operating system, architecture, Node runtime or native dependency ABI cannot be shown compatible
- **THEN** deployment refuses before fencing writers or changing live state

#### Scenario: Prepared bytes change before use
- **WHEN** the staged CMS candidate no longer matches the digest bound to the admitted operation before migration, activation or retry
- **THEN** the operator refuses to consume the changed candidate and preserves the existing fenced recovery state

### Requirement: CI preparation does not replace data safety or recovery

Paired staging194 CMS deployment SHALL keep the existing mutually exclusive admission, writer fence, verified backup, candidate database migration, activation, health and media checks, and explicit recovery or rollback contracts. Static-only publication retains its existing separate contract. A successful artifact build SHALL NOT be treated as proof that a live migration or deployment succeeded.

#### Scenario: Artifact succeeds but migration fails
- **WHEN** a verified artifact is admitted but candidate migration or post-activation verification fails
- **THEN** the existing fenced failure and recovery rules apply
- **AND** the deployment is not reported as successful

#### Scenario: Workspace and rollback targets survive deployment and cleanup
- **WHEN** a paired CMS release is prepared, activated, recovered or cleaned up
- **THEN** the previous CMS and site releases, the current and next-start CMS workspaces, and required rollback targets remain protected until no longer required by the existing recovery contract
- **AND** update and rollback keep the CMS version and its workspace path consistent
- **AND** uncertain workspace identity prevents automatic CMS release deletion
- **AND** publication, release and cleanup use the existing shared lock; successful publication requests existing cleanup, and an interrupted cleanup request remains retryable

#### Scenario: CMS administration configuration differs
- **WHEN** staging or production needs a different public administration configuration
- **THEN** deployment uses only an artifact whose compiled administration behavior is verified compatible with that environment
- **AND** no production secret is embedded in the artifact
