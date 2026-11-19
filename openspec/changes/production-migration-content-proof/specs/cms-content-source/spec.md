## MODIFIED Requirements

### Requirement: Production paired recovery is bound to its operation backup

A production-paired operation SHALL bind its source, old CMS/schema identity, verified off-host backup digest, and captured content snapshot fingerprint in that operation's existing host journal and backup sidecar. Before static publication, the browser-checked production snapshot SHALL satisfy Requirement: Reviewed migration proves the expected production content. Production paired operations SHALL NOT read, write, initialize, or reset the shared stand CMS provenance ledger. Existing stand publication history and ledger behavior SHALL remain unchanged.

#### Scenario: Production content differs from the stand ledger
- **WHEN** the live production content fingerprint differs from the latest fingerprint in the shared stand ledger
- **THEN** production-paired admission uses the verified production backup and operation journal without reading or changing the stand ledger

#### Scenario: Candidate differs from this operation's backup
- **WHEN** the browser-checked production snapshot fails the comparison defined in Requirement: Reviewed migration proves the expected production content
- **THEN** the operator refuses the static switch and keeps the production operation fenced for same-ID recovery

#### Scenario: Stand history remains untouched
- **WHEN** a production-paired backup, publication, or recovery is processed
- **THEN** no entry or high-water mark in the shared stand CMS provenance ledger is created, changed, or reset

#### Scenario: A new operation follows a prior production operation
- **WHEN** a new production-paired operation starts after an earlier operation is terminal
- **THEN** its old-pair and verified backup capture the then-current production CMS and media state, and recovery remains bound to that new operation's ID and backup

## ADDED Requirements

### Requirement: Reviewed migration proves the expected production content

If the operation did not freshly apply a full reviewed public-content transformation, including an inherited or no-op cohort, the comparison SHALL require equality to the verified backup projection when fingerprint semantics are identical; if semantics differ, the version-bound semantic comparison below SHALL establish equivalence or refuse. The transformed comparison is allowed only when a fresh production receipt proves that this operation applied the full reviewed composition. For the transformed comparison, an independent closed-world audit SHALL compare the verified backup-derived source and the exact candidate across the complete schema and every record and field, including additions, deletions, identifiers, users, roles, permissions, content and media references. Only exact reviewed changes admitted by the full ordered composition are allowed; unknown or unaudited fields, records, tables or changes SHALL fail closed. The actual migration stages SHALL pass their original byte-bound composition contract, including independently admitted plan and stage identities and source-to-candidate lineage; the verified off-host backup SHALL be proven to correspond to that source. The exact candidate SHALL be proven to correspond to the final audited stage and the browser-checked target snapshot. Original uploads SHALL be verified from the same backup. The audit SHALL independently compare public preimage and target projections with their bound historical and admitted target projectors, accounting for each approved transformation and all unaffected content. A second execution of the migration SHALL NOT be required. For a prior cohort declaring a historical registry, the preimage and restore projection SHALL bind its exact old release registry bytes and digest; unavailable or mismatched declared bytes SHALL refuse the operation. A legacy old pair without a prior registry cohort SHALL instead require positively established absence in the operation journal oldPair before any switch and use a deterministic empty projection; it SHALL NOT claim synthetic empty bytes were an actual registry. The transformed target projection and candidate SHALL bind the operation-approved target registry bytes and digest. Both paths SHALL clear untrusted ambient registry overrides. The original CMS schema and the complete reproducible historical projector remain bound to the preimage and recovery. Its exact source revision, field map, capture and fingerprint semantics, transitive source dependencies and required fixtures SHALL be verified and bound to the operation separately from old CMS/schema SHA. Recovery of an existing operation SHALL preserve its originally bound projector identity and semantics even when its source SHA differs from the old CMS SHA; passing an old schema to a newer projector SHALL NOT by itself establish compatibility. Runtime and dependencies SHALL be pinned and available without installing on production; inputs SHALL be processed from the verified backup copy with controlled environment and no CMS or external writes. For a transformed comparison, the proof SHALL bind the operation ID, release source SHA and admission, original backup digest and old CMS/schema identity, fresh production receipt and its registry binding, migration contract, exact reviewed plan and step digests, every applied migration and its order, target schema and projector, input and resulting content identities, complete before/after audit result, and the browser-checked candidate static digest. It SHALL establish that the applied composition matches the reviewed declaration and that the migration audit accepts all changes. The fresh receipt and its bindings SHALL be independently checked against the operation journal; a stand receipt SHALL NOT be accepted. Ordinary and inherited/no-op comparisons SHALL NOT require a fresh migration receipt. If source and target use different projector or fingerprint semantics, raw fingerprints SHALL NOT be compared as though they share a contract: the operation SHALL use a separately reviewed, version-bound semantic comparison that establishes equivalence of all unaffected public content or refuse the switch. Snapshot IDs SHALL NOT serve as cross-version equivalence proof. Missing, ambiguous, conflicting, incomplete or unreviewed evidence SHALL refuse the switch. A receipt, plan-stated fingerprint or candidate self-report SHALL NOT alone establish the content.

