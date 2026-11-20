## MODIFIED Requirements

### Requirement: Production content is backed up and remains production-owned

The paired operation SHALL capture the live production SQLite database and uploads as its only content source; it SHALL NOT import staging194 database, media, users, roles, or content. It SHALL NOT consult the shared stand CMS provenance journal or its high-water mark because that journal has no destination scope and records stand state. Before any live database mutation, the operator SHALL close and verify all CMS writers, checkpoint SQLite WAL, prove no CMS process holds the live database, and create an integrity-checked database-and-media backup whose bytes and manifest are verified off-host. The backup manifest and existing host operation journal SHALL bind the operation, source, old CMS/schema identity, database identity, projected content fingerprint, media names and permissions, and archive digest. Candidate migration and audit SHALL preserve existing production users, roles, permissions, content, and media references except for exact reviewed changes declared by the release. Before static switch, the production candidate snapshot SHALL satisfy the cms-content-source Requirement: Reviewed migration proves the expected production content. For each new operation, the captured live production state becomes that operation's old-pair and backup baseline; unexplained candidate changes SHALL prevent activation. Production paired publication SHALL NOT use the staging frozen-capture exception or initial-prod proof.

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
- **WHEN** the production candidate snapshot fails the comparison defined in the cms-content-source Requirement: Reviewed migration proves the expected production content
- **THEN** the operator refuses the static switch and keeps the same operation fenced for recovery

#### Scenario: Migration changes existing identities or unrelated data
- **WHEN** the migration audit finds unapproved changes to existing users, roles, grants, content, or media references
- **THEN** the candidate is not activated and the operation remains recoverable before commit
