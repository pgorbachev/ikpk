## ADDED Requirements

### Requirement: Reuse only a verified terminal staging194 capture for static-only builds

The staging194 `static-main` operator SHALL accept the optional `--reuse-capture-operation-id <operation-id>` to select an existing sealed CMS/content/media capture. It SHALL reuse only a capture whose operation belongs to the staging194 target and profile, has durable `prepared` evidence and sealed manifest/bundle digests, and is terminal as `committed` or `recovered`. A recovered operation without durable preparation evidence SHALL be refused. The capture path SHALL be confined to the configured immutable operation store, have the expected owner and permissions, contain no symlink traversal, and pass the existing manifest, database, schema, media-manifest, media-byte, and capture-proof digest checks. The operation record and manifest host/site/source identity SHALL agree with staging194. Its original `sourceSha`, operation ID, snapshot ID, reference date, origin, and capture proof SHALL remain intact.

Before building, the operator SHALL compare the current read-only CMS fingerprint with the fingerprint recorded by the selected terminal operation. It SHALL verify that the current build source uses the same schema/mapping digest as the capture, and that the original snapshot's content fingerprint and snapshot ID verify against its unchanged reference date. A mismatch or missing/unreadable identity SHALL stop the operation before candidate publication. The operator SHALL materialize the selected operation's validated snapshot files and media store byte-for-byte as build input, without recapturing CMS data or regenerating the snapshot for today's date. This check SHALL NOT create a new SQLite image, CMS backup, or content capture. The existing `static-main` path without the reuse option retains its current fresh-capture behavior.

The new static build SHALL remain bound to the exact current canonical `main` SHA and its four successful required CI workflows. Its operation record SHALL bind the new build source SHA, CI run/attempt, new operation ID, selected capture operation ID and original source SHA, the existing `captureProof.bundleDigest` and snapshot identity, and new static-tree digest. The release SHALL identify the new code SHA, new operation ID, and reused snapshot ID without rewriting the capture's source provenance; the snapshot proof SHALL continue to identify the original capture operation. Browser acceptance, pre-commit CMS fingerprint preservation, static-only activation, and explicit compare-and-swap rollback SHALL continue to apply. CMS/DB/uploads/rights, production publication, and CMS migration paths SHALL remain unchanged.

#### Scenario: Reuse a sealed capture from a committed operation across a date boundary

- **WHEN** an operator selects a staging194 capture from a committed operation on a later UTC date and its recorded CMS fingerprint and schema/mapping identity still match
- **THEN** the operator verifies the durable preparation evidence and existing capture proof, then builds the current admitted `main` from the original snapshot files and media bytes
- **AND** the original reference date and snapshot ID remain unchanged
- **AND** the new operation records both the original capture provenance and the new build provenance
- **AND** no new SQLite image, CMS backup, or content capture is created

#### Scenario: Reuse a prepared capture after recovery

- **WHEN** an operator selects a capture from a recovered staging194 operation that has durable preparation evidence and a sealed capture bundle
- **THEN** the operator may reuse it after the same ownership, integrity, and current-fingerprint checks as a committed capture
- **AND** a recovered operation without durable preparation evidence is refused before build or activation

#### Scenario: Refuse a capture incompatible with the current build source

- **WHEN** the current source's schema/mapping digest, snapshot content fingerprint, or snapshot ID does not match the selected sealed capture
- **THEN** the reuse operation stops before build or activation and preserves the selected capture unchanged

#### Scenario: Refuse stale, unsafe, or mismatched capture input

- **WHEN** the selected operation is nonterminal, belongs to another target/profile, lacks durable preparation evidence, has an unsafe path or invalid ownership, has a digest/provenance mismatch, or its recorded CMS fingerprint differs from the current CMS
- **THEN** the operator stops before candidate publication and reports the failed identity check
- **AND** it does not silently substitute a fresh capture or alter CMS/data/static pointers

#### Scenario: Keep current build and static rollback acceptance

- **WHEN** a reused capture passes validation and the new candidate is built
- **THEN** the served release identifies the new exact `main` SHA and the reused snapshot ID, while the capture manifest retains its original `sourceSha`, operation ID, reference date, origin, and proof
- **AND** all subprocesses from dependency installation through build consume the selected capture and immutable materialized snapshot inputs (`snapshot.json`, optional metadata files, and media content store) as read-only input, owned by the configured CMS build user and unchanged after the build
- **AND** newly generated derivative/output directories remain writable build outputs
- **AND** exact CI revalidation, desktop/mobile browser acceptance, CMS fingerprint preservation, and explicit rollback to the exact previous static tree remain required
