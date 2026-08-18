# Post-merge verification

Implementation PR #123 was squash-merged as
`e43d51792ad4712be03b8de53bda4514bee164ac` on 2026-08-17.

## Publication signal and recovery

The manual monitor run used a controlled 31-minute lag for the merged main SHA and no
published SHA. Run 32071149194 failed and logged:

```text
вершина main e43d51792ad4712be03b8de53bda4514bee164ac не опубликована 1860000 ms; опубликован none
```

Run: https://github.com/pgorbachev/ikpk/actions/runs/32071149194

The recovery run supplied the same SHA as published and succeeded:
https://github.com/pgorbachev/ikpk/actions/runs/32071211407

## Live Dependabot grouping

The update cycle started automatically from the merged configuration. It produced:

- PR #124 for `tsx`, changing both `scripts` and `web` manifests/lockfiles;
- PR #126 for `globals`, changing both `scripts` and `web` manifests/lockfiles;
- those two dependency names arrived as separate PRs;
- CMS remains a separate scope; PR #122 is a CMS-only eslint major and contains only
  `cms/package.json` and `cms/package-lock.json`.

Links:

- https://github.com/pgorbachev/ikpk/pull/124
- https://github.com/pgorbachev/ikpk/pull/126
- https://github.com/pgorbachev/ikpk/pull/122

No `typescript-eslint` update was available in this cycle. `tsx` and `globals` exercise
the same dependency-name cross-directory contract with compatible constraints, while
the CMS-only major demonstrates the separate acceptance class.

## One-shot accepted-loss lifecycle

`dependency-platform-entries.test.ts` now executes the four chronological states in one
scenario, treating each previous head as the next accepted base:

1. named loss plus a new allowance — green;
2. tuple returns while the allowance remains — red with `staleAllowances`;
3. stale allowance removed — green;
4. tuple disappears again without a new allowance — red with `missingTuples`.

This gives the merge-boundary semantics without deliberately corrupting a production
lockfile across four repository merges.
