# Dependency gates applicability

The prerequisite archive was committed as
`308b00824dfe05c9ecd94a71d7e55e511659f6af`. At that revision:

- `dependency-update-gates` is archived under
  `openspec/changes/archive/2026-08-18-dependency-update-gates/`;
- its requirements are present in
  `openspec/specs/dependency-update-automation/spec.md`;
- `sanitize-rich-html-content` is archived under
  `openspec/changes/archive/2026-08-14-sanitize-rich-html-content/`;
- the rich-content security dependency registry is committed at
  `web/tests/fixtures/rich-content-safety/security-dependency-registry.json`;
- the producer contract and completeness tests pass: 2 files, 98 tests.

## Disposable application proof

A detached disposable worktree was created at the exact revision above. In that
worktree the following commands succeeded:

```text
./bin/openspec archive dependabot-auto-merge --yes
./bin/openspec validate dependency-update-automation --strict --no-interactive
```

The archive command reported:

```text
dependency-update-automation: update
+ 4 added
~ 2 modified
Totals: + 4, ~ 2, - 0, → 0
Specs updated successfully.
```

The resulting main specification passed strict validation. The disposable worktree was
then removed; the active `dependabot-auto-merge` change remains active and unarchived.
