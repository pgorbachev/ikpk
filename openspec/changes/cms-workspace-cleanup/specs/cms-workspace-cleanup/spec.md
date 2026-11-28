## Purpose

Reclaim retired paired CMS build workspaces without impairing site refresh, service restart or supported recovery.

## ADDED Requirements

### Requirement: Reclaim only verified unused workspaces

The existing post-release cleanup and timer-driven `cleanup-site` SHALL evaluate production paired workspaces under the fixed `/var/lib/ikpk-site-build/production-paired/` root, regardless of the profile selected for unrelated site cleanup or the absence of a publication marker. On staging194 it SHALL apply the same workspace lifecycle and cleanup rules under a separately fixed staging-only root. Deletion SHALL be restricted to verified real immediate child directories of the environment-specific root. A workspace SHALL be deleted only when its valid `.ikpk-workspace-identity.json`, directory name and durable paired-operation journal unambiguously identify the same source and completed operation and the workspace is proven unreferenced by all protected consumers. Unknown, missing, malformed, mismatched or ambiguous evidence SHALL retain the affected workspace; inability to establish the complete protected set SHALL prevent all workspace deletion. Age, ordering and broken dependency links SHALL NOT establish eligibility. Static-main workspaces, databases, uploads, backups and dependency generations SHALL NOT be deleted by this capability.

#### Scenario: Completed unused release
- **WHEN** a workspace belongs to a verifiably completed operation and no protected consumer or unfinished operation refers to it
- **THEN** cleanup removes it and reports its identity and reason

#### Scenario: Unknown workspace identity
- **WHEN** a marker or journal is missing, corrupt, inconsistent or ambiguous
- **THEN** cleanup retains the affected workspace and reports the evidence failure

#### Scenario: Protected set unknown
- **WHEN** running, next-start, rollback or unfinished-operation references cannot be established completely
- **THEN** cleanup deletes no workspaces and reports why

### Requirement: Align staging194 workspace lifecycle

Staging194 paired releases SHALL prepare an operation-identified workspace using the same lifecycle, marker and dependency-link rules as production paired releases, with its own fixed workspace root, settings, data and release admission. CMS refresh and restart SHALL use the admitted staging workspace. Before activation the effective CMS systemd sandbox SHALL grant the service write access to the new workspace while preserving the access needed to recover and refresh from the legacy workspace; actual refresh and restart SHALL verify both paths across a failed transition. Installation failure SHALL permit restoration of the prior service configuration. Recovery of the first interrupted transition SHALL restore the exact prior staging workspace and its environment; cleanup SHALL preserve both legacy and new workspaces when needed by active or unfinished operations. The change SHALL NOT apply production integration settings or production data paths to staging194.

#### Scenario: First staging transition is interrupted
- **WHEN** the first release using a staging paired workspace is interrupted before global commit
- **THEN** supported recovery restores the previous staging source workspace and its environment and a later refresh can use it

#### Scenario: Subsequent staging releases
- **WHEN** multiple staging paired releases complete
- **THEN** workspace creation, protected references, cleanup and retry exercise the same rules as production using staging-only resources

### Requirement: Preserve consumers and recovery

The protected set SHALL be derived from actual running CMS environment and process references, next-start service configuration and environment, the supported paired rollback target and its recorded environment, and all unfinished publication, restore and recovery operations. The workspace and dependencies required by each protected consumer SHALL remain usable. The cleanup SHALL retain potentially needed workspaces if state or reference resolution is uncertain and SHALL NOT assume that releasing an OS lock completes an operation.

#### Scenario: Recovery and subsequent refresh
- **WHEN** cleanup follows multiple paired releases and a later paired release is interrupted before global commit
- **THEN** the running CMS can refresh the site and restart, and the supported recovery restores the previous pair and permits another content refresh
- **AND** no post-commit CMS rollback capability is required

#### Scenario: Interrupted publication
- **WHEN** a paired publication or recovery is unfinished
- **THEN** any workspace it may need is retained and the reason is reported

### Requirement: Serialize and contain removal

Inventory, decision and deletion SHALL occur while holding the existing publication lock and the applicable operation journal locks in the established order, with site-refresh admission and reservations checked. If locks or required state cannot be acquired or validated, cleanup SHALL defer and remain retryable. The shared locks and admission checks SHALL serialize the supported publication, content refresh and recovery workflows throughout inventory and removal. Removal SHALL use symlink-resistant operations, SHALL NOT traverse symbolic links or nested mounts, and SHALL NOT intentionally delete outside the applicable workspace root. The owner accepts the residual risk of a non-cooperating process changing a workspace concurrently outside these locks; cleanup SHALL stop if it detects an unexpected identity or path change.

