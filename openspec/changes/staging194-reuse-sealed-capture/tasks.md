## 1. Red contract tests

- [ ] 1.1 In a separate clean test session, add and present failing operator/host tests for `--reuse-capture-operation-id`, terminal-state and durable-prepared eligibility, confined path/`cmsUser` ownership/digests, and exact current-fingerprint equality without a new SQLite image or capture.
- [ ] 1.2 Add failing tests proving a reuse across a UTC date boundary preserves the original `.snapshot` bytes, media, referenceDate, snapshotId, origin, and proof; incompatible new-source schema/mapping refuses.
- [ ] 1.3 Add a failing attempted-write check showing the original capture and materialized snapshot/media are in `read_only_paths` from `npm ci` through build and their existing identities stay unchanged.

## 2. Operator implementation

- [ ] 2.1 Implement the explicit reuse option and small operation-to-capture resolver; keep the no-option fresh-capture path intact and make an invalid reuse request refuse without implicit fallback.
- [ ] 2.2 Validate the recorded operation/profile/owner, existing capture manifest and `captureProof.bundleDigest`, current CMS fingerprint, and new-source schema/mapping compatibility; materialize the original validated `.snapshot` and media bytes without recapture or date regeneration.
- [ ] 2.3 Add reused capture and materialized snapshot/media to existing `read_only_paths` from dependency installation through build; record a reference to existing capture proof fields while keeping new build `sourceSha` and operation ID distinct.
- [ ] 2.4 Update `_build_static`/`release.json`, `_static-main` export and commit media probes, Python browser validation, and TypeScript `readStagingSnapshot` so the release keeps the new build operation ID while snapshot origin/proof and media remain tied to the selected capture operation.
- [ ] 2.5 Run focused red/green tests and OpenSpec strict validation; verify refusal leaves CMS, data, and static pointers unchanged.

## 3. Independent acceptance and staging publication

- [ ] 3.1 Have independent reviewers inspect the full implementation revision for behavior, provenance, and omitted requirements; resolve confirmed findings and review the resulting exact SHA.
- [ ] 3.2 After the helper revision is reviewed and installed through the existing host-maintenance procedure, run the owner-authorized static-only staging194 widget publication from exact current `main` with all four required CI workflows green.
- [ ] 3.3 Verify desktop/mobile browser acceptance, durable `static-main-committed` journal evidence, served release/routes/media, unchanged CMS fingerprint, and the recorded exact previous-static rollback target.
