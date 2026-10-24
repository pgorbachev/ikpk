# Native Bitrix entry RED handoff

Test-only branch `test/native-bitrix-red-20261024`; approved change content is based on `7dba93d705419637af8cab63c643b5939b9732fe`, whose fresh-main parent is `adb6f0814a492a2bf50abc0ca1943a75f485f499`.

`npm run build` passed in this isolated worktree (Astro built 460 pages; Pagefind indexed 273). The focused browser RED command was:

```sh
npx playwright test --config=playwright.attached.config.ts tests/chat-entry-visibility.spec.ts --project=desktop -g "normal page load fetches Bitrix once without opening its chooser or adding a site card" --reporter=line
```

It exited 1 on the behavior assertion `the SDK-created launcher exists after ordinary load`: `[data-chat-stub-launcher]` was not found within 5 seconds. The stub records one configured loader request, a closed chooser, and measured 66×66/right50/bottom50/fixed launcher geometry; it does not simulate portal text, VK delivery, or provider focus management.

The built-policy regression also exited 1 (1 failed, 5 passed):

```sh
npx vitest run --config vitest.build.config.ts tests/external-widgets-privacy-doc.test.ts --reporter=dot
```

It rejects the current false sentence that the chat loads only after a click and causes no platform requests before that click. No production source or policy text was changed. `openspec validate chat-entry-visibility --strict --no-interactive` passed. A read-only check found all 7 `MODIFIED` requirement headings in the baseline `external-widgets` spec. OpenSpec 1.7.0 has no `apply` command; its apply instructions require implementation/task progress, and archive/update is explicitly deferred until external portal acceptance. No live Bitrix/VK acceptance is claimed.

The full browser matrix was not run in this RED-only handoff. The selected browser tests parse successfully via `playwright --list`; `git diff --check` passed.
