# Transport authorization RED — task 4.2a

Base: `codex/manual-publication-transport-red@4a31d8b1842390690a98ca7cc76603974e5c9fcf`.
The production transport implementation was not read. The existing no-op RED stub is unchanged.

Agreed library contract: `createSshTransport({ ..., authorize })`, where the trusted
callback receives `{ action, destinationId, expectedDigest?, operation? }` and returns
`{ destinationId, treeDigest, commit, snapshotId }`. Actions are `connect`, `stage`,
`activate`, `rollback`, and `recover`. A valid connect proof is required before the
first SSH process, including recovery. Stage binds the expected digest; operations
bind all four proof identity fields. Recovery authorizes the complete pending
operation before indexing or clearing it. Its proof may come from the original
record; it does not require new main, CMS, or historical Actions queries.

The production callback must be the fixed worker closure over real CI/local report
validation. JSON configuration and CLI flags must not supply or bypass it. The
fixture explicitly installs its own test-only policy, including inside the lock
worker after JSON deserialization; no production guard is disabled.

Command (Node v24.13.0):

```sh
node --test scripts/tests/publication-transport-authorization.test.mjs scripts/tests/publication-transport-harness.test.mjs
```

Observed 2026-09-19: **11 tests, 10 RED, 1 GREEN**, 1179 ms. All ten failures are
behavior assertions / missing expected rejection against the no-op stub. The
independent GREEN control executes three local fake-SSH processes, round-trips
stdin/stdout, writes files, and measures corruption. No real SSH/CMS or network
mutation was performed. `node --check` passes for all four changed/new JS files.

Coverage: missing/serialized callback; false/undefined/empty/incomplete proof;
throwing callback; foreign destination before connection; fixed proof actually
uploads; stage digest mismatch before upload; all four activation identity fields;
rollback operation binding; recovery pending identity binding; fixed original
recovery proof. Action refusals permit host-lock bookkeeping but prohibit release
transfer, activation, indexing, or pending-marker removal as applicable.
