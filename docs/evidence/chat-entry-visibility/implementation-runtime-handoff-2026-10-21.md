# Chat-entry runtime handoff — 2026-10-21

This is a scoped handoff for the fresh verifier. Production source is unchanged at `5764f89b4c058d5681592bc8127c4127e926bb85`; the test-only candidate was based on `dc3c32196e2de9f0dd75e803dd6c39fe3a448565`. No product fix is established by the results below.

## Preserved focused results

- `widgets-e2e-5764-focused.log` preserves the earlier focused run: 17 passed, 6 failed, 1 skipped. The destructive forward-fragment test was not selected by that run's grep. The mobile chat-enabled repeat case passed; ordinary baseline-repeat failed because its config had no server at `127.0.0.1:4325`.
- `widgets-e2e-dc3c-focused.log` preserves the next run: 3 passed, 3 failed. Both destructive forward-fragment tests passed. Search failed because the oracle demanded the complete 106.64px title inside an 89px nested drawer; the card was 252.83px tall. The aggregate history assertion expected `22299` and observed `21795` on Back to schedule.
- `widgets-e2e-20261021-test-only-diagnostic-{desktop,mobile}.md` preserve the latest aggregate error contexts. The test failed before its schedule navigation, so the temporary lifecycle recorder emitted no history trace and established no cause for the 504px difference.
- `widgets-e2e-20261021-search-oracle-{desktop,mobile}.md` preserve the latest search bounds. The first attempt at line-by-line reachability used viewport coordinates without subtracting the drawer's top; that known test-helper error has been corrected in the unverified working diff.

## Remaining focused work

1. Re-run the search oracle after the drawer-local coordinate correction. It now measures each wrapped text line relative to the drawer, scrolls only the nested result drawer, checks full-line clipping bounds and hit-testing, verifies focusable-link semantics, and checks that the page scrollport top is unchanged. The complete title is intentionally not required to fit simultaneously in the smaller drawer.
2. Diagnose the schedule history mismatch before changing product code. A valid trace must be installed before navigation (for every document), observe the scrollport itself, and capture `scrollTop`, `scrollHeight`, `clientHeight`, maxScroll, loaded/pending images, `document.fonts.status`, active history entry and saved map at schedule entry, immediately before leaving, `pagehide`, synchronous `pageshow`, `popstate`, the product's immediate restore, and the next animation frame/task. Distinguish the expected saved top (`oldMax - 180 = 22299`) from the restored document's current max before deciding whether this is a clamp, layout shift, or other scroll write. The previous recorder was attached only after navigation and watched `window` scroll, so it was inadequate and was removed from the test.
3. Run the focused aggregate, search and destructive forward-fragment cases on desktop and mobile after the candidate is fixed. The history mismatch remains unresolved; do not add retry or clamp compensation without trace evidence.

The latest targeted command was run with the isolated 4325 config, workers=1, and localhost permission. It exited 1 after 6.5 minutes: 2 passed, 4 failed. The forward-fragment case passed both projects. The aggregate failed on the schedule Back assertion in both projects (`Expected: 22299`, `Received: 21795`). Search failed because of the known coordinate bug in the temporary helper in that run. The final working diff corrects that helper but has not been run. The ordinary external baseline-repeat server/config issue is separate and remains with the final verifier.

The diagnostic run command was:

```sh
npx playwright test tests/chat-entry-visibility.spec.ts \
  --config=playwright.chat-entry-4325.config.ts \
  --project=desktop --project=mobile --workers=1 \
  --grep='anchor, history, wheel|short mobile viewport keeps|history keeps a forward fragment position'
```

The temporary history instrumentation was removed from the spec. `web/playwright.chat-entry-4325.config.ts` remains untracked and is not part of this evidence commit. Port 4322 was not touched. No test/build process from this handoff remains active.
