# Recovering a stale site-housekeeping reservation

The housekeeping helper deliberately does not remove an existing site-refresh lock. A killed helper can leave `${siteRefreshState}.lock` behind; a later housekeeping retry then fails closed. There is no automatic stale-lock retry because a PID+nonce file does not identify which root writer created it.

Use this procedure only when housekeeping reports a stale reservation. Keep CMS refresh/Restore clicks and all host publications paused until the retry finishes. Do not run the manual bootstrap concurrently.

1. Stop new helper triggers while investigating:

   ```sh
   systemctl stop ikpk-site-housekeeping.path ikpk-site-housekeeping.timer
   ```

2. Read the root-owned profile config. For production, use the profile recorded in `host-publication.json` when that marker exists; otherwise use the installed production profile. For 194, use `/etc/ikpk/rehearsal.json`. Take `stateDir` and `siteRefreshState` only from that fixed config. Never infer them from the lock filename or a CMS request.

3. Hold locks in the normal order while checking and removing the reservation: on both production and 194 acquire the fixed `/var/www/ikpk/.publication.lock` first, then `<stateDir>/.operation.lock`. Keep both held through verification and unlink. Confirm no housekeeping service or operator publication is still running.

4. Inspect `${siteRefreshState}.lock` without following symlinks. It must be a regular file with one link, owner `root`, mode `0600`, and exactly two lines: a decimal PID and a 32-character lowercase hexadecimal nonce. Probe that PID as root. Continue only when the probe proves `ESRCH`; a live PID, `EPERM`, malformed/partial contents, wrong owner/mode, or any read error means **leave the file in place**.

5. Verify the durable operation state before unlinking. CMS state must be terminal, and any `succeeded` state must name the release currently selected by `current`. If `host-publication.json` exists, its profile must match the selected fixed config and its operation must have a terminal record in that profile's journal. Confirm there are no unfinished journal operations or recovery intents. A non-null `previousReleaseId` must still resolve to its direct release child; if cleanup has already cleared it, it must be null. If any check is unknown or disagrees, stop and preserve the reservation.

6. Immediately before unlinking, reopen the lock without following symlinks and confirm the device/inode and exact bytes still match the values inspected in step 4; probe the same PID again and require `ESRCH`. Unlink only that lock file and fsync its parent directory. Keep the outer locks held until this finishes.

7. Restart the path and timer units, then retry the fixed housekeeping service:

   ```sh
   systemctl start ikpk-site-housekeeping.path ikpk-site-housekeeping.timer
   systemctl start ikpk-site-housekeeping.service
   ```

If the owner PID is live, the token or inode changes, the profile cannot be selected, or any state/journal check is ambiguous, do not unlink anything. Escalate for recovery of the underlying publication first.

## One-time 194 legacy release

The 2026-11-02 read-only inventory reported one legacy directory without a root `release.json`:
`/var/www/ikpk/releases/demo193-20261015-pr-6b339613-final-d2a19de7`. It contains `public/release.json` for commit `6b33961383d7d6583d2f637cf4d0ac1524053f86`; the inventory found its matching staging194 journal operation terminal and committed, with `current` elsewhere and no pending preparation or CMS-state reference. This report is a lead for a one-time operator action, not a permanent exemption in the cleanup selector.

If the directory still exists, handle only this exact path manually. Under `/var/www/ikpk/.publication.lock`, the staging194 `.operation.lock`, and the normal CMS site-refresh reservation, repeat the read-only checks: exact direct-child path and inode; root ownership and directory mode; valid `public/release.json` matching the committed journal entry; `current` and every temporary pointer target elsewhere; no marker, unfinished journal, recovery, CMS state, workspace/capture or mount reference. Keep the CMS reservation and both host flocks held for the entire check and removal. Recheck inode immediately before removing only this tree, fsync `/var/www/ikpk/releases`, then retry the ordinary housekeeping service. If any fact differs from the inventory, leave it in place and investigate; do not widen the generic selector.
