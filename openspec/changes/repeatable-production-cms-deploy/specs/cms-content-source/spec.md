## ADDED Requirements

### Requirement: Production paired recovery is bound to its operation backup

A production-paired operation SHALL bind its source, old CMS/schema identity, verified off-host backup digest, and captured content snapshot fingerprint in that operation's existing host journal and backup sidecar. Before static publication, the browser-checked production snapshot fingerprint SHALL equal the fingerprint projected from those verified backup bytes. Production paired operations SHALL NOT read, write, initialize, or reset the shared stand CMS provenance ledger. Existing stand publication history and ledger behavior SHALL remain unchanged.

#### Scenario: Production content differs from the stand ledger
- **WHEN** the live production content fingerprint differs from the latest fingerprint in the shared stand ledger
- **THEN** production-paired admission uses the verified production backup and operation journal without reading or changing the stand ledger

#### Scenario: Candidate differs from this operation's backup
- **WHEN** the browser-checked production snapshot fingerprint differs from the fingerprint projected from this operation's verified off-host backup
- **THEN** the operator refuses the static switch and keeps the production operation fenced for same-ID recovery

#### Scenario: Stand history remains untouched
- **WHEN** a production-paired backup, publication, or recovery is processed
- **THEN** no entry or high-water mark in the shared stand CMS provenance ledger is created, changed, or reset

#### Scenario: A new operation follows a prior production operation
- **WHEN** a new production-paired operation starts after an earlier operation is terminal
- **THEN** its old-pair and verified backup capture the then-current production CMS and media state, and recovery remains bound to that new operation's ID and backup

### Requirement: Production paired recovery cannot restore a stale operation

A staged production restore SHALL reopen writers only when the exact operation journal records the restore fingerprint and restored database digest, the current database still has that digest, the CMS/media payload matches the journaled old pair, and the old CMS and static targets are selected. A terminal or committed operation SHALL NOT restore a prior pair. If any required evidence is missing or differs, the host SHALL remain fenced.

#### Scenario: Retry finalizes the exact staged restore
- **WHEN** the same operation retries finalization and the staged fingerprint, database digest, CMS/media payload, and old pointers still match
- **THEN** the host completes the existing recovery idempotently without another database/media restore

#### Scenario: Restore evidence differs from the operation
- **WHEN** the staged fingerprint or restored database/media bytes do not match the operation journal and verified backup
- **THEN** finalization refuses to reopen writers

#### Scenario: A prior terminal operation is reused
- **WHEN** recovery is requested for an already committed or recovered operation
- **THEN** the host refuses a database restore and does not switch CMS or static pointers to the old pair
