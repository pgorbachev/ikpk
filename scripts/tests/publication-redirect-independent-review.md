# Independent redirect transaction review

Reviewed full revision `9747fd527da3bfa760fe86aaa844ecbd69007902`
(`codex/redirect-transaction`) against base
`014dc87715184f41815fc394a3c42e86cb576362` in a separate worktree.
No implementation, production host, GitHub comment, or deployment changes.

## Confirmed finding

**P1: indirect include sharing permits cross-destination redirect changes.**
At the reviewed revision, `scripts/lib/publication-remote.py:226-227` checks only
literal direct `include <destination>/shared/nginx-redirects.conf` directives in
other server blocks. A different destination can consume that same file through
`include <destination>/shared/*.conf` or a wrapper snippet containing the literal
include. `nginx -T` dumps each source file once, rather than expanding the include
into each caller's block. The parser discards file headers and caller relationships,
so both configurations pass. Publishing replaces and reloads the shared redirect
fragment for both destinations and records success. Binding must account for other
consumers, or refuse an ambiguous include graph before any write.

Independent RED tests appended to `publication-redirect-transaction.test.mjs`
exercise both paths through the real SSH transport and uploaded Python harness.
Each fails because `recordIndex` ran once when it must not run; the failure is not
an exception thrown from the callback. Local native nginx independently accepts
both fixture layouts (`nginx -T`, exit 0).

## Verification

Before additions: **108 passed / 0 failed** using:

```sh
node --test scripts/tests/publication-redirect-transaction.test.mjs \
  scripts/tests/publication-serving-probes.test.mjs \
  scripts/tests/publication-transport.test.mjs \
  scripts/tests/publication-transport-retained.test.mjs \
  scripts/tests/publication-transport-review.test.mjs \
  scripts/tests/publication-transport-authorization.test.mjs
```

Targeted independent RED command:

```sh
node --test --test-name-pattern='REVIEW: refuses shared redirects' \
  scripts/tests/publication-redirect-transaction.test.mjs
```

Result: **0 passed / 2 failed**, both with `actual: 1, expected: 0` for index calls.
The full six-file suite after the additions returned **108 passed / 2 failed**;
only the two independent cases fail. `git diff --check` passed.
Native configuration proof (runs inspection only, starts no server):

```sh
python3 - <<'PY'
from pathlib import Path
import tempfile, subprocess
with tempfile.TemporaryDirectory(prefix='ikpk-native-nginx-review-') as temporary:
    root = Path(temporary)
    (root / 'shared').mkdir()
    fragment = root / 'shared' / 'nginx-redirects.conf'
    fragment.write_text('location = /legacy { return 301 /old-page; }\n')
    wrapper = root / 'wrapper.conf'
    wrapper.write_text(f'include {fragment};\n')
    for kind, include in [('wildcard', root / 'shared' / '*.conf'), ('wrapper', wrapper)]:
        config = root / 'nginx.conf'
        config.write_text(
            f'pid {root}/nginx.pid; error_log stderr; events {{}} http {{ access_log off; '
            f'server {{ listen 127.0.0.1:19880; root {root}/current; include {fragment}; }} '
            f'server {{ listen 127.0.0.1:19881; root /other/current; include {include}; }} }}\n')
        result = subprocess.run(['nginx', '-T', '-c', str(config), '-p', str(root)],
                                capture_output=True, text=True)
        print(kind, result.returncode, result.stderr, result.stdout)
        assert result.returncode == 0
PY
```

Executed with `/opt/homebrew/bin/nginx`; wildcard and wrapper both returned 0,
with `syntax is ok` and `test is successful`.

## Simplification review

No independent deletion or standard-library replacement is justified by this diff.
The bounded fragment reader, durable old/new evidence, atomic replacement,
prepare/cancel/commit recovery phases, and active-operation error propagation each
serve distinct tested failure paths. The include-parser issue above is a correctness
failure, not an optional simplification finding. `/ponytail-review` was not available
in this session or discovered among local skills; this was a manual full-diff
simplification review, not a claim to have executed that skill.

Worker/build wiring and protected installation/full-vhost changes remain outside
this review's assigned scope. No additional confirmed defects were found in the
bounded transaction, transport error path, or supplied fault tests.
