# Native Bitrix entry RED handoff

Test-only branch `test/native-bitrix-red-20261024`; approved change content is based on `7dba93d705419637af8cab63c643b5939b9732fe`, whose fresh-main parent is `adb6f0814a492a2bf50abc0ca1943a75f485f499`.

`npm run build` passed in this isolated worktree (Astro built 460 pages; Pagefind indexed 273). The focused browser RED command was:

```sh
npx playwright test --config=playwright.attached.config.ts tests/chat-entry-visibility.spec.ts --project=desktop -g "normal page load fetches Bitrix once without opening its chooser or adding a site card" --reporter=line
```

It exited 1 on the behavior assertion `the SDK-created launcher exists after ordinary load`: `[data-chat-stub-launcher]` was not found within 5 seconds. The stub records one configured loader request, a closed chooser, and measured 66×66/right50/bottom50/fixed launcher geometry; it does not simulate portal text, VK delivery, or provider focus management.

The built-policy regression also exited 1 (1 failed, 5 passed):

```sh
npx vitest run --config vitest.build.config.ts tests/external-widgets-privacy-doc.test.ts --reporter=dot
```

It rejects the current false sentence that the chat loads only after a click and causes no platform requests before that click. No production source or policy text was changed. `openspec validate chat-entry-visibility --strict --no-interactive` passed. A read-only check found all 7 `MODIFIED` requirement headings in the baseline `external-widgets` spec. OpenSpec 1.7.0 has no `apply` command; its apply instructions require implementation/task progress, and archive/update is explicitly deferred until external portal acceptance. No live Bitrix/VK acceptance is claimed.

The full browser matrix was not run in this RED-only handoff. The selected browser tests parse successfully via `playwright --list`; `git diff --check` passed.

## Implementation candidate checkpoint (not merged)

The implementation/test source was reviewed at `36af94515fe63fcf22c07d01f373aaac488a5c0b` and `2fe936efae9c34e352c40c7573e9abb247247f86`. After synchronization, the current source candidate is `2ba79251f8803ae5de07021c86ab5bec159744f7`, based on fresh `origin/main@e0b50d86280d4c80cce6be1fa7838f8c1e895673`; no source conflicts needed manual resolution. Subsequent commits `201fedd724500d0bfd56a69cfdd9eab57c71b8fb` and `e376746a2fa078b2bc372bb08361991c3eb1b07f` only regenerate the strict source and built-output registries from the candidate source and its builds.

The exact production build command was `env -u DEMO_FORMS -u DEMO_OUTPUT -u PAYMENT_ROLE -u PAYMENT_ENDPOINT_PROD -u DEPLOY_MODE -u CHAT_LOADER_FALLBACK CHAT_LOADER_SRC=https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js npm run build`; it exited 0, built 460 pages and indexed 273. Its immutable output copy is `/private/tmp/ikpk-native-review-evidence-20261024/candidate-2ba79251-prod` (113M); `robots.txt` allows `/`, and the home HTML contains the configured loader without a local greeting card or wide CTA. `npm run build:demo` also exited 0, built 477 pages and indexed 273.

The generated baseline checkpoint changed only `baseline-meta.json`, `executable-source-slots.json`, and `source-registry.json`; the separate occurrence-registry commit contains 11,236 rules from `web/dist` and `web/dist-demo`, with no unmatched output. No policy allowlist was relaxed.

Seven focused isolated/stub browser checks on the synchronized candidate passed: the 1280×280 desktop dropdown exposes its final link; the header does not overflow across 1023/1024 and the navigation works at both boundaries; the closed launcher geometry holds at 320/375/1280; the provider greeting can be closed while the launcher remains available; and the keyboard-only helper receives focus and restores focus after Escape. They ran on a temporary port 43858; the occupied shared 4322 server was not touched. `npm run lint` and `npm run typecheck` exited 0; Astro checked 519 files with 0 errors, 0 warnings, and 9 hints.

`vitest run --config vitest.build.config.ts` exited 1: 25/26 files, 286 passed, 7 skipped. Its only failure was an `ENOENT` renaming `web/node_modules/.vite/deps` in `tests/seminar-dates.build.test.ts` while Vite re-optimized dependencies in the parallel run. An isolated rerun of that exact suite passed 2/2. The full command is not reported green. On the prior candidate `2fe936efae9c34e352c40c7573e9abb247247f86`, `npm run test:demo` passed 8 files/58 tests, `npm run test:render` passed 10 files/41 tests, and desktop/mobile widget matrix passed 105/112 with 7 expected skips. The earlier full `npm test` exited 1 with 2,332/2,333 tests due one timeout in `tests/manual-publication-launcher.test.ts`; its isolated rerun passed, but the full command remains non-green.

OpenSpec strict validation and `./bin/check-spec-refs` passed on the feature branch; reference audit found 106 measured/106 registered spans with no discrepancies or new unmeasurable spans. In a disposable worktree at the repaired change, archive/apply projected the delta (+4/~7 requirements to `external-widgets`) and `./bin/openspec validate --all --strict --no-interactive` passed 27/27. This was only a disposable projection: the actual change remains unarchived and `openspec/specs/` was not changed in the feature branch.

The 20-run production Lighthouse collection completed with exit 0; its `assert` command exited 1 because all four required templates scored SEO 0.92 against the 0.95 threshold on `crawlable-anchors`. A targeted audit traced the two failing action anchors to Bitrix SDK output; both provider-generated anchors lack `href`. Other asserted budgets passed. Reports are in `/private/tmp/ikpk-native-review-evidence-20261024/.lighthouseci-production-2ba79251`, with summary `/private/tmp/ikpk-native-review-evidence-20261024/production-lh-summary-2ba79251.json`. The earlier demo/preview-mode attempt scored SEO 0.61 because its generated `robots.txt` disallowed indexing; that failed non-candidate result is retained separately.

Bounded real-SDK behavioral evidence from candidate `bd235ec5df4c571c4e1ab03271876022488ed446` is stored in `/private/tmp/ikpk-native-review-evidence-20261024/`: `acceptance-summary.json`, `android-native-report.json`, `desktop-helper-report.json`, and `payment-preview-report.json`. The accepted implementation-source SHA was `36af94515fe63fcf22c07d01f373aaac488a5c0b`; the code reviewer confirmed the product helper is byte-identical on the synchronized candidate and subsequent registry-only commits. The evidence records a 66×66 native launcher at 375×812, 320×720, and desktop 1280×720, persistence after greeting dismissal and footer scrolling, actual `show()`/`hide()` functions and boolean `isShown`, Enter opening the native chooser, Escape after focusing an existing provider anchor restoring helper focus, payment stacking/inert behavior, and zero focused-helper axe violations. It does not establish portal greeting/logo configuration, VK availability or real-message delivery, or physical-keyboard behavior.

The 375×812 and 320×720 captures used headless Chromium with iPhone/Android user-agent and touch emulation; they are not tests on physical phones and do not prove physical-keyboard behavior. Final candidate screenshots include `actual-final-mobile375-afterX.png`, `actual-final-android320-afterX.png`, and `actual-final-desktop.png`. A later desktop keyboard probe was aborted because its temporary test harness fell back to clicking the greeting body when it failed to find the close control, which opened the CRM form. No fields were touched or submitted; this is a harness error, not a product-helper failure, and it does not count as a complete final-candidate desktop keyboard pass. The helper interaction evidence comes from the earlier accepted report and the synchronized source review. The user still needs to inspect the live 194 candidate from physical phones.

Portal greeting text/emblem configuration and real VK Open Line delivery still require authorized Bitrix-admin acceptance. No real messages, forms, or channel selections were submitted.
