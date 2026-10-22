# RED regression run

The tests were written and run by a separate executor in the tests/seminar-start-visibility-red-20261022 branch before implementation. Its test-only commit is `5d0fc1008928be98f8f70199b6ad44ec039a88ca`, based on preimplementation commit `84afdd50bc0de63edd7272bd92400585edf61fe6`. That commit changes only five files under `web/tests/`; no product code is in the test branch.

From `web/` with the test-only tree:

| Command | Exit | Result |
| --- | ---: | --- |
| `npx vitest run tests/seminar-start-visibility.test.ts --reporter=verbose` | 1 | 21 failed, 2 passed; full output in `unit-red.log` |
| `npx playwright test --config=tests/seminar-start-visibility.config.ts --reporter=line` | 1 | 16 failed, 2 passed in Moscow and Los Angeles browser zones; full output in `browser-red.log` |

The browser fixture uses real built pages and controlled time/content. Both before-start controls passed; post-boundary hero, schedule, program, and detail-route scenarios failed as expected. The current payment form has no dated picker, so payment-picker behavior is covered by the reconciled separate change and was not asserted by this run.
