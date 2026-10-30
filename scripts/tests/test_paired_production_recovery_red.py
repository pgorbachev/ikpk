"""Safety contract for pre-commit recovery of the repeatable production profile."""

import sqlite3
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host
from scripts.lib.rehearsal_state import RehearsalState


class PairedProductionRecoveryTests(unittest.TestCase):
    def test_host_cli_exposes_production_paired_recovery(self):
        calls = []
        with patch.object(rehearsal_host, "dispatch",
                          side_effect=lambda args: calls.append(args) or {"phase": "recovered"}):
            result = rehearsal_host.main(["--profile", "production-paired", "recover",
                                          "--operation-id", "prod-recovery-20261031-01"])

        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual((calls[0].profile, calls[0].action, calls[0].operation_id),
                         ("production-paired", "recover", "prod-recovery-20261031-01"))

    def test_prebackup_pointer_mismatch_keeps_production_writers_fenced(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-paired-production-recovery-") as temporary:
            root = Path(temporary)
            state_root = root / "state"
            state_root.mkdir()
            state = RehearsalState(state_root)

            database = root / "live.sqlite"
            db = sqlite3.connect(database)
            db.execute("CREATE TABLE content (body TEXT NOT NULL)")
            db.execute("INSERT INTO content VALUES ('production write')")
            db.commit()
            db.close()

            cms_releases = root / "cms-releases"
            old_cms, candidate_cms = cms_releases / "old", cms_releases / "candidate"
            old_cms.mkdir(parents=True)
            candidate_cms.mkdir()
            current_cms = root / "current-cms"
            current_cms.symlink_to(candidate_cms)

            static_releases = root / "static-releases"
            old_static, candidate_static = static_releases / "old", static_releases / "candidate"
            old_static.mkdir(parents=True)
            candidate_static.mkdir()
            current_static = root / "current-static"
            current_static.symlink_to(old_static)

            operation_id = "prod-prebackup-recovery"
            old_pair = {
                "cmsPath": str(old_cms.resolve()),
                "staticPath": str(old_static.resolve()),
                "staticTreeSha256": rehearsal_host._tree_sha256(old_static),
            }
            state.begin(operation_id, "a" * 40, old_pair)
            config = {
                "profile": "production-paired",
                "stateDir": str(state_root),
                "backupRoot": str(root / "backups"),
                "cmsDatabase": str(database),
                "cmsUnit": "ikpk-cms-test.service",
                "writerUnits": ["ikpk-cms-test.service"],
                "cmsHealthUrl": "http://127.0.0.1/health",
                "siteHealthUrl": "https://ikpk.su/",
                "currentCms": str(current_cms),
                "releaseRoot": str(cms_releases),
                "currentStatic": str(current_static),
                "staticReleaseRoot": str(static_releases),
                "mediaRoots": [],
            }
            flag_changes = []
            commands = []

            def fake_run(argv, **_kwargs):
                commands.append(argv)
                if argv[1:2] == ["is-active"]:
                    return subprocess.CompletedProcess(argv, 3, "inactive", "")
                return subprocess.CompletedProcess(argv, 0, "", "")

            args = Namespace(profile="production-paired", action="recover", operation_id=operation_id,
                             backup_sha256=None)
            with patch.object(rehearsal_host.os, "geteuid", return_value=0), \
                 patch.object(rehearsal_host, "_root_config", return_value=config), \
                 patch.object(rehearsal_host, "_set_flag",
                              side_effect=lambda _config, enabled: flag_changes.append(enabled)), \
                 patch.object(rehearsal_host, "_write_gate"), \
                 patch.object(rehearsal_host, "_verify_fence"), \
                 patch.object(rehearsal_host, "_stop_writers"), \
                 patch.object(rehearsal_host, "_assert_no_database_handles"), \
                 patch.object(rehearsal_host, "run", side_effect=fake_run):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "CMS code changed before backup"):
                    rehearsal_host.dispatch(args)

            marker = state._read_marker()
            self.assertEqual(marker["operationId"], operation_id)
            self.assertEqual(marker["fence"], "closed")
            self.assertEqual(flag_changes, [True])
            self.assertFalse(any(argv[1:2] == ["start"] for argv in commands),
                             "recovery must not reopen CMS writers after the old pair fails verification")
            self.assertEqual(current_cms.resolve(), candidate_cms.resolve())
            self.assertEqual(current_static.resolve(), old_static.resolve())


if __name__ == "__main__":
    unittest.main()
