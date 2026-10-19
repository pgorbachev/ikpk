## Context

The staging194 rehearsal retains the existing configured CMS release, SQLite, uploads, and static paths while moving operation state, maintenance flag, and backups into the distinct staging194 directory. Its operator SSH destination and every external probe are fixed to `194.226.99.10`; SSH uses the provided identity and known-hosts file with strict host checking. This config binding does not establish the live host layout, loaded Nginx state, or readiness. The candidate SHA, exact successful run, and effective gate behavior still require evidence.

## Decisions

1. **Operator admission:** CI never publishes. Fix destination and source before executing candidate code. Require canonical exact-SHA `Tests` push run with all mandatory jobs successful and no skipped/cancelled job. One source SHA yields separate CMS/static digests. Browser checks and served verification use the same static bytes.
2. **Staging snapshot exception:** only the staging194 rehearsal uses the accepted untracked publication-snapshot policy; production journal/high-water-mark behavior is unchanged.
3. **Fence and backup:** the first CMS command holds the host flock, checks operation availability, and prepares the admitted source, CMS dependencies, and CMS artifact while current writers remain open. Build dependencies use a complete immutable generation keyed by the lock hash and build profile; preparation failures create no new journal or marker and leave live data and releases unchanged. After preparation, existing acquisition records the old pair, starts the operation, writes the marker, and verifies writer closure before DB or live-code mutation. The off-host-confirmed follow-up validates ownership and the prepared output, reuses it without npm or CMS rebuild, and verifies the backup digest. Later commands reacquire the process-scoped flock; the journal and verified fence preserve ownership across process loss. After closure, checkpoint WAL and verify DB handles before capturing and confirming the DB/media backup. Migration and static snapshot/build run after the fence; static build uses the prepared web dependencies.
4. **Bound host work:** CMS migration/audit and static snapshot/build run on the server as the configured unprivileged user. Root is limited to configured gate/unit/release operations. Reuse Nginx locations, validate with `nginx -t`, and restore the previous gate file if validation fails. A closed fence survives process loss and reboot.
5. **Acceptance and commit:** poll health up to 20 minutes, prove the actual DB via process environment and open FD, and check media. Verify served `/release.json`, routes, and images against the same static candidate. Append `start`, `new-bundle`, and `committed`; write commit after both acceptances and before reopening writers. Before commit, explicit recovery may restore the old pair; after commit DB restore is forbidden.
6. **Second release:** capture the current live DB/media and retain a new editor record. Check migration lineage and integrity, not equality with the first immutable backup hash.

## Acceptance scenarios

- **First release:** exact source/run admitted; real DB/media backup bytes verified off-host; CMS and static health, provenance, process DB, media, and served candidate proofs pass; commit precedes reopen.
- **Pre-commit recovery:** acquisition interruption changes no data/code; failures after closure leave the fence active; retry under the same operation ID or explicit recovery verifies/restores the old pair; post-commit DB restore refuses.
- **Second release:** a new editor record/media remains served and migration ledger is unchanged.

## Risks

Current CI evidence is stale or failed, and disk inspection cannot prove loaded Nginx behavior. These facts block rehearsal admission; demo success will not establish production readiness.
