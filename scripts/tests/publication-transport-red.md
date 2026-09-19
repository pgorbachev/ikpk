# Manual publication transport: independent RED delivery

Measured 2026-09-19 11:32 UTC on macOS, Node.js v24.13.0.
Approved specification: `2fb57519cc7f44482c2940cd5650ee11e61b3f35`.
Base after the subsequent main merge: `fcd19261f892c95b4dbdd3b6d74f53f1f69908b4`.
The specification itself did not change in that merge.

This delivery contains tests, local test fixtures and an explicitly empty transport
scaffold. It does not implement publication or exercise a real SSH server.

## Reproduce

From the repository root, with Node.js on PATH:

```sh
node --test --test-reporter=tap scripts/tests/publication-transport-harness.test.mjs
node --test --test-reporter=tap scripts/tests/publication-transport.test.mjs
```

Measured results:

| Command | Exit | Tests | Passed | Failed | Skipped / cancelled |
| --- | --- | --- | --- | --- | --- |
| Harness positive control | 0 | 1 | 1 | 0 | 0 / 0 |
| Transport behavior | 1 | 25 | 0 | 25 | 0 / 0 |

All 25 failures are `ERR_ASSERTION`: missing expected rejection or missing expected
filesystem/locking/index behavior. There are no import failures, unavailable test
dependencies or fixture exceptions in the recorded final run. The behavioral run
took 1094 ms; the harness control took 405 ms.

The separate positive control executes three actual local child processes through
the fake SSH executable. It verifies binary stdin/stdout and an on-disk file, then
verifies two measured corruptions (raw bytes and base64 bytes). Thus the fault
injector and execution boundary are exercised independently of the empty scaffold.

## Agreed module contract

`createSshTransport({ host, user, root, destinationId, knownHostsFile, sshCommand })`
returns `withLock(callback)` and `recover({ recordIndex })`.

The callback receives:

- `stage({ releaseId, sourceDir, expectedDigest })`;
- `activate({ releaseId, operation, recordIndex })`;
- `rollback({ releaseId, expectedDigest, operation, recordIndex })`.

An operation contains `publicationId`, `releaseId`, `destinationId`, `commit`,
`snapshotId`, and `treeDigest`. The durable pending JSON is
`root/.publication-pending.json`; `current` points at a retained release in
`root/releases/`. The host lock is `root/.publication.lock` and covers the entire
callback. Recovery takes that same lock and verifies the actual current release,
destination and digest before retrying `recordIndex(operation)`; success returns
`{ recovered: true, operation }`, absence of pending returns `{ recovered: false }`.

The digest oracle hashes sorted relative paths followed by their file bytes:
`UTF8PathByteLength + ':' + path + FileByteLength + ':' + bytes`, concatenated for
all files and hashed with SHA-256. Empty trees and symlinks are rejected.

`sshCommand` is an injectable executable/argument array at the module boundary,
not an operator-facing CLI option. The fake executable runs the actual remote
shell command locally; it does not emulate stage, locking, hashing or activation.
The tests do not prescribe the remote command language or JSON protocol.

## Behavioral coverage

- Exact transferred bytes, including binary data, spaces and Unicode paths;
  expected and remotely corrupted digest mismatch before activation.
- Empty and symlink-containing trees, release collisions and path traversal.
- Activation preserves the previous release; concurrent readers observe only
  complete old/new documents. Filesystem events check pending-before-current
  ordering, and the index callback observes the durable pending operation.
- Index failure leaves the active pair identifiable and pending durable;
  pending blocks stage, activation and rollback.
- Recovery retries the identical operation, is idempotent after success, and
  rejects a wrong active release, changed bytes or another destination.
- Two separate operator processes contend for the host lock; an exception releases
  it for a subsequent process. Both processes must actually cross the SSH boundary.
- Rollback uses retained checked bytes without executing release scripts; missing
  and corrupted retained releases are rejected.

These tests cover the transport boundary, not the launcher's CI authorization or
the real VPS prerequisites. The coordinator must register the Node test commands
in CI: the existing `scripts/lib/**/*.test.ts` Vitest discovery does not include
this directory. After implementation goes green, targeted mutations are still
required; this RED delivery does not claim to have run them against absent code.
