# Redirect publication transaction: independent RED delivery

Baseline: `codex/manual-publication-implementation@fd7a625eeb0a223c2b29f54b452832419bd34776`.
The production transport and remote Python are unchanged in this delivery. Tests were
written independently before the redirect-transaction implementation, in the separate
`codex/publication-redirect-red` worktree. No real host or GitHub was changed.

## Requirements and boundary

- `openspec/changes/manual-publication-only/design.md`, sections 2b, 3, 3a, 4:
  one transport, checked retained bytes, pending recovery, final provenance/main check
  after heavy work, no automatic rollback after activation.
- `openspec/changes/manual-publication-only/specs/deploy-gating/spec.md`, requirements
  «Ручная публикация остаётся доступной» and «Код из стороннего репозитория не
  исполняется привилегированно»: destination-bound history/rollback and limited privileges.
- `openspec/changes/server-hardening/specs/server-hardening/spec.md`, requirement
  «Права выкладки ограничены и покрывают её фактические действия»: existing redirect
  include only; named inspection, validation and reload commands; no vhost writes.
- `openspec/specs/static-serving/spec.md`, redirect/cache interaction: preserved redirect
  behavior must travel with the content that was validated.

The parent agreed the routine API boundary before these tests were written:
`activate`/`rollback` receive `redirectsPath: 'deploy/nginx-redirects.conf'`, which may
select only that fixed artifact within the digest-checked tree. Its omission remains a
library compatibility control; the publication worker must always supply it. The existing
`activeOperation` transport error property is what the worker converts to `activePair`.

The detailed transaction design was reported separately to the parent. These tests do
not define a new provisioning path. Absent production full-vhost artifact, configuration
drift/previous-config evidence, and first-confirm prerequisites remain blockers; the
existing stand-vhost manual deviation remains named, not repaired by privileged writes.

## Reproduction

```sh
node --test scripts/tests/publication-redirect-transaction.test.mjs
```

Result against baseline: **22 tests, 2 pass, 20 fail, exit 1**. Full observations are in
`publication-redirect-transaction-red.log`.

All cases call existing `stage`, `activate`, `rollback`, and `recover` methods. There are
no missing-export failures or no-op API shims. Representative red observations:

- Final check sees old redirect bytes, because incoming fragment was never installed.
- Wrong-path/comment/other-vhost includes and failed `nginx -T`/`-t` do not refuse.
- Rollback switches HTML but retains the new release's redirect configuration.
- Reload failure is ignored because reload never happens.
- Prepared cancellation/recovery clears pending after unexpected manual config drift.
- Committed crash recovery attempts to attest new HTML with old redirect bytes.
- Missing artifact, arbitrary artifact selector and symlink destinations are accepted.
- Candidate-validation crash and failed restore are never reached because no config
  transaction happens.

Existing digest protection over a tampered retained fragment passes. The real
`committing` + old-current crash remains blocked and passes. These controls establish
that red is the absent redirect transaction, not broken upload/digest/phase machinery.

## Historical positive controls

```sh
node --test scripts/tests/publication-serving-probes.test.mjs \
  scripts/tests/publication-transport.test.mjs \
  scripts/tests/publication-transport-retained.test.mjs \
  scripts/tests/publication-transport-review.test.mjs \
  scripts/tests/publication-transport-authorization.test.mjs
```

Result: **83 tests, 83 pass, 0 fail, exit 0**.

The existing serving-probe fixture still executes the exact remote Python submitted by
production `createSshTransport`. Its optional `transactionRoot` mode adds only OS boundary
observations, fixed `nginx -t`/reload stubs, and explicit filesystem/process faults. Real
network and unrecognized commands remain denied. Without that flag its original probe
observations are unchanged. Crashes occur in the real process at `os.replace(current)`
or the actual nginx subprocess boundary, not via a fabricated protocol response.

The test fixture stores the canonical temporary root to match remote `realpath` on macOS;
otherwise `/var` versus `/private/var` would prevent the intended current-switch fault.

`git diff --check`: clean. No production code, accepted requirements, or package files
were edited; no implementation green is claimed by this RED delivery.
