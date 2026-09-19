# Independent state-store review evidence

Reviewed implementation commit: `a61cd7d639c605b687550f794478334640d14c54`.
Independent regression-test commit: `c08e4c0d2ad2f608242255681d8f7aec2afe1eef`.
All commands ran in the reviewer's separate worktree. No network service or production state was changed; Git pushes targeted temporary bare fixture repositories.

## Baseline and new regressions

From `web/`:

```sh
npx vitest run tests/publication-state-store.test.ts tests/cms-provenance-ledger.test.ts
```

Before adding the four review cases: **30 passed / 0 failed** (18 store + 12 ledger).

```sh
npx vitest run tests/publication-state-store.test.ts -t 'REVIEW:'
```

**0 passed / 4 failed** on the reviewed implementation:

- Token as HTTPS username is accepted by the constructor; clone would put it in argv and origin config.
- An uppercase `HTTPS` scheme bypasses the password check as well.
- With current CMS entry `4 = edit C`, reading an unknown fingerprint returns trusted revision 4.
- Reading historical fingerprint A under that same current entry also returns trusted revision 4.

## Mutation 1: overwrite competing state after a rejected push

Apply this exact change to `web/scripts/lib/publication-state-store.ts`:

```diff
   function push(): boolean {
-    try { git(['push', 'origin', `HEAD:refs/heads/${PROVENANCE_BRANCH}`]); return true; } catch { return false; }
+    try { git(['push', 'origin', `HEAD:refs/heads/${PROVENANCE_BRANCH}`]); return true; } catch { git(['fetch', 'origin', `refs/heads/${PROVENANCE_BRANCH}`]); git(['push', '--force', 'origin', `HEAD:refs/heads/${PROVENANCE_BRANCH}`]); return true; }
   }
```

Run from `web/`:

```sh
npx vitest run tests/publication-state-store.test.ts -t 'a non-fast-forward append'
```

Baseline **2 passed / 0 failed** → mutation **0 passed / 2 failed**. The CMS case fails because remote `ledger/entry-000004.json` disappeared. The publication case fails because `other-writer` disappeared from the remote index. Both failures occur in the intended preservation tests after the fixture confirms the competing push happened.

## Mutation 2: replay stale acceptance onto a newer event

Restore mutation 1, then remove exactly these two lines from `web/scripts/lib/publication-state-store.ts`:

```diff
-        if (last.number !== input.expectedObservedEntry) throw new Error('stale observed-entry confirmation');
-        if (last.fingerprint !== input.fingerprint) throw new Error('current fingerprint mismatch');
```

```sh
npx vitest run tests/publication-state-store.test.ts -t 'a CMS event racing the acceptance push'
```

Baseline **1 passed / 0 failed** → mutation **0 passed / 1 failed**. The intended test fails because the promise resolves with `entry = { number: 5, previous: 4, fingerprint: 'A', marker: 'accept-state', confirmedBy: 'operator' }` after competing edit C became entry 4.

## Restoration

```sh
git restore --source=c08e4c0d2ad2f608242255681d8f7aec2afe1eef -- web/scripts/lib/publication-state-store.ts
git diff --exit-code a61cd7d639c605b687550f794478334640d14c54 -- web/scripts/lib/publication-state-store.ts web/scripts/lib/provenance-ledger.ts
```

The production sources match the reviewed commit exactly. No implementation fixes are included in this delivery.

After restoration, the combined selector `a non-fast-forward append|a CMS event racing the acceptance push` returned **3 passed / 0 failed**.
