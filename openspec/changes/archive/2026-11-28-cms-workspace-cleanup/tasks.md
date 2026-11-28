## 1. Design closure and approval

- [x] 1.1 Specify journal writer lock ordering and staging provisioning and transition; prove runtime behavior in the tests and staging acceptance below.
- [x] 1.2 Review the complete proposal, specs, design and tasks independently and obtain owner approval before tests or implementation.

## 2. Independent red tests

- [x] 2.1 (deviation, see below) In a separate clean-context session, add and demonstrate failing tests for identity/journal matching, protected running/restart/recovery references, dependency retention and ambiguous or malformed evidence.
- [x] 2.2 (deviation, see below) Add failing tests for marker-free timer retry, selected-profile routing, lock contention and same-inode handling, preview without mutation, crash boundaries and containment of links and mounts.
- [x] 2.3 (deviation, see below) Add failing tests for staging paired workspace creation, CMS sandbox write access, legacy transition recovery, environment isolation and the real systemd cleanup sandbox boundary.

## 3. Implementation

- [x] 3.1 Implement shared environment-specific workspace preparation, activation and legacy staging recovery with verified dependency links and safe unit configuration transition.
- [x] 3.2 Implement protected-reference inventory, operation identity checks and coordinated CMS release/dependency retention under the documented locks.
- [x] 3.3 Implement retryable cleanup, crash-safe removal, logging and non-destructive preview, with production activation disabled pending the first preview review.
- [x] 3.4 Update the installer and systemd sandbox probe; verify staging CMS and cleanup units can write only the required paths.

## 4. Review and staging acceptance

- [x] 4.1 Run relevant gates and obtain two independent code reviews and the separate simplification review required by the project; resolve findings.
- [x] 4.2 Prepare and verify a supported, journal-consistent 194 import of the approved production database and media copy; verify staging-specific settings and controls before activation, then publish content and check the site.
- [x] 4.3 Deploy to 194 and perform sequential paired releases, repeated cleanup, refresh, CMS restart, and pre-commit recovery followed by refresh; test interrupted deletion, malformed marker and durable logs.
- [x] 4.4 Verify the live systemd sandbox and environment isolation, and record exact tested source SHA, results, limitations and independent review evidence.

## 5. Production

- [x] 5.1 Prepare the admitted production deployment and safe helper/unit transition; keep automatic workspace cleanup disabled before preview review.
- [x] 5.2 Immediately before first production application, present a fresh locked delete/retain/reason/allocated-size preview; re-evaluate under locks on execution.
- [x] 5.3 Enable the reviewed cleanup, verify site and CMS refresh/restart and retry behavior, and report exact outcomes and remaining retained data.

## 6. Hardening after retrospective review (2026-11-28)

- [x] 6.1 In a separate session, add failing tests that kill each unprotected safeguard found by review: protected-set failure deletes nothing; inode recheck before removal; nested mount; activation gate on apply; tombstone validity; CMS-release dependency protection; CMS inactive or NeedDaemonReload; plus the four scenarios of "Keep release cleanup independent and failures visible". Record the mutation that each test catches.
- [x] 6.2 Decouple production CMS release cleanup from the workspace step and protect dependencies of every workspace under the fixed root from the filesystem.
- [x] 6.3 Persist decisions and refusals in a size-bounded log and a status file in the production-paired state directory on both timer and post-commit paths.
- [x] 6.4 Treat an unsafe activation marker as disabled and reported; document the marker, preview command, emergency disable and status/log locations in `docs/deploy-vps.md`.
- [x] 6.5 Two independent code reviews and the simplification review; resolve findings.

## Deviations and accepted debt (recorded at archive, 2026-11-28)

- **2.1–2.3, tests were not written red-first in a separate session.** Tests for workspace preparation, inventory and cleanup were written alongside the implementation (PR #535, #537). The guards were later checked retrospectively. Task 6.1 added 11 guard tests, each confirmed by a recorded mutation that turns it red, plus the scenario tests for "Keep release cleanup independent and failures visible".
- **4.3, legacy staging recovery is not confirmed on 194.** Recovery of the first interrupted transition into the legacy staging workspace was not exercised on 194. The owner accepted this as named debt: the 194 behaviour has low priority, and production reliability is the goal.
- **Release evidence** is kept outside the public repository, in the owner's private evidence store:
  - helper release of source `d08372e2dbbed5761035ddfde11e359b67f2b1c8` with green required CI;
  - locked production preview of 2026-11-27, reviewed before activation;
  - activation marker installed root-owned with mode 0600.
- **6.x hardening** follows the retrospective reviews of 2026-11-28. Production CMS release cleanup no longer depends on the workspace step. Dangling dependency links are not a refusal. Failed runs are visible in the status file and the log.

