# SSH publication transport: GREEN and mutation evidence

Measured 2026-09-19 on macOS, Node.js v24.13.0, Python 3.9.6.
Implementation: `feat/manual-publication-transport@21de794c852bbd6e87af40d2a91101390b49d6b2`.
Measured final baseline (includes independent lock-observer correction):
`feat/manual-publication-transport@714d465f319a929a38378b2f37f9649a5c2fdc37`.

The implementation contains only `scripts/publication-transport.mjs` and
`scripts/lib/publication-remote.py`. The independent test author supplied the
beforeActivate, deterministic pending observer, IPC cleanup and OS-lock probe
changes; the implementer did not author those tests. The earlier test RED evidence
is in `publication-transport-red.md` and `publication-transport-lock-probe-red.md`.

## GREEN commands and results

From the repository root:

```sh
node --test --test-reporter=tap scripts/tests/publication-transport.test.mjs scripts/tests/publication-transport-harness.test.mjs
```

Exit **0**, **29 tests / 29 passed / 0 failed / 0 skipped / 0 cancelled**,
19044 ms. This is 28 transport cases plus the independent fake-SSH harness control.
The fake executable runs the real remote Python program locally. No VPS or real
SSH server was contacted, and no production destination was modified.

From `scripts/`:

```sh
npm run lint
npm run typecheck
npm run audit:prod
```

All exit **0**; audit reports **0 vulnerabilities**. Lint was rerun after the final
independent test change. Typecheck and audit ran against the identical production
code before that test-only change.

## Mutations

Each mutation below was applied individually to the committed
`scripts/lib/publication-remote.py`, after its selected test passed. The exact
original line occurred once; after mutation its occurrence count was zero.
The original bytes were restored in `finally` before the next case.
Each command is run from the repository root.

### digest

```diff
-            require(tree_digest(temporary) == expected, "remote upload digest mismatch")
+            # MUTATION: remote upload digest check removed
```

```sh
node --test --test-reporter=tap --test-name-pattern='corruption on the upload channel' scripts/tests/publication-transport.test.mjs
```

Before: **1 passed / 0 failed, exit 0**. Mutant: **0 passed / 1 failed, exit 1**.

```text
not ok 1 - corruption on the upload channel is detected by the remote digest
```

### pending

```diff
-            os.rename(temporary, self.pending)
+            os.unlink(temporary)  # MUTATION: no durable pending
```

```sh
node --test --test-reporter=tap --test-name-pattern='pending is persisted before current changes' scripts/tests/publication-transport.test.mjs
```

Before: **1 passed / 0 failed, exit 0**. Mutant: **0 passed / 1 failed, exit 1**.

```text
not ok 1 - pending is persisted before current changes and remains visible to the index writer
```

### lock

```diff
-        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
+        # MUTATION: host lock removed
```

```sh
node --test --test-reporter=tap --test-name-pattern='two separate operator processes' scripts/tests/publication-transport.test.mjs
```

Before: **1 passed / 0 failed, exit 0**. Mutant: **0 passed / 1 failed, exit 1**.

```text
not ok 1 - two separate operator processes cannot hold the host publication lock together
```

Digest removal fails with `Missing expected rejection`; the raw upload corruption
fixture is independently validated by the harness. Pending removal fails when the
beforeActivate callback cannot read the expected durable marker (cancellation
also reports the missing preparation). Lock removal fails with
`callback must hold the actual host OS lock`, actual `available`, expected `held`.

The initial timing-only lock test allowed this mutation to survive: 1 passed,
exit 0. That was a test-observation gap, not accepted evidence. The independent
author replaced the startup delay with a separate Python process attempting
nonblocking acquisition of the documented lock file while each operator owns the
session, then positively acquiring it after release. The final mutation above is
measured against that corrected observer.

## Restoration

After restoring the last mutation:

```sh
node --test --test-reporter=tap --test-name-pattern='corruption on the upload channel|pending is persisted before current changes|two separate operator processes' scripts/tests/publication-transport.test.mjs
git status --porcelain
git diff 714d465f319a929a38378b2f37f9649a5c2fdc37 --exit-code
```

Tests: exit **0**, **3 passed / 0 failed / 0 skipped / 0 cancelled**. Both Git
commands produced no output; diff exit **0**. Restored remote helper SHA-256:
`fafdb920d18dd837271f11baa0fd3dce3b549a748733adada6315bb36e9076f4`.
This report was added only after those clean restoration checks.

## Scope and remaining work

Implemented: one SSH session holds the host flock across transfer, final source
check, switch and index callback; pinned known-host checking; raw length-framed
file transfer and remote tree digest verification; durable pending before atomic
current replacement; retained-byte rollback; recovery validates actual current,
destination and digest before retrying the same publication ID without switching.
`beforeActivate()` runs after preparation and immediately before the switch;
callback rejection preserves current and removes its uncommitted pending marker.

**Task 4.2a remains open.** The transport API does not yet require an authorization
verdict; refusing direct command-line invocation does not implement that boundary.
The independent authorization RED delivery and its implementation are a separate
integration step owned by the coordinator. This report does not claim that direct
calls to this transport API are authorized by the publication core.

A crash after pending is persisted but before current is switched deliberately
leaves pending and recovery refuses because actual current differs. Controlled
abort/recovery for that state remains separate work; the transport does not silently
delete its evidence. Production invocation must supply the final main/CMS callback
and an idempotent append-only index writer. CLI/workflow integration and real-host
acceptance were outside this bounded delivery.
