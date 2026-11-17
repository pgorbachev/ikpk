## Context

See `proposal.md` for the requested authoring behavior. Current main has three different states: `cms/src/lib/publication-validation.ts` requires both Article SEO fields; `web/scripts/lib/content-contract.ts` requires SEO title/description in every Article snapshot; and `web/src/pages/statyi/[slug].astro` already falls back at render time to `title` and `body_text.slice(0, 200)`. The article catalog spec still describes the pre-fallback template. The separate active `cms-content-authoring-and-migration` change also states that Article SEO fields are required.

## Goals / Non-Goals

**Goals:**
- Let the CMS publication gate accept missing SEO overrides whenever its existing non-SEO requirements pass; resolve SEO fallbacks only in the web snapshot pipeline.
- Resolve each field independently, keep normalized website snapshots contract-complete, and keep CMS records unchanged.
- Reconcile the article catalog spec and the conflicting active authoring spec as part of implementation planning.

**Non-Goals:**
- Change schema keys, APIs, slug or URL behavior, editorial UI layout, noindex/robots behavior, OG image selection, or SEO rules for other content types.
- Backfill or rewrite existing CMS records or historical snapshots.

## Decisions

1. **Keep CMS and website publication gates separate.** The CMS lifecycle gate checks only its existing required fields; after this change it permits absent Article SEO overrides and does not inspect the web sanitizer or prove defaults exist. The web CMS-to-site snapshot normalizer alone resolves fallbacks and keeps `content-contract.ts` nonempty. If the existing sanitizer leaves no body text and no explicit description exists, reject that new site snapshot before activation; do not invent a CMS sanitizer or a second safety policy.
2. **Treat blank values as absent independently.** Trim only to determine whether an override is blank; preserve a nonblank override as supplied. Derive a missing title from the Article title and a missing description from sanitized visible body text, capped at the current template fallback length of 200 characters. Generated values exist only in validation/normalized website representation and are never saved into CMS.
4. **Keep validator copies synchronized.** `cms/src/lib/publication-validation.ts` is a documented partial synchronized copy of `scripts/lib/cms-publication-validation.ts`. Implement the Article-specific gate consistently in both and add a parity test so direct scripts validation and the CMS lifecycle cannot drift.
5. **Roll out web before CMS using an admitted release.** Follow `docs/release-process.md`: use an exact published `vX.Y.Z` GitHub Release at its full commit SHA with the required main CI green. From that same admitted release, deploy the web fallback and snapshot normalization first, then verify `/release.json`, health, and content-publication checks. Only then deploy/activate the CMS publication gate from that same release revision. CMS-first is unsupported because the prior web snapshot contract rejects missing SEO values. Record the tag, full SHA, web verification results, and CMS installation result for both stages.
6. **Roll back without stranding SEO-empty records.** If the CMS gate has accepted Articles without SEO overrides, restore the previous CMS gate first to block future SEO-empty publications. Keep the fallback-capable web release active while identifying already-published records with missing/blank SEO fields and having editors supply explicit SEO values. Capture and validate the resulting content against the old snapshot contract. Roll back the web release only after that exact snapshot passes the old contract. If the web release fails before CMS gate activation, it can be rolled back normally because the old CMS gate still blocks SEO-empty publication. No CMS content is silently rewritten by the rollback.
7. **Keep URL and other SEO behavior stable.** Slugs, existing explicit overrides, robots/noindex directives, and OG image choice are outside this change. No schema migration or bulk update is required.

## Risks / Trade-offs

- [Snapshot normalization and rendered metadata could diverge] → Resolve fallbacks at the snapshot boundary once and test that normalized values reach generated head and JSON-LD unchanged.
- [The CMS and scripts validation copies could diverge] → Add a parity test and exercise the actual CMS lifecycle in integration tests.
- [Sanitization or entity handling could yield an empty or misleading excerpt] → Extract from the existing sanitized rendered tree, test decoded references and discarded script/style subtrees, and verify that text whose hidden attributes are stripped remains included; reject empty results.
- [Deploying the CMS gate before web compatibility could publish unrenderable content] → Enforce web-first release ordering with exact release IDs and a readiness check before CMS gate deployment.
- [CMS can mark an Article published although the web snapshot gate later rejects the website update] → Treat CMS and website publication as distinct states; surface snapshot failure with the Article identity, keep the previous site publication active, and require a successful website publication result before reporting the content change as live. Do not add a second sanitizer or silently rewrite CMS content.
- [Rollback could leave CMS records that the old snapshot contract rejects] → Keep the fallback-capable web release until published empty-SEO records are repaired and the old contract is verified.
- [The active `cms-content-authoring-and-migration` delta conflicts with this change] → Keep its Article requirement and scenarios synchronized with this change and verify both deltas together before implementation or archive.
- [Existing article URLs could be accidentally regenerated] → Do not touch slug generation; add regression coverage proving unchanged slugs/URLs.

## Migration Plan

No schema migration is planned. Existing nonblank SEO overrides remain authoritative; absent values are resolved in normalized site content, never stored in CMS. A CMS lifecycle success does not mean the website update succeeded: snapshot validation is the authoritative website-publication gate and leaves the active site untouched on failure. Use the exact admitted `vX.Y.Z` release and full SHA for both stages: (1) install and verify web fallback/snapshot compatibility; (2) only after those checks pass, install the CMS gate from the same release revision. On rollback after stage 2, restore the CMS requirement first, retain the compatible web version, have editors repair published Articles with absent overrides, and verify a fresh snapshot passes the old contract before allowing web rollback. Record release tag/SHA, health/publication evidence, repaired record IDs, and old-contract validation result. Do not access production as part of implementation or test verification.

## Open Questions

None. The expected edge case is explicit: CMS may mark an Article published even when the safe rendered body provides no description; the web snapshot gate then fails and the already active site publication remains in place. The website snapshot result, not CMS record status alone, determines whether the content is live on the site.
