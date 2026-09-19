# Retained release read: independent RED evidence

Scope: approved `manual-publication-only` rollback branch in
`openspec/changes/manual-publication-only/specs/deploy-gating/spec.md`.
Implementation baseline: `codex/manual-publication-implementation@2dfd92fdbbff6120d0a18f926623f1ecc0ddef74`.
Tests written independently in isolated worktree `ikpk-retained-read-red`, branch
`codex/retained-read-red-base`. No implementation, deployment or GitHub write is included.

## API agreed before implementation

`session.readRetained({ releaseId })` returns
`{ releaseId, destinationId, currentReleaseId, treeDir }` while retaining the existing
host lock and SSH connection. `treeDir` is an isolated local copy removed when the
lock callback completes, including failure. The transport authorization action is
`read-retained`; its request and proof both bind `releaseId`, in addition to the
existing destination/proof checks. Other authorization actions keep their current
proof contract. Bounded manifest and file-chunk responses may use the same framed
connection. Tests do not prescribe numeric size limits.

## Behavioral RED

Command:

```sh
node --test scripts/tests/publication-transport-retained.test.mjs
```

Result with the temporary inert API below: **0 passed, 20 failed**, exit 1.
Full captured output: `scripts/tests/publication-transport-retained-red.log`.
Failures are missing copied bytes, missing refusals, or failure to remove the empty
local copy. No missing-method, missing-import, compilation or dependency error is
counted as RED. The fixture copies and executes a harmless marker script directly
as a positive control before verifying that retained reads never execute it.

The unimplemented baseline has no `readRetained` method. To expose behavioral
failures instead of counting that missing method, temporarily add `mkdirSync` to
the existing `node:fs` import in `scripts/publication-transport.mjs`, then add this
member at the start of `const session = {`:

```js
async readRetained({ releaseId: id }) {
  const treeDir = join(connectionConfig.root, '..', 'noop-download');
  mkdirSync(treeDir, { recursive: true });
  return {
    releaseId: id,
    destinationId: connectionConfig.destinationId,
    currentReleaseId: 'current-release',
    treeDir,
  };
},
```

This stub only creates an empty fixture-owned directory and returns API-shaped
metadata. It neither reads nor transfers retained bytes and implements no security
checks. Every test fixture removes its directory. The stub was removed after the
RED run; `git diff -- scripts/publication-transport.mjs` is empty.

## Coverage and limits

Twenty cases cover actual binary/empty/Unicode filenames and metadata, unchanged
remote releases/current/index/pending, a positive external flock probe, same-session
read followed by rollback without upload, local cleanup on success and failure,
closed-session refusal, retained script nonexecution, missing/pruned releases,
five invalid IDs, root/file/directory symlinks, FIFO, backslash traversal, two target
proof failures, and two hostile response path cases (absolute and deep traversal).

The stream proxy launches the existing fake SSH, which executes the real Python
remote program locally. It observes request bytes and optionally replaces a filename
in actual remote stdout; it does not emulate transport operations. Each hostile
path case must observe the substitution in the proxy log and verify an isolated
external sentinel was not created. These injection assertions are reachable only
after the read implementation exists; the inert stub fails earlier on missing
rejection. GREEN must therefore demonstrate those assertions as well.

A read issues one manifest request and uses one SSH connection. Repeated identical
file-chunk requests are refused by the test oracle as duplicate transfers. Numeric
resource limits and broader concurrent filesystem-adversary races are outside this
bounded suite.

## Existing baseline

After removing the stub:

```sh
node --test scripts/tests/publication-transport.test.mjs \
  scripts/tests/publication-transport-review.test.mjs \
  scripts/tests/publication-transport-authorization.test.mjs \
  scripts/tests/publication-transport-harness.test.mjs
```

The requested baseline contains 47 existing cases. First run: **46 passed, 1 failed**.
The unchanged case `REVIEW: prepared crash recovery refuses when current changed to
another retained release` expected `/pending|unfinished|unresolved/i` at line 505,
but received `SSH upload stream failed`. This baseline failure is reported rather
than fixed in a tests-only delivery. It is unrelated to the new proxy or suite,
which were not included in that run.

One isolated retry passed (**1 passed, 0 failed**):

```sh
node --test --test-name-pattern='prepared crash recovery refuses when current changed' \
  scripts/tests/publication-transport.test.mjs
```

The first failure remains recorded; a passing retry does not erase the observed
baseline error-message race. Syntax checks for both new `.mjs` files passed.
