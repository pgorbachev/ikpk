## Purpose

Make a CI-built CMS candidate safe to admit and install for an exact source revision without building the CMS on the destination host.

## ADDED Requirements

### Requirement: The CMS artifact is built without live inputs

The delivery process SHALL build the complete CMS candidate from the admitted source in a trusted CI run without access to live databases, uploads or production secrets. It SHALL include the configuration, migrations and migration-runner payload required by the existing artifact checks. Live media and host-specific paths SHALL remain outside the artifact. For staging194 and reusable production paired CMS deployment, the destination SHALL NOT build the CMS candidate. The fixed historical initial production operation retains its original contract.

#### Scenario: CI build lacks production data
- **WHEN** the CMS candidate is built in CI
- **THEN** no production database, media or production secret is supplied to the build
- **AND** the existing artifact and migration payload checks pass on the produced candidate

### Requirement: Only a verified compatible artifact is admitted

The operator SHALL bind the artifact and its integrity evidence to the exact admitted source revision and trusted CI run and attempt. Before fencing writers or changing live state, it SHALL verify the artifact bytes, the lockfile identity and compatibility of the runtime and all native dependencies with the target. It SHALL bind the admitted artifact digest to the operation and ensure the exact verified bytes are consumed at migration, activation and retry, using revalidation or equivalent immutable staging. Missing, mismatched, untrusted or unverifiable evidence SHALL cause refusal before the relevant mutation.

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

Staging194 and reusable production paired CMS deployment SHALL keep the existing mutually exclusive admission, writer fence, verified backup, candidate database migration, activation, health and media checks, and explicit recovery or rollback contracts. Static-only publication retains its existing separate contract. A successful artifact build SHALL NOT be treated as proof that a live migration or deployment succeeded.

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
