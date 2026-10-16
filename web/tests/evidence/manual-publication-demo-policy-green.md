# DEMO publication policy implementation evidence — 2026-10-16

Scope: existing publisher, explicit protected `sourcePolicy: demo-publication-only`.
This is local implementation evidence, not a server publication or production acceptance.

- Independent initial RED: commit `504df1c9ec4c796bf9a18ff7e53a33c808ba941e` (35 policy/runner/rollback tests plus the state-store preservation case).
- Launcher boundary added RED before implementation: four native tests failed on the old launcher; invalid policy/binding reached later source/runtime validation. After implementation, all five tests pass, including new audit coverage. The fixture broker marker stays absent for every invalid host/origin/mode/payment/policy variant on publish/recover/rollback.
- Latest focused publisher/capture regression: 210 tests passed in seven files, including policy, core, adapters, audit, live snapshot and prepare-snapshot behavior.
- Durable recovery: seven tests passed. Saved operation survives removal of worker scratch; overwrite, escaping path, writable root and symlink root refuse. Operation/bundle/snapshot/report mismatch refuses. The bundle verifier is explicitly mocked in these unit orchestration tests; root ownership and seal/digest verification are tested in the separate capture helper suite.
- DEMO adapters: three tests passed. Fixed narrow sudo wrapper, exact capture ID/schemaRoot, sealed snapshot CLI, one normal `npm run build` to `web/dist`, protected staging origin, no REST fallback on capture failure.
- Broad publisher regression initially: 526 passed, six timed out in the launcher/state-store files during concurrent execution. Serial rerun of those two files with the unchanged default timeouts: 68 passed. The increased-timeout diagnostic was interrupted and is not strict passing evidence.
- Legacy records, three journal events/HWM 3 and two historical stand pairs remain unchanged in the real bare-Git state-store regression; only the new discriminated record is appended. No synthetic revision or accept-state is used.
- Rollback fixture was strengthened to supply the capture proof required by the approved record contract; missing proof now has an explicit rejection test.

Capture helper implementation is a separate delivery (`c5c91b60838473dc9d2b9c4ecdfb834a2ae56e5e`), cherry-picked only for local integration. Source/schema/media compatibility and real DEMO operations still require independent reviews and the separately authorized acceptance sequence. No server operation, push, merge, or PR comment was performed by this implementation session.

## Independent-review follow-up: evidence durability before activation

The reviewers found that `flush: true` covered only `operation.json`; snapshot,
media, reports and their directory entries could still be lost after power loss.
`saveDemoOperation` now fsyncs every regular file and each directory bottom-up,
then the parent directory chain, after writing the final operation. Symlinks,
hardlinks, special files and replaced inode/type fail closed; every descriptor
closes even if fsync fails. The sealed root capture bundle is not traversed or modified.

RED: the seven initial durability tests all failed on core commit
`c5ab39428794d6c3956d554f4ca56af86cb91a98`. GREEN: eight durability tests plus
existing DEMO evidence/policy regressions pass, 54/54. Tests perform real local
open/fsync/close calls and inject failure for media, report and parent directory;
new publication stops before transport, and rollback-report failure leaves the
current release active. This verifies the fsync boundary and control flow, not a
physical power-loss/reboot rehearsal.
