## 1. First release

- [ ] Admit one reconciled full `dev` SHA with exact canonical push `Tests` run and every mandatory job successful; build separate CMS/static payloads from that source and verify same-candidate browser checks.
- [ ] On demo193, acquire one operation ID, fence and stop writers, checkpoint WAL, prove no DB handles, and verify actual DB/media backup bytes off-host before mutation.
- [ ] Run CMS build/migration unprivileged; verify CMS health, process DB path, and media. Activate static and verify served `/release.json`, routes, and images; durably commit both acceptances before reopening writers.

## 2. Pre-commit recovery

- [ ] Prove interrupted acquisition performs no mutation and recovery closes writers first; after verified closure, prove the fence persists through process loss and a pre-commit CMS/static failure.
- [ ] Retry with the same operation ID or explicitly restore and verify the old pair before reopen; prove DB restore refuses after commit.

## 3. Second release after an editor write

- [ ] Save a new record and media after release one, run a fresh admitted operation, and prove the record is served and migrations are not repeated.

Historical checklist and September evidence are not completion evidence for this rehearsal. Production deployment, GitHub Release, tag archival, and `dev` retirement remain later work.