#### Scenario: Publication or refresh is busy
- **WHEN** a conflicting publication, restore or refresh holds the shared gate or leaves unresolved state
- **THEN** cleanup does not delete a workspace and the existing retry mechanism remains effective

#### Scenario: Workspace is replaced during cleanup
- **WHEN** cleanup detects that a candidate identity or path changed during its checks
- **THEN** cleanup refuses or stops and reports the change

### Requirement: Auditable preview and repeatable operation

Cleanup SHALL record each removed workspace and each retained candidate with its reason, and report inspection errors without claiming success. A non-destructive preview SHALL apply the same eligibility and lock checks and show delete or retain, reasons and estimated allocated bytes. Immediately before the first production application an operator SHALL present a fresh preview and total expected space to the owner; the application SHALL recompute decisions under locks and not trust a historical preview. The cleanup service SHALL have tested write access to the precise workspace root under its systemd sandbox. Repeated cleanup SHALL be safe, including after interruption. An interrupted deletion SHALL NOT leave a partial workspace accepted as ready under its original name; restart or retry SHALL use durable deletion evidence and preserve ambiguous state.

#### Scenario: Preview becomes stale
- **WHEN** a workspace becomes protected after the preview
- **THEN** the subsequent cleanup re-evaluates it under locks and retains it

#### Scenario: Deletion is interrupted
- **WHEN** cleanup stops after recording intent, moving a candidate, or deleting part of its contents
- **THEN** no partially deleted tree is accepted as a ready workspace under its original name
- **AND** retry safely resumes only with valid durable evidence or retains and reports ambiguous data

#### Scenario: Cleanup runs twice
- **WHEN** cleanup is repeated after successfully removing eligible workspaces
- **THEN** it safely reports current decisions without harming retained workspaces

### Requirement: Keep release cleanup independent and failures visible

On production, failure of the workspace step (including inability to establish the protected set, a stopped or reloading CMS service, an unsafe activation marker or lock contention with another production profile) SHALL NOT prevent cleanup of CMS releases in the same run. CMS release cleanup SHALL protect every CMS release that a dependency link (`web/node_modules`, `cms/node_modules`) of any immediate child of the fixed production workspace root points into, determined from the filesystem alone, in addition to the existing current, rollback and restart protection; a dangling or looping link protects nothing, and CMS release deletion SHALL be refused only if such a link cannot be read. Staging194 SHALL keep its existing behaviour. A run in which the workspace step failed SHALL still report failure (non-zero exit on the timer path, `cleanupPending` on the post-commit path) after completing CMS release cleanup.

Every run that reaches cleanup, on the timer and on the post-commit path, SHALL update a status file in the production-paired state directory recording the time of the last fully successful run, the number of consecutive failed runs, the last reason and whether workspace deletion is enabled; a fully successful run SHALL reset that count to zero. A run that refuses, disables deletion or removes anything SHALL append its workspace decisions, removals and reason to a size-bounded append-only log in the same directory. Refusals before cleanup starts (lock contention, refresh or publication in progress) are not counted; the age of the last successful run is the monitoring signal. On the timer path a failed run SHALL end with the existing cleanup failure (non-zero exit).

The production activation marker SHALL enable workspace deletion only when it is a root-owned empty regular file with mode 0600 and a single link. Any other marker SHALL disable workspace deletion and be reported as the reason, without failing the run.

#### Scenario: CMS stopped during cleanup
- **WHEN** the workspace protected set cannot be established because the CMS service is stopped or needs a daemon reload
- **THEN** no workspace is deleted, CMS releases not referenced by any workspace dependency link are still removed, and the run reports failure with the workspace reason

#### Scenario: Retained workspace keeps its dependencies
- **WHEN** a workspace is retained for any reason and its dependency links point into a CMS release that is neither current nor rollback
- **THEN** that CMS release is not removed

#### Scenario: Activation marker created with a default mode
- **WHEN** the activation marker exists with mode 0644
- **THEN** workspace deletion is disabled, the reason is reported and logged, and site and CMS release cleanup complete normally

#### Scenario: Persistent refusal is visible
- **WHEN** cleanup runs fail repeatedly
- **THEN** the status file shows the time of the last successful run and the growing count of consecutive failures, and the log contains each refusal reason

