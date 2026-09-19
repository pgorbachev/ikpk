# Git metadata configuration containment — RED

Reviewed implementation: `codex/manual-publication-implementation@0604a84d0e728640c17d76277c190535c0887b17`.

```sh
npm --prefix web exec -- vitest run web/tests/manual-publication-launcher.test.ts -t 'configuration inside repository Git metadata' --reporter=verbose
```

Result: exit 1; 1 failed, 30 not selected. The launcher returns success for a 0600 configuration file inside the operator repository's `.git` directory when `--source-dir` is omitted. It invokes the fixture credential broker and canonical worker. The configuration is otherwise identical to the positive fixture.

`repositoryRoot()` uses `git rev-parse --show-toplevel`; inside Git metadata that command fails and is treated as proof of being outside a repository. The guard therefore fails to enforce its intended external-installation boundary. This finding concerns repository containment only; ownership and ancestor directory protection remain a separate installation responsibility.

Before adding this regression, the full core/launcher gate on this SHA passed 145 tests across four files:

```sh
npm --prefix web exec -- vitest run web/tests/manual-publication-launcher.test.ts web/tests/manual-publication-core.test.ts web/tests/cms-publish-gate.test.ts web/tests/cms-publication-pipeline.test.ts --reporter=verbose
```
