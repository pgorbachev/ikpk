# Transport authorization and prepared-crash recovery: verification

Measured 2026-09-19, Node.js v24.13.0 / Python 3.9.6 on macOS.
Implementation and final measured baseline:
`feat/manual-publication-transport@cfd20525de5f1818c594eb4af1a1c746f11a207c`.

## Independent RED and GREEN

Independent tests were supplied in `b5881236a58786ff1d43d70710b34ab6e62a0896`
(authorization), `3665ce5ba1be8f54b210bf150a38edc87c2abe56` (SSH loss after
preparation), and `3b92a7cc773f031150d95b8694fd5deb1cdada79` (changed current).
On the pre-fix baseline `28ad905ce05dbf6ce95fca8fc31581acdb5054d0`, the implementer
reproduced authorization **10 failed / 0 passed** and prepared-crash recovery
**1 failed / 0 passed** (`current release mismatch`), each with exit 1.

Final command, from the repository root:

```sh
node --test --test-reporter=tap scripts/tests/publication-transport-authorization.test.mjs scripts/tests/publication-transport.test.mjs scripts/tests/publication-transport-harness.test.mjs
```

Exit **0**, **41 passed / 0 failed / 0 skipped / 0 cancelled** (19498 ms).
This final run happened after restoring all mutations. It includes 10 authorization
cases, 30 transport cases and the independent fake-SSH positive control. All SSH
processes are the local fake executable; no real server was contacted.

From `scripts/`, `npm run lint` and `npm run typecheck` both exit **0**.
No dependencies changed; the earlier transport delivery's production audit was
**0 vulnerabilities**.

## Negative mutations

Exact SHA, file, command, one-line replacement, occurrence counts and failing test
names are recorded in [the mutation receipt](publication-transport-authorization-mutations.json).
Each mutation was made independently after the selected baseline passed; original
bytes were restored in `finally`. No mutation remained in the committed code.

| Removed guard | Baseline passed | Mutant failed | Exit before → after |
| --- | ---: | ---: | --- |
| Authorization before first SSH | 1 | 1 | 0 → 1 |
| Stage proof digest binding | 1 | 1 | 0 → 1 |
| Complete operation proof binding (activate, rollback, recover) | 3 | 3 | 0 → 1 |
| Prepared recovery previous-current identity | 1 | 1 | 0 → 1 |
| Remote upload digest | 1 | 1 | 0 → 1 |
| Durable pending write | 1 | 1 | 0 → 1 |
| Actual host flock | 1 | 1 | 0 → 1 |

Before adding this report, both `git status --porcelain` and
`git diff cfd20525de5f1818c594eb4af1a1c746f11a207c --exit-code` were empty; diff
exit 0. Restored SHA-256 values:

- `scripts/publication-transport.mjs`: `90332969eef3612501f4dab6cac1c59fc330a9e54dedaa5aa5976dfa27de6f8c`
- `scripts/lib/publication-remote.py`: `083f20256e3358f86a3b6aff9e80d15c6c10853f684913e793b03cfd77e6ec11`

## Delivered boundary

`config.authorize` must be a trusted function returning the complete proof
`{destinationId, treeDigest, commit, snapshotId}`. The connect proof is validated
before spawning SSH. Stage binds the expected digest; activation, rollback and
recovery bind every identity field against a copied complete operation. Recovery
requires the operation proof before indexing or cancelling prepared state.
A serialized flag or missing callback cannot open SSH.

Pending remains the exact operation JSON. The durable
`.publication-preparation.json` sidecar stores that full operation, the previous
current symlink's raw target/device/inode/ctimeNs (or null), and phase
`prepared`/`committing`. Commit intent is durable before replacing current.
Prepared cancellation requires matching operation, prepared phase, identical
previous current, and verified retained bytes. It performs neither switch nor
index write and returns `{recovered:false,cancelled:true,operation}`.
Completed-switch recovery remains `{recovered:true,operation}` and is idempotent
through the supplied index writer.

## Explicitly outstanding

The transport library now enforces its authorization boundary, but production
integration must supply the fixed worker closure over actual CI/local evidence;
that integration is outside this delivery.

**Recovery is not fully delivered operationally.** A crash after durable committing
intent but before current replacement leaves an ambiguous committing/old-current
state and remains fail-closed. The coordinator explicitly retained this gap for a
separate audited operator repair command/procedure. Manual file deletion is not a
recovery runbook.

Missing sidecar plus old current also fails closed. A crash between the pending and
sidecar writes can produce that state. Cleanup removes sidecar before pending;
active-current recovery without sidecar remains available for legacy pending data
and interrupted cleanup. An orphan sidecar with no pending does not authorize a
publication and is overwritten on the next preparation.

Focused independent mutation tests for phase=committing with old current and for
sidecar/pending operation mismatch remain outstanding. The reviewer was reassigned
to the Git state-store review before writing those probes. Existing positive
prepared-crash recovery and changed-current refusal are tested and their
previous-current guard has been negatively mutated; this report does not claim
coverage of the two pending probes.
