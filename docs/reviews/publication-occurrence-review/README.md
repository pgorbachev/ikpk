# Publication occurrence independent review

Reviewed `codex/manual-publication-implementation@57efedd4d9d25fea51bd25e8f474e08485a5787b`, which integrates the bounded fix originally authored as `41f7fc48af372edcba53acbee450c461c3dda1a5`. Reviewer is independent of implementation. This delivery adds regression tests and evidence only; no implementation changes.

## Findings

1. **P2 — Project the fields after the snapshot loader's localization.** `web/tests/publication/build.test.ts:24` passes raw `snapshot.content.types.articles` to the projection. Actual rendering reads the result of `localizeAssetUrls(raw, source.origin?.url)` in `web/src/lib/data.ts:86`. Consequently an ordinary article excerpt containing `See https://cms.example.test/uploads/guide.png` renders `See /uploads/guide.png` but the projected identity still expects the absolute URL. The named regression invokes the actual `getArticles()` loader against an isolated temporary snapshot and observes two occurrence errors: expected count 1, received 0; unregistered template. A text mention of a URL is valid content and need not introduce a new CMS route or executable element.

2. **P2 — Normalize browser-serialized attribute entities consistently.** `web/tests/publication/occurrences.ts:31-33` constructs identity from raw Unicode strings, while `web/tests/publication/build.test.ts:30` matches the Chromium serialization. For a safe title `Safe\u00a0title`, Chromium serializes the attribute as `safe&nbsp;title`; `decodeBasicEntities` in `web/tests/helpers/rich-content-safety/html-scan.ts` does not decode `&nbsp;`. The independent regression uses the same inert Chromium harness as the real gate and gets the same count/unregistered-template false refusal. This is common valid typography, not hostile markup.

No P0/P1 or new fail-open defect was confirmed in this bounded pass. Unknown CMS route rejection remains the already known registry limitation, not a new finding.

## Evidence and commands

From this review worktree's `web/`:

```sh
node_modules/.bin/vitest run tests/publication-occurrences.test.ts
node_modules/.bin/vitest run tests/publication-occurrences-review.test.ts
node_modules/.bin/tsx tests/helpers/publication-adapter-review-negative.ts /Users/pgorbachev/projects/private/ikpk-manual-publication-adapters/web/dist /Users/pgorbachev/projects/private/ikpk-publication-occurrence-review/docs/reviews/publication-occurrence-review/adapter-evidence.json /private/var/folders/b6/wycqx9812rx5dbv2f9kxmlvr0000gp/T/ikpk-publication-real-fixture-ENqZUA/snapshot
```

- Existing occurrence tests: **2 passed**.
- Independent regression tests: **1 passed, 2 failed** (the two findings above). The passing control proves duplicate projected identities consume exactly two matching occurrences and reject one missing or additional node.
- Real adapter positive control: **4 passed, 0 failed**, accepted.
- Exact script mutation `<script>window.__publicationUnexpectedScript = true;</script>` inserted before the home page's `</body>`: **3 passed, 1 failed**, rejected by `all rendered content satisfies the existing rich-content safety matrix`.
- Exact link mutation `<a href="http://ikpk.su/__missing_publication_internal_link__">HTTP internal probe</a>` inserted at the same point: **3 passed, 1 failed**, rejected by `internal links and every declared legacy redirect resolve in the checked tree`.

Full adapter assertion reports are in `adapter-evidence.json`. The existing helper copies both source inputs, restores the mutated page in `finally`, and deletes its own `web/dist` and temporary snapshot. Source artifact and captured snapshot paths were read only. After the run this review worktree has no `web/dist`.

The projection obtains scope, route, placement and slot provenance from committed registries, and the matcher checks source provenance, exact identity, placement and count. Nothing in the fix registers occurrences from output. Duplicate template identities are handled correctly because the matcher consumes one previously unused occurrence per projected rule.

## Separate simplification note

Optional: remove the index-aligned `changed` calculation from `publication-occurrences.test.ts` and assert the payment script rule directly. The present test reconstructs a filtered registry merely to find one known rule; this obscures its target and makes harmless ordering changes look meaningful. This is test readability debt, not a correctness finding or approval blocker.
