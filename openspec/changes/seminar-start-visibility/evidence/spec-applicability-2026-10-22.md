# Applicability check, 2026-10-22

Checked with the installed OpenSpec CLI 1.7.0 against the isolated change branch. This was a simulation in a disposable worktree; no change was archived in the working branch or production.

1. Strict validation passed for `seminar-start-visibility`, `cms-content-authoring-and-migration`, and `payment-seminar-picker`.
2. The first simulated archive of `seminar-start-visibility` failed because its `MODIFIED` block dropped two original scenario headings from `schedule-month-filter`. The delta was repaired to retain those scenarios while changing their expected behavior.
3. A new simulated archive of `seminar-start-visibility` succeeded, updating `schedule-month-filter` and creating the `seminar-start-visibility` main spec.
4. Strict validation of the two overlapping changes passed against that archived baseline. Simulated archiving of `cms-content-authoring-and-migration` and then `payment-seminar-picker` also succeeded, with no missing requirement or scenario errors.

The simulation intentionally used `--yes` to proceed despite unfinished implementation tasks. It proves delta applicability only; it does not mean those changes are complete or ready for real archiving.
