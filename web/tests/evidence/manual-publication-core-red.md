# Manual publication core RED evidence

Tests-only revision: `37f7d133f65597cb0ace8990962b55bb7628a5a6`.
Implementation baseline: `74df60098d58909f5ce3b3c712cc675469bb0046`.
Branch: `test/manual-publication-red-core`.

Run from `web/`:

```sh
npx vitest run tests/manual-publication-core.test.ts --reporter=verbose
```

Result: exit 1; **72 failed, 14 passed, 86 executed**. Full output is in
`manual-publication-core-red.log`. Every implementation module imported successfully;
failures are behavioral assertions against the pre-change implementation. The passing
controls include complete new-publication evidence, schedule evidence, unchanged-head and
high-water protection, explicit rollback confirmation, round-trip persistence, and
match/mismatch/unreadable observations.

Also passed for the test file:

```sh
npx eslint tests/manual-publication-core.test.ts
npx tsc --noEmit --allowImportingTsExtensions --module esnext --moduleResolution bundler --skipLibCheck --target es2022 tests/manual-publication-core.test.ts
```

## Scope and API

This is the independent test-first delivery for tasks 2.3, 2.3a, 2.6, 2.11a, 5.2a and
5.3 at the pure authorization / persistence boundary. The test-local types specify
extensions to existing `chooseManualPublication`, `comparePublishedState`, and
verified-pair persistence/merge functions; there are no new implementation modules.

- A new publication authorizes `freshPair`, checked against strict CI evidence and
  the five independently named local groups. Historical success cannot authorize it.
- CI policy fixtures (`expectedCi`) are unit inputs. Production must use its fixed
  trusted policy; this suite does not authorize caller-controlled production policy.
- Reports bind the full pair, destination and tree digest. Required groups and CI
  have nonzero counts. Missing groups and zero counts must be named in the decision.
- Rollback selects `releaseId` and the full pair from its original record, requires
  explicit confirmation/reason, complete original evidence, a retained matching
  tree and fresh rollback checks, and returns `writesProvenanceEntry: false`.
- Full publication records are append-only by `publicationId`; repeated publication
  of the same pair and publication to another destination retain separate records.
- Observation derives the expected pair from the selected destination's history;
  pending operations are destination scoped and explained separately.

The API still carries legacy inputs so this RED run reaches existing behavior;
new-field types are test-local casts, not fallback implementations. Legacy-only
index records remain covered by the separate existing merge suite. Conflicting
old publication tests (automatic success publication, selection of newest history,
snapshot-age retention) must be migrated when implementing the changed contract.

## Work outside this bounded delivery

- Trusted API acquisition and provenance of CI executed-test counts; the fixture's
  count is not evidence of a production report parser.
- Actual local test runner / browser / payment readiness behavior and fixed production
  policy; the suite tests consumption of reports, not how reports are generated.
- Launcher, transport, host lock, final CMS/head race checks, switch, failed-write
  recovery, host redirect rules, and end-to-end destination persistence.
- IO proof that rollback never contacts CMS/CI, rebuilds, executes old server code,
  or writes the provenance journal. The pure decision can assert only its no-write flag.
- CLI printing of counts; here counts and group names are asserted in decisions.
- Post-implementation negative mutations of new gates. They require the GREEN
  implementation and must be performed and logged there; this RED report does not
  claim they have already passed.
