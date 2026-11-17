## Why

The user asked for article SEO fields to work like seminar SEO: editors should be able to publish an article without manually writing SEO title and description, while the website supplies useful defaults. Today the article template has partial fallbacks, but both the CMS publication gate and the content snapshot contract still require both SEO fields, so the requested authoring behavior cannot be used.

## What Changes

- Make Article SEO title and description independently optional at publication time.
- Use the article title as the default page/structured-data title and a sanitized plain-text excerpt from the article body (up to 200 characters) as the default description.
- Keep editorial overrides independent, preserve them when nonblank, and compute defaults for publication/snapshot/rendering without saving generated values back to CMS.
- Keep the normalized website snapshot contract and emitted title/description nonempty. Keep URLs, existing nonblank SEO values, noindex behavior, and OG image behavior unchanged.
- Release the website fallback and snapshot support before enabling the CMS publication gate; define a rollback sequence that keeps already-published SEO-empty articles renderable.

If the CMS accepts an Article whose body leaves no text after the existing sanitizer and no description override exists, CMS status may become published while the web snapshot gate rejects the site update. The currently active site publication remains in place; the website snapshot result is the live-site check.

## Capabilities

### New Capabilities
- `article-seo-publication`: Article SEO fields may be omitted independently and are resolved to usable publication defaults.

### Modified Capabilities
- `article-catalog`: Article snapshots and rendered metadata retain nonempty page title and description by resolving missing SEO overrides from article content.

## Impact

This affects Article publication validation in `cms`, CMS-to-snapshot normalization in `web/scripts`, and Article metadata generation in `web`. It does not change schema/API field names, CMS persistence, slug/URL behavior, robots directives, or OG image selection. This delivery synchronizes the overlapping Article requirements in the active `cms-content-authoring-and-migration` change before either delta is approved or applied.
