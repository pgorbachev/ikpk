# Verification of the approved owner choices

Implemented after the owner selected **A** (one PR per dependency across
`web`/`scripts`) and a **30 minute** publication lag.

## Grouping

- The shared `directories: [/web, /scripts]` rule now uses
  `group-by: dependency-name` and admits only patch/minor updates.
- `cms` remains a separate scope without a broad group, so different CMS
  dependencies and majors arrive separately.
- Targeted contract: `dependabot-grouping.test.ts`, **6/6 green**.

## Publication monitor

- `.github/workflows/published-head.yml` runs every ten minutes and supports
  `workflow_dispatch`.
- It resolves the current `main` SHA and committer timestamp, scans deployments
  in the `github-pages` environment, and accepts only a deployment with a
  `success` status.
- The workflow invokes the existing dependency-gate CLI with
  `--max-lag 1800000`; Node 22.22.3 executes the TypeScript directly without a
  dependency install.
- Positive control: published SHA equals the main SHA, exit **0**.
- Negative control: published SHA differs at **1,800,001 ms**, exit **1** and
  the message names the full unpublished SHA
  `2222222222222222222222222222222222222222`.
- Targeted contracts for the decision and workflow: **4/4 green**.

The live GitHub API shape was checked read-only before implementation: the latest
successful `github-pages` deployment exposes the same full SHA as `main` and a
`success` deployment status.
