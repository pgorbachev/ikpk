# Manual acceptance scenarios for dependabot-auto-merge

These scenarios cannot be proved by a unit test because their subject is GitHub's
effective repository permission and auto-merge state, not a repository-local function.
They remain mandatory live acceptance items after the workflow implementation exists.

## Effective permissions of the privileged job

Reason for manual verification: parsing workflow YAML proves declared permissions but
does not prove the permissions GitHub actually grants to a particular run.

Reproduction:

1. Trigger the decision workflow on a disposable Dependabot PR.
2. Record the run URL and inspect the `Set up job` permission report.
3. Verify exactly `contents: write` and `pull-requests: write`; verify `pages`,
   `packages`, `id-token`, `actions`, and workflow-changing credentials are absent.
4. Record that the job has no checkout/download step and runs no PR-owned command.

Expected result: the job can mark auto-merge through the GitHub API but cannot publish
or alter workflows, and its working tree never contains the PR head.

## A maintainer enables auto-merge without changing the head SHA

Reason for manual verification: GitHub decides whether changing only the auto-merge
flag schedules a new required-check evaluation; that platform event behavior cannot be
reproduced faithfully by a local adapter.

Reproduction:

1. Create a disposable Dependabot PR and push a human commit while auto-merge is off.
2. Record the head SHA, the red eligibility gate, and the separate negative
   provenance result for that same SHA.
3. Enable auto-merge manually without changing the head SHA.
4. Confirm the eligibility result remains red and GitHub does not merge the PR.
5. Confirm the owner can use only the dedicated eligibility ruleset's PR-only bypass
   after every ordinary required CI check succeeds.
6. Disable auto-merge and close the disposable PR after collecting the run/PR URLs.

Expected result: marker state never changes auto-eligibility for the same head. The
manual path is the repository owner's narrow PR-only bypass of the eligibility ruleset,
not a green result that could later be reused by native auto-merge.
