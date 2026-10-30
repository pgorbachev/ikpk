## ADDED Requirements

### Requirement: Paired recovery restore events bind to their operation

A restore event appended by a paired deployment recovery SHALL be durably bound to the paired operation ID, restored content fingerprint, and expected previous entry. Existing append-only entries SHALL NOT be rewritten. The added binding SHALL remain readable by the previous CMS reader, and the current reader SHALL verify both the existing entry integrity and paired-operation binding. A retry SHALL accept only the exact event for its operation; a same-fingerprint event for a different operation or any other journal advance SHALL fail closed. The HWM remains monotonic. Concrete fields and checksum construction are described in the paired-deployment design.

#### Scenario: Retry observes the operation's own restore event
- **WHEN** the canonical branch contains the exact next restore entry for this operation, fingerprint, and prior entry
- **THEN** retry verifies both integrity bindings and proceeds without appending a duplicate

#### Scenario: The prior CMS reader verifies a new restore entry
- **WHEN** the previous production CMS reader loads a newly appended paired-recovery restore entry
- **THEN** it validates the entry using its existing integrity rule and remains compatible with the added binding

#### Scenario: Another operation restored the same content
- **WHEN** the canonical branch contains the same restored fingerprint but a different operation ID
- **THEN** retry does not accept that entry as its own and keeps writers fenced

#### Scenario: A different event advanced the journal
- **WHEN** the expected restore event is not the next canonical entry
- **THEN** retry refuses to append or reopen writers until the journal discrepancy is reconciled
