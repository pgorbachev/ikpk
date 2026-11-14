# Historical registry cohort activation

This is the host half of the approved seminar migration. It requires the paired
host publication lock, the existing stopped-writer fence, verified off-host
backup, CI-admitted CMS artifact and independent migration/registry review.
It does not authorize production installation.

The existing database path and CMS pointer cannot be changed in one filesystem
transaction. The helper therefore commits a durable `historical-cohort-intent`
before either mutation, keeps editors closed, selects the exact reviewed database
and CMS, then atomically replaces the root-owned registry `current.json`. A
`historical-cohort-selected` record follows that replacement. CMS startup and
runtime checks follow; the existing static publication acceptance/global commit
is still required before editors reopen. This is atomic visibility under the
fence, not a claim that three filesystem writes form one transaction.

The version 2 manifest contains the separately approved registry identity, full
source commit, migration plan and original source database digests, candidate
database digest, runner artifact identity, CI CMS payload digest, exact proof
artifact digest, receipt digest, operation ID, selected CMS release/pointer and
live database device/inode. Readers verify the selected CMS and database identity.
They intentionally do not compare the current database content to its activation
hash: normal CMS edits must continue to work. Exception matching still checks
published row/version/content fingerprints. Replacing the database file or
changing the CMS pointer without a coordinated activation fails closed.

## Host/runner handoff

`_activate_cms` requires `state`, `operation_id` and `cohort_admission` for a source
containing `web/scripts/lib/historical-exceptions.ts`. Admission has
`registryPath`, `receiptPath`, `receiptSha256`, and independently reviewed `binding`.
The runner receipt must be `prepared` and contain the same `registryBinding`.
The binding has version 1, operationId, sourceCommit, migrationPlanDigest,
sourceDatabaseSha256, candidateDatabaseSha256, registrySha256,
cmsArtifactSha256 (runner logical artifact fingerprint), and proofArtifactSha256
(the CI-admitted proof archive payload digest). Paths are transport details,
never authority. The independent expected binding must not be reconstructed from
the writable receipt.

The host verifies all these bytes and identities, source file/WAL fingerprint,
and the fenced backup's live database digest. It does not turn a partial
composition audit into approval. The companion admission/runner implementation
must repeat that audit, verify the externally pinned registry review and only
then set `prepared`/`registryBinding`. Until it supplies this handoff, activation
is deliberately unavailable.

## Recovery and installation

Retain the old registry file and full prior manifest in the initial `oldPair`
before backup as well as in the activation intent. Existing
`recover` restores the verified off-host database backup and old code/static
pointers before restoring the prior manifest and starting CMS. The prior manifest
is rebound to the verified restored database inode because atomic database
restore creates a new inode. Recovery journals the exact baseline before a DB
replace, and seals the restored database identity and manifest before the
terminal `recovered` row. Crashes after this seal retry without recopying the
database. Terminal retries only validate identity: in-place editorial writes are
allowed, replacing the database inode is rejected. Older unsealed operations may
acquire a missing baseline only while the original cohort still verifies, before
a separately verified backup is restored. They cannot invent that baseline from
an already replaced database. An interrupted first activation removes its new
manifest on recovery. A manifest belonging to a different operation is never
overwritten. Existing global-commit/editor-reopen restrictions continue to apply.

Before use on 194, install the exact admitted helper with its updated
`rehearsal_state.py` and `housekeeping_journal.py`, then provision
`/etc/ikpk-cms/seminar-history` as a root-owned, non-group/other-writable directory
readable/traversable by the CMS service. CMS and web artifacts must contain the
matching version 2 readers. An existing version 1 manifest is insufficient
cohort evidence; do not blindly overwrite it or claim it proves a rollback
baseline. Complete the runner/operator admission integration, independent crash
and drift tests and rehearsal before enabling live migration. Production uses
the same mechanism only after its separate release/admission and acceptance.

## Root-sealed dependency generations

A runner advertising `ROOT_SEALED_DEPENDENCIES_VERSION = 3` selects a separate
`full-build-sealed-v3` dependency generation. The host requires a dedicated non-login `ikpk-deps` UID and primary group,
separate from CMS and with no supplementary group membership. The installer
runs in an inner work directory behind a root-owned `0710` outer directory
traversable only by that group. Neither CMS nor an installer chmod of its inner
work tree can expose that tree to CMS. The host invokes the validated canonical
Node binary with the root-controlled npm CLI explicitly; the lifecycle PATH
contains a root-owned alias of the same Node. Version checks and npm ci use this
same isolated command, with `env -i`, private HOME/cache and no npm user/global
configuration or CMS secrets.

