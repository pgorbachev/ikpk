## 1. Prepare red tests before implementation

- [ ] 1.1 Add failing unit tests for both publication-validation copies: Article with both SEO overrides absent, each partial override, whitespace-only values, missing required title/body, and all unchanged non-SEO publication requirements; add a parity assertion for both implementations.
- [ ] 1.2 Add failing tests through the actual CMS publication lifecycle using nested `seo.seo_title`/`seo.seo_description`, including publish with both absent, each partial override, and update payloads that omit/preserve the other nested SEO value; prove CMS gate does not resolve or inspect web sanitizer fallback availability.
- [ ] 1.3 Add failing capture/normalization and content-contract tests showing absent Article SEO overrides are independently resolved in the website snapshot while required normalized fields remain nonempty; retain nonblank editorial values.
- [ ] 1.4 Add failing site publication tests for generated `<title>`, description/OG text metadata, and JSON-LD title/description from the normalized snapshot; also prove that a body with no text after the existing sanitizer makes site snapshot validation fail while CMS record remains published and the previously active site publication stays unchanged.
- [ ] 1.5 Add red excerpt-resolution tests that compare the fallback to the actual Article render sanitizer output: character references decode to text; script/style/discarded subtrees contribute no text; text under `hidden`/`aria-hidden` is included when sanitizer strips those attributes; whitespace is normalized. Test the fallback extractor rather than rewriting or extending sanitizer policy.
- [ ] 1.6 In a separate test-authoring session and isolated worktree, run the complete new regression suite against untouched production code before implementation begins. Preserve the exact command, exit status, failed behavior-test identifiers, and stdout/stderr as red evidence; confirm failures identify the missing behavior, not setup or unrelated errors. If an underlying sanitizer characterization assertion already passes, record it separately as green baseline evidence. Hand the exact test revision and evidence to the separate implementation session.

## 2. Implement and turn the red suite green

- [ ] 2.1 Implement the Article-only optional SEO gate in `cms/src/lib/publication-validation.ts` and `scripts/lib/cms-publication-validation.ts`; keep their parity test green and preserve other content-type gates.
- [ ] 2.2 Implement lifecycle-compatible validation for nested SEO component values without resolving or writing generated defaults into CMS; make lifecycle tests green for both absent and partial overrides.
- [ ] 2.3 Implement snapshot normalization using the current Article title and text derived from the existing sanitized rendered body; preserve the nonempty normalized snapshot contract and make capture/contract tests green.
- [ ] 2.4 Make actual static Article output use the normalized independent values for `<title>`, description/OG text metadata, and JSON-LD; keep the empty-sanitized-body case from activating a new site publication, and return a clear failure identifying the Article while preserving the CMS state and prior active site state.
- [ ] 2.5 Add URL/slug, existing explicit SEO value, robots/noindex, and OG image regression assertions; verify none changes.
- [ ] 2.6 Re-run the captured red suite and record green results for every test first shown failing.

## 3. Verify staged release and rollback readiness

- [ ] 3.1 From an admitted published `vX.Y.Z` release at the exact full SHA, deploy and verify web fallback/snapshot compatibility first; record release ID, `/release.json`, health, and content-publication checks.
- [ ] 3.2 Deploy the CMS publication gate from that same release revision only after web verification succeeds; record CMS release identity and prove new-web/old-CMS and new-web/new-CMS combinations. Confirm CMS-first is rejected by the delivery procedure.
- [ ] 3.3 Verify rollback after CMS gate activation: restore the old CMS gate first, keep compatible web active, repair all already-published SEO-empty Article records through editorial updates, capture a fresh snapshot, and prove it passes the old contract before allowing web rollback. Keep this verification in isolated test data; do not access production.
- [ ] 3.4 Run focused lifecycle/parity, capture/contract, Article HTML metadata, and sanitizer-text tests, then applicable package quality gates.
- [ ] 3.5 Strictly validate this change and the synchronized active authoring delta; apply/archive both in a disposable worktree to prove applicability.
