## ADDED Requirements

### Requirement: Static-only publication reuses verified content when unchanged

For staging194 `static-main`, the host SHALL reuse the current static release's sealed database capture when its committed journal, source and snapshot identities, root-journal-anchored capture digests, SQLite integrity, and complete CMS fingerprint match the live inputs. It SHALL seal a new capture bound to the admitted source SHA, verify the copied database digest, and record the source capture operation ID. It SHALL NOT take another live SQLite snapshot for this matching case.

#### Scenario: Unchanged CMS inputs and valid prior capture

- **WHEN** a frontend-only release is prepared and all reuse proofs match
- **THEN** the database bytes come from the prior sealed capture, the new capture is verified, and the journal names the reused operation

#### Scenario: Changed inputs or invalid prior capture

- **WHEN** the live fingerprint differs or a required proof is missing or invalid, including old journal rows without capture digests
- **THEN** the host creates and verifies a new read-only SQLite snapshot before building the candidate

#### Scenario: Capture changes while being copied

- **WHEN** reused database bytes differ from the previously verified digest after copying
- **THEN** preparation fails before candidate acceptance or pointer switching
