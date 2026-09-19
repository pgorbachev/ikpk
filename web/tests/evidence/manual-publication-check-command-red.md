# Standalone publication checks — independent RED delivery

Base: `codex/manual-publication-implementation@ca183a5c81f9f40d78d8d254f228973360b2507a`.
Worktree: `/Users/pgorbachev/projects/private/ikpk-publication-check-red`.
Subject: approved `manual-publication-only` design §3a and task 4.4.
No implementation, production publication, real SSH, or GitHub writes were performed.

## Contract handed to the implementation executor

`npm --prefix web run test:publication -- --snapshot-dir ABS --ledger-dir ABS --config ABS --commit SHA --report ABS`

The package script invokes `tsx scripts/publication-check-command.ts`. The entry exports
`runPublicationCheckCommand({ argv, env, cwd })`, returning `LocalChecks`; `cwd` is the web
working directory, and output is its fixed `dist`. The protected configuration is validated
with existing `protectedFile` / `readConfig`. Reporter directory is fixed to `${report}.checks`.
The command cannot choose checks, substitute report input, accept restored state, or publish.

Use the actual `runPublicationChecks` and `createPublicationCheckPorts`. Override only capture
with a validated read of the supplied existing live snapshot. Snapshot bytes and journal remain
unchanged. The five fixed groups check this snapshot and one build; `release.json` precedes
the digest, and evidence is fresh and outside both artifact and snapshot. Active payment roles
use the existing restricted `connect` / `payment-readiness` source proof and fixed preflight;
`ci` contacts no SSH or payment API. No credential broker is required. Invalid CLI arguments
produce a safe `publication-check-arguments` diagnostic, not an arbitrary missing-script exit.

## Commands and measured result

From `web`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-check-command.test.ts --reporter=json --outputFile=tests/evidence/manual-publication-check-command-red.json
./node_modules/.bin/eslint tests/manual-publication-check-command.test.ts
npm run typecheck
```

Vitest: **22 collected, 1 passed, 21 failed**. The passing fixture control executes the real
existing runner and adapters, verifies the real HTTP preview and release metadata, computes
a real tree digest, and consumes five nonzero groups. External subprocess effects and SSH
transport are mocked. This is orchestration evidence, not a claim that Astro or browser suites
ran on production content.

Twenty missing-entrypoint assertions and one missing-package-script assertion are RED. The
entry existence/export checks occur outside expected rejections, so negative scenarios cannot
turn green merely because the implementation is absent. Invalid-argv CLI execution is asserted
only after the package entry exists. Full evidence is in the adjacent JSON report.

ESLint: passed. Typecheck: passed, 423 files, 0 errors, 0 warnings, 7 existing hints.
