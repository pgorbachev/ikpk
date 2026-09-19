# Independent check-only CLI and build-subject review

Reviewed `codex/manual-publication-implementation@8a4b810a52e382156ba2f84e5b0a4b283b2dac18` in an isolated worktree on 2026-09-19. Scope: standalone CLI, actual runner/adapter selection, protected configuration, input/output separation, fresh reports, environment filtering, scoped readiness authorization, and the demo-gate runtime-import classifier. This is a bounded review, not a full PR approval.

## P1: reject journal/output overlap before starting checks

`web/scripts/publication-check-command.ts:34-37` canonicalizes the journal but only checks where reports will be written. `--ledger-dir=<web>/dist/ledger` is accepted. The snapshot check runs before the build, so it can read valid provenance before Astro empties `dist`. The journal is then deleted by the build; no later check reads it, and the command can write a successful report. Astro's installed `dist/core/build/static-build.js:63-64` empties the output directory by default, and this repository does not override `emptyOutDir`.

The independent regression copies a valid fixture journal beneath the output, then calls the real CLI, runner, and adapters. Only external process/SSH boundaries use the existing fixture; its build effect empties output as Astro does. Expected: refusal before subprocesses and unchanged journal bytes. Actual: accepted, six subprocesses, journal absent. Fix with canonical overlap validation before any check/build effect. The supplied protected config/known-host paths should also be considered when checking destructive output containment.

## Baseline and controls

Commands below ran from the isolated `web/` directory, except the explicitly shown `--root web` command from the repository root.

- Baseline: `./node_modules/.bin/vitest run tests/manual-publication-check-command.test.ts tests/demo-gate.test.ts` — **32 passed** (22 CLI, 10 demo).
- Independent RED: `./node_modules/.bin/vitest run tests/manual-publication-check-command.test.ts -t 'refuses a journal inside'` — **1 failed, 22 skipped**. Failure is the accepted/deleted journal, not missing imports or executables.
- CLI negative mutation: insert `ports.checkBrowser = async () => ({ conclusion: 'success', executedTests: 4 });` immediately before the CLI invokes the runner. `./node_modules/.bin/vitest run tests/manual-publication-check-command.test.ts -t 'builds exactly once'` — **1 failed, 22 skipped**, missing the browser subprocess despite fabricated positive counts. Mutation restored byte-for-byte with `git restore`.
- Runtime-import negative mutation: prepend `import './helpers/dist-pages';` to `tests/demo-output.test.ts`. `web/node_modules/.bin/vitest --root web run tests/demo-gate.test.ts -t 'у каждой проверки обязательного прогона ровно один предмет'` — **1 failed, 9 skipped**, naming the mixed `dist`/`dist-demo` subject. Mutation restored.
- Type-only control: prepend `import type { dist } from './helpers/dist-pages';` instead. `./node_modules/.bin/vitest run tests/manual-publication-check-command.test.ts tests/demo-gate.test.ts -t 'builds exactly once|у каждой проверки обязательного прогона ровно один предмет'` — **2 passed, 31 skipped**. This also verifies restoration of the actual browser execution. Type-only mutation then restored; only the regression and this evidence remain changed.

No other actionable P0/P1/P2 was found in this bounded subject. Report freshness and canonical report containment are checked before effects; snapshot/output overlap is checked by the real runner. Active payment authorization only allows connect/readiness for the configured destination and expires after use. CI role does not probe. Fixed adapter groups do not accept operator-selected commands or reports. Subprocess environments exclude supplied CMS/GitHub tokens and executable injection variables.

## Simplification pass

No removal or replacement recommendation: the CLI delegates to the existing runner/adapters and does not duplicate their five-group sequencing. The AST classifier uses the already-installed TypeScript parser and preserves runtime imports/exports and literal dynamic imports. No extra abstraction or registry is warranted for these two changes.
