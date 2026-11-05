## Purpose

Provides a repeatable, manually invoked production release path that updates CMS code and the static site from one admitted source while retaining production-owned database and media content.

## ADDED Requirements

### Requirement: Production paired releases are explicitly admitted

The production paired operator SHALL accept only an explicit local invocation bound to the fixed production target, the exact current full SHA of canonical `main`, a stable published GitHub Release whose tag resolves to that SHA, successful canonical CI runs required by the release policy, and a successful `release-preflight` for that tag and SHA. It SHALL bind the operation ID, release tag, source SHA, CI run IDs and attempts, and target before executing candidate code. Immediately before writing the operation marker or performing any live side effect, and again before each first-time CMS or static candidate switch, it SHALL recheck that the Release, `main` head, and required CI still admit the source. If a switch-time check fails after the fence is acquired, it SHALL refuse that new switch and leave the operation for same-ID recovery. It SHALL refuse an unfinished unrelated operation, stale source, or missing, failed, skipped, or cancelled required check before changing live state. A new operation SHALL use a fresh ID; a journal-owned operation MAY continue a not-yet-switched phase only after fresh admission, while recovery and finalization of already committed state use the journal without GitHub. This profile SHALL remain reusable for new unique operations after a completed release. The one-time `initial-prod` and static-only `production-static` profiles retain their existing scope.

#### Scenario: Current main release and required CI are admitted
- **WHEN** an operator explicitly starts a new paired production operation for the current canonical `main` SHA, a stable published Release tag resolves to it, `release-preflight` admits it, and every required exact-SHA CI run succeeded
- **THEN** the operator records the bound release, source, run evidence, operation ID, and production target before executing the candidate
- **AND** CMS and static candidates use that same SHA

#### Scenario: Release, source, or CI evidence is not current and complete
- **WHEN** a new operation's Release is draft or prerelease, its tag does not resolve to the current canonical `main` head, `release-preflight` refuses, or any required run/job is absent, failed, skipped, or cancelled
- **THEN** the operator refuses before changing production CMS, database, media, or static pointers

#### Scenario: An operation ID is reused for a different operation
- **WHEN** an operator tries to start a new operation with an ID already owned by a terminal or unrelated journal entry
- **THEN** the operator refuses before creating a new operation or changing live state

#### Scenario: A journal-owned operation is retried
- **WHEN** an operator resumes an unfinished operation with its original ID, source, and target
- **THEN** the operator performs only the next idempotent journal-owned phase and does not repeat completed migration or activation work

### Requirement: CMS candidates are prepared before the writer fence

Before creating the operation marker or closing CMS writers, the operator SHALL validate and extract the admitted source, prepare web dependencies with the existing `npm ci` in the extracted source tree, and validate a compatible CI-built CMS artifact bound to that source and its trusted CI evidence under the CI-built CMS artifact requirements in this change. Any required target-side CMS dependencies SHALL be complete, compatible and verified against the admitted lockfile; if installed on the host, npm SHALL use the official `registry.npmjs.org` or the existing verified immutable CMS generation. The operator SHALL NOT build the CMS artifact on the destination, use a third-party registry mirror or change persistent npm configuration. If web or CMS preparation, artifact validation or compatibility verification fails, it SHALL refuse with CMS writers open and without creating an operation journal/marker or changing live state.

#### Scenario: Web preparation or CMS preparation is unavailable
- **WHEN** web `npm ci` fails, the CI-built CMS artifact cannot be verified, or required compatible CMS dependencies are unavailable
- **THEN** the operation refuses before fencing writers or creating its marker/journal
- **AND** persistent npm configuration and live CMS/site state remain unchanged

### Requirement: Production content is backed up and remains production-owned

The paired operation SHALL capture the live production SQLite database and uploads as its only content source; it SHALL NOT import staging194 database, media, users, roles, or content. It SHALL NOT consult the shared stand CMS provenance journal or its high-water mark because that journal has no destination scope and records stand state. Before any live database mutation, the operator SHALL close and verify all CMS writers, checkpoint SQLite WAL, prove no CMS process holds the live database, and create an integrity-checked database-and-media backup whose bytes and manifest are verified off-host. The backup manifest and existing host operation journal SHALL bind the operation, source, old CMS/schema identity, database identity, projected content fingerprint, media names and permissions, and archive digest. Candidate migration and audit SHALL preserve existing production users, roles, permissions, content, and media references except for exact reviewed changes declared by the release. The production candidate snapshot fingerprint SHALL equal the fingerprint projected from that operation's verified backup before static switch. For each new operation, the captured live production state becomes that operation's old-pair and backup baseline; unexplained candidate changes SHALL prevent activation. Production paired publication SHALL NOT use the staging frozen-capture exception or initial-prod proof.

