# Owner-choice review fixes

Reviewed revision: `a66d63ab19871d13072324bd6cf30f38c5ce7eca`.

Independent grouping and publication-monitor reviews found five actionable issues. The
follow-up implementation:

- queries Pages deployments for the current `main` SHA;
- selects the current deployment status deterministically by `created_at` and does not
  accept an older `success` after a newer failure;
- measures the 30-minute window from the matching `main` push-run of `Tests`, not from
  the commit's author/committer timestamp;
- states Dependabot's compatible-constraint limitation and permits relative patch/minor
  differences within the selected dependency-name group;
- rejects grouping filters, security-only applicability, and overlapping npm scopes in
  the committed configuration tests.

The new adapter suite was first run before its implementation existed:

```text
Test Files  1 failed | 1 passed (2)
Tests       7 passed (7)
Error: Cannot find module '../scripts/lib/github-published-head'
```

After the first implementation, the focused command passed 14/14. Final re-review added
coverage for empty status lists, malformed deployments/statuses, glob scopes, and YAML
null values, and complete pre-validation of the deployments response. The final full
unit command passed 33 files / 552 tests. Together with render 9, build 119, and demo 28,
the web Vitest floor is 708 executed tests.

The production adapter was also executed read-only against GitHub with Node 22.22.3. It
resolved the matching push run, current Pages deployment and status, and reported:

```text
вершина main 99f660a6a54852517575037109ca4dfbf601b96e опубликована
```
