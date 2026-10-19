## 1. First release

- [ ] Keep staging194 admission on exact `dev` head/run and add fixed `initial-prod` admission on exact current `main` head/run; the initial production operation uses the single protected ID `initial-prod-20261019-A-01`, binds source/run at start, and cannot be reused after commit. Prepare source, CMS/web dependencies, and CMS artifact before creating the journal or marker. Keep CMS/static payload digests separate.
- [x] On staging194 (`194.226.99.10`), hold the host flock and reject an existing marker, unfinished operation, or used operation ID before preparation; after complete preparation, record the old pair, fence and stop writers, checkpoint WAL, prove no DB handles, and verify actual DB/media backup bytes off-host before mutation.
- [x] After backup confirmation, run CMS migration/audit unprivileged; verify CMS health, process DB path, and media. Build static output from the sealed capture with the prepared web dependencies, verify served `/release.json`, routes, and images, then durably commit both acceptances before reopening writers.
- [ ] For initial-prod, retain truthful `origin=server-db` with a distinct production-only proof bound to host, source SHA, run, operation ID, DB/schema/media digests; use production origin/payment role and run browser checks against the same frozen candidate with external payment/CRM writes disabled. Verify production HTTPS served release/routes/images before commit. Keep ordinary publication snapshot validation rejecting this proof.

## 2. Pre-commit recovery (staging194 only; initial-prod recovery deferred)

- [ ] Prove prefence preparation failure leaves existing writers open with no new journal/marker or live mutation; after acquisition begins, prove recovery closes writers first and the verified fence persists through process loss and a pre-commit CMS/static failure.
- [ ] Retry with the same operation ID or explicitly restore and verify the old pair before reopen; prove DB restore refuses after commit.

## 3. Second release after an editor write (staging194 only; initial-prod release deferred)

- [ ] Save a new record and media after release one, run a fresh admitted operation, and prove the record is served and migrations are not repeated.

Owner-accepted staging194 A01 evidence: source `b06e9ea354c7fdbd58e347258a076b4a0860786b`; canonical Tests run 39226509667, attempt 1 (all five required jobs green); off-host DB/media backup SHA-256 `28bbc71b5a8762a6689c412caf65410f18a0406404d82e29b01f9d5294331db9`; 32/32 browser checks; 3,783 media responses returned HTTP 200; operation committed. This records the completed staging first-release tasks only.

Initial-prod recovery acceptance, the production equivalent of recovery scenario 2, CMS editor workflows, the production equivalent of second-release scenario 3, ordinary production publication, GitHub Release, tag archival, and `dev` retirement remain deferred by the owner. These scenarios are not claimed as passed. A pre-commit production failure stays fenced pending safe completion of the same admitted operation or separate owner-approved database restore.
