## 1. First release

- [ ] Admit one reconciled full `dev` SHA with exact canonical push `Tests` run and every mandatory job successful; before creating the operation journal or marker, extract that source, install CMS/web dependencies, and build the CMS artifact. Keep CMS and static payload digests separate; static output is built later from the sealed capture.
- [ ] On staging194 (`194.226.99.10`), hold the host flock and reject an existing marker, unfinished operation, or used operation ID before preparation; after complete preparation, record the old pair, fence and stop writers, checkpoint WAL, prove no DB handles, and verify actual DB/media backup bytes off-host before mutation.
- [ ] After backup confirmation, run CMS migration/audit unprivileged; verify CMS health, process DB path, and media. Build static output from the sealed capture with the prepared web dependencies, verify served `/release.json`, routes, and images, then durably commit both acceptances before reopening writers.

## 2. Pre-commit recovery

- [ ] Prove prefence preparation failure leaves existing writers open with no new journal/marker or live mutation; after acquisition begins, prove recovery closes writers first and the verified fence persists through process loss and a pre-commit CMS/static failure.
- [ ] Retry with the same operation ID or explicitly restore and verify the old pair before reopen; prove DB restore refuses after commit.

## 3. Second release after an editor write

- [ ] Save a new record and media after release one, run a fresh admitted operation, and prove the record is served and migrations are not repeated.

Historical checklist and September evidence are not completion evidence for this rehearsal. Production deployment, GitHub Release, tag archival, and `dev` retirement remain later work.
