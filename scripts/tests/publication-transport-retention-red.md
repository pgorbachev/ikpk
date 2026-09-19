# Release retention: independent RED delivery

Production revision tested: `codex/manual-publication-implementation@2899173adf3c346184f63398b87ed148c0329b2c`.
Only the new test and evidence files differ from that revision. No implementation, deployment,
real SSH connection, dependency installation or GitHub operation was performed.

## Accepted contract and agreed interface

- `openspec/specs/deploy-gating/spec.md:646-679`: at least five total release directories,
  including current; remove only oldest excess directories. The window is measured in releases,
  not days. `static-serving` retains the related old hashed-asset availability contract.
- `openspec/changes/manual-publication-only/specs/deploy-gating/spec.md:381-400`: retained
  trees determine available rollback targets; previous index entries remain historical evidence.
- `openspec/changes/manual-publication-only/design.md:136-150`: the serving-host lock covers
  index recording; failed index recording after activation blocks subsequent publication until recovery.
- Coordinator agreed that existing `createSshTransport(config.keepReleases)` supplies the limit,
  omission defaults to five, values below five refuse before connecting, and worker configuration
  must enforce the same minimum. No new transport method or wall-clock expiry policy is specified.
- Cleanup happens after successful `recordIndex`, within the existing locked transaction.
  On cleanup failure the call refuses success and reports `activeOperation` truthfully; these
  tests do not prescribe whether the pending marker remains after that failure.

## Executed checks

```sh
node --test scripts/tests/publication-transport-retention.test.mjs
```

Exit **1**, **11 tests: 8 named RED, 3 PASS**. Full output:
`publication-transport-retention-red.log`.

| Scenario | Result on production revision |
| --- | --- |
| Configured five total after acknowledged activation | RED: all eight directories remain |
| Configured seven total after acknowledged activation | RED: all nine directories remain |
| Omitted limit defaults to five | RED: all eight directories remain |
| Below-limit successful publication | PASS positive control |
| Failed index acknowledgement protects current, pending and prior trees | PASS |
| Recovery prunes after index acknowledgement | RED: all eight directories remain |
| Rollback protects oldest active target plus newest four previous trees | RED: all seven directories remain |
| Failed final source check never prunes | PASS |
| Configured depth two refuses before SSH | RED: succeeds |
| Configured depth four refuses before SSH | RED: succeeds |
| Actual filesystem deletion failure reports failure and active operation | RED: succeeds |

All normal fixtures use the existing fake SSH boundary, which launches the actual Python
remote program locally. Chronological mtimes deliberately disagree with release-name order.
Every seeded release has an existing history entry. Assertions check actual directory contents,
current symlink, index history and real `flock` exclusion, rather than matching implementation text.
An oldest directory with mode `0500` supplies the deletion fault: deleting its regular child is
first attempted independently and verified to fail with `EACCES`/`EPERM`. This control passed on
the unprivileged local runner; the test intentionally fails its control if run as privileged root.

Additional executed checks:

```sh
node --test scripts/tests/publication-transport-harness.test.mjs
node --check scripts/tests/publication-transport-retention.test.mjs
git diff --check
```

All passed; existing fake-SSH harness: **1/1**. No implementation mutation was needed to make
the missing retention behavior fail. The implementer must run the full suite GREEN and then
negatively verify the newly implemented pruning/order/protection assertions by mutation.
Worker-specific configuration tests and worker minimum change are handed to the coordinator;
this native suite owns only the actual transport boundary. Unknown-directory policy, stale-day
expiry and deterministic equal-mtime tie order are not invented by these tests.
