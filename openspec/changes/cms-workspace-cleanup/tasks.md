## 1. Design closure and approval

- [x] 1.1 Specify journal writer lock ordering and staging provisioning and transition; prove runtime behavior in the tests and staging acceptance below.
- [x] 1.2 Review the complete proposal, specs, design and tasks independently and obtain owner approval before tests or implementation.

## 2. Independent red tests

- [ ] 2.1 In a separate clean-context session, add and demonstrate failing tests for identity/journal matching, protected running/restart/recovery references, dependency retention and ambiguous or malformed evidence.
- [ ] 2.2 Add failing tests for marker-free timer retry, selected-profile routing, lock contention and same-inode handling, preview without mutation, crash boundaries and containment of links and mounts.
- [ ] 2.3 Add failing tests for staging paired workspace creation, CMS sandbox write access, legacy transition recovery, environment isolation and the real systemd cleanup sandbox boundary.

## 3. Implementation

- [ ] 3.1 Implement shared environment-specific workspace preparation, activation and legacy staging recovery with verified dependency links and safe unit configuration transition.
- [ ] 3.2 Implement protected-reference inventory, operation identity checks and coordinated CMS release/dependency retention under the documented locks.
- [ ] 3.3 Implement retryable cleanup, crash-safe removal, logging and non-destructive preview, with production activation disabled pending the first preview review.
- [ ] 3.4 Update the installer and systemd sandbox probe; verify staging CMS and cleanup units can write only the required paths.

## 4. Review and staging acceptance

- [ ] 4.1 Run relevant gates and obtain two independent code reviews and the separate simplification review required by the project; resolve findings.
- [ ] 4.2 Prepare and verify a supported, journal-consistent 194 import of the approved production database and media copy; verify staging-specific settings and controls before activation, then publish content and check the site.
- [ ] 4.3 Deploy to 194 and perform sequential paired releases, repeated cleanup, refresh, CMS restart, and pre-commit recovery followed by refresh; test interrupted deletion, malformed marker and durable logs.
- [ ] 4.4 Verify the live systemd sandbox and environment isolation, and record exact tested source SHA, results, limitations and independent review evidence.

## 5. Production

- [ ] 5.1 Prepare the admitted production deployment and safe helper/unit transition; keep automatic workspace cleanup disabled before preview review.
- [ ] 5.2 Immediately before first production application, present a fresh locked delete/retain/reason/allocated-size preview; re-evaluate under locks on execution.
- [ ] 5.3 Enable the reviewed cleanup, verify site and CMS refresh/restart and retry behavior, and report exact outcomes and remaining retained data.
