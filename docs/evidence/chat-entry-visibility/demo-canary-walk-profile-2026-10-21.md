# Demo canary walker profile

This read-only profile used the already generated `web/dist-demo`; it did not rebuild or regenerate inventories. It imported `demoPages()` and the hostile-canary token before starting either timer, then measured `demoPages()` and a sequential `readFileSync(..., 'utf8')` plus `html.includes(token)` pass in one Node runtime.

The first measured pass reported:

| Measurement | Result |
|---|---:|
| `demoPages()` | 42,223.09 ms |
| HTML reads and token search | 15,079.91 ms |
| HTML files | 476 |
| Total HTML bytes | 32,132,029 |
| Token hits | 0 |
| First-level entries | 46 |

A later, separate parity pass compared the prior `readdirSync` + `statSync` algorithm against the `Dirent` implementation on the existing `dist` and `dist-demo` trees. It found exact path equality for all 459 and 476 HTML files respectively. In that pass, the old/new timings were 169/93 ms for `dist` and 206/99 ms for `dist-demo`. The timings differ by orders of magnitude from the first profile, so these measurements establish variance, not a deterministic performance improvement or causal explanation for the earlier timeout.

The test history is also kept separate: before the helper change, the canary scan exceeded its 15-second test timeout at 22,702 ms. The first post-change exact four-test attempt instead timed out while starting the Chromium `beforeAll` hook at its unchanged 30-second limit; the next exact attempt passed all four tests in 13.50 seconds. None of the timeout values or test scope changed.

The final implementation avoids `statSync` for ordinary directory entries. It retains the prior behavior for symlinked directories and files, and broken links still throw. Characterization tests cover nested HTML, extension filtering, both symlink forms, and fail-closed broken links.
