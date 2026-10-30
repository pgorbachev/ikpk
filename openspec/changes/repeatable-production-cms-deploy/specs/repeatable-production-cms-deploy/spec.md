## Purpose

Provides a repeatable, manually invoked production release path that updates CMS code and the static site from one admitted source while retaining production-owned database and media content.

## ADDED Requirements

### Requirement: Production paired releases are explicitly admitted

The production paired operator SHALL accept only an explicit local invocation bound to the fixed production target, the exact current full SHA of canonical `main`, a stable published GitHub Release whose tag resolves to that SHA, successful canonical CI runs required by the release policy, and a successful `release-preflight` for that tag and SHA. It SHALL bind the operation ID, release tag, source SHA, CI run IDs and attempts, and target before executing candidate code. Immediately before writing the operation marker or performing any live side effect, and again before each first-time CMS or static candidate switch, it SHALL recheck that the Release, `main` head, and required CI still admit the source. If a switch-time check fails after the fence is acquired, it SHALL refuse that new switch and leave the operation for same-ID recovery; local byte restoration may be offline, but a database-restoring recovery SHALL keep writers fenced until its canonical restore event is published and verified. It SHALL refuse an unfinished unrelated operation, stale source, or missing, failed, skipped, or cancelled required check before changing live state. A new operation SHALL use a fresh ID; a journal-owned operation MAY continue a not-yet-switched phase only after fresh admission, while recovery and finalization of already committed state use the journal without GitHub. This profile SHALL remain reusable for new unique operations after a completed release. The one-time `initial-prod` and static-only `production-static` profiles retain their existing scope.

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

Before creating the operation marker or closing CMS writers, the operator SHALL validate and extract the admitted source, prepare web dependencies with the existing `npm ci` in the extracted source tree, and prepare CMS dependencies with `npm ci` from the official `registry.npmjs.org` or reuse a complete immutable CMS dependency generation whose lock hash and completeness the existing helper verifies. It SHALL then build the CMS artifact as the configured unprivileged user. The existing immutable-generation fallback applies to CMS only; web dependencies SHALL use the existing source-tree `npm ci` path. The operator SHALL NOT use a third-party registry mirror or change persistent npm configuration. If web `npm ci`, CMS preparation, or CMS artifact build fails, or if CMS `npm ci` is unavailable and no complete verified CMS generation is usable, it SHALL refuse with CMS writers open and without creating an operation journal/marker or changing live state.

#### Scenario: Web preparation or CMS preparation is unavailable
- **WHEN** web `npm ci` fails, or CMS `npm ci` cannot reach `registry.npmjs.org` and the existing CMS lock-hash generation is missing, incomplete, or incompatible
- **THEN** the operation refuses before fencing writers or creating its marker/journal
- **AND** persistent npm configuration and live CMS/site state remain unchanged

### Requirement: Production content is backed up and remains production-owned

The paired operation SHALL capture the live production SQLite database and uploads as its only content source; it SHALL NOT import staging194 database, media, users, roles, or content. Before writing the operation marker or closing CMS writers, it SHALL perform a read-only validation of the canonical `state/cms-provenance` journal and high-water mark defined by `cms-content-source` and `deploy-gating`; missing, unreadable, corrupt, or internally inconsistent evidence SHALL refuse before fencing writers. After the writer fence and live capture, it SHALL verify that the captured snapshot's content fingerprint equals the latest canonical entry fingerprint and that its observed journal entry, content revision, and HWM still match that validated lineage; a mismatch, gap, regression, or newer entry blocks migration and activation. Before every first-time CMS or static pointer switch, it SHALL re-read canonical provenance and require the latest fingerprint, observed entry, revision, and HWM to remain equal to the captured snapshot. The provenance journal remains outside the database backup and is never reset or initialized by this operation. Before any live database mutation, the operator SHALL close and verify all CMS writers, checkpoint SQLite WAL, prove no CMS process holds the live database, and create an integrity-checked database-and-media backup whose bytes and manifest are verified off-host. The backup manifest SHALL bind the operation, source, database identity, schema/content lineage, observed provenance record, content fingerprint, content revision, current high-water mark, media names and permissions, and archive digest. Candidate migration and audit SHALL preserve existing production users, roles, permissions, content, and media references except for exact reviewed changes declared by the release. Unexplained changes SHALL prevent activation. Production paired publication SHALL NOT use the staging frozen-capture exception or initial-prod proof.

