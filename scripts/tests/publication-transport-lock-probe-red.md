# Deterministic host-lock witness

The previous 150 ms wait after fake SSH startup allowed a missing-lock mutation to
survive when Python had not reached the callback yet. The operator test now probes
`root/.publication.lock` with an independent Python process using
`fcntl.LOCK_EX | fcntl.LOCK_NB` after each operator has signaled `entered`.
Acquisition must be blocked while the callback owns the lock. After both owners
release, the same probe must acquire it, providing the positive control. The two
separate operator processes and real fake-SSH connection count remain checked.
There is no production delay or implementation-source inspection.

On the unchanged no-op RED stub, Node v24.13.0:

```sh
node --test --test-name-pattern='two separate operator processes' scripts/tests/publication-transport.test.mjs
```

2026-09-19: **1 test, 1 RED**, 340 ms. Exact assertion: callback must hold the actual
host OS lock; observed `available`, expected `held`. Syntax and whitespace checks
pass. GREEN and the missing-lock mutation are delegated to the implementation
owner, who holds the production implementation in a separate worktree.
