# Chat entry visibility implementation checkpoint

This checkpoint records implementation status at the source review candidate. It is not a full-green result.

- Candidate source/test changes: capsule styling/layout, shared page scrollport, body-level payment overlay, viewport-aware page geometry, and lazy chat trigger are in the implementation branch. Mobile menu and search popup max-heights now use their measured anchor and the actual scrollport/visual-viewport bottom.
- Confirmed review fixes in this checkpoint: mobile drawer/search clipping CSS; all 15 applicable templates × 320/375/1280 × start/middle/footer geometry coverage; navigation checks at all three widths; blank lower-zone click behavior; visible-caption and keyboard-focus oracles; redundant dark-hover rule removed.
- `npm run lint`: exit 0 on this source/test revision.
- `npm run typecheck`: most recent completed run exited 0 (498 files, 0 errors, 0 warnings, 9 hints) before the final PageDown test-precondition adjustment. A subsequent run was interrupted by the checkpoint request with exit 130; it did not produce a new summary.
- Targeted Playwright diagnostic: exit 1, 3 passed, 2 failed, 5 did not run. The PageDown failure was a test precondition: the preceding wheel input had already reached `scrollTop=480`, its maximum. The retry then exhausted disk while rebuilding the local fixture (`ENOSPC`); no product conclusion was obtained for the unrun browser scenarios. Error contexts and exact command/result are preserved alongside this file.
- `CHAT_LOADER_SRC=none npm run test:build -- --maxWorkers=1`: exit 1 with ENOSPC during Astro static generation, before the test phase.
- Source AST slot collector diagnostic found 146 live slots; committed source inventory also has 146, with four line-based IDs moved and three slot identities changed. The committed source/output registry fixtures remain untouched until both fresh production and demo outputs can be generated and reviewed together. This provenance item remains pending.
- No full production/demo build, existing widget suite, full desktop/mobile matrix, payment/layout gates, or requested screenshots are complete. These remain pending until disk space and npm-cache approval permit fresh outputs.

The Playwright diagnostic partial at `/private/tmp/ikpk-widget-probe-V2Z7Bu` was created by this run, recorded, and removed. No RED worktree source or evidence was changed.
