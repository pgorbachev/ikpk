## ADDED Requirements

### Requirement: Staging193 rehearsal uses one sealed publication snapshot without production journal writes

Only an owner-designated rehearsal on staging193 (`193.124.115.99`, `https://staging.ikpk.su`, `deployMode=stand`, `paymentRole=ci`) may use `sourcePolicy=demo-publication-only`, profile `demo-dev`, `recordKind=publication-snapshot`, `sourceAge=untracked`, `origin=server-db`, and `sourceId=demo193-cms`. The source ID is a retained legacy machine identifier. For this frozen current-state snapshot, this scoped rule overrides generic provenance-journal observation and high-water-mark preconditions; it is not an edit, restore, or migration event and creates no edit, restore, initial-migration, acceptance, revision, or high-water-mark entry. All production publication, migration, and restore operations remain subject to the existing provenance journal contract.

Fix the destination and admitted full source SHA before executing candidate code. The operation manifest SHALL record its ID, old/new CMS code, DB, media, static and config identities, canonical ref, full SHA, exact CI run/attempt, and separate CMS/static payload digests. The CMS and static outputs SHALL derive from that one SHA. Build CMS and static output on the server as the configured unprivileged user. CI receives no host credentials. The snapshot proof SHALL bind a quiesced SQLite image, schema/content inventory, every referenced media byte, original media names and permissions, and one sealed bundle digest. REST reads alone are insufficient.

Each process SHALL acquire a host flock and verify the same persistent journal operation ID; the OS lock is process-scoped and is not held between commands. The durable journal and verified writer fence preserve operation ownership across commands. Before any database or code mutation, all CMS writers SHALL be fenced and stopped and closure verified; a persistent marker alone does not prove closure. The fence blocks admin, content-manager, upload, API write, and custom write routes while preserving payment/status routes and GET/HEAD media. Use existing Nginx locations; validate changes with `nginx -t` and restore the prior gate file on failure. If acquisition stops before verified closure, do not mutate data or code; recovery closes and verifies writers first. After closure, checkpoint SQLite WAL, prove no CMS process holds a DB handle, and make an integrity-checked DB/media backup whose actual bytes are verified off-host before migration or activation. Preserve media names, permissions, and DB references. Run CMS npm/build/migration/audit as `ikpk-cms`; root performs only bounded configured path, unit, gate, and atomic switch operations.

After CMS activation, poll health for up to 20 minutes and prove the running DB using process environment and open FD. After static activation verify served `/release.json`, required routes, and images against the same candidate. Keep one readable append-only journal file: success records are `start` (old bundle), `new-bundle`, `committed`. Commit follows CMS and static acceptance and precedes writer reopen. Before commit, explicit recovery may restore and verify the old pair; after commit, DB restore is forbidden.

#### Scenario: first release is accepted as one pair

- **WHEN** admitted source and run pass, off-host DB/media bytes verify, and CMS plus static candidate checks pass
- **THEN** health, process DB proof, media, and served release/routes/images identify the operation and source
- **AND** the three journal records end in durable commit before writer reopen, without production journal writes

#### Scenario: failure before commit is recovered explicitly

- **WHEN** acquisition stops early or CMS/static acceptance fails before commit
- **THEN** no mutation occurs before verified fence closure and the fence persists after closure
- **AND** retry uses the same operation ID or explicit recovery verifies/restores the old pair before reopening
- **AND** recovery refuses DB restore after commit

#### Scenario: second release retains an editor write

- **WHEN** a new editor record and media are saved after the first release and a second operation runs
- **THEN** that record and media remain served, migrations are not repeated, and mutable DB/WAL is checked by lineage and integrity rather than equality to the first backup
