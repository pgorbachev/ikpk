# CI widget failures and harness fix (2026-10-21)

On PR head `c490ddfdc31f9e0ab09270a11323834638a8295f`, GitHub Actions run [39652258790](https://github.com/pgorbachev/ikpk/actions/runs/39652258790), Playwright job `119413172052` reported 4 failures, 59 passes, 4 skips, and 33 tests not run.

- Desktop and mobile `chat-entry-visibility.spec.ts` failed the existing assertion that a touch-like scroll increases the shared scrollport's `scrollTop` (`0` observed). The CDP gesture was sent without enabling Chromium touch emulation. The test now enables touch emulation before the same CDP touch gesture; the scroll assertion is unchanged.
- Desktop `external-widgets.spec.ts` and mobile `chat-entry-visibility.spec.ts` failed while separate probe builds competed over Astro's shared `web/.astro/.prerender/chunks` scratch files. The widget Playwright command now uses one worker, matching the already-green local full widget run and preventing concurrent probe builds in that suite.

No product source or assertions were changed. The targeted local touch rerun is diagnostic only; Linux behavior is established by the required CI run on the resulting PR head. Local source lint and `git diff --check` pass for the changed test/script files.
