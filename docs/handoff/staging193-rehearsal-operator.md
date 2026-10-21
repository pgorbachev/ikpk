# staging193 rehearsal operator

This legacy-named runbook now describes the custom staging194 operator: its root-owned config and SSH binding target `https://194.226.99.10`. The existing dev `cms-update`/`static-publish` sequence remains unchanged and still admits only exact `dev` plus its successful `Tests` push run. `staging.ikpk.su` resolves to a different host and is not used here. CMS migration/build runs under the CMS account; the bounded host helper performs systemd, Nginx, database, and pointer operations only for that existing dev workflow.

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
