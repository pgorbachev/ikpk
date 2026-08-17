## Test-only verification record

This file belongs to the test-first phase. It records scenarios that cannot be
proved by a deterministic local unit test; it does not claim that they have
already passed on GitHub.

### Automated coverage

- Lint coverage: threshold, dependency-only base comparison, source-change scope,
  and unusable reports are covered by `web/tests/dependency-lint-coverage.test.ts`.
- Platform tuples: nested deduplication, package-name-sensitive loss, explicit
  one-shot allowances, stale allowances, and empty measurements are covered by
  `web/tests/dependency-platform-entries.test.ts`.
- Executed test counts: Vitest and Playwright machine reports, skipped tests,
  dependency-only base comparison, source-change scope, and absent reports are
  covered by `web/tests/dependency-test-count.test.ts`.
- Published head policy is covered by `web/tests/dependency-published-head.test.ts`.
- The locally observable semantics of Dependabot grouping are covered by
  `web/tests/dependabot-grouping.test.ts`.
- Runtime-audit scope before/after a manifest-section move, including empty and
  unreadable measurements at both the checker and CLI boundary, is covered by
  `web/tests/dependency-runtime-audit-scope.test.ts`.
- Full-SHA action pins, readable version comments, file/line diagnostics for a
  movable ref, and placement of all three invariants inside workflow `Tests`
  are covered by `web/tests/dependency-workflow-integrity.test.ts`.

### Manual or stand verification

1. **Actual required checks on `main`.** Repository branch protection is remote
   mutable state and is not represented by a tracked file. After implementation,
   capture before/after output from:

   ```sh
   gh api repos/pgorbachev/ikpk/branches/main/protection/required_status_checks
   ```

   The evidence must show the original nine names and then `Scripts unit tests`
   plus any new standalone gate names (unless the gates are steps in an already
   required job).

2. **Actual Dependabot PR grouping.** A local parser can prove the configured
   scopes but cannot run GitHub's Dependabot scheduler or prove which PRs the
   service opens. After merging the configuration, trigger or wait for one update
   cycle and preserve `gh pr list --author app/dependabot --state all` plus the
   changed package paths for the resulting PRs. Verify `typescript-eslint` in
   particular: `web` and `scripts` share a PR for the same update type, `cms` is a
   separate PR, and majors are separate from patch/minor groups.

3. **Actual signal delivery for an unpublished head.** Unit tests prove the
   decision rule, not that GitHub schedules the monitor and delivers its signal.
   On a disposable branch/stand, make the deployed SHA lag the current `main` head
   beyond the owner-selected limit, run the monitoring workflow, and preserve its
   URL/log showing the exact unpublished SHA. Restore deployment afterwards and
   preserve the successful follow-up run.

### Resolved planning decision

The owner selected per-dependency cross-directory grouping. Task 2.5, spec, and
design now agree: `group-by: dependency-name` combines the same dependency
across `web`/`scripts`; manifest section is not an input; `cms`, majors, and
different dependency names arrive separately. The updated RED evidence is in
`evidence/owner-choice-red.md`.
