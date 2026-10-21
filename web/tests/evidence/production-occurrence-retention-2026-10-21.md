# Production occurrence rules retained from current main on 2026-10-21

The fresh standard generator produced 11052 rules (10203 production and 10133 demo). Current main contains 220 additional production rules on ten routes absent from both fresh local build roots. The rows below were rebound from the actual current-main registry and source inventory to the fresh source/output identities.

## Revisions and outputs

- Current main: `fabaa27f1e2108d82e4a0f3e58864b29d40f5419` (469 production routes; 10423 production rules).
- Product source freeze: `da95fdf0a05359d82b5ebe483b53d7f08436bdb6`; the one-line ChatFacade URL resolution simplification was independently reviewed by two Astra passes and root.
- Fresh build input: `aaddbb51d541d83d01143eaabc36dba9a3dba32a`; production `npm run build`, exit 0, 459 pages; demo `npm run build:demo`, exit 0, 476 pages. Both used only inert `https://chat-loader.invalid/probe/loader_probe.js`; production `DEMO_OUTPUT` was unset. Exact commands, logs, and input SHAs are in the machine-readable report.
- Standard occurrence generator: `npx tsx tests/helpers/rich-content-safety/generate-occurrences.ts`, exit 0 at `e7c6e23f9d24829273a8d0456db301d92b1896d1`. The candidate registry contains 11272 rules (10423 production, 10133 demo).

## Mapping

All 220 retained rows come from actual `origin/main@fabaa27f1e2108d82e4a0f3e58864b29d40f5419` and were checked against its 469-route registry and source slots. 200 rows keep slot ID and source identity; 10 keep slot ID with changed source identity; 10 map through a unique same-file slot relocation. Changed source identities are recorded per file in the machine-readable report.

Fresh common-production output gives same-placement witnesses for 190 rows. 150 retained identities match those current output witnesses; 30 rows use the fresh output identity; 10 route-specific canonical URLs are kept exactly as main has them. 30 unchanged-source rows have no common-route witness because their template-specific slots do not appear in the current local production route set. The standard generator's 11052 rows are preserved. After candidate `23cf8e293eec4911fa4cbf6ccc0447fc9169dd29` was committed, a one-shot clean-tree generation produced exactly the candidate registry minus the retained 220 rows (11052 rows); all compared metadata matched except the expected `generatedFromSha`. The exact candidate registry SHA-256 `4fa12c7a78b1ed2b0b766ca6c9449ef069a48079aee67791aece74c665eff0e7` was restored byte-for-byte.

The per-row mapping, output witnesses and retained rules are in `production-occurrence-retention-report-2026-10-21.json`. The 2026-10-19 historical report remains unchanged.

## Evidence boundary

The ten retained routes are absent from both fresh local build roots, so this report does not establish their current route-specific HTML, production state, deployment or acceptance. Common-route witnesses establish only a current source/output identity emitted on another route. Earlier A01 evidence remains a staging candidate only; no staging canonical is used as production evidence.

## Diagnostic build results

Two earlier `test:build` runs are recorded as failures, not successes. The initial run with `CHAT_LOADER_SRC` unset failed the chat configuration assertion and the broad media URL scan; the latter was traced to the redundant `new URL(...)` in ChatFacade and removed by the reviewed one-line source fix. A subsequent `CHAT_LOADER_SRC=none` run passed 277 tests and failed one hazard identity assertion because the occurrence registry still held the pre-fix ChatFacade body hash. The exact second diagnostic is losslessly gzip-compressed at `docs/evidence/chat-entry-visibility/test-build-none-stale-registry-2026-10-21.log.gz` (read with `gzip -dc`). A later explicit inert-address build also initially failed two test oracles: the raw-button rule classified the app-owned chat trigger as CMS content, and the configured-address detector ignored the invalid host in its non-navigation data attribute. Test-first fixtures were red for both; narrow test-only fixes at `99759d359499a00d9b088fb3b5d30c9287c9f608` preserve CMS spoof rejection and navigation exclusions. The filtered fixture/output rerun passed 6 selected tests (56 filtered out, not skips), then the full final `test:build` passed 25/25 files and 282 tests with 6 actual skips. Raw logs and uncompressed hashes are recorded in the machine-readable report.