#### Scenario: Production candidate is prepared from live production data
- **WHEN** the operation reaches the sealed capture phase
- **THEN** the snapshot and backup are derived from the configured production database and uploads
- **AND** the backup integrity and off-host bytes are verified before candidate migration or activation
- **AND** no staging194 data is included

#### Scenario: A backup or lineage check fails
- **WHEN** SQLite integrity, media inventory, manifest lineage, off-host digest, or writer-closure verification fails
- **THEN** no migration or live database mutation occurs and production remains fenced only if the writer fence was already acquired

#### Scenario: Production content differs from the stand ledger
- **WHEN** the live production fingerprint differs from the latest fingerprint recorded by the shared stand CMS provenance journal
- **THEN** the production operation uses its own verified backup and operation journal and leaves the stand journal unchanged

#### Scenario: The production candidate differs from its operation backup
- **WHEN** the production candidate snapshot fingerprint differs from the fingerprint projected from the operation's verified off-host backup
- **THEN** the operator refuses the static switch and keeps the same operation fenced for recovery

#### Scenario: Migration changes existing identities or unrelated data
- **WHEN** the migration audit finds unapproved changes to existing users, roles, grants, content, or media references
- **THEN** the candidate is not activated and the operation remains recoverable before commit

### Requirement: CMS and static site commit as one fenced operation

Before the first live side effect, the paired operator SHALL durably record the operation and its host journal/maintenance state and fail closed on malformed or mismatched operation state. The paired operation journal/maintenance state owns paired recovery; the separate existing shared site-publication marker is consumed by CMS publishers and SSH publication commands to block conflicting operations. Each paired host-side state-changing command SHALL acquire and validate the same existing destination publication lock used by CMS refresh and Restore; a missing or unsafe lock SHALL refuse the command. Busy-lock behavior remains command-specific: `cleanup-site` waits and then rechecks admission, while the other paired host commands refuse. The lock serializes individual host commands, is not held across separate commands in the paired workflow, and is not itself a destination-visible marker. The operator SHALL keep production CMS writers fenced after candidate activation until CMS health and runtime database proof, static candidate checks, browser checks against the exact candidate bytes, served release identity, routes, and referenced media have passed. The static candidate SHALL use the validated production form/payment settings and configured production chat loader; it SHALL NOT use staging demo form stubs or `CHAT_LOADER_SRC=none`. Browser checks SHALL NOT submit payment, CRM, or other external write actions. Activation SHALL update `IKPK_BUILD_WORKSPACE`, `IKPK_INSTALLED_COMMIT`, `INITIAL_PROD_PROFILE=1`, `DEPLOY_MODE=prod`, `PAYMENT_ROLE=prod`, `PAYMENT_ENDPOINT_PROD`, and `CHAT_LOADER_SRC` from the validated production profile, and clear `DEMO_FORMS` and `CHAT_OFFLINE_MESSAGE` for the production site build. The operation SHALL record prior values for these nine keys and restore them during recovery, preserving unrelated environment values without exposing secrets. It SHALL verify that the next CMS site-refresh uses the ready workspace, exact installed source SHA, and production build settings. It SHALL record one durable operation journal tying old and new CMS, database, media, environment, and static identities to the source and backup. The operation SHALL commit once both CMS and static candidates are accepted; only then may it reopen writers. Static-only publication SHALL NOT be treated as completion of a paired CMS release.

#### Scenario: Both candidates pass acceptance
- **WHEN** CMS health and database proof pass and the same-source static candidate passes its checks
- **THEN** the operator records the paired commit and reopens production writers
- **AND** the served release identifies the admitted source and operation

#### Scenario: CMS or static acceptance fails before commit
- **WHEN** either candidate fails its required checks before global commit
- **THEN** writers remain fenced until the same operation is retried successfully or explicit recovery completes
- **AND** no partial CMS-only or static-only release is reported as committed

#### Scenario: A static-only command is used for a CMS release
- **WHEN** an operator invokes the production static-only profile while a CMS release is expected
- **THEN** that command leaves the CMS and production database unchanged and does not satisfy paired-release acceptance

#### Scenario: Production static candidate retains production integrations
- **WHEN** the paired production site candidate is built and browser-checked
- **THEN** it uses production form/payment configuration and the configured production chat loader
- **AND** acceptance checks do not submit external writes

