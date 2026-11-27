import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.lib import rehearsal_host as host
from scripts.lib.rehearsal_state import RehearsalState


class WorkspaceTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="ikpk-paired-workspace-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.sha = "a" * 40
        self.operation_id = "candidate"
        self.release_root = self.root / "releases"
        self.source = self.release_root / f"{self.sha}-{self.operation_id}"
        self.workspace_root = self.root / "workspace"
        self.workspace = self.workspace_root / self.source.name
        self.database = self.root / "data.db"
        self.config = {
            "profile": "staging194",
            "siteBuildWorkspaceRoot": str(self.workspace_root),
            "releaseRoot": str(self.release_root),
            "cmsDatabase": str(self.database),
            "currentCms": str(self.root / "current"),
            "cmsUser": "ikpk-cms",
            "cmsUnit": "ikpk-cms-test.service",
            "cmsHealthUrl": "http://127.0.0.1:1338/_health",
        }
        self.user = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())


class StagingWorkspaceTests(WorkspaceTestCase):
    def test_preparation_copies_staging_workspace_with_identity_and_dependency_links(self):
        web_deps = self.source / "web/node_modules"
        web_deps.mkdir(parents=True)
        cms_deps = self.root / "cms-deps/node_modules"
        cms_deps.mkdir(parents=True)
        (self.source / "cms").mkdir()
        (self.source / "cms/node_modules").symlink_to(cms_deps, target_is_directory=True)
        (self.source / "web/package.json").write_text("{}", encoding="utf-8")
        (self.source / "cms/package.json").write_text("{}", encoding="utf-8")
        (self.source / ".staging193-rehearsal").mkdir()
        with patch.object(host.pwd, "getpwnam", return_value=self.user), \
                patch.object(host, "STAGING194_PAIRED_WORKSPACE_ROOT", self.workspace_root, create=True):
            actual = host._prepare_paired_site_workspace(self.config, self.source, self.sha, self.operation_id)

        self.assertEqual(actual, self.workspace)
        identity = json.loads((actual / ".ikpk-workspace-identity.json").read_text(encoding="utf-8"))
        self.assertEqual(identity, {"operationId": self.operation_id, "sourceSha": self.sha})
        self.assertEqual((actual / "web/node_modules").readlink(), web_deps)
        self.assertEqual((actual / "cms/node_modules").readlink(), cms_deps)
        self.assertFalse((actual / ".staging193-rehearsal").exists())

    def test_activation_restarts_staging_with_the_paired_workspace(self):
        self.source.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.database.touch()
        capture = self.root / "capture"
        capture.mkdir()
        (capture / "media-manifest.json").write_text(json.dumps({"media": [
            {"url": "/uploads/fixture.webp", "originalName": "fixture.webp"}]}), encoding="utf-8")
        (self.source / ".ikpk-rehearsal-ci.json").write_text("{}", encoding="utf-8")
        artifact = {"fixture": "admitted"}
        with ExitStack() as stack:
            stack.enter_context(patch.object(host, "STAGING194_PAIRED_WORKSPACE_ROOT", self.workspace_root, create=True))
            stack.enter_context(patch.object(host.pwd, "getpwnam", return_value=self.user))
            stack.enter_context(patch.object(host, "_trusted_cms_artifact", return_value=artifact))
            stack.enter_context(patch.object(host, "_service_pid", return_value=123))
            stack.enter_context(patch.object(host, "run", return_value=subprocess.CompletedProcess([], 0)))
            for name in ("_verify_cms_artifact_bytes", "_assert_no_database_handles", "_copy_atomic", "_switch_pointer",
                         "_preflight_staging194_source", "_wait_health", "_database_process_proof"):
                stack.enter_context(patch.object(host, name))
            write_env = stack.enter_context(patch.object(host, "_write_staging194_cms_source_env"))
            verify_env = stack.enter_context(patch.object(host, "_assert_staging194_process_source_env"))
            host._activate_cms(self.config, self.source / "artifact", self.root / "candidate.db", capture,
                               self.source, self.sha, self.workspace, artifact, operation_id=self.operation_id)

        expected = {"IKPK_BUILD_WORKSPACE": str(self.workspace), "IKPK_INSTALLED_COMMIT": self.sha}
        write_env.assert_called_once_with(self.config, expected)
        verify_env.assert_called_once_with(self.config, expected)


