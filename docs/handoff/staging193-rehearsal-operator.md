# staging193 rehearsal operator

This legacy-named runbook now describes the custom staging194 operator: its root-owned config and SSH binding target `https://194.226.99.10`. The existing dev `cms-update`/`static-publish` sequence remains unchanged and still admits only exact `dev` plus its successful `Tests` push run. `staging.ikpk.su` resolves to a different host and is not used here. CMS migration/build runs under the CMS account; the bounded host helper performs systemd, Nginx, database, and pointer operations only for that existing dev workflow.

## Staging194 helper lock cutover

Before the first helper installation that replaces a legacy staging194 launcher, require an explicit exclusive owner handoff confirming that no legacy helper command remains in flight. The legacy launcher imported its host modules before acquiring the destination lock, so the lock by itself cannot exclude a process that already loaded the old helper and has not yet reached the lock. Do not perform that first replacement without the handoff. After cutover, the generated staging194 launcher acquires the existing `/var/www/ikpk/.publication.lock` before importing the helper for every host action that uses that destination lock. `status`, `space-preflight`, and `validate-config` remain outside this pre-import lock path; production profiles are unchanged.

After reviewed code and exact candidate CI are ready, install the bounded helper and prepare the existing CMS unit to use `/opt/ikpk-cms-prototype193/current`:

```sh
bash scripts/install-rehearsal-host.sh --prefix /usr/local
bash scripts/bootstrap-staging193-current.sh
bash scripts/install-rehearsal-host.sh --prefix /usr/local --staging193-config
```

The bootstrap checks the current unit identity and original release path, saves the effective unit configuration under `/var/lib/ikpk-rehearsal/bootstrap/staging193`, and writes a narrow systemd drop-in. It does not restart the service. The versioned `scripts/staging193-rehearsal.json` template installs as root-owned `/etc/ikpk/rehearsal.json`; installation creates the existing `ikpk-cms` account's private HOME if it is absent, creates the private journal/backup directories, and runs the helper's read-only config, current pointer, and live CMS database process check. It refuses to overwrite a different config or accept an unsafe existing HOME. The operator uses the existing root SSH identity at `~/.ssh/id_ed25519_ikpk_vps` to invoke only the fixed helper; CMS npm/build/migration and runtime stay under `ikpk-cms`. The service user's npm cache consumes staging disk during a build and must be included in the preflight space check.

Run the two operator commands with the same fresh operation ID and admitted SHA:

```sh
python3 scripts/rehearsal/staging193.py cms-update --operation-id <id> --source-sha <40-hex-sha>
python3 scripts/rehearsal/staging193.py static-publish --operation-id <id> --source-sha <40-hex-sha>
```

`cms-update` closes and verifies the writer fence, stops writers, checkpoints SQLite, exports and verifies the actual database/media bytes off-host, then builds and migrates the CMS artifact. That package uses the previously active CMS release as migration provenance and links `public/uploads` to the original external media tree. `static-publish` builds the staging193 profile from the operation's sealed CMS capture, retains old hashed assets alongside the candidate, exports those exact bytes for local browser acceptance without deploy credentials, rechecks canonical source CI, then atomically switches static and verifies `release.json`, routes, captured media and retained hashed asset URLs. Only after both acceptances does it commit durably and reopen writers.

## Static-only staging194 main refresh

`static-main` is an independent operation kind for refreshing only the static site on staging194. It requires the exact current canonical `main` commit and successful push runs for `Tests`, `Lint and Typecheck`, `Security`, and `Lighthouse CI`; Tests must have all five mandatory jobs successful, and every job in the other three runs must complete successfully. Without the reuse option, the host takes a read-only SQLite backup and seals the current CMS/content/media capture with that exact source SHA. Both modes install only the web dependencies and build a candidate without stopping or restarting CMS, changing its pointer, applying migrations, or writing the live database/uploads. They fingerprint the CMS unit, environment files, release payload, database/WAL, and media trees before and after preparation and activation. After local browser acceptance, the operator rereads canonical source and CI, then atomically switches only `currentStatic`; the host verifies the served release declaration, routes, captured media and retained hashed assets. The journal records the pre-switch intent; rollback restores the exact previous static tree only while the pointer still names this operation's candidate. Static recovery is a separate command and generic CMS recovery refuses static-main journals.

On 2026-10-22, the owner selected exact canonical `main` SHA plus green `Tests`, `Lint and Typecheck`, `Security`, and `Lighthouse CI` as the staging194 static-site admission rule, with no published Release requirement. This exception applies only to the staging194 static site: the CMS-button decision and production release policy are unchanged. The root-owned rehearsal config must contain `staticMainReleasePolicy: "ci-only-approved"`; a missing or different value fails closed. After the helper/config revision is reviewed and installed through the separately authorized host-maintenance procedure, the operator command is:

