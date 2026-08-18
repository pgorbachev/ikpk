# Repository prerequisites

Observed through the GitHub API on 2026-08-18T08:13:27Z for
`pgorbachev/ikpk`:

```json
{
  "allow_auto_merge": true,
  "default_branch": "main",
  "owner_type": "User",
  "visibility": "public"
}
```

The owner type rules out merge queue as the fallback described in the change design.

The required-status-checks endpoint initially returned `strict: false`. It was updated
to `strict: true` while preserving all 11 check records and their existing `app_id`
bindings:

- `web checks`
- `cms checks`
- `scripts checks`
- `Unit and build tests`
- `Playwright smoke (desktop + mobile)`
- `Secret scan`
- `Runtime dependency audit (web)`
- `Runtime dependency audit (scripts)`
- `Lighthouse budgets (4 templates, median of 5)`
- `Dependency update invariants`
- `Scripts unit tests`

Task 1.5 remains open until `enablePullRequestAutoMerge` is exercised on a safe draft PR
and shown not to return the former repository-level denial. Repository configuration
alone proves the flag but not the mutation path named by the task.
