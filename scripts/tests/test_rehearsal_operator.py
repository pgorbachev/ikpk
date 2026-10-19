import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.rehearsal import staging193


SHA = "a" * 40
JOBS = sorted(staging193.REQUIRED_TEST_JOBS)


class OperatorAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.runs = [{
            "headSha": SHA,
            "workflowName": "Tests",
            "event": "push",
            "headBranch": "dev",
            "status": "completed",
            "conclusion": "success",
            "databaseId": 123,
            "attempt": 1,
            "createdAt": "2026-10-18T10:00:00Z",
        }]
        self.jobs = [{"name": name, "status": "completed", "conclusion": "success"} for name in JOBS]

    def _capture(self, argv):
        if argv[:2] == ["gh", "repo"]:
            return staging193.CANONICAL_REPOSITORY
        if argv[:2] == ["gh", "api"]:
            return SHA
        if argv[:3] == ["gh", "run", "list"]:
            return json.dumps(self.runs)
        if argv[:3] == ["gh", "run", "view"]:
            return json.dumps({"jobs": self.jobs})
        return ""

    def test_admits_only_exact_canonical_tests_push_with_every_mandatory_job(self):
        with patch.object(staging193, "capture", side_effect=self._capture):
            result = staging193.validate_sha_and_ci(SHA)
        self.assertEqual(result["sourceSha"], SHA)
        self.assertEqual(result["runId"], 123)
        self.assertEqual(result["attempt"], 1)

    def test_rejects_a_moved_canonical_ref(self):
        def moved(argv):
            if argv[:2] == ["gh", "api"]:
                return "b" * 40
            return self._capture(argv)

        with patch.object(staging193, "capture", side_effect=moved):
            with self.assertRaisesRegex(staging193.Refusal, "canonical pgorbachev/ikpk"):
                staging193.validate_sha_and_ci(SHA)

    def test_canonical_head_lookup_does_not_use_a_local_fork_origin(self):
        calls = []
        def canonical(argv):
            calls.append(argv)
            if argv[:2] == ["gh", "repo"]:
                return staging193.CANONICAL_REPOSITORY
            if argv[:2] == ["gh", "api"]:
                return SHA
            if argv[:3] == ["git", "ls-remote", "origin"]:
                return f"{'b' * 40}\t{staging193.CANONICAL_REF}"
            if argv[:3] == ["gh", "run", "list"]:
                return json.dumps(self.runs)
            if argv[:3] == ["gh", "run", "view"]:
                return json.dumps({"jobs": self.jobs})
            return ""
        with patch.object(staging193, "capture", side_effect=canonical):
            staging193.validate_sha_and_ci(SHA)
        self.assertFalse(any(argv[:3] == ["git", "ls-remote", "origin"] for argv in calls))

    def test_rejects_skipped_or_cancelled_mandatory_job(self):
        self.jobs[0] = {"name": self.jobs[0]["name"], "status": "completed", "conclusion": "skipped"}
        with patch.object(staging193, "capture", side_effect=self._capture):
            with self.assertRaisesRegex(staging193.Refusal, "not successful"):
                staging193.validate_sha_and_ci(SHA)

    def test_remote_helper_uses_fixed_existing_root_identity_without_sudo(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-operator-identity-") as temporary:
            identity = Path(temporary) / "identity"
            identity.write_text("test fixture", encoding="utf-8")
            result = subprocess.CompletedProcess(["ssh"], 0, b"{}", b"")
            with patch.object(staging193, "TARGET_IDENTITY", identity), \
                 patch.object(staging193.subprocess, "run", return_value=result) as invoke:
                self.assertEqual(staging193.ssh_remote(["status", "--operation-id", "op"]), b"{}")
            argv = invoke.call_args.args[0]
            self.assertEqual(argv[argv.index("-i") + 1], str(identity))
            self.assertIn("root@193.124.115.99", argv)
            self.assertEqual(argv[-4:], ["/usr/local/sbin/ikpk-rehearsal", "status", "--operation-id", "op"])
            self.assertNotIn("sudo", argv)

    def test_cms_update_sends_source_archive_before_offhost_backup_confirmation(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-operator-prefence-") as temporary:
            archive = b"admitted source archive"
            backup = b"verified off-host backup"
            responses = [
                json.dumps({"offhostBackupRequired": True, "backupSha256": "b" * 64,
                            "phase": "fenced"}).encode(),
                backup,
                json.dumps({"phase": "cms-activated"}).encode(),
            ]
            calls = []

            def ssh(arguments, input_bytes=None):
                calls.append((arguments, input_bytes))
                return responses.pop(0)

            def save_backup(directory, operation_id, _source_sha, payload, _digest):
                path = Path(directory) / f"{operation_id}.tar"
                path.write_bytes(payload)
                return path

            provenance = {"sourceSha": SHA, "runId": 123, "attempt": 1}
            with patch.object(staging193, "validate_sha_and_ci", return_value=provenance), \
                 patch.object(staging193, "make_archive", return_value=(archive, "a" * 64)), \
                 patch.object(staging193, "ssh_remote", side_effect=ssh), \
                 patch.object(staging193, "persist_offhost_backup", side_effect=save_backup):
                staging193.invoke(type("Args", (), {"host": staging193.TARGET_HOST,
                    "command": "cms-update", "operation_id": "prefence", "source_sha": SHA,
                    "backup_dir": temporary})())

            self.assertEqual(len(calls), 3)
            self.assertEqual(calls[0][1], archive)
            self.assertIn("--archive-sha256", calls[0][0])
            self.assertIsNone(calls[2][1])
            self.assertNotIn("--archive-sha256", calls[2][0])
            self.assertIn("--offhost-sha256", calls[2][0])


if __name__ == "__main__":
    unittest.main()
