# Source clean-filter regression — RED

Implementation under review: `codex/manual-publication-implementation@f76f6c2f7a9e8094dbe70986ce50c3c74e6f587e`.

Command, from repository root:

```sh
npm --prefix web exec -- vitest run web/tests/manual-publication-launcher.test.ts --reporter=verbose
```

Result: exit 1; 1 failed, 28 passed. Full output: `review2-clean-filter-red.log`.

A local Git clean filter configured in the explicitly supplied source executes before the launcher refuses `dirty-source`. The tracked file changes from `original\n` to equal-length `mutated!\n`; the untracked attributes file selects the filter. The filter writes an execution marker and echoes input, without accessing credentials or network. The refusal and absence of broker/worker execution pass; absence of untrusted execution fails. This violates source authorization ordering, not credential secrecy alone.