#### Scenario: CMS site refresh uses the installed workspace
- **WHEN** the paired release commits and the CMS site-refresh button is used next
- **THEN** the service environment points `IKPK_BUILD_WORKSPACE` to the ready admitted workspace and `IKPK_INSTALLED_COMMIT` to its exact source SHA, and the refresh child build uses the validated production flags and integration settings
- **AND** all unrelated environment values remain unchanged

#### Scenario: Activation or recovery updates paired site-build settings
- **WHEN** a paired operation updates or restores the CMS workspace and installed commit
- **THEN** it sets `IKPK_BUILD_WORKSPACE`, `IKPK_INSTALLED_COMMIT`, `INITIAL_PROD_PROFILE=1`, `DEPLOY_MODE=prod`, `PAYMENT_ROLE=prod`, `PAYMENT_ENDPOINT_PROD`, and `CHAT_LOADER_SRC` from the validated production profile
- **AND** it clears `DEMO_FORMS` and `CHAT_OFFLINE_MESSAGE` for the production site build and verifies the build environment before CMS restart
- **AND** recovery restores the previous values of all nine paired keys before reopening the old CMS release, preserving every unrelated environment value

#### Scenario: Crash at an operation boundary
- **WHEN** the process stops after operation-marker creation, fence activation, backup, CMS activation, static switch, commit, or writer reopen
- **THEN** the same journal-owned operation can safely recover or finalize its next phase without starting a different operation
- **AND** a damaged or mismatched operation journal blocks paired continuation until explicit repair through that operation; the shared lock serializes host-side commands, and the manual maintenance window covers the intervals between paired commands

### Requirement: Paired publication uses a manual single-operator maintenance window

The paired workflow SHALL be run inside one manually coordinated maintenance window by one operator. The operator SHALL prevent other CMS or static publications, including CMS site-refresh and UI Restore, from starting until the paired operation commits or verified recovery completes. Every host-side state-changing command SHALL acquire and validate the existing destination `.publication.lock` inode; if it is missing or unsafe, the command SHALL refuse, and the operator SHALL NOT replace or change its ownership or mode. When the lock is busy, `cleanup-site` waits and then rechecks admission; other paired host commands refuse. The shared lock serializes host-side commands but is released between commands in the paired sequence, so the maintenance window remains necessary across the sequence. The host SHALL retain its operation journal and SHALL fail closed for active, malformed, or unknown paired-operation state.

#### Scenario: Another publication is active or state is unknown
- **WHEN** the operator observes an active or unknown site-refresh/Restore worker, lock, or paired journal state
- **THEN** the operation does not proceed to backup, migration, or activation
- **AND** the operator waits for a known worker to finish normally or stops the operation when its state cannot be established

#### Scenario: Single-operator maintenance window spans both phases
- **WHEN** `cms-update` has completed but `static-publish` or verified recovery has not
- **THEN** the operator keeps the same maintenance window and prevents other publishers and CMS UI Restore from starting
- **AND** no technical guarantee against a separate concurrent operator or publisher is implied

#### Scenario: CMS UI Restore targets a previous source after paired commit
- **WHEN** `previousReleaseId` points to a release whose source commit differs from the installed `IKPK_INSTALLED_COMMIT`
- **THEN** Restore refuses before switching the static pointer
- **AND** a content-only previous release built by the installed CMS source remains restorable

### Requirement: The first paired update gates known legacy publishers

Before the first paired update stops the legacy CMS, the operator SHALL use the existing Nginx write gate to reject new routed CMS write and Restore requests, inspect the existing site-refresh state and lock, and wait for every recorded refresh/Restore PID and recognizable legacy worker to exit normally. Active workers SHALL NOT be killed. The operator SHALL stop and refuse capture or activation when recorded state is malformed, a recorded worker remains active, a lock is stale or unreadable, or process inspection fails. This procedure checks the process and state evidence available to the host; it does not prove that every accepted Node handler has exited. In particular, an in-flight handler may continue after its client disconnects even after the Nginx worker exits, leaving a residual race with CMS stop/acquisition. The manual single-operator window reduces competing publication attempts but does not technically eliminate this race. Passing a staging194 rehearsal SHALL NOT be represented as proof that this application-level race is absent in production.

#### Scenario: Recorded legacy refresh or Restore worker is active
- **WHEN** the old CMS state, PID, lock, or process scan shows an active worker
- **THEN** the operator waits for its normal completion before stopping CMS, or refuses if it does not drain
- **AND** no worker is killed and no capture or activation proceeds while state is active or unknown

