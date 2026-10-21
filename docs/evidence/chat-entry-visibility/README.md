# Evidence index

Current local acceptance results are in [final-verification-2026-10-21.md](final-verification-2026-10-21.md). This file preserves the original partial RED and infrastructure history; it is historical evidence, not the final gate result. The original RED was interrupted before all required scenarios ran, so OpenSpec tasks 2.1–2.3 remain unchecked.

# Historical chat-entry-visibility RED evidence

Base revision: `origin/main@2fee597b5335f6c61fd61a622fa2a5f3f475a605`.
The approved proposal/design/delta spec were copied from the planning worktree without changing normative scope or HTML mockups. Owner approval was recorded as 2026-10-21 in `tasks.md`, `design.md`, and `review.md`.

## Browser evidence

The diagnostic browser command was run against a fresh `web/dist` produced by the same invocation's preceding successful Astro production build. The build phase rendered 459 pages and Pagefind indexed 272 pages. The enclosing `npm run test:build` then exited 1 in its Vitest phase: fixture builds exhausted shared `/private/tmp` (`ENOSPC`), and the existing `external-widgets-dist` guard rejected the current build because it declares neither a loader URL nor explicit no-loader state. These are recorded in `test-build.log` and `test-build.result`; they are not counted as feature RED.

The regular Playwright config first failed before tests with `config.webServer` timeout (60 seconds). The existing `playwright.attached.config.ts` was used for diagnostics because the suite's `buildProbe`/`serveStatic` fixtures serve their own non-demo artifacts. The un-escalated attached run also stopped before assertions with loopback `listen EPERM`; the escalated rerun reached browser assertions.

- `browser-red-escalated.log` / `.result`: exit 1. The non-demo preview-role probe test passed, confirming a real chat trigger and payment form/dialog plus zero loader requests before activation and one activation path. The next three tests ran and failed on behavior; the three remaining tests were not run after `--max-failures=3`.
- Concrete capsule RED: expected visible caption/accessibility name `Написать нам`, received `Открыть чат с центром`; rendered caption was only `💬`; height was 32 rather than 52 CSS px; left/right padding were 0 rather than 20 CSS px; measured light/320 hover caption contrast was 2.56:1 rather than 4.5:1. The suite also measured absent gap and 20×25.59 icon geometry against the approved 10px gap and 22×22 icon.
- Concrete flow RED: a shared scrollport containing header/main/footer was not found; `#programs` was not revealed below the sticky header; a wheel action left the expected scrollport at `scrollTop=0`.
- `browser-red-targeted.log` / `.result`: exit 1, two targeted tests executed. With the test-only visualViewport fixture reducing visible height to 360 CSS px while layout stayed the same, the chat button bottom remained at 624px and no scrollport followed the reduced viewport. The payment test observed that the payment root was not a direct body child, no page scrollport existed, and the scrollport was not inert while the dialog was open. The test includes further focus, input-lock, position-restore, and focus-restore checks; the log records the assertions reached by this run.
- `browser-red-attached.log` / `.result` and `browser-red.log` / `.result` preserve the earlier infrastructure-only failures (loopback EPERM and regular-config webServer timeout); they are not behavioral evidence.

## Scenario to test map

| Approved scenario | Test | Evidence state |
|---|---|---|
| Non-demo role has a real chat entry and payment dialog; no third-party request before activation; one activation path | `non-demo payment probe has both real product entry points and keeps the loader lazy until one activation` | Passed in escalated browser run. |
| 52px capsule, 22px icon, 10px gap, 20px padding; visible and accessible caption; contrast 4.5:1 for light/dark, normal/hover/focus/pressed at 320/375/1280 | `label, capsule geometry, keyboard name, and text contrast hold in both themes and all widths` | Executed and RED; exact representative failures above. Paint-state pointer release was corrected after this run; the full paint test was not rerun on the final test revision. |
| Real shared scrollport plus separate 80px useful lower zone; no visible clipped text/control overlap at start/middle/footer on seven TD-52 templates and three widths | `page flow has one real scrollport and an 80px sibling lower zone without clipped visible overlap` | Executed and RED because the shared scrollport/lower zone is absent; this test failed before full template/position matrix completed. No safe-area inset above zero was simulated. |
| Anchors/deep links, history/back/forward and scroll restore; wheel/touch/keyboard and focus reveal | `anchor, history, wheel, touch-like scroll, keyboard scroll, and focus reveal stay in the shared scrollport` | Executed and RED at anchor/shared-scrollport and wheel assertions. Later actions were not reached in this bounded run. Touch is a CDP synthetic gesture with `gestureSourceType: touch`, not physical hardware input. |
| Resize and visible focused fields/chat control under a reduced visual viewport | `layout resize and reduced visualViewport keep the focused field and chat control visible` | Targeted run executed and RED. The test-only visualViewport override validates event/layout contract, not a physical mobile keyboard. |
| Payment root outside scrollport; overlay above chat; background/chat inert and blocked for wheel/touch/keyboard; scroll position and focus restore; field reveal | `payment overlay is a body-level sibling, blocks background input, and restores scroll and focus` | Targeted run executed and RED on root placement, missing scrollport, and inert state. Remaining assertions are in the test but are not claimed as individually proven by this failed run. |
| `none`, unset, demo and 404 have no empty slot; ordinary content remains reachable | `none, unset, demo output, and 404 do not reserve an empty chat slot` | Test is present but was not run because the bounded full suite stopped after three failing tests. Existing config baseline failure is separately recorded above. |

`test:e2e:widgets` now includes this suite for both existing desktop/mobile projects; no test skip was added. Tasks 2.1–2.3 remain pending because the complete scenario set has not yet passed through its RED assertions. Hardware acceptance for a nonzero safe-area inset and physical mobile keyboard remains pending.

## Workspace artifacts

At handoff, this worktree had `web/node_modules` 491 MiB, `web/dist` 107 MiB, `web/.snapshot` 7.1 MiB, `web/dist-snapshot` 7.1 MiB, and `web/.astro` 12 KiB. The latest measured filesystem availability was recorded by the runner as approximately 339 MiB on `/private/tmp`'s backing volume. No temporary directories belonging to other processes or worktrees were removed. The empty `/private/tmp/ikpk-widget-probe-9nenrq` directory was created by this session's failed build and occupied 0 bytes; it was left in place.
