# Production occurrence rules retained from origin/main on 2026-10-21

The fresh standard generator produced 11,052 rules (10,203 production and 10,133 demo). Current main contains 220 additional production rules on ten routes absent from both fresh local build roots. This report maps rows from the actual current-main registry and source inventory to the frozen current source inventory.

## Revisions and outputs

- Current main: `fabaa27f1e2108d82e4a0f3e58864b29d40f5419` (469 production routes; 10423 production rules).
- Product source freeze: `5764f89b4c058d5681592bc8127c4127e926bb85`; product sources are byte-identical to this revision.
- Fresh build input commit: `19d3d8c4311420d7e2dbf790146a973342296c31`. Production: `npm run build`, exit 0, 459 pages. Demo: `npm run build:demo`, exit 0, 476 pages.
- Standard occurrence generator: `npx tsx tests/helpers/rich-content-safety/generate-occurrences.ts`, exit 0 at `908fcb27b385f8a4e2fcebede25dd28e0c4c2f1d`.

## Mapping

All 220 added rows come directly from `origin/main@fabaa27f1e2108d82e4a0f3e58864b29d40f5419`. They match the prior 2026-10-19 report's `new` rows exactly, while this report records main's actual current source slots as the old side of each mapping. 200 rows keep both slot ID and source identity; 10 rows keep slot ID but have changed source identity; 10 ChatFacade rows map from the old locator to the unique script slot in the same file. Source identity changed only in `components/MotionScript.astro` (10 rows) and `components/chat/ChatFacade.astro` (10 rows). ContactShell and TopNav rows already match current main's source inventory.

Fresh common production routes provide same-placement output witnesses for 190 rows. 150 retained output identities are present in those current witnesses, including 4 cases where the exact main output remains one of several observed variants. 30 identities are refreshed from current output. 10 canonical rules keep main's route-specific URL because the available witness is another route. The remaining 30 unchanged-source rows have no common-route output witness because their template-specific slots do not appear in the current local production route set.

The 220 appended rows are production-only. Final registry counts: 11272 total, 10423 production, 10133 demo. The earlier 2026-10-19 evidence files remain unchanged. The machine-readable per-row old-main/current-source/output-witness mapping is in `production-occurrence-retention-report-2026-10-21.json`.

## Evidence boundary

The ten retained routes are not present in either fresh local build root, so their current route-specific HTML is not demonstrated here. A common-route witness establishes a current source/output identity emitted on another route; it does not prove the retained route's current rendered HTML or production state. Earlier A01 evidence remains a staging candidate, not production provenance. No staging canonical is used as production evidence.