#### Scenario: Production candidate is prepared from live production data
- **WHEN** the operation reaches the sealed capture phase
- **THEN** the snapshot and backup are derived from the configured production database and uploads
- **AND** the backup integrity and off-host bytes are verified before candidate migration or activation
- **AND** no staging194 data is included

#### Scenario: A backup or lineage check fails
- **WHEN** SQLite integrity, media inventory, manifest lineage, off-host digest, or writer-closure verification fails
- **THEN** no migration or live database mutation occurs and production remains fenced only if the writer fence was already acquired

#### Scenario: Provenance cannot be validated before fencing
- **WHEN** the canonical provenance journal/HWM is missing, unreadable, corrupt, or inconsistent during the read-only preflight
- **THEN** the paired operation refuses before writing its marker or closing writers and does not initialize or lower provenance state

#### Scenario: Captured content no longer matches preflight lineage
- **WHEN** the fenced snapshot's fingerprint, observed entry, content revision, or HWM differs from the valid read-only preflight lineage or latest canonical entry
- **THEN** the paired operation refuses migration and activation and does not initialize or lower provenance state

#### Scenario: Provenance changes or fingerprint differs before a switch
- **WHEN** before a first-time CMS/static switch the canonical latest fingerprint differs from the snapshot, or the latest entry, revision, or HWM has changed since capture
- **THEN** the candidate is stale and the operation refuses that switch; operator confirmation cannot override the stale capture

#### Scenario: Production content is a restore regression
- **WHEN** the snapshot observes the latest journal record but its derived content revision is below the canonical HWM
- **THEN** the paired operation does not publish automatically and uses only the existing explicit restore-confirmation and acceptance-event flow before a fresh capture is eligible

#### Scenario: Migration changes existing identities or unrelated data
- **WHEN** the migration audit finds unapproved changes to existing users, roles, grants, content, or media references
- **THEN** the candidate is not activated and the operation remains recoverable before commit

### Requirement: CMS and static site commit as one fenced operation

Before the first live side effect, the paired operator SHALL durably record the operation and its destination-visible marker while holding the common destination lock; it SHALL fail closed on a malformed marker. It SHALL keep production CMS writers fenced after candidate activation until CMS health and runtime database proof, static candidate checks, browser checks against the exact candidate bytes, served release identity, routes, and referenced media have passed. The static candidate SHALL use the existing production build policy, including production form/payment settings and the configured production chat loader; it SHALL NOT use staging demo form stubs or the staging `CHAT_LOADER_SRC=none` setting. Browser checks SHALL NOT submit payment, CRM, or other external write actions. Activation SHALL update only `IKPK_BUILD_WORKSPACE` and `IKPK_INSTALLED_COMMIT` in the existing CMS service environment to the ready workspace and exact installed source SHA. The operation SHALL record their previous values without exposing or rewriting other environment values, and SHALL verify the next CMS site-refresh uses the new workspace and commit. It SHALL record one durable operation journal tying the old and new CMS, database, media, environment, and static identities to the source and backup. The operation SHALL commit once both CMS and static candidates are accepted; only then may it reopen writers. Static-only publication SHALL NOT be treated as completion of a paired CMS release.

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
- **THEN** the service environment points `IKPK_BUILD_WORKSPACE` to the ready admitted workspace and `IKPK_INSTALLED_COMMIT` to its exact source SHA
- **AND** all unrelated environment values remain unchanged

#### Scenario: Activation or recovery updates versioned environment values
- **WHEN** a paired operation updates or restores the CMS workspace and installed commit
- **THEN** it atomically changes only those two versioned keys and verifies their values before CMS restart
- **AND** recovery restores the previous values before reopening the old CMS release

#### Scenario: Crash at an operation boundary
- **WHEN** the process stops after operation-marker creation, fence activation, backup, CMS activation, static switch, commit, or writer reopen
- **THEN** the same journal-owned operation can safely recover or finalize its next phase without starting a different operation
- **AND** a damaged or mismatched marker blocks every publisher until explicit repair through that operation

