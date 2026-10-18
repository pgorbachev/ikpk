# staging193 rehearsal operator

The local operator admits one full `dev` SHA through the canonical `Tests` push run, requires every mandatory job to finish successfully, and sends that exact source tree to staging193. It stores the verified database and media archive on the operator machine before any migration or release switch. CMS migration/build runs under the CMS account; the bounded host helper performs systemd, Nginx, database, and pointer operations.

After reviewed code and exact candidate CI are ready, install the bounded helper and prepare the existing CMS unit to use `/opt/ikpk-cms-prototype193/current`:

```sh
bash scripts/install-rehearsal-host.sh --prefix /usr/local
bash scripts/bootstrap-staging193-current.sh
```

The bootstrap checks the current unit identity and original release path, saves the effective unit configuration under `/var/lib/ikpk-rehearsal/bootstrap/staging193`, and writes a narrow systemd drop-in. It does not restart the service. Root-owned `/etc/ikpk/rehearsal.json` supplies the reviewed staging paths, CMS writer units and URI probes, media roots, and existing Nginx include paths.

Run the two operator commands with the same fresh operation ID and admitted SHA:

```sh
python3 scripts/rehearsal/staging193.py cms-update --operation-id <id> --source-sha <40-hex-sha>
python3 scripts/rehearsal/staging193.py static-publish --operation-id <id> --source-sha <40-hex-sha>
```

`cms-update` closes and verifies the writer fence, stops writers, checkpoints SQLite, exports and verifies the actual database/media bytes off-host, then builds and migrates the CMS candidate. `static-publish` builds from that operation's sealed database/media capture, switches the retained static release, checks the served release metadata/routes/images, runs the browser suite against the same public bytes without deploy credentials, records both acceptances, commits durably, and reopens writers.

Before global commit, recover explicitly with the same ID. If a final backup exists, recovery requires the exact off-host archive; before backup creation it preserves the old live database and editor writes. A durable `committed` or `recovered` journal row forbids another database restore. If commit succeeded but reopening did not, retry `static-publish` to finish reopening.

The three live acceptance scenarios are first release, pre-commit failure/recovery, and a second release that preserves a new editor record and media. The rehearsal does not establish production readiness: TD-56's production journal-writer decision remains open, and production needs a separate admitted `main` SHA and canonical CI run. No service install, reload, stop, or rehearsal has been run on staging193 from this worktree.
