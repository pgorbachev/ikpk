# Independent worker / rollback / index integration review

Reviewed revision: `codex/manual-publication-implementation@2a9f54c6bbb4f3cf86653da053ce633b67be9a72`.
Reviewer: independent Codex subagent, separate worktree and branch `codex/worker-rollback-review`.
No implementation edits, deployment, GitHub writes or production requests.

## Finding

**P2 — reject an invalid original revision before rollback activation.**

`web/scripts/lib/publication-rollback.ts:47-48` accepts the original stored publication through
`isPublicationRecord`, CI evidence and local-check validation, none of which validates its
revision. An index entry with revision `0`, `-1` or `1.5` consequently authorizes a retained
rollback. After activation and served-pair verification, `appendPublication` rejects the same
record at `web/scripts/lib/publication-state-store.ts:121-124`, because a positive safe integer
revision is mandatory. This unnecessarily changes serving state and leaves an active pending
operation that cannot be recorded through the ordinary store. Corrupted/incomplete stored
evidence should cause refusal before the transport/switch; use compatible evidence validation
on both sides of that boundary.

The reproduction uses the actual Git store and a local bare remote containing the original
index, with no CMS journal. The existing rollback fixture supplies only retained-tree,
transport and HTTP effects; the real coordinator performs decisions and the real store
validates/writes the index. Revision `7` completes and records the rollback (positive control).
Each invalid revision is rejected only after the fixture observes `switch`.

Reproduce from `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-rollback-review.test.ts
```

Result: **1 passed / 3 failed**, all three failures specifically assert that no switch should
have occurred. Full output: `manual-publication-worker-rollback-review-red.log` beside this file.
No P0/P1 found in this bounded full pass.

## Fix verification

The coordinator now requires a positive safe-integer revision before constructing the
transport. The independent regression and existing rollback suite pass together:
`vitest run tests/manual-publication-rollback.test.ts tests/manual-publication-rollback-review.test.ts`
— **15 passed**. Invalid stored revisions leave the existing release and pending state
unchanged. This closes the reported P2; it does not close the unfinished integration scope below.

## Coverage and verification

Read the full implemented worker, deploy shell entrypoint, new-publication runner, rollback
coordinator, state store, served-pair verification, publication validators and immutable index
implementation, with relevant launcher/transport/check-adapter boundaries and approved change
requirements. Checked source/config bootstrap, credential environments, fixed real ports,
snapshot provenance and final rechecks, scoped authorization, locked retention/digest checks,
fresh rollback groups, original evidence, no CMS/main/old-CI rollback dependencies, immutable
index append/retry, post-switch verification and pending behavior.

Focused existing suite, from `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-worker.test.ts tests/manual-publication-rollback.test.ts tests/publication-state-store.test.ts tests/manual-publication-runner.test.ts tests/manual-publication-runner-review.test.ts
```

Result: **5 files / 75 tests passed**. Native Node `v24.13.0` additionally loaded worker,
runner, check-adapters, rollback and state-store using the actual `tsx/esm/api` register path.
Dependencies were APFS-cloned to the review worktree; no npm install was run.

Explicitly excluded known unfinished work: fd3 structured audit, installed rollback CLI and
three-group production adapters/runtime packaging, nginx/preflight/remote-readiness integration,
retention pruning, explicit pending repair and unavailable production provisioning. No claim
of end-to-end production acceptance is made.

## Separate simplification pass

Optional local deletion: `web/scripts/publication-worker.ts:110-114` checks both
`dirname(launcher)` and `dirname(configPath)` for repository containment although line 83
has already required the config to be `config.json` in the launcher's directory. One directory
check suffices. This is minor duplication, not a correctness blocker; no additional abstraction
or broad refactor is recommended.
