# Independent bounded retained rollback review

Reviewed `codex/retained-checks@6318961597bfd440437d229d3d855b14082c985e`,
including implementation `7a2e6591c974b3c85f9fd0f13267f9fa87bb2d71`.
Separate reviewer and isolated worktree; no implementation changes.

## Findings

### P2: invisible schedule passes the browser group

`web/tests/publication-smoke.spec.ts:67–75` checks DOM count against HTML count and
registration href syntax. Neither assertion establishes that a visitor sees any card
or can use a visible registration link. The retained adapter newly uses this suite
as its fixed browser group. The approved change requires working schedule and
registration links on desktop/mobile (`manual-publication-only/specs/deploy-gating/spec.md:163,184`).

On a copied real artifact, inject exactly this rule before `</head>` of
`raspisanie-i-tseny/index.html`:

```html
<style>[data-schedule-item]{display:none!important}</style>
```

Independent Chromium observations at widths 1280 and 375: 57 DOM cards remain;
visible cards fall **25 → 0** in both. The real coordinator nevertheless accepts
all groups, **4 destination + 8 browser + 1 payment absence = 13**. The independent
expected-refusal assertion fails. This is not an integrity bypass: the mutated
tree receives its own digest. It demonstrates a false successful browser verdict
for that tree. Check actual visible schedule content and a usable visible
registration link, while allowing pagination to hide the other cards.

Evidence: `retained-review-schedule-hidden.json`, `retained-review-schedule-hidden-red.log`.
Original copied-tree bytes restored in `finally`; before/restored digest both
`b0b50e3f0bdb187cc31e2181d29d83a0fe2f9398917379c15326145be3ad8204`.
The source build was never modified.

The earlier zero-card deletion hypothesis was **not confirmed**: deleting 57 cards
also removes all registration links, so the real browser group already rejects
it (6 passed, 2 failed). It is a negative control, not a second finding.

### Known typed failure-count issue: independent RED only

Parent requested regression coverage for its already identified follow-up.
`manual-publication-rollback-counts-review.test.ts` has two failures on the reviewed
revision: first destination `PublicationReportError(local, 0)` leaves the audit
count absent; after destination 2, browser `PublicationReportError(local, 3)` leaves
2 instead of 5. This is not counted as a new review finding. Evidence is in
`retained-review-counts-red.json`.

## Scope and positive checks

- Retained coordinator/adapter/tree helper contracts: **20/20** pass.
- Rollback wrapper identity, digest, authorization and recording tests: **15/15** pass.
- Own real retained harness: **13/13** pass; original digest is unchanged.
- Reviewed fixed group selection; installed-command cwd; no snapshot/CMS/build/main
  dependency in retained checks; sanitized process environment; absolute artifact
  binding and report containment; digest before/after and wrapper binding to original
  release identity and proof; Article and Event/Course selection.
- No additional confirmed P0/P1 in this bounded scope. Installed CLI, retention and
  serving transaction are outside scope. Known active payment role/config issue
  and typed-count issue were not re-reported as new findings.

## Reproduction

From `web/`, using the source existing build without rebuilding it:

```sh
node_modules/.bin/vitest run tests/manual-publication-rollback-checks.test.ts tests/manual-publication-rollback-adapters.test.ts tests/manual-publication-retained-tree.test.ts
node_modules/.bin/vitest run tests/manual-publication-rollback.test.ts tests/manual-publication-rollback-review.test.ts
node_modules/.bin/tsx tests/helpers/publication-retained-real-smoke.ts /Users/pgorbachev/projects/private/ikpk-manual-publication-adapters/web/dist > tests/evidence/retained-review-real-green.json
node_modules/.bin/tsx tests/helpers/retained-review-schedule-red.ts tests/evidence/retained-review-real-green.json
node_modules/.bin/vitest run tests/manual-publication-rollback-counts-review.test.ts
```

The last two commands are intentionally RED before fixes. Optional final argument
`empty` on the visibility helper runs the already-rejected zero-card control.
Recreate the real harness evidence before rerunning: its scratch artifact is cleaned
after the review.

## Separate simplification pass

No required deletion or abstraction identified. The shared adapter factory uses one
retained discriminant to remove source dependencies while keeping the real fixed
checks shared. The rollback coordinator has a smaller pipeline with a genuinely
different contract; forcing both coordinators into a generic workflow would add
indirection. Optional deduplication of the two small path helpers is not a blocker
and was not requested as another abstraction.
