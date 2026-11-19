## 1. Reconcile and approve

- [ ] 1.1 Reconcile both overlapping requirements with `repeatable-production-cms-deploy`, review the full resulting contract independently, and obtain owner approval before implementation.
- [ ] 1.2 Record the measured 0→NULL before/after projection on a disposable copy of 1ace separately from the as-yet uncaptured fresh production baseline. Add a RED reproduction on a private copy of the verified 1ace backup using its 43b0 old CMS schema and the current FIELD_MAP; record the missing-field failure (890 for 1ace with the PR #510 reader; 882 for the older prod-node225-v2026.1113.2-20261113-01 archive). Record 9fad as the separately identified historical projector; do not infer it from the old CMS SHA. Do not write production.
- [ ] 1.3 In a disposable worktree archive the prerequisite change and verify this delta applies; strictly validate both and deliver overlapping changes atomically.

## 2. Tests before implementation

- [ ] 2.1 In a separate clean-context session write and demonstrate failing tests for unchanged release equality, reviewed ordered migration and complete per-record before/after audit.
- [ ] 2.2 Demonstrate refusal for an unrelated content change, missing/extra/reordered or altered plan steps, mismatched backup, source, operation, production receipt, registry, target schema or projector, audit, candidate digest or fingerprint, stand receipt, and incomplete or unknown audit coverage. Verify inherited and no-op cohorts retain original equality for identical semantics and require version-bound semantic comparison otherwise; verify resume preserves a historical projector SHA distinct from the old CMS schema SHA; test legacy journal-proven absence through the first fresh production lineage, refusal for missing declared old registry, nonempty old and target registries, poisoned ambient registry variables, and wrong target schema.
- [ ] 2.3 Demonstrate that pre-commit restore uses the exact original backup and fingerprint, fails on altered evidence, and never accepts the candidate fingerprint as restore proof.

- [ ] 2.4 Exercise full verified backup → exact-old-source projection → recovery on disposable 9fad and current-source fixtures; reject altered old source, schema, map, helpers, fixture, runtime, registry and backup. Check sealed media, controlled environment and no external writes.
- [ ] 2.5 Verify the complete candidate upload inventory, including nonpublic uploads, against backup by names, SHA-256 and size; reject missing, added or altered bytes unless explicitly reviewed.
- [ ] 2.6 Verify a version-bound semantic comparison accepts unchanged content across projector versions and rejects any unrelated change; test the actual price transformation and registry impact. A raw hash or snapshot ID equality is not proof.

## 3. Implementation and verification

- [ ] 3.1 Implement a reproducible source-bound historical projector and independently checked target projection and complete before/after audit and bind existing operation evidence without new infrastructure; preserve the original equality and recovery paths.
- [ ] 3.2 Exercise the fresh post-editor fenced backup, preserve whichever owner-approved CTA values actually appear in it, and never replay staging edits or receipts. Run focused tests and relevant gates; independently review correctness and completeness, including migration audit and recovery, then perform complexity review.
- [ ] 3.3 Rehearse on disposable copies; verify no production operation was run and identify any outstanding deployment authorization separately.
