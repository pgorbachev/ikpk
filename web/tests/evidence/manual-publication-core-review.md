# Independent core and launcher review

Reviewed implementation: `838eb7b4d527c7d651329de15a201ec7e85f0933`.
Planning baseline: `2fb57519cc7f44482c2940cd5650ee11e61b3f35`.
Regression tests: `a08a64ee22f4816d299c587c646da2d5aaa821fc`.
The four reviewed modules are unchanged in the subsequent main merge
`084b55f5f74c70835ee2c43e8034bfc571a33127` (verified with git diff).

Full pass covered `scripts/publication-launcher.mjs` and
`web/scripts/lib/{publish-gate,published-state,verified-pairs}.ts`: source trust before
execution/credentials, CI and local report validation, rollback authorization,
digest identity, append-only publication records and destination observation.
CLI/workflows/transport wiring is a known later stage and is not reported as a defect.

## Findings

### P1 — local Git configuration executes code before source authorization

At reviewed SHA, `scripts/publication-launcher.mjs:39-42,79` disables hooks and global
Git config, but still honors the explicitly supplied source's `.git/config`.
`git status` invokes a configured `core.fsmonitor` command before refusing a dirty
source. A local command thus executes before origin/main/source authorization,
contrary to the trusted launcher boundary.

Reproduction: the `REVIEW: local git fsmonitor...` test installs an executable marker
hook under `.git`, configures `core.fsmonitor`, dirties the entrypoint, and invokes
`publish --source-dir`. The launcher refuses `dirty-source` and does not call the
broker, but the hook's execution marker already exists. Neutralize executable local
Git configuration for all pre-authorization Git commands; disabling hooks alone is
insufficient.

### P1 — a parent symlink redirects the worker outside the verified checkout

At reviewed SHA, `scripts/publication-launcher.mjs:92-102` checks only the final
worker inode. A canonical main containing `scripts` as a symlink to an external
local directory passes `lstat(worker).isFile()`; the launcher then issues credentials
and executes that directory's `deploy-web.sh`. Those bytes are not from the verified
revision.

Reproduction: the `REVIEW: parent symlinks...` test commits and pushes such a symlink
to its isolated canonical bare remote. The external worker execution marker appears.
All components between the verified checkout and the worker must remain inside that
checkout and be nonsymlinks before calling the broker.

### P2 — immutable records can be reordered to change the expected published pair

At reviewed SHA, `web/scripts/lib/verified-pairs.ts:23-27` checks membership and field
identity but allows replacing `[p1,p2]` with `[p2,p1]`. The records themselves remain
identical, so the writer accepts the replacement. However,
`web/scripts/lib/published-state.ts:15-16` treats the last array element as the last
publication, silently changing the expected pair to the older release.

Reproduction: the `REVIEW: persisted append-only history...` test writes two records,
then writes them in reverse order; the expected refusal does not occur. Preserve the
existing publication sequence as an append-only prefix, and make merge order derive
from the authoritative remote history rather than a stale local ordering.

## Regression run

From `web/`:

```sh
npx vitest run tests/manual-publication-core.test.ts tests/manual-publication-launcher.test.ts -t 'REVIEW:' --reporter=verbose
```

At the exact regression-tests commit: **3 failed, 112 skipped**, exit 1.
`manual-publication-core-review-red.log` preserves the command, SHA and full output.
The preexisting full bounded suites passed **112 tests**, with only the three new
review probes excluded. These are actual repro failures, not missing imports.

## Targeted negative mutations

All five mutations were applied one at a time in the separate review worktree and
restored to the committed implementation bytes. Exact replacements, commands,
individual test names, output and restored SHA256 values are in
`manual-publication-core-review-mutations.json`.

| Gate / mutation | Before | Mutated |
|---|---:|---:|
| Remove CI repository equality | 1 pass | 1 fail |
| Derive required groups from available report groups | 5 pass | 5 fail |
| Remove input file list sorting from digest | 1 pass | 1 fail |
| Disable persistent-history immutability rejection | 1 pass | 1 fail |
| Disable dirty-source rejection before broker | 1 pass | 1 fail |

`git diff` against the reviewed implementation for all four modules is empty after
restoration. Mutations do not claim coverage of remaining transport or runner gates.

## Simplification review

No additional abstraction or framework is justified for this delivery. Two small
cleanup opportunities belong with the remaining migration:

- Remove unused `now` / `retentionDays` inputs from the manual chooser and the legacy
  snapshot-retention constant once old CLI callers have migrated; retained releases,
  not snapshot age, now define rollback availability.
- Replace the launcher's hard-coded `executedChecks: 7` with a factual source-validation
  result or the actual runner report. It is only a fixture-level launcher counter
  today and must never become proof that CI or publication tests ran.

These cleanup suggestions are distinct from the three actionable defects above.

## Handoff

Root implements fixes; reviewers do not modify implementation in its worktree.
The next separately scoped test-first delivery is `readCiEvidence` (GitHub API run,
all five required jobs, trusted run JSON test counts) and the `test:publication`
runner. It has not been started by this review task.
