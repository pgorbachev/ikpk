## ADDED Requirements

### Requirement: Retain static-main sources by journal state

On `production-static`, after a static-main operation records `static-main-committed`, the existing post-commit cleanup SHALL remove every immediate child of the profile's `releaseRoot` named `<40-hex sha>-<operationId>` whose operation the profile journal records as a terminal static-main operation, including the operation just committed. Terminal and unfinished states SHALL be those of the existing journal state machine. If any operation is unfinished, the existing cleanup refusal SHALL apply and no source SHALL be removed. Entries that do not map to a static-main operation in the journal SHALL NOT be removed and SHALL be listed in the cleanup result as `retainedUnknownStaticSources`. Age and modification time SHALL NOT affect decisions. Removal SHALL NOT follow symbolic links or cross mount points; an entry that cannot be removed safely SHALL be kept and listed in `retainedUnknownStaticSources` without stopping removal of the others. The operator client SHALL report `cleanupPending` and every kept entry. If the journal cannot be read or the root cannot be validated, nothing SHALL be removed and the run SHALL report `cleanupPending`; a later commit retries.

#### Scenario: Production publication completes
- **WHEN** a static-main operation commits on `production-static` and older terminal operations left source trees in `releaseRoot`
- **THEN** every terminal operation's source tree, including the one just committed, is removed

#### Scenario: Unfinished operation on production
- **WHEN** another operation is unfinished
- **THEN** cleanup refuses and no source tree is removed

#### Scenario: Unknown entry on production
- **WHEN** `releaseRoot` contains a directory that does not match a static-main operation in the journal
- **THEN** it is kept and listed in `retainedUnknownStaticSources`

#### Scenario: Rolled-back operation
- **WHEN** an operation ended as `static-main-rolled-back` or `static-main-rollback-expired`
- **THEN** it is treated as terminal and its source tree is removable

### Requirement: Committed retry does not need the source

A repeated `static-main` request for an operation that the journal already records as `static-main-committed` SHALL report the committed result without reading the operation's source tree, so that a client retry after a lost connection succeeds after the source has been removed.

#### Scenario: Retry after the source was removed
- **WHEN** the client repeats `static-main` for an operation that is already committed and whose source tree was removed
- **THEN** the host reports the operation as committed and does not fail on the missing source

### Requirement: Keep the newest usable capture on staging194

On staging194, every path that runs CMS release cleanup in the shared `releaseRoot` (post-commit of paired and static operations, and the `cleanup-site` timer) SHALL protect exactly one static source tree: the capture referent of the most recent operation (by journal position) that satisfies the journal conditions of the existing reuse check (`_verify_reusable_static_capture`). The referent SHALL be the source tree of the capture that operation reused, if it reused one, otherwise its own source tree, and SHALL be protected only if it still exists. All other static source trees on staging194 SHALL remain removable as today.

#### Scenario: Latest operation used a fresh capture
- **WHEN** the most recent eligible operation C captured its own content
- **THEN** C's source tree is kept and reuse of C remains possible

#### Scenario: Latest operation reused an earlier capture
- **WHEN** the most recent eligible operation C reused the capture of operation A
- **THEN** A's source tree is kept, C's source tree is removable, and reuse of A remains possible
