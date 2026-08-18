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

## Auto-merge mutation proof

Draft PR #133 was used as the controlled target. GitHub first rejected the mutation with
`Pull request is a draft`, confirming that the draft guard was active. While required
checks were still pending, the PR was briefly changed to ready and the same GraphQL
mutation succeeded:

```json
{
  "number": 133,
  "autoMergeRequest": {
    "enabledAt": "2026-08-18T08:15:06Z",
    "mergeMethod": "SQUASH"
  }
}
```

`disablePullRequestAutoMerge` was called immediately and returned
`autoMergeRequest: null`; PR #133 was then converted back to draft. Its final observed
state is open draft with no auto-merge request. The former repository-level denial did
not occur.
