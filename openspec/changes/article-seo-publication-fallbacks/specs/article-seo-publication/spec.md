## Purpose

Allow article editors to publish without writing optional SEO overrides while ensuring each published article still has useful, nonempty title and description metadata on the website.

## ADDED Requirements

### Requirement: Article SEO overrides are optional

The CMS SHALL allow an Article to be published when `seo_title`, `seo_description`, or both are absent, null, empty, or whitespace-only, provided the article's existing non-SEO publication requirements are met. A nonblank override for either field SHALL be used independently of the other field. Generated values SHALL NOT be persisted to CMS. Existing required Article title and body fields remain required.

#### Scenario: Both SEO overrides are omitted
- **WHEN** an otherwise valid Article has no SEO title and no SEO description
- **THEN** CMS publication is allowed based on its existing non-SEO gate and does not check or resolve SEO fallbacks
- **AND** no generated values are persisted to CMS

#### Scenario: One SEO override is supplied
- **WHEN** an otherwise valid Article has a nonblank SEO title and a missing or blank SEO description, or vice versa, and the web fallback source for the blank field is nonempty after sanitization
- **THEN** the supplied override is preserved and used
- **AND** the web snapshot fills only the missing or blank field from its default

#### Scenario: Whitespace-only overrides are absent
- **WHEN** either SEO override contains only whitespace and the web fallback source for that field is nonempty after sanitization
- **THEN** that field is treated as absent by web snapshot normalization and resolved from its default

#### Scenario: CMS gate does not inspect sanitized fallback availability
- **WHEN** an Article meets all existing non-SEO CMS requirements and has nonempty raw body markup that the existing sanitizer later discards, with no SEO description
- **THEN** the CMS publication gate accepts the Article without generating SEO values
- **AND** subsequent web snapshot validation blocks the new site publication because no description fallback can be resolved
- **AND** the CMS record remains published while the prior site publication remains active

### Requirement: Defaults are derived without changing CMS content

For an Article without a nonblank SEO title, the published website representation SHALL use the nonblank article title as its title default. For an Article without a nonblank SEO description, it SHALL use up to the first 200 characters of plain text extracted from the article body after that body passes through the existing `rich-content-safety` rendering pipeline. The extraction SHALL reflect the text in that sanitized rendered output: content discarded by the existing sanitizer contributes no text; allowed body text remains included when sanitizer-only attributes such as `hidden` or `aria-hidden` are removed and the text therefore remains rendered. Extraction SHALL decode character references, normalize whitespace, and emit plain text; stripping markup with a regular expression alone SHALL NOT satisfy this requirement. Generated defaults SHALL NOT be written into CMS SEO fields. If the sanitized rendered body has no text and no explicit SEO description exists, website snapshot validation SHALL fail and SHALL NOT activate a new site publication.

#### Scenario: Title and body provide defaults
- **WHEN** an Article has a nonblank title and body with visible text but no SEO overrides
- **THEN** its published website representation uses the article title and a sanitized body-text excerpt of at most 200 characters
- **AND** no generated value is persisted to the CMS SEO component

#### Scenario: Sanitized body has no text and no description override
- **WHEN** an Article has no nonblank SEO description and the body contains no text after the existing sanitizer removes discarded content
- **THEN** website snapshot validation fails with the Article and unavailable description fallback identified
- **AND** the current site publication remains active

#### Scenario: Explicit description is not truncated to fallback length
- **WHEN** an Article has a nonblank SEO description longer than 200 characters
- **THEN** the explicit override is preserved under the existing field-length rules and is not shortened by the fallback limit

#### Scenario: Fallback matches sanitized rendered body text
- **WHEN** an Article body includes character references, markup, or content discarded by the existing rich-content safety boundary
- **THEN** the fallback description matches decoded, whitespace-normalized text remaining in the sanitized rendered body
- **AND** it contains no markup or content discarded by that boundary

#### Scenario: Metadata output is nonempty
- **WHEN** an Article with absent SEO overrides passes website snapshot validation
- **THEN** its rendered `<title>`, `<meta name="description">`, `og:title`, `og:description`, and JSON-LD title/description are nonempty and use the independently resolved values
- **AND** robots directives and OG image selection remain unchanged
