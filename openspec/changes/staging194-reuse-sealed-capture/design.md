## Context

See `proposal.md` and `specs/cms-content-source/spec.md`. The current `static-main` path captures current CMS content for each operation and validates the capture against that operation's source SHA. The reuse path needs an explicit distinction between the code being built and the earlier operation that sealed the content input.

## Goals / Non-Goals

**Goals:** Reuse the already stored immutable capture by operation ID; prove it remains the current CMS state; preserve its original proof while binding a new build and release.

**Non-Goals:** Change ordinary static-main capture, CMS publication/migration, production policy, the browser acceptance matrix, or static rollback behavior.

## Decisions

- Add the explicit CLI option `--reuse-capture-operation-id <operation-id>` to `static-main`. Resolve the input only through the existing host operation store; do not accept a free-form path. This keeps the operator action reviewable and prevents path selection from becoming a new interface.
- Reuse only a staging194 operation with durable `prepared` journal evidence, a sealed capture and snapshot, and terminal state `committed` or `recovered`. A recovered row without durable preparation is insufficient. A current old-release snapshot is eligible only when its operation ID resolves to such a record and its capture proof passes the same checks. An invalid reuse request refuses; the existing fresh-capture path runs only on a separate explicit `static-main` invocation without the reuse option.
- Resolve the operation root from the recorded operation ID, never from a user-supplied path. Validate the operation state, staging target/profile identity (journal plus the existing manifest host/site/source tuple), `cmsUser` ownership, sealed permissions, and absence of symlinks. Verify the existing capture manifest and proof fields: database/schema/media digests and per-media byte hashes. Use the already recorded `captureProof.bundleDigest` (the SHA-256 of `capture-manifest.json`) as the stable sealed-capture reference; do not invent a journal digest that the current format does not store.
- Compare the current read-only CMS fingerprint with the fingerprint recorded by the selected terminal operation before building, then retain the existing before/after fingerprint check through static activation. Exact equality may refuse reuse after a harmless write; that is the accepted fail-closed behavior. This path creates no new SQLite image export, CMS backup archive, or capture bundle.
- Check the new source's CMS schema/mapping digest against the capture manifest. Validate the saved `.snapshot` content fingerprint and snapshot ID using its original `referenceDate`, origin, and capture proof. Materialize the selected operation's original `.snapshot` files and media store byte-for-byte into the new code candidate's build input; do not call live capture or regenerate the snapshot using today's date. Keep the original capture operation separate from the new build operation; never reuse the old candidate code root as the build source.
- The capture and materialized snapshot/media must be owned by the configured `cmsUser` and included in the existing `read_only_paths` for every subprocess from dependency installation (`npm ci`) through the build. Sealed modes alone are insufficient; test an attempted write from a subprocess and verify the existing capture/snapshot identities remain unchanged.
- Store a small reference to the old capture in the new operation record: original capture operation ID and source SHA, existing `captureProof.bundleDigest`, and snapshot ID/reference date. Keep the new operation's existing `sourceSha` bound to current canonical `main` and its CI run. The served release uses the new code SHA and reused snapshot ID; browser validation checks the release against the new source and the snapshot proof against the original capture operation without rewriting origin or proof fields.
- Keep every consumer on the correct operation ID: `_build_static` and `release.json` use the new build operation ID; snapshot proof uses the original capture ID; `_static-main` export and commit-time media probes resolve media from that capture; Python browser validation and TypeScript `readStagingSnapshot` accept the two linked IDs without weakening either proof.

## Risks / Trade-offs

- **[Risk] Exact fingerprint equality refuses reuse after unrelated or harmless database changes.** → Fail closed and direct the operator to the existing fresh-capture path; do not weaken the identity check or infer semantic equality.
- **[Risk] A recovered operation may have stopped before a valid capture was sealed.** → Require durable preparation evidence plus all sealed digests; recovery state alone never grants eligibility.
- **[Risk] A provenance mix-up could label old captured content as if captured by the new build.** → Keep the old capture immutable and record capture provenance separately from the new build source in the journal and release validation.

## Migration Plan

No data migration or host mutation is part of implementation. Add the optional operator path and focused tests while retaining the existing fresh-capture path. Install a reviewed helper through the established host-maintenance procedure before invoking it; the later static publication still requires exact-current-main CI, desktop/mobile browser acceptance, unchanged CMS fingerprint, durable commit, and the existing explicit rollback proof.