The transient unit uses a dedicated UID, `NoNewPrivileges`, no capabilities,
`ProtectSystem=strict`, `ProtectHome`, cgroup protection, and namespace/SUID
restrictions. `KillMode=control-group` and an explicit stop are followed by a
complete process-UID check: no seal is written while any installer process
survives. A missing account, unsafe group membership, untrusted runtime or
unavailable process inspection fails closed. The install is never run as CMS
or root. Both install input files come from bytes of the CI CMS archive whose
SHA-256 equals the externally admitted payload digest, never from mutable checkout
files. The package.json digest also participates in the generation cache key, so
changing root lifecycle scripts cannot reuse a lock-only installation.
It then copies the install into new root-private inodes using descriptor-relative
`O_NOFOLLOW` traversal, hashes those copied bytes, checks every copied symlink
stays inside the generation, and publishes a root-owned read-only tree. It does
not chown the original install in place: an already-open CMS write descriptor
would survive that permission change.

The root-written `.ikpk-install-provenance-v3.json` lives next to `node_modules`,
not inside the CI CMS artifact. It is readable by CMS and binds the generation
path and inode, exact dependency tree digest, package.json/package-lock digests, Node version
and ABI, npm CLI path/digest, npm/Strapi versions, dedicated installer UID/GID,
cgroup-drained isolation, observed command/exit status and timestamp. Every
ancestor must be root-owned and not writable by CMS. The host reuses only this
protected generation; existing CMS-owned caches are not promoted into a seal.
The runner remains unprivileged and requires an exact Linux read-only mount of
that dependency root, supplied by `ReadOnlyPaths` on the preparation unit.

The runner artifact fingerprint includes the exact proof-file digest and tree
digest instead of rereading every dependency on each reviewed stage. Invalid
present proof files fail closed. Older runner versions retain their full-content hash contract. The v3 runner
requires its root-owned attestation for every external dependency tree, including
when the checkout claims legacy capability; there is no v3 fallback. Host preparation
and prepared-candidate validation select capability from CI-pinned archive bytes. Version 2 service-user installations are
not admitted by this version 3 path or reused as its cache. Switching a prepared operation between
identity methods is refused by the existing receipt checks.

The first generation still pays for npm installation and one complete protected
copy/hash. Repeated preparation avoids the large vendor-tree scan; the 3600-second
prepare limit is unchanged. Linux/systemd mount and actual Strapi startup must be
rehearsed before live use. Local tests cover the filesystem boundary and parser
with an explicit test UID/mount fixture; they are not a Linux host execution.

Provision `ikpk-deps` once, only if that user/group does not already exist:
`useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin ikpk-deps`.
Do not repurpose an existing UID or grant it CMS, Docker, sudo or other groups.
The helper validates the actual account before use and does not modify accounts.
On 194 the existing root-controlled `/usr/bin/node` and `/usr/bin/npm` symlinks
resolve to `/opt/node-v22.23.5/...`; aliases are supported after validation of
canonical files and their root-owned ancestors.

The transient service/termination contract follows the official
[systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)
and [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
documentation. Account isolation, effective mounts and successful Strapi startup
still require the separate Linux rehearsal.


Closed migration execution uses a separate protected copy under
`releaseRoot/../migration-code/<source>-<operation>-<payload-prefix>/cms-artifact`.
The helper creates fresh root-owned files directly from the admitted tar bytes,
retains the same absolute sealed `node_modules` link, and provides an empty uploads
directory. All ancestors are root-controlled. Every resume checks the exact
archive digest, completion identity, protected paths and all copied bytes.
A directory is published only after its files and directories are fsynced; a crash
before publication leaves an unselected partial directory, while a crash after
publication reuses the validated copy. Partial directories are not automatically
removed after a process crash.

Both `prepare` and `status` execute the protected runner and use its artifact
path. Candidate DB, receipt, reviews and stage snapshots stay in the existing
CMS-private operation directory. The receipt records the protected execution
path; its logical artifact fingerprint is unchanged because copied bytes and the
absolute dependency link are identical. The active CMS artifact stays in its
existing path for runtime caches/uploads, and existing pre-activation checks
continue to verify it against the admitted archive. This copy protects closed
migration execution; it does not change the ownership policy of running CMS code.
