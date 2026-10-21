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

    def _main_capture(self, argv, skipped_workflow=None):
        if argv[:2] == ["gh", "repo"]:
            return staging193.CANONICAL_REPOSITORY
        if argv[:2] == ["gh", "api"]:
            return SHA
        if argv[:3] == ["gh", "run", "list"]:
            workflow = argv[argv.index("--workflow") + 1]
            index = (staging193.STATIC_MAIN_ADDITIONAL_WORKFLOWS.index(workflow) + 1
                     if workflow in staging193.STATIC_MAIN_ADDITIONAL_WORKFLOWS else 0)
            return json.dumps([{**self.runs[0], "workflowName": workflow, "headBranch": "main",
                                "databaseId": 123 + index}])
        if argv[:3] == ["gh", "run", "view"]:
            run_id = int(argv[argv.index("view") + 1])
            workflow = (staging193.STATIC_MAIN_ADDITIONAL_WORKFLOWS[run_id - 124]
                        if run_id >= 124 else None)
            jobs = self.jobs
            if skipped_workflow is not None and workflow == skipped_workflow:
                jobs = [{**jobs[0], "conclusion": "skipped"}, *jobs[1:]]
            return json.dumps({"jobs": jobs})
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

    def test_main_admission_uses_exact_main_push_and_returns_all_required_jobs(self):
        with patch.object(staging193, "capture", side_effect=self._main_capture):
            result = staging193.validate_static_main_ci(SHA)
        self.assertEqual(result["ref"], "refs/heads/main")
        self.assertEqual(result["headBranch"], "main")
        self.assertEqual(result["requiredJobs"], sorted(JOBS))
        self.assertEqual({proof["workflow"] for proof in result["additionalWorkflows"]},
                         set(staging193.STATIC_MAIN_ADDITIONAL_WORKFLOWS))
        self.assertTrue(all(proof["conclusion"] == "success" for proof in result["additionalWorkflows"]))

    def test_static_main_rejects_skipped_job_in_other_required_workflow(self):
        with patch.object(staging193, "capture", side_effect=lambda argv: self._main_capture(
                argv, skipped_workflow="Lighthouse CI")):
            with self.assertRaisesRegex(staging193.Refusal, "Lighthouse CI jobs are not successful"):
                staging193.validate_static_main_ci(SHA)

    def test_static_main_rejects_main_ref_moving_during_last_workflow_read(self):
        moved = False

        def capture(argv):
            nonlocal moved
            if argv[:2] == ["gh", "api"]:
                return "b" * 40 if moved else SHA
            result = self._main_capture(argv)
            if (argv[:3] == ["gh", "run", "view"]
                    and argv[argv.index("view") + 1] == str(123 + len(staging193.STATIC_MAIN_ADDITIONAL_WORKFLOWS))):
                moved = True
            return result

        with patch.object(staging193, "capture", side_effect=capture):
            with self.assertRaisesRegex(staging193.Refusal, "canonical main head moved during CI admission"):
                staging193.validate_static_main_ci(SHA)
        self.assertTrue(moved, "the simulated ref movement must happen during the last workflow read")

    def test_static_main_revalidates_exact_main_ci_after_browser_acceptance_before_commit(self):
        provenance = {"repository": staging193.CANONICAL_REPOSITORY, "ref": "refs/heads/main",
                      "sourceSha": SHA, "workflow": "Tests", "workflowName": "Tests", "event": "push",
                      "headBranch": "main", "runId": 123, "attempt": 2, "status": "completed",
                      "conclusion": "success", "requiredJobs": sorted(JOBS),
                      "runUrl": f"https://github.com/{staging193.CANONICAL_REPOSITORY}/actions/runs/123",
                      "additionalWorkflows": [{"workflow": workflow, "headSha": SHA, "event": "push",
                          "headBranch": "main", "runId": index + 200, "attempt": 1,
                          "status": "completed", "conclusion": "success", "requiredJobs": ["job"],
                          "runUrl": f"https://github.com/{staging193.CANONICAL_REPOSITORY}/actions/runs/{index + 200}"}
                          for index, workflow in enumerate(staging193.STATIC_MAIN_ADDITIONAL_WORKFLOWS)]}
        responses = [json.dumps({"phase": "browser-check-required", "staticTreeSha256": "c" * 64}).encode(),
                     b"candidate bytes", json.dumps({"phase": "committed"}).encode()]
        calls = []

        def ssh(arguments, input_bytes=None, **_kwargs):
            calls.append((arguments, input_bytes))
            return responses.pop(0)

        with patch.object(staging193, "validate_static_main_ci", side_effect=[provenance, provenance]) as admit, \
             patch.object(staging193, "make_archive", return_value=(b"source archive", "a" * 64)), \
             patch.object(staging193, "ssh_remote", side_effect=ssh), \
             patch.object(staging193, "browser_check") as browser:
            staging193.invoke(type("Args", (), {"host": staging193.TARGET_HOST, "command": "static-main",
                "operation_id": "main-static", "source_sha": SHA})())

        self.assertEqual(admit.call_count, 2)
        self.assertEqual([call[0][0] for call in calls], ["static-main", "export-static-main", "static-main"])
        self.assertEqual(calls[0][1], b"source archive")
        self.assertIn("--browser-digest", calls[-1][0])
        browser.assert_called_once_with(SHA, "main-static", "c" * 64, b"candidate bytes", "staging194", provenance)

    def test_static_main_refuses_changed_main_proof_before_remote_activation(self):
        admitted = {"sourceSha": SHA, "runId": 123, "attempt": 2}
        changed = {"sourceSha": SHA, "runId": 124, "attempt": 1}
        responses = [json.dumps({"phase": "browser-check-required", "staticTreeSha256": "c" * 64}).encode(),
                     b"candidate bytes"]
        calls = []

        def ssh(arguments, **_kwargs):
            calls.append(arguments)
            return responses.pop(0)

        with patch.object(staging193, "validate_static_main_ci", side_effect=[admitted, changed]), \
             patch.object(staging193, "make_archive", return_value=(b"source archive", "a" * 64)), \
             patch.object(staging193, "ssh_remote", side_effect=ssh), \
             patch.object(staging193, "browser_check"):
            with self.assertRaisesRegex(staging193.Refusal, "changed during acceptance"):
                staging193.invoke(type("Args", (), {"host": staging193.TARGET_HOST, "command": "static-main",
                    "operation_id": "main-static", "source_sha": SHA})())
        self.assertEqual(responses, [])
        self.assertEqual(len(calls), 2)

    def test_remote_helper_uses_fixed_existing_root_identity_without_sudo(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-operator-identity-") as temporary:
            identity = Path(temporary) / "identity"
            known_hosts = Path(temporary) / "known_hosts"
            identity.write_text("test fixture", encoding="utf-8")
            known_hosts.write_text("194.226.99.10 ssh-ed25519 AAAATEST\n", encoding="utf-8")
            result = subprocess.CompletedProcess(["ssh"], 0, b"{}", b"")
            with patch.object(staging193, "TARGET_IDENTITY", identity), \
                 patch.object(staging193, "TARGET_KNOWN_HOSTS", known_hosts), \
                 patch.object(staging193.subprocess, "run", return_value=result) as invoke:
                self.assertEqual(staging193.ssh_remote(["status", "--operation-id", "op"]), b"{}")
            argv = invoke.call_args.args[0]
            self.assertEqual(argv[argv.index("-i") + 1], str(identity))
            self.assertIn("root@194.226.99.10", argv)
            self.assertIn("StrictHostKeyChecking=yes", argv)
            self.assertIn(f"UserKnownHostsFile={known_hosts}", argv)
            self.assertIn("GlobalKnownHostsFile=/dev/null", argv)
            self.assertEqual(argv[-4:], ["/usr/local/sbin/ikpk-rehearsal", "status", "--operation-id", "op"])
            self.assertNotIn("sudo", argv)

    def test_operator_refuses_an_unknown_host_before_ssh(self):
        with patch.object(staging193.subprocess, "run") as invoke:
            with self.assertRaisesRegex(staging193.Refusal, "bound to the authorized staging194 host"):
                staging193.invoke(type("Args", (), {"host": "193.124.115.99", "command": "recover",
                    "operation_id": "unknown-host", "backup_dir": None})())
        invoke.assert_not_called()

    def test_static_main_commands_refuse_initial_prod_profile_before_ci_or_ssh(self):
        for command in ("static-main", "static-main-recover"):
            with self.subTest(command=command):
                args = type("Args", (), {"host": staging193.INITIAL_PROD_HOST, "profile": "initial-prod",
                    "command": command, "operation_id": staging193.INITIAL_PROD_OPERATION_ID,
                    "source_sha": SHA})()
                with patch.object(staging193, "validate_static_main_ci") as admit, \
                     patch.object(staging193, "ssh_remote") as ssh, \
                     self.assertRaisesRegex(staging193.Refusal, "bound to the staging194 profile"):
                    staging193.invoke(args)
                admit.assert_not_called()
                ssh.assert_not_called()

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

            def ssh(arguments, input_bytes=None, **_kwargs):
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
