# Historical occurrence exception registry

The paired static build and CMS refresh read a root-owned registry manifest at
`/etc/ikpk-cms/seminar-history/current.json`. It has version 1 and requires
`registrySha256`, `sourceDatabaseSha256`, `migrationPlanDigest` (all lowercase
SHA-256), and `sourceCommit` (full lowercase 40-character Git SHA). The registry
is the JSON array `registry-<registrySha256>.json` in the same directory. Both
files must be regular, single-link, root-owned and not writable by group or
others. Every ancestor directory must be root-owned and not writable by group or
others. The CMS user needs read and traversal access. The reader verifies the
registry bytes against the manifest before passing its path and digest to both
capture and build. Staging194 and production refresh require the manifest; a
missing or malformed installation fails the operation before site activation.

A content-addressed registry file can be prepared before atomic replacement of
`current.json`. Capture/build recheck the digest of that manifest to detect a
concurrent change. The old manifest and registry must be retained for rollback.

The original version 1 manifest is a delivery-only record. Active paired builds
and CMS refresh now require a version 2 cohort sealed by the host coordinator.
See [cohort activation](historical-registry-cohort.md) for the independently
reviewed runner handoff, durable intent, actual code/database identity checks and
recovery. Merely writing a root-owned version 1 manifest does not authorize
activation.