```sh
python3 scripts/rehearsal/staging193.py static-main --operation-id <fresh-id> --source-sha <current-40-hex-main-sha>
```

This command performs a static activation on staging194; it does not deploy the helper or config. Do not run it until the owner authorizes the deployment and the installed helper/config are confirmed to match the reviewed revision. For a crash during activation, use `static-main-recover --operation-id <same-id>`; it can restore only this operation's old static pointer and refuses to overwrite a newer foreign pointer.

### Reuse a sealed staging194 capture

For a front-only refresh with unchanged CMS inputs and schema/mapping, select the operation that originally created the capture. In the current static release's `release.json`, use `reusedCapture.operationId` when present, otherwise `operationId`. Do not select the newer build operation that merely reused that capture. The selected origin must have durable preparation evidence and be terminal as `static-main-committed` or `static-main-recovered`; a recovered operation without preparation evidence is refused.

```sh
python3 scripts/rehearsal/staging193.py --profile staging194 static-main \
  --operation-id <fresh-id> --source-sha <current-40-hex-main-sha> \
  --reuse-capture-operation-id <capture-origin-operation-id>
```

Use this mode only after confirming that the reviewed helper/config revision supporting it is installed. The operator verifies the selected journal and capture identity, safe paths/ownership, original snapshot/media bytes, current CMS fingerprint and schema/mapping compatibility. It preserves the original snapshot ID and reference date, creates no new SQLite image, backup or capture, and records the origin under `reusedCapture` in the new release. A mismatch stops the operation; there is no implicit fresh-capture fallback. Omit the option for an explicitly selected fresh capture. Current-main CI, browser acceptance, CMS preservation and static rollback checks remain required.

### Static-only rollback

After a committed activation, rollback is a separate explicit action; recovery never undoes an accepted release automatically. The operator must supply an identity and reason:

```sh
python3 scripts/rehearsal/staging193.py static-main-recover --operation-id <same-id> \
  --rollback-committed --operator '<operator>' --reason '<reason>'
```

The host checks the current candidate against the durable committed tree digest and the old target against its captured tree digest, then records operator/reason before the pointer switch. It uses compare-and-swap and refuses a newer foreign pointer or changed old tree. Repeating the exact completed request is idempotent; a different operator or reason is refused. This rollback changes only the static pointer and leaves CMS state untouched.

Legacy `/media/` is captured from the selected current static release and restored by returning to the old static pointer; its tree digest is verified before recovery completes and writers reopen. Recovery writes media files only under mutable `/uploads/`.

Before global commit, recover explicitly with the same ID. If a final backup exists, recovery requires the exact off-host archive; before backup creation it preserves the old live database and editor writes. A durable `committed` or `recovered` journal row forbids another database restore. If commit succeeded but reopening did not, retry `static-publish` to finish reopening.

Run accepted release A first. Re-measure disk afterward. Do not remove anything until the owner approves an exact path list after readback; retain runtime dependencies, backups, journal, receipts, and logs. Then run pre-commit failure/recovery and release C after a new editor record is written.

The three live acceptance scenarios are first accepted release A, pre-commit failure/recovery, and a second release C that preserves a new editor record and media. The rehearsal does not establish production readiness: TD-56's production journal-writer decision remains open, and production needs a separate admitted `main` SHA and canonical CI run. A01 and A02 are recovered. The standalone CMS build with a 1024 MiB Node heap failed with a V8 heap-limit error; the 1536 MiB CMS probe was stopped after two consecutive health timeouts and systemd timed out stopping its children, so it has no accepted result. The pinned-fixture web profile build passed in 4:43.69 with peak RSS 369420 KiB; this resource probe is not release acceptance.

## Reviewed seminar migration: proof admission and resumable pauses

The seminar migration additionally requires a complete proof source archive from
`scripts/build-seminar-proof-artifact.sh`. Supply its independently recorded SHA-256:

```sh
python3 scripts/rehearsal/staging193.py --profile staging194 cms-update \
  --operation-id <same-id> --source-sha <admitted-40-hex-sha> \
  --seminar-proof-artifact /absolute/proof.tar.gz --seminar-proof-sha256 <sha256>
```

The operator still requires the existing canonical source/CI admission. It compares
all archive members (including executable bits) with `git archive` of that exact
commit before sending the proof. An archive PAX comment alone grants no authority.
The host verifies the externally pinned archive bytes and their correspondence to
the admitted source. The root journal retains the source/artifact identity across
resumes. Production-paired retains its stable Release and exact-main gates.