### Requirement: Production site publishers are mutually exclusive

The production paired operator, production static-only operator, CMS site-refresh API/worker, and CMS UI Restore SHALL serialize every static-pointer switch against the same destination `.publication.lock`. Each pointer-changing path SHALL acquire and verify that lock before mutation. The paired and static-only operators SHALL inspect the CMS-local refresh state while holding the destination lock and refuse if a live or unreconciled refresh owns it. Before a production static-only publication relies on the shared-lock protocol, it SHALL verify that the installed CMS site-refresh and Restore code honors the same lock and marker; if the installed CMS is legacy or compatibility cannot be proven, static-only SHALL refuse before switching until a paired update installs the compatible CMS. UI Restore SHALL acquire the destination lock before its CMS-local state lock and switch only while it owns both. In addition, Restore SHALL refuse before switching when the target release's source commit differs from the currently installed `IKPK_INSTALLED_COMMIT`; a content-only Restore built by the same installed CMS remains available. A paired operation SHALL establish a durable destination-visible production-operation marker before releasing the lock between CMS activation and static publication; site-refresh, static-only, and UI Restore SHALL refuse while that marker identifies an unfinished paired operation. The marker SHALL be removed only after paired commit or verified recovery. New operations SHALL fail closed on malformed/foreign markers or unresolved pending/preparation state. A journal-owned recovery/finalization under the common lock MAY proceed through its matching valid marker and state, but SHALL refuse on damaged or mismatched ownership; a new operation or Restore SHALL NOT take over that state. The shared lock SHALL be accessible only to the fixed publication and CMS service principals; unrelated users SHALL have no access. The API/worker handoff SHALL preserve exclusive ownership across reservation and spawn, and an interrupted handoff SHALL not permit an unowned worker to mutate the site.

#### Scenario: Site refresh is already running
- **WHEN** the site-refresh worker holds the destination lock while the paired operation is requested
- **THEN** the paired operation refuses before creating a fence or changing CMS, database, or site state

#### Scenario: CMS API handoff is interrupted
- **WHEN** the CMS refresh API or detached worker stops during reservation and worker handoff
- **THEN** the handoff is reconciled as interrupted/failed and no unowned worker captures, builds, or switches the site

#### Scenario: Paired CMS activation is waiting for static acceptance
- **WHEN** the paired operation has activated its CMS candidate but has not committed or recovered
- **THEN** a site-refresh worker and production static-only operation acquire the common lock only to observe the unfinished marker and refuse without switching the site

#### Scenario: Static-only publication is active
- **WHEN** a production static-only publication holds the destination lock while a paired CMS operation is requested
- **THEN** the paired operation refuses before fencing writers or changing the CMS/database

#### Scenario: A site publication is pending recovery
- **WHEN** the destination has an unfinished site publication or preparation record
- **THEN** the paired and static-only operators refuse before capturing, fencing writers, or switching a pointer

#### Scenario: Matching paired recovery owns the unfinished marker
- **WHEN** recovery or finalization is requested for the journal owner of the valid paired-operation marker
- **THEN** it may proceed under the common lock using the same operation ID and required recovery evidence
- **AND** unrelated new operations, static-only publication, site refresh, and UI Restore continue to refuse

#### Scenario: Legacy CMS is still installed for static-only publication
- **WHEN** production static-only is requested while the installed CMS does not honor the shared lock and marker, or its compatibility cannot be proven
- **THEN** the static-only operation refuses before capture or pointer switch, including when a legacy same-cgroup refresh worker is active
- **AND** a later request may proceed after a paired update installs and verifies the lock-aware CMS

#### Scenario: CMS UI Restore races a paired or static-only switch
- **WHEN** Restore attempts to switch `current` while a paired operation, production static-only operation, or site-refresh worker holds the destination lock or has an unfinished paired marker
- **THEN** Restore refuses before switching the pointer
- **AND** a Restore holding the lock causes a new paired/static-only operation to refuse before its first side effect

