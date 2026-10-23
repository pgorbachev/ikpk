# Greeting RED evidence — 2026-10-23

Scope: RED tests for the approved greeting contract at `openspec/changes/chat-entry-visibility/specs/external-widgets/spec.md`. Source implementation and Bitrix/VK portal configuration were not changed.

Run from `web/`:

```sh
npx playwright test tests/chat-entry-visibility.spec.ts --config=playwright.attached.config.ts --grep='greeting|keyboard dismissal|activating the chat' --project=desktop --workers=1
```

The complete serialized desktop run exited **1** with **4 tests, 4 product assertion failures**. The existing test file's `beforeAll` built the guarded non-demo probe with `CHAT_LOADER_SRC=https://chat-loader.invalid/probe/loader_probe.js`; the attached config did not use shared port 4322. Failures reached browser assertions:

- `greeting appears immediately with the approved name, exact text, emblem, and no eager loader request` — `Вера Рум` was absent.
- `greeting remains visible in the lower zone without covering page content on desktop and mobile widths` — exact greeting text was absent at 320 px.
- `keyboard dismissal persists through scroll and resize until a new document` — accessible close button `Закрыть приветствие` was absent.
- `activating the chat hides the local greeting through provider close` — exact greeting text was absent before activation.

One newly added payment layering scenario was then run once on its own and exited **1** at its product assertion because the exact greeting was absent on `/oplata` before opening payment. This is a separate first execution of that scenario, not a repeat of the complete run.

The complete run's per-test failures were printed in the Playwright output and are summarized in this committed record; a later invocation replaced Playwright's default result directory. The only generated error context still on disk is `web/test-results/chat-entry-visibility-chat-76147-eps-focus-inside-the-dialog-desktop/error-context.md` from the separate payment scenario.

Repeatability: the full new-test group was executed once, serially with one worker; each failure was an absent required DOM/accessibility element in the current static baseline, with no timeout or setup error. The payment scenario independently observed the same absent greeting. No portal UI, external route, or live provider response was simulated as acceptance evidence.
