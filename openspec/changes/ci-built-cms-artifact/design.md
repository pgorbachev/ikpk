## Context

The existing host preparation builds a checked CMS artifact before writer fencing and keeps dependency generations tied to the lockfile, Node version, ABI and platform. Its later steps back up and migrate live-derived data only after the fence. The artifact builder carries migrations and runner files beyond the compiled administration output.

## Goals / Non-Goals

**Goals:** move CMS build work off the small host while retaining the existing release and data safety contract for both environments.

**Non-Goals:** a new deployment service, copying live data into CI, automatic production deployment, or requiring a GitHub Release or a single artifact for both environments.

## Decisions

1. Build only from an admitted trusted CI run for the selected full SHA. Bind downloaded bytes to independently verified run/attempt and integrity evidence. Reuse the existing operator and CI admission; do not treat an untrusted pull-request artifact or a self-declared manifest alone as authority.
2. Reuse the existing CMS artifact builder and migration payload checks. Determine by an isolated experiment whether compatible dependency bytes can be included, or whether the existing verified target dependency generation must be reused. Never silently fall back to a CMS build on the destination. Reject compatibility ambiguity before the writer fence.
3. Verify the compiled administration behavior for the target public paths with non-secret test settings; never carry target database, uploads, secret environment or host-specific symlinks in the artifact. One common artifact is allowed only if both targets' actual runtime and compiled behavior are proven compatible.
4. Integrate only at the existing prepare boundary; the same admitted candidate proceeds through the unchanged fence, backup, candidate migration, activation, health and recovery sequence. The overlapping active changes are updated in this revision; verify their applicability against the current main specs before implementation or merge.

## Risks / Trade-offs

- Native binaries or Node ABI differ between CI and a host → record and verify actual platform identity and exercise native module loading in a target-equivalent environment; refuse unknown compatibility.
- Artifact retention or CI permission may prevent retrieval → fail before fencing; do not create another storage service to mask the failure.
- A clean build can still fail migration or rollback → CI proof does not replace existing data and runtime acceptance.

## Migration Plan

First establish a target-equivalent isolated build and consumer proof, including negative provenance and compatibility tests. Integrate the operator only after the proof and approved spec; rehearse on 194 after its explicit handoff, then leave production deployment to a separate authorization. Recovery remains the existing explicit path.