#### Scenario: Client disconnects while a CMS handler continues
- **WHEN** an accepted CMS handler outlives its disconnected client after the Nginx worker exits
- **THEN** the operator acknowledges that the existing process checks cannot prove the handler has exited
- **AND** this residual race remains an explicit limitation of the manual maintenance procedure

### Requirement: Recovery restores or finalizes the journal-owned production pair

Before global commit, an explicit recovery command SHALL verify operation ownership and keep writers closed. If no destructive mutation began, recovery MAY reopen the unchanged old pair only after verifying live SQLite integrity and exact old CMS/static identities. After destructive mutation, recovery SHALL require the exact verified off-host backup and restore the prior CMS release, database, media, environment keys, and static pointer. Before reopening, the same host operation journal SHALL verify the staged restore fingerprint, restored database digest, CMS/media payload, environment keys, and old CMS/static targets; retry SHALL be idempotent for that operation and SHALL fail closed on any conflicting or ambiguous evidence. Recovery SHALL refuse if phase, live state, or backup identity cannot be proven. After global commit, this profile SHALL support only verification and finalization of the committed pair; it SHALL NOT restore the database or roll back CMS code, environment, or the static pointer. This change provides no post-commit code/static rollback path. Such rollback is outside scope and requires a separately admitted operation that proves schema compatibility and preserves production writes; neither static-only publication nor CMS UI Restore is a supported paired rollback.

#### Scenario: Verified pre-commit recovery
- **WHEN** an operator recovers a failed, uncommitted operation with matching evidence
- **THEN** the unchanged old pair is safely reopened if no destructive mutation began, or the verified off-host backup restores and verifies the prior pair before writers reopen
- **AND** any database restore is verified against that operation's staged fingerprint and database/media digests

#### Scenario: Restore evidence is unavailable or ambiguous
- **WHEN** the operation journal, backup sidecar, restored database/media bytes, or old pointer targets are unavailable or inconsistent
- **THEN** restored bytes remain in place, writers remain fenced, and retry does not repeat the byte restore or reopen the wrong pair

#### Scenario: Final admission is stale or unavailable before a switch
- **WHEN** `main`, Release, or required CI no longer admits the source, or GitHub cannot complete the fresh check before a first-time CMS/static switch
- **THEN** that switch is refused and the same operation follows the recovery requirements above without changing source

#### Scenario: Interrupted after commit before finalization
- **WHEN** the durable commit exists but the process stopped before reopening writers or clearing the marker
- **THEN** retrying the same operation ID verifies the committed pair, completes reopen/finalization, and does not restore the database or switch either pointer again

#### Scenario: Recovery evidence is missing or mismatched
- **WHEN** the journal, backup digest, operation owner, or prior-pair identity does not match
- **THEN** recovery refuses and keeps writers fenced

#### Scenario: Post-commit rollback is requested
- **WHEN** an operator requests database or code/static rollback through this profile after global commit
- **THEN** the command refuses; this change defines no rollback path after commit
- **AND** any future rollback requires a separately admitted operation with proven schema compatibility and preservation of production writes


### Requirement: The CMS artifact is built without live inputs

For reusable production paired CMS deployment, the delivery process SHALL build the complete CMS candidate from the admitted source in a trusted CI run without access to live databases, uploads or production secrets. It SHALL include the configuration, migrations and migration-runner payload required by the existing artifact checks. Live media and host-specific paths SHALL remain outside the artifact. For reusable production paired CMS deployment, the destination SHALL NOT build the CMS candidate. The fixed historical initial production operation retains its original contract.

#### Scenario: CI build lacks production data
- **WHEN** the CMS candidate is built in CI
- **THEN** no production database, media or production secret is supplied to the build
- **AND** the existing artifact and migration payload checks pass on the produced candidate

### Requirement: Only a verified compatible artifact is admitted

For reusable production paired CMS deployment, the operator SHALL bind the artifact and its integrity evidence to the exact admitted source revision and trusted CI run and attempt. Before fencing writers or changing live state, it SHALL verify the artifact bytes, the lockfile identity and compatibility of the runtime and all native dependencies with the target. It SHALL bind the admitted artifact digest to the operation and ensure the exact verified bytes are consumed at migration, activation and retry, using revalidation or equivalent immutable staging. Missing, mismatched, untrusted or unverifiable evidence SHALL cause refusal before the relevant mutation.

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

Reusable production paired CMS deployment SHALL keep the existing mutually exclusive admission, writer fence, verified backup, candidate database migration, activation, health and media checks, and explicit recovery or rollback contracts. Static-only publication retains its existing separate contract. A successful artifact build SHALL NOT be treated as proof that a live migration or deployment succeeded.

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
