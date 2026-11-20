## Context

`repeatable-production-cms-deploy` currently demands both reviewed migration changes and unconditional equality to the pre-migration content fingerprint. Its two overlapping deltas must be reconciled with this change in the same delivery; strict validation alone does not prove applicability. The 0→NULL effect was measured on a disposable 1ace backup copy; a fresh production baseline has not been captured by this proposal.

## Goals / Non-Goals

Prove the expected transformed content from the operation's verified backup without weakening normal equality or recovery. No new infrastructure, stand source, live production test, or post-commit rollback is proposed.

## Decisions

Only a fresh production receipt independently bound to this operation and its complete reviewed composition permits transformed comparison. Inherited and no-op cohorts retain strict original equality when semantics match; otherwise the version-bound semantic comparison is mandatory.

For transformed comparison, use the existing byte-bound staged composition plus an independent closed-world audit of the same verified backup-derived source and exact final candidate. Check every table, record and field, including additions and deletions, against the exact reviewed plans and explicit rules for operational metadata. Bind original backup to the first audited stage, each ordered stage and its receipt to the journal, and the final stage to the candidate DB, registry, target schema/projector, browser-checked snapshot and static digest. Validate unchanged users, roles, permissions, content and media, and verify original upload bytes. Prove that no unchecked table or field is silently dropped. Existing independently reviewed stage auditors may be composed with checks of both endpoint identities and public projections, provided their combined coverage is demonstrably complete; no second universal DB audit engine is required. A passed receipt or repeating the same migration alone is insufficient; no second replay is required.

Retain the complete exact-old-source projector, field map, fingerprint semantics, schemas, transitive helper code and required fixtures for preimage and restoration, with independently bound bytes and a controlled execution environment. An old schema passed to the current FIELD_MAP is insufficient: the 1ace backup using its 43b0 CMS schema has been observed to produce 890 missing-field errors with the PR #510 projector (the older prod-node225-v2026.1113.2-20261113-01 archive produces 882); its historical projector is separately identified as 9fad. Archive and verify historical source paths and their exact commit. Bind projector source independently of old CMS schema SHA: an existing operation must resume with its originally bound projector even if those SHAs differ. Avoid mutable dependency resolution or secret/network access and pin runtime/dependencies.

Bind exact old registry provenance to preimage and restore, and approved target registry bytes to postimage and candidate; a pre-switch journal-proven legacy absence uses a deterministic empty projection without inventing file bytes, whereas missing declared registry bytes refuse. Clear ambient registry overrides. Retain the original fingerprint for restoration. Do not admit arbitrary expected hashes or a general mismatch override.

## Risks / Trade-offs

The existing stage audit may not cover the full closed-world comparison or all provenance links; these must be demonstrated rather than inferred from a passed receipt. Fingerprints do not independently establish audit correctness. Precise before/after comparison and negative tests are required.

## Migration Plan

Reconcile this proposal with the existing approved change and re-review; demonstrate applicability after the existing change is archived in a disposable worktree. After approval and RED tests, implement and verify on disposable copies only. Deployment requires its own admission and authorization.


Old and target fingerprint formats and public mappings can change; raw cross-version hashes or snapshot IDs alone do not establish equivalence. Require a reviewed version-bound semantic comparison that accounts for every unchanged field and explicitly approved transformation; if unavailable, fail closed. The target proof uses the target projector, while backup and restoration use the same historical projector. This is a proposal, not a claim that an adapter is already available.
