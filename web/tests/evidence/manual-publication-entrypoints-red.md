# Local publication inventory: independent RED

Base revision: `codex/manual-publication-implementation@482e6c2d2ff3eca64999e477fa4fceb8bbfa4246`.
Independent test-only worktree: `codex/publication-entry-inventory-red`.

Approved scope: `manual-publication-only`, task 6.1 and design section 6. Existing hosted configuration checks did not inspect local entrypoints. The additional gate groups the launcher and its known private implementation edges into one publication path; `scripts/publication-launcher.mjs` is its identifier, not a claim that the launcher alone performs the transfer.

Expected gate API: `inventoryPublicationEntrypoints(root: string): string[]`, exported by `web/tests/helpers/publication-entrypoints.ts`. The actual repository and positive fixture must yield the sole approved path. Zero/inert launcher, second launcher, direct web transfer/current switch, private-worker npm wrappers and hosted publication must refuse. The canonical declaration's storage shape is not prescribed by these tests. Discovery covers known literal executable capabilities and package/workflow configuration; it does not prove arbitrary JS/Python semantics. Native authorization tests remain necessary.

Command from `web/`:

```sh
./node_modules/.bin/vitest run tests/manual-publication-entrypoints.test.ts tests/manual-publication-restore-bypass.test.ts
```

Observed: **14 tests: 1 PASS, 13 RED**. Twelve fail because the required local/hosted inventory gate is absent; its existence assertion runs before each case, outside `rejects.toThrow`, so absence cannot falsely satisfy a refusal case. One independent behavioral test fails because the real backup restore command activates an unverified backup without the publication launcher. Historical positive control passes and proves the harness really performs that switch.

The native regression runs the actual restore script against a temporary `WEB_ROOT` and backup, with only rsync/mv mechanics adapted to the local macOS host. There is no SSH, credential, real host, protected launcher or publication index. It observes successful exit, one byte-equality comparison, and `current` changing from `current-release` to `restore-*`. The historical script fixture preserves this control after implementation changes.

## Contract conflict requiring explicit resolution

At this revision `scripts/restore-server-state.sh` is executable and directly creates a web release and switches `WEB_ROOT/current`. That is a second capable path, not harmless provisioning or a private transport edge. `server-provisioning` separately requires backup restoration. The owner has been asked to reconcile those requirements; this delivery makes no implementation or spec change and does not silently exempt the utility. Suggested resolution is offline backup preparation followed by activation through the approved publication mechanism.

Bootstrap's CMS artifact switching and read-only server verification are different subjects; their mere use of SSH is not proof of web publication. Do not fix the gate with a blanket SSH ban or a misleading allowlist for the live web restore bypass.
