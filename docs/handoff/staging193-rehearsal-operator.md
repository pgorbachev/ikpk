# staging193 rehearsal operator

The local operator admits one full `dev` SHA through the canonical `Tests` push run, requires every mandatory job to finish successfully, and sends that exact source tree to staging193. `staging193` is the environment name; its current URL is `https://193.124.115.99`. `staging.ikpk.su` currently resolves to a different host and is not used by this rehearsal. It stores the verified database and media archive on the operator machine before any migration or release switch. CMS migration/build runs under the CMS account; the bounded host helper performs systemd, Nginx, database, and pointer operations.

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

Legacy `/media/` is captured from the selected current static release and restored by returning to the old static pointer; its tree digest is verified before recovery completes and writers reopen. Recovery writes media files only under mutable `/uploads/`.

Before global commit, recover explicitly with the same ID. If a final backup exists, recovery requires the exact off-host archive; before backup creation it preserves the old live database and editor writes. A durable `committed` or `recovered` journal row forbids another database restore. If commit succeeded but reopening did not, retry `static-publish` to finish reopening.

Run accepted release A first. Re-measure disk afterward. Do not remove anything until the owner approves an exact path list after readback; retain runtime dependencies, backups, journal, receipts, and logs. Then run pre-commit failure/recovery and release C after a new editor record is written.

The three live acceptance scenarios are first accepted release A, pre-commit failure/recovery, and a second release C that preserves a new editor record and media. The rehearsal does not establish production readiness: TD-56's production journal-writer decision remains open, and production needs a separate admitted `main` SHA and canonical CI run. A01 and A02 are recovered. The standalone CMS build with a 1024 MiB Node heap failed with a V8 heap-limit error; the 1536 MiB CMS probe was stopped after two consecutive health timeouts and systemd timed out stopping its children, so it has no accepted result. The pinned-fixture web profile build passed in 4:43.69 with peak RSS 369420 KiB; this resource probe is not release acceptance.
