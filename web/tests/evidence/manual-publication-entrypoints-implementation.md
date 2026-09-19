# Local/hosted publication inventory — implementation evidence

Implementation revision: `codex/entry-inventory-implementation@1fd728d1a081c1e17ec833420c653ce44bb7c2fc`.
Independent RED: `e209c8e05def3d4fcf1681c06bb020edf297c710` (applied here as `0ac2efea`).

`web/tests/helpers/publication-entrypoints.ts` declares the single launcher chain once,
then checks the actual literal capabilities of executable files, script/bin sources,
npm commands (including lifecycle wrappers), and parsed hosted workflows. Private native
worker/transport edges belong to that implementation; an ordinary local launcher wrapper
is not counted again. Missing/inert members, copied implementations, direct web transfer,
current-pointer writes, private-worker npm wrappers and hosted launchers refuse.

This is a bounded configuration/capability audit, not proof of arbitrary JS/Python/shell
semantics. It recognizes literal commands and the native chain's known implementation
signatures. Generated/dependency/build/test-fixture directories are not production
entrypoints. The existing hosted configuration suite separately covers action/credential
policies; native authorization tests cover the real runtime boundary.

## Verification

From `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-entrypoints.test.ts tests/manual-publication-restore-bypass.test.ts tests/manual-publication-workflows.test.ts
./node_modules/.bin/eslint tests/helpers/publication-entrypoints.ts tests/manual-publication-entrypoints.test.ts
./node_modules/.bin/tsc --noEmit --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions tests/helpers/publication-entrypoints.ts
```

- Integrated: **43 passed, 2 failed**, with both remaining failures intentionally visible.
- Inventory fixture and targeted negative cases: **14 passed**. Actual-repository inventory
  fails with `declared scripts/publication-launcher.mjs; scripts/restore-server-state.sh: current-write`.
- Native restore positive control passes; the current utility test fails because the utility
  actually changes the live symlink to its unverified backup. No remote host is involved.
- Hosted configuration: **28 passed**. ESLint and focused TypeScript check: exit 0.
- Integrated output: `manual-publication-entrypoints-integrated.log`.

From repository root:

```sh
node --test scripts/tests/publication-transport-authorization.test.mjs scripts/tests/publication-launcher-agent.test.mjs
```

**11 passed, 0 failed**, using isolated native fixtures.

## Sensitivity mutation

In `web/tests/helpers/publication-entrypoints.ts`, replace the single
`out.push('current-write');` with `void 0;`, then run from `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-entrypoints.test.ts -t 'local current switch|actual legacy backup'
```

Before: **2 passed, 0 failed** (13 unrelated cases filtered out).
Mutation: **0 passed, 2 failed** because both negative fixtures unexpectedly resolved;
output: `manual-publication-entrypoints-disabled-current-write.log`.
Restore original bytes and rerun the complete integrated command: **43 passed, 2 known
restore failures**, as above. No mutation remains in the committed source.

## Unresolved contract conflict

No restore implementation, restore test assertion, provisioning specification or deployment
contract was changed. `scripts/restore-server-state.sh` remains an independent publisher.
An owner decision on an offline backup-only restore contract is pending. Tasks 2.9/6.1 must
not be represented as fully green until that conflict is resolved and both real-repository
checks pass. The gate does not allowlist or rename the conflicting utility away.
