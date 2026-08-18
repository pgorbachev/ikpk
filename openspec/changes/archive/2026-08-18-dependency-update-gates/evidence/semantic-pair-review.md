# Semantic pair review

Reviewed on draft PR #123 at `dbadb31d65063d56b42106da4af87bbf4fb28ad9`.

## Thresholds

- The post-merge web floor is 709 and equals the measured 553 unit + 9 render + 119
  build + 28 demo executions. Skipped/pending tests are excluded by the parser.
- The scripts floor is 13 and equals the measured unit executions.
- The Playwright floor remains 143; its report inputs and aggregation are unchanged.
- Lint floors match the committed package measurements (`web` 218, `cms` 40,
  `scripts` 10).

## Grouping

- Spec, design, tasks, configuration, and tests use the same unit: one dependency name
  across `web`/`scripts` when constraints permit one target.
- Manifest section and relative patch/minor type are not grouping inputs; CMS, majors,
  and different dependency names are separate.
- Filters, security-only applicability, unknown/glob directories, and overlapping npm
  scopes are rejected by the static contract.

## Required checks and publication

- The combined `Dependency update invariants` job contains the three new gates and is a
  prerequisite of publication.
- GitHub branch protection contains the original nine contexts plus that job and
  `Scripts unit tests`; strictness remains false.
- The 30-minute clock consistently starts at the matching main push-run of `Tests`.
  Publication consistently means the current status of a Pages deployment for that
  exact SHA is `success`.

No contradiction remained among these paired requirements after the review fixes.
