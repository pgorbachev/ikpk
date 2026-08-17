# Preconditions evidence

Captured on 2026-08-17 against `origin/main` at
`99f660a6a54852517575037109ca4dfbf601b96e`.

## Required checks before the change

The repository branch-protection GraphQL query returned the following exact contexts
for `main`:

1. `web checks`
2. `cms checks`
3. `scripts checks`
4. `Unit and build tests`
5. `Playwright smoke (desktop + mobile)`
6. `Secret scan`
7. `Runtime dependency audit (web)`
8. `Runtime dependency audit (scripts)`
9. `Lighthouse budgets (4 templates, median of 5)`

The same response reports `requiresStatusChecks: true` and
`requiresStrictStatusChecks: false`. `Scripts unit tests` is not in the required
contexts before this change.

Reproduction command:

```sh
gh api graphql -f query='query { repository(owner:"pgorbachev", name:"ikpk") { branchProtectionRules(first:20) { nodes { pattern requiresStatusChecks requiresStrictStatusChecks requiredStatusCheckContexts } } } }'
```

## Workflow write capability

`gh auth status` reports the active `pgorbachev` token with scopes
`gist`, `read:org`, `repo`, and `workflow`. The token therefore has the `workflow`
scope needed to push a branch that changes `.github/workflows/`.

## Required checks after the change

After draft PR #123 created both new check contexts, the required-status-checks endpoint
was updated without changing strictness or removing any existing context. Its response
on 2026-08-17 reported `strict: false` and these eleven exact contexts:

1. `web checks`
2. `cms checks`
3. `scripts checks`
4. `Unit and build tests`
5. `Playwright smoke (desktop + mobile)`
6. `Secret scan`
7. `Runtime dependency audit (web)`
8. `Runtime dependency audit (scripts)`
9. `Lighthouse budgets (4 templates, median of 5)`
10. `Dependency update invariants`
11. `Scripts unit tests`

Reproduction command:

```sh
gh api repos/pgorbachev/ikpk/branches/main/protection/required_status_checks
```
