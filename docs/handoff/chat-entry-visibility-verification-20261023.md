# Chat greeting verification — 2026-10-23

Implementation was reviewed at the code and fixture checkpoints by root and Astra. Final browser evidence on the rebased branch: `tests/chat-entry-visibility.spec.ts` passed 38/38 across desktop and mobile; the paired baseline-repeat run finished 41 passed and 1 intentional desktop-only skip. Lint, Astro typecheck, strict OpenSpec validation (27/27), and `check-spec-refs` passed.

The fresh `CHAT_LOADER_SRC=none npm run test:build` built production output successfully but returned exit 1 because the rich-content hazard fixture still named the previous global CSS asset. The fixture was updated only for the ChatFacade source slot and global CSS identity. On that same build output, the targeted hazard test then passed 1/1; the other 24 build-test suites from the initial run had passed. Registry comparison against `origin/main@1fdb462b8ad0ca501254ef430a9f32bd78dc6131` preserved 11,213 occurrence rows, 476 routes, and 148 slots; only the 475 ChatFacade slot/body identities and 476 global CSS href identities changed (951 row updates total).

OpenSpec applicability was checked in a disposable copy: archiving the copy applied the `external-widgets` delta (+5 requirements, 1 modified), and both the resulting `external-widgets` spec and all specs validated strictly. The real change remains unarchived.

Review screenshots from a non-demo chat-enabled probe are in the local task workspace:

- `/private/tmp/ikpk-chat-greeting-375x812-top.png`
- `/private/tmp/ikpk-chat-greeting-375x812-middle.png`
- `/private/tmp/ikpk-chat-greeting-375x812-footer.png`
- `/private/tmp/ikpk-chat-greeting-1280x720-top.png`

VK routing and the provider-side greeting remain pending authorized Bitrix admin access on Monday. No production loader/config or portal settings were changed; no fake route or provider stub was presented as acceptance.
