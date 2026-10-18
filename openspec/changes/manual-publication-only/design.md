## Context

Demo193's CMS service points directly at a release directory, SQLite is outside that directory, and uploads use a separate data tree. Existing HTTP and TLS vhosts include a shared empty writer-gate snippet. These are read-only disk facts, not proof of loaded Nginx state or readiness. The candidate SHA, exact successful run, and effective gate behavior still require evidence.

## Decisions

1. **Operator admission:** CI never publishes. Fix destination and source before executing candidate code. Require canonical exact-SHA `Tests` push run with all mandatory jobs successful and no skipped/cancelled job. One source SHA yields separate CMS/static digests. Browser checks and served verification use the same static bytes.
2. **Narrow demo snapshot exception:** only the demo193 rehearsal uses the accepted untracked publication-snapshot policy; production journal/high-water-mark behavior is unchanged.
3. **Fence and backup:** each command first acquires a process-scoped host flock and checks the persistent journal operation ID. The first command then appends `start`, writes the marker, closes and verifies every CMS writer before DB/code mutation. Later commands reacquire the flock and confirm the same operation ID; the OS lock is not held between commands, while the journal and verified fence survive process loss and reboot. If acquisition stops before verified closure, mutate nothing; recovery closes writers first. After closure checkpoint WAL, prove no DB handles, capture DB/media, and verify actual bytes off-host before destructive work.
4. **Bound host work:** CMS build/migration/audit and static build run on the server as the configured unprivileged user. Root is limited to configured gate/unit/release operations. Reuse Nginx locations, validate with `nginx -t`, and restore the previous gate file if validation fails. A closed fence survives process loss and reboot.
5. **Acceptance and commit:** poll health up to 20 minutes, prove the actual DB via process environment and open FD, and check media. Verify served `/release.json`, routes, and images against the same static candidate. Append `start`, `new-bundle`, and `committed`; write commit after both acceptances and before reopening writers. Before commit, explicit recovery may restore the old pair; after commit DB restore is forbidden.
6. **Second release:** capture the current live DB/media and retain a new editor record. Check migration lineage and integrity, not equality with the first immutable backup hash.

## Acceptance scenarios

- **First release:** exact source/run admitted; real DB/media backup bytes verified off-host; CMS and static health, provenance, process DB, media, and served candidate proofs pass; commit precedes reopen.
- **Pre-commit recovery:** acquisition interruption changes no data/code; failures after closure leave the fence active; retry under the same operation ID or explicit recovery verifies/restores the old pair; post-commit DB restore refuses.
- **Second release:** a new editor record/media remains served and migration ledger is unchanged.

## Risks

Current CI evidence is stale or failed, and disk inspection cannot prove loaded Nginx behavior. These facts block rehearsal admission; demo success will not establish production readiness.
