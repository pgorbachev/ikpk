import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, contextmanager, nullcontext
from argparse import Namespace
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
        # The deployed staging194 template omits profile; absence means staging194.
        del self.config["profile"]
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


class PairedWorkspaceHelpers:
    """Journal, workspace and CMS-process stubs shared by the paired cleanup test classes."""

    def _append_operation(self, operation_id, sha, *, completed=True,
                          previous_workspace=None, cms_path=None):
        row = {"version": 1, "operationId": operation_id, "sourceSha": sha}
        old_pair = {"cmsPath": str(cms_path or self.root / "previous-cms"),
                    "staticPath": str(self.root / "previous-static")}
        if previous_workspace is not None:
            old_pair["cmsSourceEnvironment"] = {"IKPK_BUILD_WORKSPACE": str(previous_workspace)}
        self.state._append({**row, "record": "start", "oldPair": old_pair})
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


    @contextmanager
    def _cms_unit(self, *, active="active", reload="no", pid=123):
        """Stub only the systemd/cgroup/environment reads; the protected-set code runs for real."""
        show = "\n".join([
            f"MainPID={pid}", "WorkingDirectory=", "Environment=",
            f"EnvironmentFiles={self.env_file} (ignore_errors=no)",
            f"ActiveState={active}", f"NeedDaemonReload={reload}",
            "ControlGroup=/system.slice/ikpk-cms-test.service"])
        real_lstat = Path.lstat
        env_file, live = self.env_file, str(self.live)

        def lstat(path, *args, **kwargs):
            info = real_lstat(path, *args, **kwargs)
            if path == env_file:
                fields = list(info)
                fields[4] = 0  # the test process cannot own a root-owned file
                return os.stat_result(fields)
            return info

        with ExitStack() as stack:
            stack.enter_context(patch.object(Path, "lstat", lstat))
            stack.enter_context(patch.object(host, "run", return_value=subprocess.CompletedProcess([], 0, show)))
            stack.enter_context(patch.object(host, "_service_pid", return_value=pid))
            stack.enter_context(patch.object(host, "_cms_process_workspace_references", return_value=set()))
            for name in ("_staging194_cms_source_env", "_paired_cms_source_env"):
                stack.enter_context(patch.object(host, name, return_value={"IKPK_BUILD_WORKSPACE": live}))
            yield

class PairedWorkspaceCleanupTests(PairedWorkspaceHelpers, WorkspaceTestCase):
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
            legacy_config.unlink()
            with self.assertRaisesRegex(host.HostFailure, "configuration is unavailable"):
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


