## Why

CMS builds on the small deployment host can exhaust memory and make the release process slow and unpredictable. Build the CMS in CI and install a verified artifact for the admitted source revision, while retaining the existing data-safety and recovery boundaries.

## What Changes

- Prepare and verify the complete CMS build in GitHub Actions without production data or secrets, and bind the resulting artifact to the exact source, trusted CI run and target-compatible runtime.
- Have the existing deployment flow validate and consume the admitted artifact before fencing or changing live data, rather than build the CMS on the destination.
- Preserve the existing writer fence, verified backup, migration, activation, health checks and explicit recovery; do not make a GitHub Release or one shared archive a prerequisite without evidence.
- Reconcile the overlapping host-build requirements in the active deployment changes before implementation or merge.

## Capabilities

### New Capabilities

- `ci-built-cms-artifact`: provenance, compatibility and safe consumption of the CI-built CMS artifact.

### Modified Capabilities

None.

## Impact

CMS build and deployment scripts, CI, deployment tests and the existing staging194 and production deployment contracts. No server or production data changes are authorized by this proposal.
