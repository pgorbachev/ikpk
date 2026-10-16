# Snapshot calendar regression, 2026-10-16

The full release visual suite exposed homepage selection using the build clock,
contrary to `openspec/specs/cms-content-source/spec.md` (the snapshot is the common
calendar source). A fixed content snapshot therefore changed after a calendar day
or year passed. Footer year had the same issue.

RED before the implementation change:

- `npx vitest run tests/home-snapshot-clock.test.ts`: 1 failed, 1 passed.
  Moving the system clock from 2026-09-20 to 2035 removed upcoming events.
- `npx vitest run --config vitest.render.config.ts tests/footer-snapshot-clock.render.test.ts`:
  1 failed; the footer showed 2035 instead of the snapshot's 2026.

GREEN after the fix:

- `npx vitest run tests/home-snapshot-clock.test.ts tests/schedule-entry-display.test.ts`:
  22 passed.
- `npx vitest run --config vitest.render.config.ts tests/footer-snapshot-clock.render.test.ts tests/seminar-price.render.test.ts`:
  11 passed.

Explicit date arguments remain available. Live captures still use their fresh
reference date. No fixture contents or visual baseline PNGs were changed.
The dated demo-prototype expectation was aligned with the snapshot source; its
built-artifact checks remain part of subsequent complete validation.
