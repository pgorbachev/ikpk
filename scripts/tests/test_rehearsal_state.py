import multiprocessing
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts.lib.rehearsal_state import RehearsalRefusal, RehearsalState, durable_json


SOURCE_SHA = "a" * 40
OLD_PAIR = {"cmsSha": "old-cms", "staticSha": "old-static", "dbSha256": "0" * 64}
NEW_PAIR = {"cmsSha": SOURCE_SHA, "staticSha": SOURCE_SHA, "staticSha256": "1" * 64}


def hold_host_lock(root: str, ready) -> None:
    state = RehearsalState(Path(root))
    with state.lock():
        ready.set()
        time.sleep(0.3)


class RehearsalStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-state-")
        self.root = Path(self.temp.name)
        self.state = RehearsalState(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_marker_replace_is_durable_and_leaves_no_partial_file(self):
        path = self.root / "marker.json"
        durable_json(path, {"phase": "old"})
        durable_json(path, {"phase": "new"})
        self.assertEqual(path.read_text().strip(), '{"phase":"new"}')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual([p.name for p in self.root.iterdir()], ["marker.json"])

    def test_second_process_waits_for_real_flock(self):
        ready = multiprocessing.Event()
        child = multiprocessing.Process(target=hold_host_lock, args=(str(self.root), ready))
        child.start()
        try:
            self.assertTrue(ready.wait(2), "child failed to acquire flock")
            started = time.monotonic()
            self.state.begin("op-after-lock", SOURCE_SHA, OLD_PAIR)
            self.assertGreaterEqual(time.monotonic() - started, 0.20, "second operation bypassed OS lock")
            child.join(timeout=2)
            self.assertEqual(child.exitcode, 0)
        finally:
            if child.is_alive():
                child.terminate()
            child.join(timeout=2)

    def test_acquisition_failure_and_unfinished_marker_fail_closed(self):
        marker = self.state.begin("op-1", SOURCE_SHA, OLD_PAIR)
        self.assertEqual(marker["fence"], "acquiring")
        with self.assertRaisesRegex(RehearsalRefusal, "unfinished operation"):
            self.state.begin("op-2", SOURCE_SHA, OLD_PAIR)
        with self.assertRaisesRegex(RehearsalRefusal, "verified writer fence"):
            self.state.mark_cms_activated("op-1")
        with self.assertRaisesRegex(RehearsalRefusal, "not confirmed closed"):
            self.state.confirm_fence("op-1", lambda: False)
        self.state.confirm_fence("op-1", lambda: True)
        self.state.mark_cms_activated("op-1")
        self.assertEqual(self.state._read_marker()["fence"], "closed")

    def test_interrupted_start_reconstructs_acquiring_marker_for_explicit_recovery(self):
        self.state._append({"version": 1, "record": "start", "operationId": "op-crash-start",
                            "sourceSha": SOURCE_SHA, "oldPair": OLD_PAIR})
        marker = self.state.begin("op-crash-start", SOURCE_SHA, OLD_PAIR)
        self.assertEqual(marker["fence"], "acquiring")
        with self.assertRaisesRegex(RehearsalRefusal, "another source SHA"):
            self.state.begin("op-crash-start", "b" * 40, OLD_PAIR)
        with self.assertRaisesRegex(RehearsalRefusal, "unfinished operation"):
            self.state.begin("op-new", SOURCE_SHA, OLD_PAIR)
        self.state.confirm_fence("op-crash-start", lambda: True)
        self.state.recover("op-crash-start", lambda: True, lambda: True)
        self.assertFalse(self.state.marker_path.exists())

    def test_append_only_three_record_success_and_commit_restore_boundary(self):
        self.state.begin("op-1", SOURCE_SHA, OLD_PAIR)
        self.state.confirm_fence("op-1", lambda: True)
        self.state.mark_cms_activated("op-1")
        with self.assertRaisesRegex(RehearsalRefusal, "accepted CMS"):
            self.state.commit("op-1")
        self.state.accept_new_pair("op-1", NEW_PAIR)
        committed = self.state.commit("op-1")
        self.assertTrue(committed["committed"])
        rows = [__import__("json").loads(line) for line in self.state.journal_path.read_text().splitlines()]
        self.assertEqual([row["record"] for row in rows], ["start", "new-pair", "committed"])
        self.assertEqual(rows[0]["oldPair"], OLD_PAIR)
        self.assertEqual(rows[1]["newPair"], NEW_PAIR)
        with self.assertRaisesRegex(RehearsalRefusal, "forbidden after durable global commit"):
            self.state.require_restore_allowed("op-1")
        with self.assertRaisesRegex(RehearsalRefusal, "reopen is not verified"):
            self.state.finalize("op-1", lambda: False)
        self.state.finalize("op-1", lambda: True)
        self.assertFalse(self.state.marker_path.exists())
        self.assertEqual(self.state.phase("op-1")["phase"], "committed")
        self.assertEqual(self.state.finalize("op-1", lambda: True)["phase"], "committed")

    def test_journal_commit_is_authoritative_if_marker_replace_crashes(self):
        self.state.begin("op-commit-window", SOURCE_SHA, OLD_PAIR)
        self.state.confirm_fence("op-commit-window", lambda: True)
        self.state.mark_cms_activated("op-commit-window")
        self.state.accept_new_pair("op-commit-window", NEW_PAIR)
        with patch("scripts.lib.rehearsal_state.durable_json", side_effect=OSError("simulated power loss")):
            with self.assertRaisesRegex(OSError, "simulated power loss"):
                self.state.commit("op-commit-window")
        marker = self.state._read_marker()
        self.assertFalse(marker["committed"], "fixture must represent the crash window")
        self.assertIn('"record":"committed"', self.state.journal_path.read_text())
        with self.assertRaisesRegex(RehearsalRefusal, "forbidden after durable global commit"):
            self.state.require_restore_allowed("op-commit-window")
        with self.assertRaisesRegex(RehearsalRefusal, "after global commit"):
            self.state.recover("op-commit-window", lambda: True, lambda: True)
        with self.assertRaisesRegex(RehearsalRefusal, "already durable"):
            self.state.commit("op-commit-window")
        self.assertTrue(self.state.marker_path.exists())
        self.state.finalize("op-commit-window", lambda: True)
        self.assertFalse(self.state.marker_path.exists())
        rows = [__import__("json").loads(line) for line in self.state.journal_path.read_text().splitlines()]
        self.assertEqual([row["record"] for row in rows].count("committed"), 1)

    def test_static_failure_stays_fenced_and_explicit_recovery_is_recorded(self):
        self.state.begin("op-1", SOURCE_SHA, OLD_PAIR)
        self.state.confirm_fence("op-1", lambda: True)
        self.state.mark_cms_activated("op-1")
        with self.assertRaisesRegex(RehearsalRefusal, "accepted CMS"):
            self.state.commit("op-1")
        self.assertEqual(self.state._read_marker()["fence"], "closed")
        self.state.recover("op-1", lambda: True, lambda: True)
        rows = [__import__("json").loads(line) for line in self.state.journal_path.read_text().splitlines()]
        self.assertEqual([row["record"] for row in rows], ["start", "recovered"])
        self.assertFalse(self.state.marker_path.exists())

    def test_same_operation_cannot_change_source_sha(self):
        self.state.begin("op-1", SOURCE_SHA, OLD_PAIR)
        with self.assertRaisesRegex(RehearsalRefusal, "another source SHA"):
            self.state.begin("op-1", "b" * 40, OLD_PAIR)

    def test_real_sqlite_wal_checkpoint_and_backup_preserve_data(self):
        source_path = self.root / "live.db"
        backup_path = self.root / "backup.db"
        live = sqlite3.connect(source_path)
        try:
            self.assertEqual(live.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower(), "wal")
            live.execute("CREATE TABLE content (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
            live.execute("INSERT INTO content(body) VALUES ('accepted editor write')")
            live.commit()
            self.assertEqual(live.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0], 0)
            backup = sqlite3.connect(backup_path)
            try:
                live.backup(backup)
            finally:
                backup.close()
        finally:
            live.close()
        readonly = sqlite3.connect(backup_path)
        try:
            self.assertEqual(readonly.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(readonly.execute("SELECT body FROM content").fetchone()[0], "accepted editor write")
        finally:
            readonly.close()
        self.assertGreater(backup_path.stat().st_size, 0)


if __name__ == "__main__":
    unittest.main()
