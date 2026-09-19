# Retained release read: GREEN evidence

Implementation extends the existing SSH transport and Python helper. The independent
RED evidence remains in `publication-transport-retained-red.md`; its 20 behavioral
cases are unchanged. The bounded delivery adds one large-file regression.

## Validation

```sh
node --test scripts/tests/publication-transport.test.mjs \
  scripts/tests/publication-transport-review.test.mjs \
  scripts/tests/publication-transport-authorization.test.mjs \
  scripts/tests/publication-transport-harness.test.mjs \
  scripts/tests/publication-transport-retained.test.mjs
```

Result: **68 passed, 0 failed, 0 skipped** (47 existing + 20 independent RED +
1 large-file regression). The previously reported prepared-crash error-message race
did not recur in this final run; no assertion was weakened.

`node --check` passed for the transport, modified fake SSH, and retained-read tests.
Python `ast.parse` passed for the helper; `git diff --check` passed. This delivery
uses the dependency-free Node suites as requested: no dependency install, package
lint/typecheck, full build, network SSH, publication, or deployment was performed.

## Bounds and responsibilities

The existing connection carries a manifest followed by base64 chunks of at most
1 MiB. Each response is limited to 8 MiB before JSON parsing. Manifests are limited
to 100,000 files and 16 GiB total bytes, with relative paths at most 4,096 UTF-8
bytes and 128 components. Python opens directory components without following
symlinks; local copies use a private temporary directory and exclusive file creation.
Copies are removed when the callback succeeds or fails. Authorization adds a
release-ID binding only for `read-retained`; other actions keep their prior contract.

The coordinator remains responsible for checking the copied tree digest and policy;
the existing remote preparation verifies the retained digest before activation.
No retained executable is run by the transfer. No current release yields
`currentReleaseId: null`, leaving the coordinator to decide eligibility.

## Confirmed fake-SSH defect

A 2 MiB + 19 byte binary retained read hung after the first 65,536 bytes of its
first response. The Python helper directly emitted the complete response. The
existing fake SSH inherited Node's nonblocking stdout; Python's unbuffered large
write was silently truncated. The fixture now uses a fresh stdout pipe and forwards
it with Node's normal backpressure handling.

Reproduction control, before the fixture fix: **exit 0, 65,536 bytes**; after:
**exit 0, 1,400,001 bytes**.

```sh
node --input-type=module <<'JS'
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [
  'scripts/tests/fixtures/fake-ssh.mjs', '/tmp/retained-fixture-control.log', '{}',
  'deploy@transport.test.invalid', `/usr/bin/python3 -u -c 'print("x"*1400000)'`,
]);
let bytes = 0;
child.stdout.on('data', (chunk) => { bytes += chunk.length; });
child.on('close', (code) => {
  console.log({ code, bytes });
  process.exitCode = code === 0 && bytes === 1400001 ? 0 : 1;
});
child.stdin.end();
JS
```

The added regression verifies every downloaded byte, increasing chunk offsets,
the 1 MiB bound, and cleanup after transferring the 2 MiB + 19 byte file.