The first invocation exports the off-host backup and runs until the next required
review. A successful pause prints `migrationPaused: true`, the runner's waiting
reason, `stageSnapshotDir`, `receiptPath`, and `proofArtifactPath`. Writers remain
fenced and the live database/code pointers remain on the old cohort. Retain the
same operation ID, source SHA, proof archive and digest on every invocation. A pause
is not deployment acceptance; explicit recovery remains available with the same ID.

After independently reviewing each stage, create a local JSON manifest and pin its
file SHA-256 separately. The manifest names the exact operation and source, plus
one of the following bindings (absolute paths below are local review files):

```json
{
  "operationId": "<same-id>",
  "sourceSha": "<admitted-40-hex-sha>",
  "reviewedStep": {
    "id": "<versioned-plan-step-id>",
    "reviewFilePath": "/absolute/review.json",
    "expectedReviewFileSha256": "<review-file-sha256>",
    "expectedPlanDigest": "<independently-reviewed-plan-digest>"
  }
}
```

Resume with both `--migration-review /absolute/manifest.json` and
`--migration-review-sha256 <manifest-file-sha256>` in addition to the previous
command's arguments. Review bytes travel on stdin after off-host backup confirmation,
not in a shell argument. Host paths are derived from the operation; review files
are private and immutable by digest. Prior bindings are checked against the root
journal, rather than accepted from the writable runner receipt. To stop after a
specific snapshot, optionally add `"stopAfterStage": "<stage-id>"`; this applies
only to that invocation. Omitting a new manifest resumes using previously admitted
reviews without replaying committed data steps.

For composition, replace `reviewedStep` with `compositionReview`, containing
`reviewFilePath`, `expectedFileSha256`, and `expectedContractDigest`. Its approved
contract must name the reported remote `proofArtifactPath` and the independently
admitted proof archive SHA. The runner rechecks stage snapshots, reviewed plans,
source/artifact identity, ledger, schema, schedule rules, document graphs, content
render evidence, and proof source bytes. It then pauses for registry cohort binding.

For the final binding, use `registryReview` with `reviewFilePath`,
`expectedFileSha256`, and `registryFilePath` (the local, explicitly approved registry
array). The review JSON must contain `version: 1`, `operationId`, `sourceCommit`,
`migrationPlanDigest` (receipt `planSha256`), `sourceDatabaseSha256` (receipt
`source.snapshotSha256`), `cmsArtifactSha256` (receipt's logical `artifactSha256`,
not the compressed CI payload digest), `proofArtifactSha256`,
`candidateDatabaseSha256` (exact checkpointed candidate file), `registrySha256`,
and the fixed remote `registryPath`:
`<receipt-directory>/reviews/registry-<registrySha256>.json`.

Registry bytes do not authorize themselves: the review file and its externally
supplied SHA authorize their association with this exact candidate. The runner
repeats the entire composition audit before validating the binding and returning
`prepared`. The host then supplies the independently journaled binding and exact
receipt digest to the cohort activation gate. Changed source, candidate, reviews,
proof bytes, registry or mismatched operation identity fail closed. No registry
entries are generated or approved automatically by these commands.

### Subsequent deployments and corrected submissions

After the first accepted seminar migration, subsequent paired deployments inherit
its selected root-owned v2 cohort. Before creating a candidate, the host checks the
selected CMS/database identity and the previous receipt against the sealed manifest.
The runner checks all four step IDs/hashes, the entire lineage row, and exact ledger
rows (including prior results and timestamps). It preserves that history without
replaying the steps or asking for new migration reviews. The unchanged approved
registry is bound to the new candidate, plan, source and proof; the ordinary
source/CI admission, full preservation audit and cohort activation gate still run.
A modified step, lineage, ledger, registry or previous receipt is a refusal.

First-time seminar composition also requires the legacy classification and documents
normalization steps to be present with their exact hashes in the original source
ledger. If they are pending, run their separately audited migration first: the
seminar composition contract does not authorize additional legacy data changes.

A review transport is journaled as `migration-review-submitted` before execution.
A rejected submission can be corrected under the same operation only if no durable
binding or completed step prevents replacement. When a reviewed data step fails,
the runner releases its tentative binding only after confirming both the absence
of a completion row and an unchanged full logical database (schema and all rows).
Committed steps remain immutable, even if someone removes a binding from the
writable receipt. An interruption with an uncertain outcome requires the original
submission or explicit recovery.
