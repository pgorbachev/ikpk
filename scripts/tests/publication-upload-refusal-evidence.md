# Upload refusal preservation — RED/GREEN evidence

Baseline: `09976bc095c828c62929cba6d6f13de3333ebace`.
Regression commit (before implementation): `31324bdbdeeddf6925555f19f7a8eca0f2a69b83`.
Fix and fault controls: `267de1f138eacecc1bb225d48e7b0f034fa2e623`.

Expected behavior: a remote retained-release collision must remain identifiable when
its header refusal closes the upload pipe before the client finishes sending bytes.
The upload must still fail when there is no response or an unexpected success reply.

The regression uses the real Python remote through local fake SSH, a previously
retained release and a 16 MiB first payload (larger than the pipe capacity). No
external SSH target, publication or GitHub action is involved.

## RED before implementation

`node --test --test-name-pattern='a retained release refusal survives' scripts/tests/publication-transport.test.mjs`

Exit 1; one named test failed, zero passed:

```text
✖ a retained release refusal survives a broken large upload pipe (2289.413458ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2371.364

✖ failing tests:

test at scripts/tests/publication-transport.test.mjs:164:1
✖ a retained release refusal survives a broken large upload pipe (2289.413458ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /exist|collision|retained/i. Input:
  
  'Error: SSH upload stream failed'
  
      at async TestContext.<anonymous> (file:///Users/pgorbachev/projects/private/ikpk-transport-error-race/scripts/tests/publication-transport.test.mjs:170:3)
      at async Test.run (node:internal/test_runner/test:1113:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:358:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: Error: SSH upload stream failed
        at file:///Users/pgorbachev/projects/private/ikpk-transport-error-race/scripts/publication-transport.mjs:133:112
        at onwriteError (node:internal/streams/writable:603:3)
        at onwrite (node:internal/streams/writable:647:7)
        at WriteWrap.onWriteComplete [as oncomplete] (node:internal/stream_base_commons:89:19),
    expected: /exist|collision|retained/i,
    operator: 'rejects',
    diff: 'simple'
  }
```

## GREEN and bounded failure controls

The same named regression: exit 0, 1/1 PASS. The previous release bytes and current
symlink remain unchanged, with no pending operation. Separate fake-peer controls
close stdin while keeping stdout alive; silence and an unexpected success reply
both remain failures, finish within five seconds, and never expose stderr.

`node --test scripts/tests/publication-transport.test.mjs`: exit 0, 33/33 PASS.

`node --test scripts/tests/publication-*.test.mjs`: exit 0, 172/172 PASS, zero skips.

`scripts/node_modules/.bin/eslint scripts/publication-transport.mjs scripts/tests/publication-transport.test.mjs`: exit 0.

`git diff --check`: exit 0.

## Negative check and restoration

Restored the pre-fix transport from the regression commit while retaining the new
tests. The named large-upload collision regression again failed (exit 1), explicitly
receiving `SSH upload stream failed` instead of a retained-release refusal. Restored
the fixed file byte-for-byte; the identical named test passed again (exit 0, 1/1).

The implementation only drains the existing size-bounded protocol response after a
write failure, for at most one second. It does not read stderr or retry the upload.