class PairedGuardTests(PairedWorkspaceHelpers, WorkspaceTestCase):
    """Part 1: one test per existing safeguard. Each names the mutation it must catch."""

    def setUp(self):
        super().setUp()
        self.workspace_root.mkdir()
        state_dir = self.root / "state"
        state_dir.mkdir(mode=0o700)
        self.state = RehearsalState(state_dir)
        self.config["stateDir"] = str(state_dir)
        self.env_file = self.root / "cms.env"
        self.env_file.write_text("", encoding="utf-8")
        self.env_file.chmod(0o600)
        self.config["cmsEnvironmentFile"] = str(self.env_file)
        self.live = self.workspace_root / "live"
        self.live.mkdir()
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(host, "STAGING194_PAIRED_WORKSPACE_ROOT", self.workspace_root, create=True))
        stack.enter_context(patch.object(host.pwd, "getpwnam", return_value=self.user))
        stack.enter_context(patch.object(host, "_mount_points", return_value=set()))
        stack.enter_context(self._cms_unit())  # healthy CMS by default; tests nest overrides

    def _retired(self, *, with_workspace=True):
        """A completed operation whose workspace is unreferenced, with a journaled previous workspace."""
        self._append_operation("previous-op", "b" * 40)
        previous = self._child("previous-op", "b" * 40)
        self._append_operation("retired", self.sha, previous_workspace=previous)
        return self._child("retired", self.sha) if with_workspace else None

    def _tombstone(self, *, inode=None):
        self._retired(with_workspace=False)  # the original name must not exist for a tombstone
        name = ".workspace-removing-" + "1" * 32
        tombstone = self.workspace_root / name
        tombstone.mkdir(mode=0o750)
        (tombstone / "payload").write_text("interrupted", encoding="utf-8")
        info = tombstone.lstat()
        receipt = self.state.root / (name + ".json")
        receipt.write_text(json.dumps({
            "sourceSha": self.sha, "operationId": "retired", "name": f"{self.sha}-retired",
            "inode": inode or [info.st_dev, info.st_ino]}), encoding="utf-8")
        receipt.chmod(0o600)
        return tombstone, receipt

    def _tombstone_decision(self, tombstone, *, protected=()):
        with patch.object(host, "_protected_paired_workspace_paths", return_value=set(protected)):
            result = self._cleanup()
        return next(item for item in result["workspaceDecisions"] if item["path"] == str(tombstone))

    # Guard 1: protected-set failure deletes nothing.
    # Mutation: in _cleanup_paired_workspaces replace `raise HostFailure("cannot establish all protected
    # CMS workspace references") from error` with `protected = set()`.
    def test_failed_protected_set_deletes_no_workspace(self):
        candidate = self._retired()
        with patch.object(host, "run", side_effect=OSError("systemctl unavailable")):
            with self.assertRaisesRegex(host.HostFailure, "cannot establish all protected CMS workspace references"):
                self._cleanup()
        self.assertTrue(candidate.exists())

    # Guard 2a: inode recheck before removal.
    # Mutation: in _cleanup_paired_workspaces replace `if ((named.st_dev, named.st_ino) != (info.st_dev, info.st_ino)`
    # with `if (False`.
    def test_workspace_replaced_after_inspection_is_refused_before_removal(self):
        candidate = self._retired()
        real_allocated = host._workspace_allocated_bytes

        def replace_after_inspection(path):
            size = real_allocated(path)
            os.rename(path, path.with_name("moved-away"))
            path.mkdir(mode=0o750)
            marker = path / ".ikpk-workspace-identity.json"
            marker.write_text(json.dumps({"operationId": "retired", "sourceSha": self.sha}), encoding="utf-8")
            marker.chmod(0o600)
            (path / "payload").write_text("replacement", encoding="utf-8")
            return size

        with patch.object(host, "_workspace_allocated_bytes", side_effect=replace_after_inspection):
            with self.assertRaisesRegex(host.HostFailure, "workspace changed before removal"):
                self._cleanup()
        self.assertEqual((candidate / "payload").read_text(encoding="utf-8"), "replacement")

    # Guard 2b: identity check inside _remove_quarantined_workspace.
    # Mutation: replace `or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino):` with `:`.
    def test_quarantine_removal_rechecks_directory_identity(self):
        target = self.workspace_root / "quarantine-target"
        target.mkdir()
        (target / "payload").write_text("must survive", encoding="utf-8")
        other = self.root / "other"
        other.mkdir()
        directory = os.open(self.workspace_root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with self.assertRaisesRegex(host.HostFailure, "identity changed"):
                host._remove_quarantined_workspace("quarantine-target", directory, other.lstat())
        finally:
            os.close(directory)
        self.assertTrue((target / "payload").exists())

    # Guard 3: nested mount.
    # Mutation: replace `elif any(point == candidate or candidate in point.parents for point in mounts):` with `elif False:`.
    def test_mount_nested_in_workspace_retains_it(self):
        candidate = self._retired()
        with patch.object(host, "_mount_points", return_value={candidate / "payload"}):
            result = self._cleanup()
        decision = result["workspaceDecisions"][0]
        self.assertEqual((decision["decision"], decision["reason"]), ("retain", "mount point in workspace"))
        self.assertTrue((candidate / "payload").exists())

    # Guard 4: activation gate on apply.
    # Mutation: replace `elif not enabled:` with `elif False:`.
    def test_eligible_workspace_is_kept_when_activation_gate_is_off(self):
        candidate = self._retired()
        with self.state.lock():
            result = host._cleanup_paired_workspaces(self.config, self.state, enabled=False)
        decision = result["workspaceDecisions"][0]
        self.assertEqual((decision["decision"], decision["reason"]),
                         ("retain", "eligible, production workspace cleanup disabled"))
        self.assertTrue(candidate.exists())

    # Guard 5a: tombstone validity, original must not be protected.
    # Mutation: replace `and original not in protected` with `and True`.
    def test_tombstone_whose_original_is_protected_is_retained(self):
        tombstone, _ = self._tombstone()
        decision = self._tombstone_decision(tombstone, protected={self.workspace_root / f"{self.sha}-retired"})
        self.assertEqual((decision["decision"], decision["reason"]),
                         ("retain", "interrupted deletion evidence is ambiguous"))
        self.assertTrue(tombstone.exists())

    def test_verified_tombstone_is_removed_with_its_receipt(self):
        tombstone, receipt = self._tombstone()
        decision = self._tombstone_decision(tombstone)
        self.assertEqual(decision["decision"], "removed")
        self.assertFalse(tombstone.exists())
        self.assertFalse(receipt.exists())

    # Guard 5b: tombstone validity, receipt must be owned by the effective user.
    # Mutation: replace `valid = (receipt.lstat().st_uid == os.geteuid()` with `valid = (True`.
    def test_tombstone_with_foreign_receipt_owner_is_retained(self):
        tombstone, _ = self._tombstone()
        with patch.object(host.os, "geteuid", return_value=os.geteuid() + 1):
            decision = self._tombstone_decision(tombstone)
        self.assertEqual(decision["decision"], "retain")
        self.assertTrue(tombstone.exists())

    # Guard 5c: tombstone validity, directory inode must match the receipt.
    # Mutation: replace `and [info.st_dev, info.st_ino] == record["inode"]` with `and True`.
    def test_tombstone_with_mismatched_inode_is_retained(self):
        tombstone, _ = self._tombstone(inode=[0, 0])
        decision = self._tombstone_decision(tombstone)
        self.assertEqual(decision["decision"], "retain")
        self.assertTrue(tombstone.exists())

    # Guard 7: CMS inactive or NeedDaemonReload prevents establishing the protected set.
    # Mutation: replace `if values.get("ActiveState") != "active" or values.get("NeedDaemonReload") != "no":` with `if False:`.
    def test_inactive_cms_unit_establishes_no_protected_set(self):
        candidate = self._retired()
        with self._cms_unit(active="inactive"):
            with self.assertRaises(host.HostFailure) as context:
                self._cleanup()
        self.assertIn("not stable", str(context.exception.__cause__))
        self.assertTrue(candidate.exists())

    def test_pending_daemon_reload_establishes_no_protected_set(self):
        candidate = self._retired()
        with self._cms_unit(reload="yes"):
            with self.assertRaises(host.HostFailure) as context:
                self._cleanup()
        self.assertIn("not stable", str(context.exception.__cause__))
        self.assertTrue(candidate.exists())

    def test_healthy_cms_unit_protects_live_and_previous_workspaces_only(self):
        # Positive control for the Guard 7 harness: with a healthy unit the real
        # protected-set code runs and the unreferenced completed workspace is removed.
        self._append_operation("previous-op", "b" * 40)
        previous = self._child("previous-op", "b" * 40)
        self._append_operation("retired", self.sha, previous_workspace=previous)
        candidate = self._child("retired", self.sha)
        self._cleanup()
        self.assertFalse(candidate.exists())
        self.assertTrue(previous.exists())
        self.assertTrue(self.live.exists())


class PairedCleanupScenarioTests(PairedWorkspaceHelpers, WorkspaceTestCase):
    """Part 2: new behaviour for the four scenarios of "Keep release cleanup independent and failures visible"
    plus the staging194 guard that must keep its current behaviour.

    Names fixed for the implementer (assertions below depend on them, in the production-paired state directory,
    which is the RehearsalState root `stateDir`):
      - `workspace-cleanup-status.json`: keys `lastSucceededAt` (null or ISO string) and `consecutiveFailures` (int)
      - `workspace-cleanup.log.jsonl`: one JSON object per line, each with at least `reason`
    Both are written by the timer `cleanup-site` path and by `_cleanup_after_commit`.
    """

    def setUp(self):
        super().setUp()
        self.workspace_root.mkdir()
        state_dir = self.root / "state"
        state_dir.mkdir(mode=0o700)
        self.state = RehearsalState(state_dir)
        self.env_file = self.root / "cms.env"
        self.env_file.write_text("", encoding="utf-8")
        self.env_file.chmod(0o600)
        self.live = self.workspace_root / "live"
        self.live.mkdir()
        self.release_root = self.root / "cms-releases"
        self.cms_current = self.release_root / "current-release" / "cms-artifact"
        self.cms_rollback = self.release_root / "rollback-release" / "cms-artifact"
        self.cms_current.mkdir(parents=True)
        self.cms_rollback.mkdir(parents=True)
        self.stale = self.release_root / "stale-release"
        self.stale.mkdir()
        (self.stale / "marker").write_text("stale", encoding="utf-8")
        self.cms_pointer = self.root / "cms-current"
        self.cms_pointer.symlink_to(self.cms_current)
        self._append_operation("previous-op", "b" * 40)
        self.previous = self._child("previous-op", "b" * 40)
        self._append_operation("retired", self.sha, cms_path=self.cms_rollback, previous_workspace=self.previous)
        self.candidate = self._child("retired", self.sha)
        shared = {**self.config, "stateDir": str(state_dir), "releaseRoot": str(self.release_root),
                  "currentCms": str(self.cms_pointer), "cmsEnvironmentFile": str(self.env_file),
                  "siteBuildWorkspaceRoot": str(self.workspace_root)}
        self.prod = {**shared, "profile": "production-paired"}
        self.staging = {**shared, "profile": "staging194"}
        self.status_file = self.state.root / "workspace-cleanup-status.json"
        self.log_file = self.state.root / "workspace-cleanup.log.jsonl"

        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(host, "PRODUCTION_PAIRED_WORKSPACE_ROOT", self.workspace_root, create=True))
        stack.enter_context(patch.object(host, "STAGING194_PAIRED_WORKSPACE_ROOT", self.workspace_root, create=True))
        stack.enter_context(patch.object(host, "PRODUCTION_OPERATION_STATE_ROOT", self.root / "no-journals", create=True))
        stack.enter_context(patch.object(host, "_config_path_for_profile",
                                         side_effect=lambda name: self.root / "absent" / (name + ".json")))
        stack.enter_context(patch.object(host.pwd, "getpwnam", return_value=self.user))
        stack.enter_context(patch.object(host, "_mount_points", return_value=set()))
        stack.enter_context(patch.object(host, "_restart_cms_releases", return_value=set()))
        stack.enter_context(patch.object(host, "_cleanup_site_releases", return_value={}))
        stack.enter_context(self._cms_unit())

    def _after_commit(self, config):
        with self.state.lock():
            return host._cleanup_after_commit(config, self.state, "retired")

    def _read_status(self):
        return json.loads(self.status_file.read_text(encoding="utf-8"))

    def _read_log(self):
        return [json.loads(line) for line in self.log_file.read_text(encoding="utf-8").splitlines()]

    @contextmanager
    def _timer_cleanup(self):
        args = Namespace(action="cleanup-site", profile="production-paired", preview_workspaces=False)
        with ExitStack() as stack:
            stack.enter_context(patch.object(host.os, "geteuid", return_value=0))
            stack.enter_context(patch.object(host, "_root_config", return_value=self.prod))
            stack.enter_context(patch.object(host, "_select_cleanup_profile",
                                             return_value=(self.prod, "production-paired", None)))
            stack.enter_context(patch.object(host, "_read_site_publication_marker", return_value=None))
            stack.enter_context(patch.object(host, "_destination_publication_lock", return_value=nullcontext()))
            stack.enter_context(patch.object(host, "_assert_site_refresh_idle", return_value=None))
            stack.enter_context(patch.object(host, "_consume_site_cleanup_request", return_value=None))
            yield args

    # Scenario a: CMS stopped during cleanup (post-commit path).
    # Red now: the workspace failure aborts the whole CMS release step before any release is removed.
    def test_cms_stopped_keeps_workspaces_and_still_removes_unreferenced_cms_releases(self):
        with self._cms_unit(active="inactive"):
            result = self._after_commit(self.prod)
        self.assertTrue(result.get("cleanupPending"))
        self.assertIn("workspace", result.get("cleanupError", ""))
        self.assertTrue(self.candidate.exists())
        self.assertFalse(self.stale.exists())
        self.assertIn(str(self.stale.resolve()), result.get("removedCmsReleases", []))

    # Scenario a on the timer path: the run must fail (dispatch raises HostFailure -> non-zero exit)
    # after CMS release cleanup completed, and the status/log must already record the refusal.
    # Red now: CMS release cleanup never runs and no status/log is written.
    def test_cms_stopped_timer_run_fails_after_cms_cleanup_and_records_the_refusal(self):
        with self._timer_cleanup() as args, self._cms_unit(active="inactive"):
            with self.assertRaises(host.HostFailure):
                host.dispatch(args)
        self.assertTrue(self.candidate.exists())
        self.assertFalse(self.stale.exists())
        self.assertEqual(self._read_status()["consecutiveFailures"], 1)
        self.assertTrue(any("reason" in entry for entry in self._read_log()))

    # Scenario c: activation marker with mode 0644 disables deletion, reports the reason, does not fail the run.
    # Red now: the unsafe marker raises HostFailure and aborts the run.
    def test_marker_with_default_mode_disables_deletion_without_failing_the_run(self):
        gate = self.state.root / "workspace-cleanup.enabled"
        gate.write_text("", encoding="utf-8")
        gate.chmod(0o644)
        result = self._after_commit(self.prod)
        self.assertFalse(result.get("cleanupPending", False), result.get("cleanupError"))
        self.assertTrue(self.candidate.exists())
        self.assertFalse(self.stale.exists())
        self.assertIn(str(self.stale.resolve()), result.get("removedCmsReleases", []))
        self.assertTrue(any(entry.get("reason") for entry in self._read_log()))

    # Scenario d: repeated failures are visible in the status file and the log, on the post-commit path;
    # a successful run resets the consecutive count.
    # Red now: no status file and no log are written.
    def test_repeated_post_commit_failures_are_visible_and_success_resets_the_count(self):
        with self._cms_unit(active="inactive"):
            self._after_commit(self.prod)
            self._after_commit(self.prod)
        status = self._read_status()
        self.assertEqual(status["consecutiveFailures"], 2)
        self.assertIsNone(status["lastSucceededAt"])
        refusals = [entry for entry in self._read_log() if "reason" in entry]
        self.assertGreaterEqual(len(refusals), 2)

        result = self._after_commit(self.prod)
        self.assertFalse(result.get("cleanupPending", False), result.get("cleanupError"))
        status = self._read_status()
        self.assertEqual(status["consecutiveFailures"], 0)
        self.assertIsInstance(status["lastSucceededAt"], str)

    # Scenario d on the timer path (status and log are the same files as above).
    # Red now: no status file and no log are written.
    def test_repeated_timer_failures_increase_the_visible_count(self):
        with self._cms_unit(active="inactive"):
            for _ in range(2):
                with self._timer_cleanup() as args, self.assertRaises(host.HostFailure):
                    host.dispatch(args)
        self.assertEqual(self._read_status()["consecutiveFailures"], 2)
        self.assertGreaterEqual(len([entry for entry in self._read_log() if "reason" in entry]), 2)

    # A dangling or looping dependency link points at nothing to protect; it must not stop CMS release cleanup.
    def test_dangling_or_looping_dependency_link_does_not_block_cms_release_cleanup(self):
        orphan = self.workspace_root / "orphan" / "web"
        orphan.mkdir(parents=True)
        (orphan / "node_modules").symlink_to(self.release_root / "gone-release" / "web" / "node_modules")
        looping = self.workspace_root / "looping" / "cms"
        looping.mkdir(parents=True)
        (looping / "node_modules").symlink_to(looping / "node_modules")
        result = self._after_commit(self.prod)
        self.assertNotIn("dependency link", result.get("cleanupError", ""))
        self.assertFalse(self.stale.exists())
        self.assertIn(str(self.stale.resolve()), result.get("removedCmsReleases", []))

    # A link into a release that still exists keeps that release.
    def test_dependency_link_into_existing_release_keeps_it(self):
        orphan = self.workspace_root / "orphan" / "web"
        orphan.mkdir(parents=True)
        (orphan / "node_modules").symlink_to(self.stale / "web" / "node_modules")
        result = self._after_commit(self.prod)
        self.assertTrue(self.stale.exists())
        self.assertNotIn(str(self.stale.resolve()), result.get("removedCmsReleases", []))

    # The unsafe-marker reason and "deletion off" are visible in the log and the status file.
    def test_unsafe_marker_reason_is_logged_and_status_shows_deletion_disabled(self):
        gate = self.state.root / "workspace-cleanup.enabled"
        gate.write_text("", encoding="utf-8")
        gate.chmod(0o644)
        self._after_commit(self.prod)
        self.assertIn("activation marker unsafe", self._read_log()[-1]["reason"])
        status = self._read_status()
        self.assertIs(status["deletionEnabled"], False)
        self.assertIn("activation marker unsafe", status["lastReason"])

    # A failure before the workspace step (site release cleanup) is counted on the timer path too.
    def test_timer_failure_before_workspace_step_is_counted(self):
        with self._timer_cleanup() as args, patch.object(
                host, "_cleanup_site_releases", side_effect=host.HostFailure("site release cleanup refused")):
            with self.assertRaises(host.HostFailure):
                host.dispatch(args)
        self.assertEqual(self._read_status()["consecutiveFailures"], 1)
        self.assertIn("site release cleanup refused", self._read_log()[-1]["reason"])

    # The timer's journald message names the step and keeps the underlying cause.
    def test_timer_workspace_failure_message_names_the_step(self):
        with self._timer_cleanup() as args, self._cms_unit(active="inactive"):
            with self.assertRaises(host.HostFailure) as raised:
                host.dispatch(args)
        self.assertTrue(str(raised.exception).startswith("workspace step failed: "), str(raised.exception))
        self.assertIn("workspace step failed", self._read_log()[-1]["reason"])

    # A status file that is not a JSON object is replaced, not left to break every later run.
    def test_non_object_status_file_is_replaced(self):
        self.status_file.write_text("[]", encoding="utf-8")
        with self._cms_unit(active="inactive"):
            self._after_commit(self.prod)
        self.assertEqual(self._read_status()["consecutiveFailures"], 1)
        self.status_file.write_text("{broken", encoding="utf-8")
        self._after_commit(self.prod)
        self.assertEqual(self._read_status()["consecutiveFailures"], 0)

    # Staging194 keeps existing behaviour: a protected-set failure still prevents CMS release cleanup.
    # Expected GREEN now; it guards against the production decoupling leaking into staging194.
    def test_staging194_protected_set_failure_still_blocks_cms_release_cleanup(self):
        with self._cms_unit(active="inactive"):
            result = self._after_commit(self.staging)
        self.assertTrue(result.get("cleanupPending"))
        self.assertTrue(self.stale.exists())
        self.assertNotIn("removedCmsReleases", result)
