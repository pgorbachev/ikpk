## Context

`_candidate_root` (`scripts/lib/rehearsal_host.py`) places each static-main source at `<releaseRoot>/<sha>-<operationId>`. After the operation's terminal record the only reader is `static-main --reuse-capture-operation-id` (`_verify_reusable_static_capture`), which the host binds to staging194. Live site, `oldStaticPath`, rollback and `static-main-recover` use only `staticReleaseRoot`. A reuse operation stores no capture of its own and points at the capture it reused (`_static_main_capture_root`). Journal measurements on 2026-11-28: production 0 of 9 static-main runs reused a capture; staging194 7 of 34, all in October.

On production the static profile's root contains static sources only; since the preceding defect fix its CMS release step is a no-op. On staging194 the root is shared with CMS releases, and `_cleanup_cms_releases` removes every unprotected child.

## Goals / Non-Goals

**Goals:** bound production growth to unfinished operations; keep the newest usable staging194 capture usable; reuse the existing post-commit path, unfinished-operation detection and removal primitive.

**Non-Goals:** a timer for static sources; a preview mode or report fields beyond removed paths and `retainedUnknownStaticSources`; a configurable retention count; any change to CMS releases on production, site releases, workspaces, backups or journals.

## Decisions

1. Unfinished operations are those reported by `RehearsalState._unfinished_operation_ids`; `static-main-rolled-back` and `static-main-rollback-expired` are terminal. No separate definition.
2. Production: after `static-main-committed`, remove every immediate child of `releaseRoot` named `<40-hex>-<operationId>` whose operation in the static journal is a terminal static-main operation, including the one just committed. The existing cleanup already refuses when any operation is unfinished, so no separate retention of unfinished sources is needed. Entries that do not map to a journal operation are kept and listed as `retainedUnknownStaticSources`. Removal uses the existing `_remove_release_tree` and mount check.
3. A retry of a committed operation currently re-enters prepare, gets `browser-check-required` and makes the client call `export-static-main`, which reads the source (`_static_main_prepare`, `_static_main_export`). Prepare SHALL short-circuit to the committed result for a committed operation (same test as browser acceptance: committed and no rollback started), so source removal cannot break the retry; the host then finishes post-commit cleanup, as the `--browser-digest` retry does.
4. Staging194: on every path that runs CMS release cleanup, protect exactly one static source tree: the capture referent of the most recent operation satisfying the journal conditions of `_verify_reusable_static_capture` (reused capture's source if `reusedCapture` is set, else its own), if it exists. A reuse operation has no capture of its own and cannot itself be reused, so it is never the protected tree.
5. Inability to read the journal or validate the root refuses deletion and returns the existing `cleanupPending`. That state is not durable (the marker is already cleared); the next commit retries.
6. Leftovers outside the journal: a source extracted before the operation's start record (failed early prepare) and killed-process temporaries `.<sha>-<op>.new-<pid>` are not removed and are listed as unknown. An entry that cannot be removed safely (symlink, non-directory, mount) is kept and listed too, without stopping removal of the others. Owner may remove them by hand.
7. Visibility: the client prints `cleanupPending` and every kept entry after a publication; the production-paired cleanup log records removed and kept sources. The production-paired status file tracks the timer and paired publications only, so a static publication does not overwrite it.

## Risks / Trade-offs

- [A source is deleted while an operator still wanted an older staging capture] → Owner accepted; take a fresh capture.
- [Journal and directory names disagree] → Entry is retained and reported.
- [Sources of failed attempts that never reached a terminal record are kept as unknown] → Rare (normal error paths remove their temporaries); listed in the result; owner removes by hand.