The original backup and its original fingerprint, recomputed using the same bound historical projector and registry identity, SHALL remain the only source for pre-commit recovery; migration proof SHALL NOT substitute the expected candidate fingerprint for restoration. Existing restore digest, old-pair, writer-fence, and post-commit restrictions SHALL remain in force.

#### Scenario: No content transformation
- **WHEN** the admitted release declares no reviewed public-content transformation
- **THEN** the candidate equals the original verified backup projection under identical semantics, or passes the reviewed version-bound semantic comparison; any unexplained difference refuses the switch

#### Scenario: Inherited or no-op migration
- **WHEN** a migration cohort was inherited or did not freshly apply the full composition in this operation
- **THEN** the candidate equals the original verified backup projection under identical semantics, or passes the reviewed version-bound semantic comparison

#### Scenario: Reviewed transformation
- **WHEN** a fresh reviewed composition produces a candidate and the independent closed-world audit accepts all changes against the verified backup
- **THEN** the audited final candidate and its target projection are bound to the exact browser-checked candidate
- **AND** the switch proceeds only if every binding and fingerprint matches

#### Scenario: Incomplete or altered proof
- **WHEN** the backup, operation, source, production receipt, registry binding, target schema or projector, old or target registry, plan, step order, audit, candidate digest or projected content identity is missing or differs from its bound evidence
- **THEN** the switch is refused and the operation remains fenced for same-ID recovery

#### Scenario: Recovery after transformation
- **WHEN** the operation requires pre-commit recovery after candidate migration
- **THEN** recovery verifies and restores the original operation backup and original fingerprint under the existing restore contract

#### Scenario: Initial lineage and historical registry
- **WHEN** a fresh production operation initializes its first migration lineage or uses nonempty historical registries
- **THEN** the independent before/after audit is checked against the actual byte-bound stage evidence and exact old and target registry identities
- **AND** operational metadata is covered by explicit audit rules and does not cause the original contract to be rewritten
- **AND** inherited registry environment values cannot alter either projection

#### Scenario: Legacy old pair has no historical registry
- **WHEN** the pre-switch operation journal positively establishes that the old pair has no registry cohort and the first fresh production migration is applied
- **THEN** preimage and restore use a deterministic empty projection identified as an absence, not a fabricated registry file

#### Scenario: Declared old registry is missing
- **WHEN** the old pair declares a registry but its exact bytes and digest are unavailable or differ
- **THEN** the operation refuses rather than treating the registry as absent

#### Scenario: Old schema needs its historical projector
- **WHEN** the backup schema belongs to an older source with a different field map
- **THEN** preimage and recovery use the complete historical projector from the separately bound projector revision, and do not silently substitute the target projector

#### Scenario: Projector versions differ
- **WHEN** source and target projections use different field maps or fingerprint semantics
- **THEN** the operation refuses unless a reviewed version-bound semantic comparison proves unchanged public content and the explicitly approved transformations
- **AND** it does not infer equivalence from two raw fingerprints or snapshot IDs

#### Scenario: Historical projector provenance differs
- **WHEN** the historical source revision, map, schema, helper, fixture, runtime, registry identity or backup does not match the bound proof
- **THEN** projection and recovery refuse without substituting current code or defaults
