import hashlib
import io
import json
import shlex
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.rehearsal import staging193


SHA = "a" * 40
JOBS = sorted(staging193.REQUIRED_TEST_JOBS)


class OperatorAdmissionTests(unittest.TestCase):
    def test_production_restore_refuses_new_ledger_entry_after_activation_even_same_fingerprint(self):
        fingerprint = "sha256:" + "c" * 64
        preflight = {"lineage": {"observedEntry": 2, "fingerprint": fingerprint,
                                  "revision": 2, "highWaterMark": 2}}
        current = {"latestEntry": 3, "latestFingerprint": fingerprint,
                   "revision": 2, "highWaterMark": 3}
        with self.assertRaisesRegex(staging193.Refusal, "lineage changed after preflight"):
            staging193.require_unchanged_provenance_lineage(preflight, current)
        staging193.require_unchanged_provenance_lineage(preflight,
            {"latestEntry": 2, "latestFingerprint": fingerprint, "revision": 2, "highWaterMark": 2})

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

    def _browser_candidate(self, root, manifest_source_sha=SHA, capture_operation_id="capture-op",
                           build_operation_id=None, reused_capture_reference=None, profile="staging194"):
        operation_id = capture_operation_id
        build_operation_id = build_operation_id or operation_id
        snapshot_id = "snapshot-demo"
        production = profile in ("initial-prod", "production-static")
        manifest = {"version": 1, "host": "89.111.184.196" if production else "194.226.99.10",
                    "siteUrl": "https://ikpk.su" if production else "https://194.226.99.10",
                    "sourceId": "initial-prod-server-db" if production else "demo193-cms",
                    "operationId": operation_id,
                    "sourceSha": manifest_source_sha, "capturedAt": "2026-10-22T10:00:00.000Z",
                    "schemaDigest": "schema-digest", "databaseSha256": "database-digest",
                    "mediaManifestSha256": "media-digest"}
        if production:
            manifest.update({"profile": profile, "runId": 123, "attempt": 1})
        manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode()
        snapshot = {"sourcePolicy": ("initial-production" if profile == "initial-prod" else "production-static")
                        if production else "demo-publication-only",
                    "sourceAge": "source-bound" if production else "untracked",
                    "origin": {"kind": "server-db", "sourceId": "initial-prod-server-db" if production else "demo193-cms"},
                    "snapshotId": snapshot_id,
                    "captureProof": {"version": 1, "method": "quiesced-sqlite-backup",
                        "sourceId": "initial-prod-server-db" if production else "demo193-cms",
                        "captureId": operation_id,
                        "schemaDigest": "schema-digest", "databaseDigest": "database-digest",
                        "mediaManifestDigest": "media-digest",
                        "bundleDigest": hashlib.sha256(manifest_bytes).hexdigest()}}
        if production:
            snapshot["captureProof"].update({"targetHost": "89.111.184.196", "siteUrl": "https://ikpk.su",
                "sourceSha": manifest_source_sha, "runId": 123, "attempt": 1})
        static_root = Path(root) / "static"
        snapshot_root = Path(root) / "snapshot"
        static_root.mkdir()
        snapshot_root.mkdir()
        (static_root / "index.html").write_text("candidate", encoding="utf-8")
        static_digest = staging193._static_tree_sha256(static_root)
        release = {"commit": SHA, "operationId": build_operation_id,
                   "staticTreeSha256": static_digest, "snapshotId": snapshot_id}
        if reused_capture_reference is True:
            reused_capture_reference = {"operationId": operation_id, "sourceSha": manifest_source_sha,
                                        "bundleDigest": hashlib.sha256(manifest_bytes).hexdigest()}
        if reused_capture_reference is not None:
            release["reusedCapture"] = reused_capture_reference
        (static_root / "release.json").write_text(json.dumps(release), encoding="utf-8")
        (snapshot_root / "snapshot.json").write_text(json.dumps(snapshot), encoding="utf-8")
        (snapshot_root / "capture-manifest.json").write_bytes(manifest_bytes)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:") as bundle:
            for base in (static_root, snapshot_root):
                for path in sorted(base.rglob("*")):
                    if path.is_file():
                        name = f"{base.name}/{path.relative_to(base).as_posix()}"
                        payload = path.read_bytes()
                        member = tarfile.TarInfo(name)
                        member.size = len(payload)
                        bundle.addfile(member, io.BytesIO(payload))
        return build_operation_id, static_digest, archive.getvalue()

    def test_browser_check_accepts_real_demo_capture_proof_without_source_sha(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-browser-proof-") as temporary:
            root = Path(temporary)
            (root / "web/node_modules/.bin").mkdir(parents=True)
            (root / "web/node_modules/.bin/playwright").touch()
            operation_id, digest, archive = self._browser_candidate(root)
            server = MagicMock()
            server.server_address = ("127.0.0.1", 12345)
            thread = MagicMock()
            with patch.object(staging193, "ROOT", root), \
                 patch.object(staging193.socketserver, "ThreadingTCPServer", return_value=server), \
                 patch.object(staging193.threading, "Thread", return_value=thread), \
                 patch.object(staging193.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
                staging193.browser_check(SHA, operation_id, digest, archive,
                    chat_loader_src="https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js")
            run.assert_called_once()
            environment = run.call_args.kwargs["env"]
            self.assertEqual(environment["CHAT_LOADER_SRC"],
                "https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js")
            self.assertEqual(environment["DEMO_FORMS"], "stub")
            self.assertEqual(environment["PAYMENT_ROLE"], "ci")

    def test_browser_check_rejects_demo_capture_manifest_for_another_source_sha(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-browser-proof-") as temporary:
            root = Path(temporary)
            (root / "web/node_modules/.bin").mkdir(parents=True)
            (root / "web/node_modules/.bin/playwright").touch()
            operation_id, digest, archive = self._browser_candidate(root, manifest_source_sha="b" * 40)
            with patch.object(staging193, "ROOT", root), \
                 patch.object(staging193.socketserver, "ThreadingTCPServer") as server, \
                 patch.object(staging193.subprocess, "run") as run:
                with self.assertRaisesRegex(staging193.Refusal, "not the sealed CMS capture"):
                    staging193.browser_check(SHA, operation_id, digest, archive)
            server.assert_not_called()
            run.assert_not_called()

    def test_browser_check_accepts_original_capture_proof_for_a_new_build_operation(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-browser-reused-capture-") as temporary:
            root = Path(temporary)
            (root / "web/node_modules/.bin").mkdir(parents=True)
            (root / "web/node_modules/.bin/playwright").touch()
            build_operation_id, digest, archive = self._browser_candidate(
                root, manifest_source_sha="b" * 40, capture_operation_id="sealed-capture",
                build_operation_id="code-only-build", reused_capture_reference=True)
            server = MagicMock()
            server.server_address = ("127.0.0.1", 12345)
            thread = MagicMock()
            with patch.object(staging193, "ROOT", root), \
                 patch.object(staging193.socketserver, "ThreadingTCPServer", return_value=server), \
                 patch.object(staging193.threading, "Thread", return_value=thread), \
                 patch.object(staging193.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
                staging193.browser_check(SHA, build_operation_id, digest, archive,
                    chat_loader_src="https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js")
            run.assert_called_once()

    def test_browser_check_rejects_reused_capture_without_release_reference(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-browser-unreferenced-reuse-") as temporary:
            root = Path(temporary)
            (root / "web/node_modules/.bin").mkdir(parents=True)
            (root / "web/node_modules/.bin/playwright").touch()
            build_operation_id, digest, archive = self._browser_candidate(
                root, manifest_source_sha="b" * 40, capture_operation_id="sealed-capture",
                build_operation_id="code-only-build")
            server = MagicMock()
            server.server_address = ("127.0.0.1", 12345)
            with patch.object(staging193, "ROOT", root), \
                 patch.object(staging193.socketserver, "ThreadingTCPServer", return_value=server), \
                 patch.object(staging193.threading, "Thread", return_value=MagicMock()), \
                 self.assertRaises(staging193.Refusal):
                staging193.browser_check(SHA, build_operation_id, digest, archive)

    def test_browser_check_rejects_reused_capture_with_wrong_release_bundle_digest(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-browser-wrong-reuse-ref-") as temporary:
            root = Path(temporary)
            (root / "web/node_modules/.bin").mkdir(parents=True)
            (root / "web/node_modules/.bin/playwright").touch()
            build_operation_id, digest, archive = self._browser_candidate(
                root, manifest_source_sha="b" * 40, capture_operation_id="sealed-capture",
                build_operation_id="code-only-build", reused_capture_reference={
                    "operationId": "sealed-capture", "sourceSha": "b" * 40,
                    "bundleDigest": "0" * 64})
            server = MagicMock()
            server.server_address = ("127.0.0.1", 12345)
            with patch.object(staging193, "ROOT", root), \
                 patch.object(staging193.socketserver, "ThreadingTCPServer", return_value=server), \
                 patch.object(staging193.threading, "Thread", return_value=MagicMock()), \
                 self.assertRaises(staging193.Refusal):
                staging193.browser_check(SHA, build_operation_id, digest, archive)

    def test_initial_prod_browser_check_rejects_reused_capture_reference(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-browser-production-reuse-ref-") as temporary:
            root = Path(temporary)
            (root / "web/node_modules/.bin").mkdir(parents=True)
            (root / "web/node_modules/.bin/playwright").touch()
            operation_id, digest, archive = self._browser_candidate(root,
                capture_operation_id=staging193.INITIAL_PROD_OPERATION_ID,
                build_operation_id=staging193.INITIAL_PROD_OPERATION_ID,
                reused_capture_reference={"operationId": staging193.INITIAL_PROD_OPERATION_ID,
                    "sourceSha": SHA, "bundleDigest": "0" * 64}, profile="initial-prod")
            with patch.object(staging193, "ROOT", root), \
                 patch.object(staging193.socketserver, "ThreadingTCPServer") as server, \
                 patch.object(staging193.subprocess, "run") as run, \
                 self.assertRaises(staging193.Refusal):
                staging193.browser_check(SHA, operation_id, digest, archive, profile="initial-prod",
                    admitted_run={"runId": 123, "attempt": 1})
            server.assert_not_called()
            run.assert_not_called()

    def test_production_static_browser_check_uses_production_capture_without_demo_environment(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-browser-production-static-") as temporary:
            root = Path(temporary)
            (root / "web/node_modules/.bin").mkdir(parents=True)
            (root / "web/node_modules/.bin/playwright").touch()
            operation_id, digest, archive = self._browser_candidate(root,
                capture_operation_id="production-static-20261025-1", profile="production-static")
            server = MagicMock()
            server.server_address = ("127.0.0.1", 12345)
            with patch.object(staging193, "ROOT", root), \
                 patch.object(staging193.socketserver, "ThreadingTCPServer", return_value=server), \
                 patch.object(staging193.threading, "Thread", return_value=MagicMock()), \
                 patch.object(staging193.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
                staging193.browser_check(SHA, operation_id, digest, archive, profile="production-static",
                    admitted_run={"runId": 123, "attempt": 1})
            environment = run.call_args.kwargs["env"]
            self.assertEqual(environment["DEPLOY_MODE"], "prod")
            self.assertEqual(environment["PAYMENT_ROLE"], "prod")
            self.assertEqual(environment["PAYMENT_ENDPOINT_PROD"], "https://ikpk.su/api")
            self.assertEqual(environment["CHAT_LOADER_SRC"], staging193.INITIAL_PROD_CHAT_LOADER_SRC)
            for key in ("PUBLICATION_STAGING_CAPTURE", "DEMO_FORMS", "CHAT_OFFLINE_MESSAGE"):
                self.assertNotIn(key, environment)

    def test_static_main_cli_accepts_explicit_reuse_capture_operation_id(self):
        with patch.object(staging193, "invoke") as invoke:
            result = staging193.main(["static-main", "--host", staging193.TARGET_HOST,
                "--operation-id", "new-build", "--source-sha", SHA,
                "--reuse-capture-operation-id", "sealed-capture"])
        self.assertEqual(result, 0)
        self.assertEqual(invoke.call_args.args[0].reuse_capture_operation_id, "sealed-capture")

    def test_static_main_forwards_reuse_capture_id_to_host_prepare(self):
        provenance = {"sourceSha": SHA, "runId": 123, "attempt": 1}
        responses = [json.dumps({"phase": "browser-check-required", "staticTreeSha256": "c" * 64}).encode(),
                     b"candidate bytes", json.dumps({"phase": "committed"}).encode()]
        calls = []

        def ssh(arguments, input_bytes=None, **_kwargs):
            calls.append((arguments, input_bytes))
            return responses.pop(0)

        args = type("Args", (), {"host": staging193.TARGET_HOST, "command": "static-main",
            "operation_id": "new-build", "source_sha": SHA,
            "reuse_capture_operation_id": "sealed-capture"})()
        with patch.object(staging193, "validate_static_main_ci", return_value=provenance), \
             patch.object(staging193, "make_archive", return_value=(b"source archive", "a" * 64)), \
             patch.object(staging193, "ssh_remote", side_effect=ssh), \
             patch.object(staging193, "browser_check"):
            staging193.invoke(args)
        self.assertIn("--reuse-capture-operation-id", calls[0][0])
        self.assertEqual(calls[0][0][calls[0][0].index("--reuse-capture-operation-id") + 1],
                         "sealed-capture")
        self.assertIn(["export-static-main", "--operation-id", "new-build", "--source-sha", SHA],
                      [call[0] for call in calls])

    def test_production_static_profile_cli_accepts_reusable_static_main_operation(self):
        with patch.object(staging193, "invoke") as invoke:
            result = staging193.main(["--profile", "production-static", "static-main",
                "--host", staging193.INITIAL_PROD_HOST, "--operation-id", "production-static-20261025-1",
                "--source-sha", SHA])
        self.assertEqual(result, 0)
        self.assertEqual(invoke.call_args.args[0].profile, "production-static")
        self.assertEqual(invoke.call_args.args[0].operation_id, "production-static-20261025-1")

    def test_production_static_reuses_static_main_engine_with_production_profile(self):
        provenance = {"sourceSha": SHA, "runId": 123, "attempt": 1}
        responses = [json.dumps({"phase": "browser-check-required", "staticTreeSha256": "c" * 64}).encode(),
                     b"candidate bytes", json.dumps({"phase": "committed"}).encode()]
        calls = []

        def ssh(arguments, input_bytes=None, **kwargs):
            calls.append((arguments, input_bytes, kwargs))
            return responses.pop(0)

        args = type("Args", (), {"profile": "production-static", "host": staging193.INITIAL_PROD_HOST,
            "command": "static-main", "operation_id": "production-static-20261025-1",
            "source_sha": SHA, "reuse_capture_operation_id": None})()
        with patch.object(staging193, "validate_static_main_ci", return_value=provenance), \
             patch.object(staging193, "make_archive", return_value=(b"source archive", "a" * 64)), \
             patch.object(staging193, "ssh_remote", side_effect=ssh) as remote, \
             patch.object(staging193, "browser_check") as browser:
            staging193.invoke(args)

        self.assertEqual(remote.call_args_list[0].kwargs.get("profile"), "production-static")
        self.assertEqual(remote.call_args_list[1].kwargs.get("profile"), "production-static")
        self.assertEqual(remote.call_args_list[2].kwargs.get("profile"), "production-static")
        self.assertEqual(browser.call_args.args[4], "production-static")
        self.assertEqual(browser.call_args.kwargs["chat_loader_src"], staging193.INITIAL_PROD_CHAT_LOADER_SRC)
        self.assertTrue(all(call[0][0] in ("static-main", "export-static-main") for call in calls))

    def test_production_paired_committed_finalize_works_without_github(self):
        responses = [json.dumps({"phase": "committed", "sourceSha": SHA}).encode(),
                     json.dumps({"phase": "committed"}).encode()]
        calls = []

        def ssh(arguments, **kwargs):
            calls.append((arguments, kwargs))
            return responses.pop(0)

        args = type("Args", (), {"profile": "production-paired", "host": staging193.INITIAL_PROD_HOST,
            "command": "static-publish", "operation_id": "paired-finalize", "source_sha": SHA})()
        with patch.object(staging193, "ssh_remote", side_effect=ssh), \
             patch.object(staging193, "validate_production_paired_admission",
                          side_effect=AssertionError("finalization must not need GitHub")):
            staging193.invoke(args)

        self.assertEqual([call[0][0] for call in calls], ["status", "static-publish"])
        self.assertTrue(all(call[1].get("profile") == "production-paired" for call in calls))
        self.assertEqual(responses, [])

    def test_production_static_profile_refuses_staging_host_before_ci_or_ssh(self):
        for host in (staging193.TARGET_HOST, "193.124.115.99"):
            with self.subTest(host=host):
                args = type("Args", (), {"profile": "production-static", "host": host,
                    "command": "static-main", "operation_id": "production-static-20261025-1",
                    "source_sha": SHA})()
                with patch.object(staging193, "validate_static_main_ci") as admit, \
                     patch.object(staging193, "ssh_remote") as ssh, \
                     self.assertRaisesRegex(staging193.Refusal,
                         "bound to the authorized production-static host"):
                    staging193.invoke(args)
                admit.assert_not_called()
                ssh.assert_not_called()

    def test_production_static_profile_refuses_cms_mutating_commands_before_ci_or_ssh(self):
        for command in ("cms-update", "static-publish", "recover"):
            with self.subTest(command=command):
                args = type("Args", (), {"profile": "production-static", "host": staging193.INITIAL_PROD_HOST,
                    "command": command, "operation_id": "production-static-20261025-1",
                    "source_sha": SHA, "backup_dir": None})()
                with patch.object(staging193, "validate_sha_and_ci") as admit, \
                     patch.object(staging193, "validate_static_main_ci") as static_admit, \
                     patch.object(staging193, "make_archive", return_value=(b"archive", "a" * 64)), \
                     patch.object(staging193, "ssh_remote", return_value=json.dumps({"phase": "cms-activated"}).encode()) as ssh, \
                     self.assertRaisesRegex(staging193.Refusal,
                         "production-static permits only static-main publication and recovery"):
                    staging193.invoke(args)
                admit.assert_not_called()
                static_admit.assert_not_called()
                ssh.assert_not_called()

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
            result = staging193.validate_sha_and_ci(SHA, "staging194-dev")
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
                staging193.validate_sha_and_ci(SHA, "staging194-dev")

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
            staging193.validate_sha_and_ci(SHA, "staging194-dev")
        self.assertFalse(any(argv[:3] == ["git", "ls-remote", "origin"] for argv in calls))

    def test_rejects_skipped_or_cancelled_mandatory_job(self):
        self.jobs[0] = {"name": self.jobs[0]["name"], "status": "completed", "conclusion": "skipped"}
        with patch.object(staging193, "capture", side_effect=self._capture):
            with self.assertRaisesRegex(staging193.Refusal, "not successful"):
                staging193.validate_sha_and_ci(SHA, "staging194-dev")

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
        browser.assert_called_once_with(SHA, "main-static", "c" * 64, b"candidate bytes", "staging194", provenance,
            chat_loader_src=staging193.STAGING194_CHAT_LOADER_SRC)

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
            self.assertEqual(len(argv[argv.index("root@194.226.99.10") + 1:]), 1)
            self.assertEqual(shlex.split(argv[-1]), ["/usr/local/sbin/ikpk-rehearsal", "status",
                                                     "--operation-id", "op"])
            self.assertNotIn("sudo", argv)

    def test_ssh_remote_serializes_operator_arguments_as_one_remote_shell_command(self):
        args = ["static-main-recover", "--operation-id", "main-op", "--rollback-committed",
                "--operator", "release operator; $(touch /tmp/nope)", "--reason",
                "failure: spaces, 'quotes', $HOME; `id`"]
        with tempfile.TemporaryDirectory(prefix="ikpk-operator-identity-") as temporary:
            identity = Path(temporary) / "identity"
            known_hosts = Path(temporary) / "known_hosts"
            identity.write_text("test fixture", encoding="utf-8")
            known_hosts.write_text("194.226.99.10 ssh-ed25519 AAAATEST\n", encoding="utf-8")
            result = subprocess.CompletedProcess(["ssh"], 0, b"{}", b"")
            with patch.object(staging193, "TARGET_IDENTITY", identity), \
                 patch.object(staging193, "TARGET_KNOWN_HOSTS", known_hosts), \
                 patch.object(staging193.subprocess, "run", return_value=result) as invoke:
                staging193.ssh_remote(args)
            argv = invoke.call_args.args[0]
            remote_command = argv[-1]
            self.assertEqual(len(argv[argv.index("root@194.226.99.10") + 1:]), 1)
            self.assertEqual(shlex.split(remote_command), ["/usr/local/sbin/ikpk-rehearsal", *args])
            self.assertIn("'release operator; $(touch /tmp/nope)'", remote_command)
            self.assertNotIn("; touch /tmp/nope", remote_command)

    def test_production_static_ssh_uses_root_identity_and_namespaced_host_profile(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-production-static-ssh-") as temporary:
            identity = Path(temporary) / "identity"
            known_hosts = Path(temporary) / "known_hosts"
            identity.write_text("test identity", encoding="utf-8")
            known_hosts.write_text(f"{staging193.INITIAL_PROD_HOST} ssh-ed25519 AAAATEST\n", encoding="utf-8")
            result = subprocess.CompletedProcess(["ssh"], 0, b"{}", b"")
            with patch.object(staging193, "INITIAL_PROD_IDENTITY", identity), \
                 patch.object(staging193, "INITIAL_PROD_KNOWN_HOSTS", known_hosts), \
                 patch.object(staging193.subprocess, "run", return_value=result) as invoke:
                staging193.ssh_remote(["status", "--operation-id", "production-static-20261025-1"],
                                      profile="production-static")
            argv = invoke.call_args.args[0]
            self.assertIn(f"root@{staging193.INITIAL_PROD_HOST}", argv)
            remote_command = shlex.split(argv[-1])
            self.assertEqual(remote_command, ["/usr/local/sbin/ikpk-rehearsal", "--profile",
                "production-static", "status", "--operation-id", "production-static-20261025-1"])

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

    def test_committed_static_rollback_requires_explicit_operator_and_reason(self):
        args = type("Args", (), {"host": staging193.TARGET_HOST, "command": "static-main-recover",
            "operation_id": "main-static", "rollback_committed": True,
            "operator": "release-operator", "reason": "Post-activation route smoke failed"})()
        with patch.object(staging193, "ssh_remote", return_value=b'{"phase":"rolled-back"}') as ssh:
            staging193.invoke(args)
        ssh.assert_called_once_with(["static-main-recover", "--operation-id", "main-static",
            "--rollback-committed", "--operator", "release-operator", "--reason",
            "Post-activation route smoke failed"])

        args.reason = "  "
        with patch.object(staging193, "ssh_remote") as ssh:
            with self.assertRaisesRegex(staging193.Refusal, "requires --operator and --reason"):
                staging193.invoke(args)
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
