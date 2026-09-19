# Manual publication launcher RED evidence

Tests plus explicitly incomplete executable stub revision:
`5a2063f96665754a20b60488411f85877ee0de90`.
Planning revision merged first: `2fb57519cc7f44482c2940cd5650ee11e61b3f35`.
Branch: `test/manual-publication-red-core`.

From `web/`:

```sh
npx vitest run tests/manual-publication-launcher.test.ts --reporter=verbose
```

Result: exit 1; **24 failed, 2 passed, 26 executed**. Full output is preserved in
`manual-publication-launcher-red.log`. The two passing fixture controls prove that
broker delivery, the trusted execution marker and the malicious execution marker
really work. The launcher tests execute an installed copy outside the repository;
there is no missing-module failure. The RED-only stub deliberately exits 78 with
`status: not-implemented` and `executedChecks: 0`; its digest export deliberately
throws `not-implemented`. This is not production functionality and must be replaced.

Passed separately for the test source:

```sh
npx eslint tests/manual-publication-launcher.test.ts
npx tsc --noEmit --allowImportingTsExtensions --module esnext --moduleResolution bundler --skipLibCheck --target es2022 tests/manual-publication-launcher.test.ts
```

## Agreed boundary

Invocation:

```sh
node /protected/publication-launcher.mjs publish --config /protected/config.json --source-url CANONICAL_URL --source-ref main
```

Optional `--source-dir` explicitly proposes an operator tree; a dirty or local-only
revision must refuse before broker invocation. A dirty cwd without that explicit
input has no authority over source selection. The launcher fetches fresh main and
executes only its `scripts/deploy-web.sh` in a separate clean checkout.

Protected configuration contains `canonicalRepository`, `destinationId`,
`deployMode`, `sshTarget`, and an absolute `credentialBroker` command array. Config
inside the explicitly supplied source or writable by group/others is refused with
`untrusted-config`. The broker writes `{env: {...}}` privately to stdout. The worker
receives `PUBLICATION_DESTINATION_ID`, `DEPLOY_MODE`, and broker-provided credentials
through environment. Its stdout ends with a successful report with nonzero
`executedChecks`; this count is a launcher-fixture control, not CI or local test
suite evidence. Refusal reasons are `dirty-source`, `untrusted-source`,
`untrusted-ref`, `source-unavailable`, and `untrusted-config`.

`digestTree(rootDir, filePaths)` is an import-safe async export of the standalone
stdlib launcher module. Tests require SHA256, stable ordering of explicit relative
paths, independence from temporary root location, sensitivity to paths/bytes,
and rejection of empty lists, traversal, absolute paths and symlink members/parents.

## Coverage and remaining work

Covers tasks 2.3b/2.4 at the local executable boundary, the deterministic digest
part of 2.5, and broker/worker argv, output and fixture-artifact secret handling
from 2.8. All Git repositories/remotes are temporary local directories. No network,
SSH, VPS, production credential or real deployment is involved.

The suite does not prove protected root ownership, the real installed launcher
layout, permissions on all ancestor directories, tamper-resistant installation,
real SSH credential transport, complete artifact enumeration, broker authenticity,
or server checksum mismatch before atomic switch. Those need implementation-level
negative verification and transport/hardening integration. Existing core tests
were not edited. Final head/CMS races and all switch behavior remain outside this
bounded delivery. Post-GREEN negative mutations are still required.

The execution policy rejected the optional shell command setting the source
stub executable bit. It remains mode 0644 and is invoked through Node; the tests
create a separate mode-0700 installed copy as part of their temporary fixture.