#### Scenario: CMS UI Restore uses the shared lock first
- **WHEN** the CMS Restore action is requested
- **THEN** it acquires the destination lock before the CMS-local lock and switches `current` only while both locks are owned
- **AND** it refuses if a paired marker, pending publication, or preparation record exists

#### Scenario: CMS UI Restore targets a previous CMS source after a paired commit
- **WHEN** `previousReleaseId` points to a release whose source commit differs from the installed `IKPK_INSTALLED_COMMIT`
- **THEN** Restore refuses before switching the static pointer
- **AND** a content-only previous release built by the installed CMS source remains restorable


#### Scenario: Paired operation reaches a terminal state
- **WHEN** the paired operation commits successfully or completes verified recovery
- **THEN** it removes its marker under the common lock and subsequent site publication may proceed

### Requirement: The first paired update quiesces legacy CMS publishers

For the first paired update, while holding the destination lock and after durably recording its operation marker, the operator SHALL close the old CMS site-refresh and Restore endpoints using the existing write gate. While the CMS service is still running, it SHALL wait for accepted requests and every existing refresh/Restore worker, descendant, and `systemd-run --user --scope` unit to exit normally. Only then may it stop the old CMS service; after stop it SHALL verify again that no request or worker remains and no new worker was launched. Before capture, CMS activation, or static switch, it SHALL verify old CMS/static pointers and refresh state are terminal and record any completed refresh as the pre-operation state. It SHALL NOT kill a worker or proceed while liveness or pointer state is ambiguous.

#### Scenario: A legacy refresh or Restore is in flight
- **WHEN** the old CMS has an active refresh/Restore request, recorded running state, detached child, or user systemd scope
- **THEN** the gate prevents new requests while the old service remains running, and the operator waits for each accepted request and child scope to finish before stopping that service
- **AND** after stop it verifies there are still no requests or workers before capture or candidate activation
- **AND** no worker is killed

#### Scenario: Legacy publisher does not quiesce or its state is unreadable
- **WHEN** the worker/scope remains active, the refresh record is corrupt, or current pointers do not match a verifiable terminal state
- **THEN** the paired update does not capture or activate a candidate
- **AND** the existing acquisition recovery reopens the old service only when live SQLite and pointers are proven unchanged; otherwise it remains fenced for operator direction

### Requirement: Recovery restores or finalizes the journal-owned production pair

Before global commit, an explicit recovery command SHALL verify operation ownership and keep writers closed. If no destructive mutation began, recovery MAY reopen the unchanged old pair only after verifying live SQLite integrity and exact old CMS/static identities. After destructive mutation, recovery SHALL require the exact verified off-host backup and restore the prior CMS release, database, media, environment keys, and static pointer. A database restore SHALL append and verify an operation-bound canonical `restore` provenance event without lowering the HWM. Local byte restoration MAY complete without GitHub, but writers SHALL remain fenced until the event is read back from the canonical branch; retry SHALL be idempotent for that operation and SHALL fail closed on a conflicting or ambiguous event. Recovery SHALL verify CMS health, restored database identity, environment keys, canonical provenance state, and the old static tree before reopening writers, and SHALL refuse if phase, live state, or backup identity cannot be proven. After global commit, this profile SHALL support only verification and finalization of the committed pair; it SHALL NOT restore the database or roll back CMS code, environment, or the static pointer. This change provides no post-commit code/static rollback path. Such rollback is outside scope and requires a separately admitted operation that proves schema compatibility and preserves production writes; neither static-only publication nor CMS UI Restore is a supported paired rollback.

#### Scenario: Verified pre-commit recovery
- **WHEN** an operator recovers a failed, uncommitted operation with matching evidence
- **THEN** the unchanged old pair is safely reopened if no destructive mutation began, or the verified off-host backup restores and verifies the prior pair before writers reopen
- **AND** any database restore is recorded through the canonical provenance event without lowering its HWM

#### Scenario: Restore provenance is unavailable or ambiguous
- **WHEN** GitHub is unavailable, the canonical restore event cannot be verified, or a conflicting event has the same fingerprint under another operation ID
- **THEN** restored bytes remain in place, writers remain fenced, and retry does not repeat the byte restore or accept the conflicting event

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