class PairedWorkspaceCleanupTests(WorkspaceTestCase):
    def setUp(self):
        super().setUp()
        self.workspace_root.mkdir()
        state_dir = self.root / "state"
        state_dir.mkdir(mode=0o700)
        self.state = RehearsalState(state_dir)
        self.config["stateDir"] = str(state_dir)
        self.config["siteBuildWorkspaceRoot"] = str(self.workspace_root)
        self.protected = set()
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(host, "STAGING194_PAIRED_WORKSPACE_ROOT", self.workspace_root, create=True))
        stack.enter_context(patch.object(host.pwd, "getpwnam", return_value=self.user))
        stack.enter_context(patch.object(host, "_mount_points", return_value=set()))
        self.references = stack.enter_context(patch.object(host, "_protected_paired_workspace_paths",
                                                            return_value=self.protected, create=True))

    def _append_operation(self, operation_id, sha, *, completed=True):
        row = {"version": 1, "operationId": operation_id, "sourceSha": sha}
        self.state._append({**row, "record": "start", "oldPair": {
            "cmsPath": str(self.root / "previous-cms"), "staticPath": str(self.root / "previous-static"),
        }})
        if not completed:
            return
        pair = {name: sha for name in ("sourceSha", "cmsSha", "staticSha")}
        for name in ("cmsPayloadSha256", "staticTreeSha256", "cmsDatabaseSha256", "cmsMediaManifestSha256",
                     "cmsCaptureBundleSha256", "oldDatabaseSha256", "oldMediaManifestSha256", "configSha256"):
            pair[name] = "f" * 64
        pair["snapshotId"] = "snap:test"
        pair["cmsDatabaseProof"] = {"pid": 100, "device": 1, "inode": 1, "database": str(self.database)}
        self.state._append({**row, "record": "new-bundle", "newPair": pair})
        self.state._append({**row, "record": "committed"})

    def _child(self, operation_id, sha, *, marker_sha=None):
        path = self.workspace_root / f"{sha}-{operation_id}"
        path.mkdir(mode=0o750)
        marker = path / ".ikpk-workspace-identity.json"
        marker.write_text(json.dumps({"operationId": operation_id, "sourceSha": marker_sha or sha}),
                          encoding="utf-8")
        marker.chmod(0o600)
        (path / "payload").write_text("workspace contents", encoding="utf-8")
        return path

    def _cleanup(self, *, preview=False):
        with self.state.lock():
            return host._cleanup_paired_workspaces(self.config, self.state, preview=preview)

    def test_preview_and_cleanup_keep_protected_and_unverified_children(self):
        for operation_id, sha in (("retired", "a" * 40), ("live", "b" * 40), ("bad-marker", "c" * 40)):
            self._append_operation(operation_id, sha)
        stale = self._child("retired", "a" * 40)
        live = self._child("live", "b" * 40)
        mismatched = self._child("bad-marker", "c" * 40, marker_sha="d" * 40)
        orphan = self._child("unknown", "e" * 40)
        self.protected.add(live)
        outside = self.root / "outside"
        outside.mkdir()
        evidence = outside / "keep"
        evidence.write_text("untouched", encoding="utf-8")
        (stale / "outward-link").symlink_to(outside, target_is_directory=True)

        self.assertIn("workspaceDecisions", self._cleanup(preview=True))
        self.assertTrue(stale.exists())
        self.assertIn("workspaceDecisions", self._cleanup())
        self.assertFalse(stale.exists())
        self.assertTrue(live.exists())
        self.assertTrue(mismatched.exists())
        self.assertTrue(orphan.exists())
        self.assertEqual(evidence.read_text(encoding="utf-8"), "untouched")
        self._cleanup()
        self.assertTrue(live.exists())

    def test_interrupted_delete_is_quarantined_and_retried(self):
        self._append_operation("retired", self.sha)
        candidate = self._child("retired", self.sha)
        with patch.object(host, "_remove_quarantined_workspace", side_effect=OSError("simulated interruption")):
            with self.assertRaisesRegex(OSError, "simulated interruption"):
                self._cleanup()
        self.assertFalse(candidate.exists())
        tombstones = list(self.workspace_root.iterdir())
        self.assertEqual(len(tombstones), 1)
        self.assertTrue((self.state.root / (tombstones[0].name + ".json")).is_file())
        result = self._cleanup()
        self.assertEqual(result["workspaceDecisions"][0]["decision"], "removed")
        self.assertFalse(tombstones[0].exists())

    def test_cms_child_file_descriptor_counts_as_a_live_reference(self):
        cgroups = self.root / "cgroups"
        processes = self.root / "proc"
        group = cgroups / "system.slice/cms.service"
        group.mkdir(parents=True)
        (group / "cgroup.procs").write_text("101\n102\n")
        retired = self._child("retired", self.sha)
        for pid in ("101", "102"):
            proc = processes / pid
            (proc / "fd").mkdir(parents=True)
            (proc / "environ").write_bytes(b"IKPK_BUILD_WORKSPACE=/srv/current\0" if pid == "101" else b"")
            (proc / "cwd").symlink_to("/srv")
            (proc / "exe").symlink_to("/usr/bin/node")
            (proc / "maps").touch()
        (processes / "102/fd/3").symlink_to(retired / "payload")
        refs = host._cms_process_workspace_references("/system.slice/cms.service", 101,
                                                      cgroups=cgroups, processes=processes)
        self.assertIn(str(retired / "payload"), refs)

    def test_production_preview_reads_legacy_initial_journal_without_loading_its_config(self):
        production_state_root = self.root / "production-state"
        initial = production_state_root / "initial-prod"
        initial.mkdir(mode=0o700, parents=True)
        initial_state = RehearsalState(initial)
        with initial_state.lock():
            pass
        legacy_config = self.root / "initial-prod.json"
        legacy_config.write_text(json.dumps({"profile": "initial-prod", "stateDir": str(initial)}), encoding="utf-8")
        real_fstat = os.fstat
        legacy_inode = legacy_config.stat().st_ino

        def root_owned_config(fd):
            info = real_fstat(fd)
            if info.st_ino == legacy_inode:
                fields = list(info)
                fields[4] = 0
                return os.stat_result(fields)
            return info
        original_lstat = Path.lstat

        def root_owned_state(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            if path == initial:
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0)
            return info

        production = {**self.config, "profile": "production-paired"}
        with self.state.lock(), \
                patch.object(host, "PRODUCTION_OPERATION_STATE_ROOT", production_state_root), \
                patch.object(host, "_config_path_for_profile", side_effect=lambda name: self.root / (name + ".json")), \
                patch.object(host, "_root_config", side_effect=AssertionError("legacy config must not be loaded")), \
                patch.object(Path, "lstat", root_owned_state), \
                patch.object(host.os, "fstat", root_owned_config), \
                patch.object(host, "_cleanup_paired_workspaces", return_value={"workspaceDecisions": []}) as cleanup:
            self.assertEqual(host._cleanup_workspace_scope(production, self.state, preview=True),
                             {"workspaceDecisions": []})
            legacy_config.write_text(json.dumps({"profile": "initial-prod", "stateDir": str(self.root / "different-state")}), encoding="utf-8")
            with self.assertRaisesRegex(host.HostFailure, "location differs"):
                host._cleanup_workspace_scope(production, self.state, preview=True)
        cleanup.assert_called_once_with(production, self.state, preview=True, enabled=False)

    def test_unfinished_publication_prohibits_workspace_deletion(self):
        self._append_operation("retired", "a" * 40)
        retired = self._child("retired", "a" * 40)
        self._append_operation("active", "b" * 40, completed=False)
        active = self._child("active", "b" * 40)

        try:
            self._cleanup()
        except (host.HostFailure, host.RehearsalRefusal):
            pass
        self.assertTrue(retired.exists())
        self.assertTrue(active.exists())
