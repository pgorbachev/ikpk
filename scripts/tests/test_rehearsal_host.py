import hashlib
import base64
import getpass
import importlib.util
import io
import json
import sqlite3
import subprocess
import shutil
import tarfile
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host
from scripts.lib.rehearsal_host import _copy_atomic, _switch_pointer
from scripts.lib.rehearsal_state import RehearsalState


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("staging193_operator", ROOT / "scripts/rehearsal/staging193.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


def sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def backup_archive(operation_id="operator-test"):
    with tempfile.TemporaryDirectory(prefix="ikpk-offhost-source-") as temporary:
        root = Path(temporary)
        database = root / "database.sqlite"
        db = sqlite3.connect(database)
        db.execute("CREATE TABLE content (body TEXT NOT NULL)")
        db.execute("INSERT INTO content VALUES ('accepted editor write')")
        db.commit()
        db.close()
        database_bytes = database.read_bytes()
        image_bytes = b"image bytes"
        media = [{"url": "/uploads/photo.jpg", "file": "media/sha256:photo",
                  "sha256": sha(image_bytes), "size": len(image_bytes), "originalName": "photo.jpg",
                  "mode": 0o640, "uid": 987, "gid": 987}]
        media_bytes = json.dumps({"media": media}, sort_keys=True).encode() + b"\n"
        manifest_bytes = json.dumps({"version": 1, "operationId": operation_id,
            "databaseSha256": sha(database_bytes), "mediaManifestSha256": sha(media_bytes),
            "media": media}, sort_keys=True).encode() + b"\n"
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as output:
            for name, payload in (("database.sqlite", database_bytes), ("media-manifest.json", media_bytes),
                                  ("manifest.json", manifest_bytes), ("media/sha256:photo", image_bytes)):
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                info.mode = 0o600
                output.addfile(info, io.BytesIO(payload))
        return archive.getvalue()


class RehearsalHostFilesystemTests(unittest.TestCase):
    def test_host_binding_rejects_wrong_host_and_cross_host_probe_urls(self):
        data = {"allowedSourceRef": "refs/heads/dev", "targetHost": "194.226.99.10",
                "cmsHealthUrl": "http://127.0.0.1:1338/_health",
                "siteHealthUrl": "https://194.226.99.10/", "siteBaseUrl": "https://194.226.99.10",
                "siteReleaseUrl": "https://194.226.99.10/release.json",
                "preserveProbeUrl": "https://194.226.99.10/",
                "paymentStatusProbeUrl": "https://194.226.99.10/api/payments/rehearsal/status",
                "siteProbeUrls": ["https://194.226.99.10/"],
                "writerProbeUrls": ["https://194.226.99.10/api"]}
        rehearsal_host._validate_target_binding(data)
        for changed in (
            {**data, "targetHost": "193.124.115.99"},
            {**data, "cmsHealthUrl": "https://ikpk.su/_health"},
            {**data, "siteProbeUrls": ["https://193.124.115.99/"]},
            {**data, "writerProbeUrls": ["https://193.124.115.99/api"]},
        ):
            with self.subTest(changed=changed):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "staging194"):
                    rehearsal_host._validate_target_binding(changed)

    def _activate_for_media_probe_test(self, media_inventory):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-media-probe-") as temporary:
            root = Path(temporary)
            live_database = root / "live.sqlite"
            live_database.write_bytes(b"old database")
            capture = root / "capture"
            capture.mkdir()
            (capture / "media-manifest.json").write_text(
                json.dumps({"media": media_inventory}), encoding="utf-8")
            config = {"cmsDatabase": str(live_database), "currentCms": str(root / "current"),
                      "releaseRoot": str(root / "releases"), "cmsUnit": "ikpk-cms-prototype193.service",
                      "cmsHealthUrl": "http://127.0.0.1:1338/_health"}
            commands = []

            def run_command(argv, **kwargs):
                commands.append(argv)
                return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

            with patch.object(rehearsal_host, "_assert_no_database_handles"), \
                 patch.object(rehearsal_host, "_copy_atomic"), \
                 patch.object(rehearsal_host, "_switch_pointer"), \
                 patch.object(rehearsal_host, "_wait_health"), \
                 patch.object(rehearsal_host, "_service_pid", return_value=123), \
                 patch.object(rehearsal_host, "_database_process_proof", return_value={}), \
                 patch.object(rehearsal_host, "run", side_effect=run_command):
                rehearsal_host._activate_cms(config, root / "new-release", root / "candidate.db", capture)
            return [argv for argv in commands if argv[0] == "/usr/bin/curl"]

    def test_cms_activation_probes_upload_when_sorted_manifest_starts_with_legacy_media(self):
        legacy = {"url": "/media/_w/1200/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp",
                  "originalName": "_w/1200/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp"}
        upload = {"url": "/uploads/1_1727008400454_5a30189ad6.webp",
                  "originalName": "1_1727008400454_5a30189ad6.webp"}

        probes = self._activate_for_media_probe_test([legacy, upload])

        self.assertEqual(len(probes), 1)
        self.assertEqual(probes[0][-1], "http://127.0.0.1:1338/uploads/1_1727008400454_5a30189ad6.webp")

    def test_cms_activation_fails_clearly_when_capture_has_no_upload_entry(self):
        legacy = {"url": "/media/_w/1200/uploads/legacy.webp",
                  "originalName": "_w/1200/uploads/legacy.webp"}

        with self.assertRaisesRegex(rehearsal_host.HostFailure, "no /uploads/ entry"):
            self._activate_for_media_probe_test([legacy])

    def test_unprivileged_build_has_a_systemd_runtime_deadline_before_client_timeout(self):
        completed = subprocess.CompletedProcess([], 0, stdout="finished", stderr="")
        with patch.object(rehearsal_host.pwd, "getpwnam", return_value=type("User", (), {"pw_name": "ikpk-cms"})()), \
             patch.object(rehearsal_host, "run", return_value=completed) as run_command:
            result = rehearsal_host._run_as_cms({"cmsUser": "ikpk-cms"}, Path("/tmp/cms"),
                                                 ["/usr/bin/npm", "ci"], timeout=90)
        command = run_command.call_args.args[0]
        self.assertIn("--property=RuntimeMaxSec=60s", command)
        self.assertIn("--property=TimeoutStopSec=15s", command)
        self.assertEqual(run_command.call_args.kwargs["timeout"], 90)
        self.assertEqual(result, "finished")

    def test_cms_artifact_build_can_mount_only_its_validated_dependency_tree_read_only(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-readonly-cms-deps-") as temporary:
            dependencies = Path(temporary) / "deps/node_modules"
            dependencies.mkdir(parents=True)
            completed = subprocess.CompletedProcess([], 0, stdout="finished", stderr="")
            user = type("User", (), {"pw_name": "ikpk-cms"})()
            with patch.object(rehearsal_host.pwd, "getpwnam", return_value=user), \
                 patch.object(rehearsal_host, "run", return_value=completed) as run_command:
                rehearsal_host._run_as_cms({"cmsUser": "ikpk-cms"}, Path("/tmp/cms"),
                    ["/usr/bin/bash", "build-cms-artifact.sh"], read_only_path=dependencies.resolve())

            command = run_command.call_args.args[0]
            self.assertIn(f"--property=ReadOnlyPaths={dependencies.resolve()}", command)
            self.assertEqual(command[-2:], ["/usr/bin/bash", "build-cms-artifact.sh"])

    def test_prepared_candidate_refuses_reused_generation_with_strapi_version_mismatch(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-strapi-mismatch-") as temporary:
            root = Path(temporary)
            source_sha, operation_id = "a" * 40, "strapi-op"
            source = root / f"{source_sha}-{operation_id}"
            cms = source / "cms"
            cms.mkdir(parents=True)
            (source / ".ikpk-rehearsal-ci.json").write_text(json.dumps(
                {"sourceSha": source_sha, "ref": "refs/heads/dev"}))
            (cms / "package.json").write_text(json.dumps({"dependencies": {"@strapi/strapi": "5.51.1"}}))
            lock = {"packages": {"node_modules/@strapi/strapi": {"version": "5.51.2"}}}
            lock_bytes = json.dumps(lock, sort_keys=True).encode()
            (cms / "package-lock.json").write_bytes(lock_bytes)
            dependencies = root / "deps/node_modules"
            (dependencies / "@strapi/strapi").mkdir(parents=True)
            (dependencies / "@strapi/strapi/package.json").write_text(json.dumps({"version": "5.51.2"}))
            (cms / "node_modules").symlink_to(dependencies, target_is_directory=True)
            artifact = rehearsal_host._cms_artifact_path(source, operation_id)
            (artifact / "dist/config").mkdir(parents=True)
            (artifact / "database").mkdir()
            (artifact / "scripts").mkdir()
            (artifact / "package.json").write_text(json.dumps({"dependencies": {"@strapi/strapi": "5.51.1"}}))
            (artifact / "package-lock.json").write_bytes(lock_bytes)
            for name in ("tsconfig.json", "dist/config/database.js", "database/.migrations-expected",
                         "scripts/run-data-migrations.mjs"):
                (artifact / name).write_text("test")
            (artifact / "node_modules").symlink_to(dependencies, target_is_directory=True)
            web_dependencies = source / "web/node_modules"
            for package in ("astro", "tsx"):
                (web_dependencies / package).mkdir(parents=True)
                (web_dependencies / package / "package.json").write_text("{}")
            (web_dependencies / ".bin").mkdir()
            for package in ("astro", "tsx"):
                (web_dependencies / package / "bin.js").write_text("")
                (web_dependencies / ".bin" / package).symlink_to(f"../{package}/bin.js")
            expected = {"version": 1, "lockSha256": sha(lock_bytes), "profile": "full-build",
                        "nodeVersion": "v24.1.0", "nodeAbi": "137", "platform": "linux",
                        "architecture": "x64"}
            config = {"allowedSourceRef": "refs/heads/dev", "cmsUser": getpass.getuser()}
            with patch.object(rehearsal_host, "_cms_build_generation", return_value=(root / "unused", expected)), \
                 patch.object(rehearsal_host, "_validate_cms_build_generation", return_value=dependencies.resolve()):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "identities do not match"):
                    rehearsal_host._validate_prepared_cms_candidate(
                        config, source, operation_id, {"sourceSha": source_sha, "ref": "refs/heads/dev"})

    def test_prefence_candidate_installs_full_cms_deps_then_builds_artifact_with_bounded_heap(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-artifact-heap-") as temporary:
            source = Path(temporary) / "candidate"
            (source / "cms").mkdir(parents=True)
            (source / "web").mkdir()
            dependencies = Path(temporary) / "shared-deps/node_modules"
            dependencies.mkdir(parents=True)
            user = type("User", (), {"pw_name": "ikpk-cms", "pw_uid": 0, "pw_gid": 0})()
            calls = []

            def run_as_cms(_config, cwd, argv, **kwargs):
                calls.append((cwd, argv, kwargs))
                if "build-cms-artifact.sh" in " ".join(argv):
                    artifact = Path(argv[-1])
                    artifact.mkdir(parents=True)
                return ""

            with patch.object(rehearsal_host, "_prepare_cms_build_dependencies", return_value=dependencies), \
                 patch.object(rehearsal_host, "_validate_prepared_cms_candidate",
                              return_value=(source, source / ".staging193-rehearsal/op/migration/cms-artifact", dependencies)), \
                 patch.object(rehearsal_host.pwd, "getpwnam", return_value=user), \
                 patch.object(rehearsal_host.os, "chown"), patch.object(rehearsal_host.os, "chmod"), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=run_as_cms):
                rehearsal_host._prepare_cms_candidate(
                    {"cmsUser": "ikpk-cms"}, source, "op", {"sourceSha": "a" * 40})

            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][1], ["/usr/bin/npm", "ci", "--no-audit", "--no-fund"])
            self.assertEqual(calls[0][0], source / "web")
            self.assertEqual(calls[1][1][:2], ["/usr/bin/bash", str(source / "scripts/build-cms-artifact.sh")])
            self.assertEqual(calls[1][2]["timeout"], 3600)
            self.assertEqual(calls[1][2]["environment"], {"NODE_OPTIONS": "--max-old-space-size=1536"})
            self.assertEqual(calls[1][2]["read_only_path"], dependencies)

    def test_complete_cms_build_dependency_generation_is_reused_without_mutation(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-build-deps-") as temporary:
            root = Path(temporary)
            source_cms = root / "source/cms"
            source_cms.mkdir(parents=True)
            lock = {"packages": {"node_modules/@strapi/strapi": {"version": "5.20.0"}}}
            lock_bytes = json.dumps(lock, sort_keys=True).encode()
            (source_cms / "package-lock.json").write_bytes(lock_bytes)
            (source_cms / "package.json").write_text(json.dumps({"dependencies": {"@strapi/strapi": "5.20.0"}}))
            release_root = root / "artifact/releases"
            release_root.mkdir(parents=True)
            config = {"releaseRoot": str(release_root), "cmsUser": getpass.getuser()}
            lock_hash = hashlib.sha256(lock_bytes).hexdigest()
            runtime = {"abi": "137", "platform": "linux", "arch": "x64"}
            key = f"{lock_hash}-full-build-node24.1.0-linux-x64-abi137"
            generation = root / "artifact/deps" / key
            dependencies = generation / "node_modules"
            strapi = dependencies / "@strapi/strapi"
            strapi.mkdir(parents=True)
            (generation / "package-lock.json").write_bytes(lock_bytes)
            (strapi / "package.json").write_text(json.dumps({"version": "5.20.0"}))
            expected = {"version": 1, "lockSha256": lock_hash, "profile": "full-build",
                        "nodeVersion": "v24.1.0", "nodeAbi": "137", "platform": "linux",
                        "architecture": "x64"}
            (generation / ".complete").write_text(json.dumps(expected))
            result = lambda stdout: subprocess.CompletedProcess([], 0, stdout=stdout, stderr="")
            current_user = rehearsal_host.pwd.getpwnam(getpass.getuser())
            before = {path.relative_to(generation).as_posix(): path.read_bytes()
                      for path in generation.rglob("*") if path.is_file()}
            with patch.object(rehearsal_host, "run", side_effect=[result("v24.1.0\n"),
                         result(json.dumps(runtime)), result("v24.1.0\n"), result(json.dumps(runtime))]), \
                 patch.object(rehearsal_host.pwd, "getpwnam", return_value=current_user), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=AssertionError("ready deps must not reinstall")):
                reused = rehearsal_host._prepare_cms_build_dependencies(config, root / "source")

            self.assertEqual(reused, dependencies.resolve())
            self.assertEqual(key.split("-full-build-", 1)[0], lock_hash)
            after = {path.relative_to(generation).as_posix(): path.read_bytes()
                     for path in generation.rglob("*") if path.is_file()}
            self.assertEqual(after, before)

    def test_packaged_cms_uploads_reuse_the_external_original_name_tree(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-media-link-") as temporary:
            root = Path(temporary)
            artifact = root / "cms-artifact"
            uploads = artifact / "public/uploads"
            uploads.mkdir(parents=True)
            (uploads / ".gitkeep").write_text("", encoding="utf-8")
            external = root / "staging-uploads"
            external.mkdir(mode=0o700)
            (external / "photo original.jpg").write_bytes(b"editor media")
            config = {"cmsUser": getpass.getuser(),
                      "mediaRoots": [{"prefix": "/uploads/", "path": str(external)}]}
            resolved = rehearsal_host._configure_candidate_uploads(config, artifact)
            self.assertEqual(resolved, external.resolve())
            self.assertTrue(uploads.is_symlink())
            self.assertEqual(uploads.resolve(), external.resolve())
            self.assertEqual((uploads / "photo original.jpg").read_bytes(), b"editor media")
            self.assertEqual(len(rehearsal_host._cms_payload_sha256(artifact, external)), 64)

    def test_cms_payload_accepts_operation_source_dependencies_and_internal_bin_links(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-node-modules-") as temporary:
            root = Path(temporary) / "source/op/.staging193-rehearsal/op/migration"
            artifact = root / "cms-artifact"
            artifact.mkdir(parents=True)
            dependencies = root.parent.parent.parent.parent / "cms/node_modules"
            (dependencies / "@strapi/strapi/bin").mkdir(parents=True)
            (dependencies / "@strapi/strapi/bin/strapi.js").write_text("runtime", encoding="utf-8")
            (dependencies / ".bin").mkdir()
            (dependencies / ".bin/strapi").symlink_to("../@strapi/strapi/bin/strapi.js")
            (artifact / "node_modules").symlink_to(dependencies, target_is_directory=True)
            (artifact / "package-lock.json").write_text("{}", encoding="utf-8")
            (artifact / "public").mkdir()
            uploads = Path(temporary) / "uploads"
            uploads.mkdir()
            (artifact / "public/uploads").symlink_to(uploads, target_is_directory=True)
            self.assertEqual(len(rehearsal_host._cms_payload_sha256(artifact, uploads, dependencies)), 64)
            wrong_dependencies = root.parent.parent.parent.parent / "other/cms/node_modules"
            wrong_dependencies.mkdir(parents=True)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "not a private installed dependency tree"):
                rehearsal_host._cms_payload_sha256(artifact, uploads, wrong_dependencies)

            legacy = Path(temporary) / "legacy-release"
            (legacy / "node_modules/.bin").mkdir(parents=True)
            outside = Path(temporary) / "outside"
            outside.write_text("not a dependency", encoding="utf-8")
            (legacy / "node_modules/.bin/escape").symlink_to(outside)
            (legacy / "public").mkdir()
            (legacy / "public/uploads").symlink_to(uploads, target_is_directory=True)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "escapes node_modules"):
                rehearsal_host._cms_payload_sha256(legacy, uploads)

    def test_backup_and_release_tree_use_real_lstat_results(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-backup-lstat-") as temporary:
            root = Path(temporary)
            database = root / "live.sqlite"
            db = sqlite3.connect(database)
            db.execute("CREATE TABLE content (body TEXT NOT NULL)")
            db.execute("INSERT INTO content VALUES ('preserved')")
            db.commit()
            db.close()
            uploads = root / "uploads"
            uploads.mkdir()
            shared_photo = b"same photo bytes in separate namespaces"
            (uploads / "photo.jpg").write_bytes(shared_photo)
            static_media = root / "old-static/media"
            static_media.mkdir(parents=True)
            (static_media / "legacy.jpg").write_bytes(shared_photo)
            (root / "backups").mkdir()
            config = {"cmsDatabase": str(database), "backupRoot": str(root / "backups"),
                      "mediaRoots": [{"path": str(uploads), "prefix": "/uploads/"},
                                     {"path": str(static_media), "prefix": "/media/"}]}
            # /proc handle inspection is Linux-specific; exercise the real SQLite backup,
            # media walk, lstat checks, tar creation and digest verification on this host.
            with patch.object(rehearsal_host, "_assert_no_database_handles"):
                manifest = rehearsal_host._backup(config, "lstat-op")
            backup_dir = root / "backups/lstat-op"
            archive_bytes = (backup_dir / "backup.tar").read_bytes()
            self.assertEqual(sha(archive_bytes), manifest["archiveSha256"])
            self.assertEqual({row["url"].split("/", 2)[1] for row in manifest["media"]}, {"uploads", "media"})
            self.assertEqual({row["url"] for row in manifest["media"]},
                             {"/uploads/photo.jpg", "/media/legacy.jpg"})
            self.assertEqual({row["file"] for row in manifest["media"]},
                             {f"media/sha256:{sha(shared_photo)}"})
            offhost = root / "offhost"
            offhost.mkdir()
            operator.persist_offhost_backup(offhost, "lstat-op", "a" * 40, archive_bytes,
                                            manifest["archiveSha256"])
            db = sqlite3.connect(f"file:{backup_dir / 'database.sqlite'}?mode=ro", uri=True)
            try:
                self.assertEqual(db.execute("SELECT body FROM content").fetchone()[0], "preserved")
            finally:
                db.close()
            release = root / "release"
            (release / "nested").mkdir(parents=True)
            (release / "index.html").write_text("served", encoding="utf-8")
            (release / "nested/asset").write_bytes(b"asset")
            self.assertEqual(len(rehearsal_host._tree_sha256(release)), 64)

    def test_source_archive_extraction_is_bound_to_operation_and_provenance(self):
        sha_value = "a" * 40
        provenance = {"sourceSha": sha_value, "ref": "refs/heads/dev", "workflow": "Tests",
                      "workflowName": "Tests", "headBranch": "dev", "event": "push", "runId": 7,
                      "attempt": 1, "repository": "pgorbachev/ikpk", "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/7"}
        payload_buffer = io.BytesIO()
        with tarfile.open(fileobj=payload_buffer, mode="w:") as archive:
            for name, payload in (("candidate.txt", b"candidate"), ("cms/index.js", b"source CMS"),
                                  (".ikpk-rehearsal-ci.json", json.dumps(provenance).encode())):
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
        payload = payload_buffer.getvalue()
        digest = sha(payload)
        with tempfile.TemporaryDirectory(prefix="ikpk-source-admission-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            config = {"releaseRoot": str(releases), "allowedSourceRef": "refs/heads/dev",
                      "cmsUser": getpass.getuser(), "backupRoot": str(root / "backups")}
            candidate = releases / f"{sha_value}-source-op"
            self.assertEqual(rehearsal_host._extract_source_archive(config, sha_value, "source-op", payload,
                digest, provenance), candidate.resolve())
            self.assertEqual((candidate / "candidate.txt").read_bytes(), b"candidate")
            self.assertEqual(json.loads((candidate / ".ikpk-rehearsal-ci.json").read_text()), provenance)
            self.assertEqual(rehearsal_host._extract_source_archive(config, sha_value, "source-op", payload,
                digest, provenance), candidate.resolve())
            old_cms = (candidate / "cms/index.js").read_bytes()
            second = rehearsal_host._extract_source_archive(config, sha_value, "source-op-2", payload,
                digest, provenance)
            (second / "cms/index.js").write_bytes(b"second operation build output")
            self.assertEqual((candidate / "cms/index.js").read_bytes(), old_cms)
            self.assertNotEqual(second, candidate)

    def test_new_cms_command_prepares_before_journal_fence_and_backup(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-prefence-order-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            (root / "state").mkdir()
            state = RehearsalState(root / "state")
            archive = b"admitted source"
            sha_value = "a" * 40
            provenance = {"sourceSha": sha_value, "ref": "refs/heads/dev", "workflow": "Tests",
                          "workflowName": "Tests", "headBranch": "dev", "event": "push", "runId": 7,
                          "attempt": 1, "repository": "pgorbachev/ikpk", "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/7"}
            config = {"releaseRoot": str(releases), "allowedSourceRef": "refs/heads/dev",
                      "cmsUser": getpass.getuser(), "backupRoot": str(root / "backups")}
            args = Namespace(operation_id="prefence-op", source_sha=sha_value,
                             provenance_b64=base64.b64encode(json.dumps(provenance).encode()).decode(),
                             archive_sha256=sha(archive), offhost_sha256=None)
            events = []
            source_root = releases / f"{sha_value}-{args.operation_id}"
            (root / "backups").mkdir()

            def prepare(_config, candidate, operation_id, _provenance):
                events.append("prepare")
                self.assertEqual(operation_id, args.operation_id)
                self.assertFalse(state.journal_path.exists())
                self.assertFalse(state.marker_path.exists())
                return candidate / ".staging193-rehearsal" / operation_id / "migration/cms-artifact"

            def start(_config, operation_state, operation_id, source_sha):
                events.append("start")
                operation_state.begin(operation_id, source_sha, {"cmsPath": "/old/cms"})
                operation_state.confirm_fence(operation_id, lambda: True)
                return operation_state.phase(operation_id)

            def backup(_config, operation_id):
                events.append("backup")
                directory = Path(config["backupRoot"]) / operation_id
                directory.mkdir()
                (directory / "manifest.json").write_text(json.dumps({"archiveSha256": "b" * 64}), encoding="utf-8")
                return {"archiveSha256": "b" * 64}

            host_stdin = type("HostStdin", (), {"buffer": io.BytesIO(archive)})()
            with patch.object(rehearsal_host.sys, "stdin", host_stdin), \
                 patch.object(rehearsal_host, "_extract_source_archive",
                              side_effect=lambda *_args: events.append("extract") or source_root), \
                 patch.object(rehearsal_host, "_prepare_cms_candidate", side_effect=prepare), \
                 patch.object(rehearsal_host, "_start_acquisition", side_effect=start), \
                 patch.object(rehearsal_host, "_verify_fence", side_effect=lambda *_args: events.append("verify")), \
                 patch.object(rehearsal_host, "_backup", side_effect=backup):
                result = rehearsal_host._cms_update(config, state, args)

            self.assertEqual(events, ["extract", "prepare", "start", "verify", "backup"])
            self.assertTrue(result["offhostBackupRequired"])
            self.assertEqual(result["backupSha256"], "b" * 64)

    def test_offhost_followup_reuses_prepared_candidate_without_npm_or_build(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-prefence-followup-") as temporary:
            root = Path(temporary)
            state_root = root / "state"
            state_root.mkdir()
            state = RehearsalState(state_root)
            operation_id, sha_value = "prepared-op", "a" * 40
            state.begin(operation_id, sha_value, {"cmsPath": "/old/cms"})
            state.confirm_fence(operation_id, lambda: True)
            backup_root = root / "backups"
            manifest_dir = backup_root / operation_id
            manifest_dir.mkdir(parents=True)
            (manifest_dir / "manifest.json").write_text(json.dumps({"archiveSha256": "b" * 64}), encoding="utf-8")
            provenance = {"sourceSha": sha_value, "ref": "refs/heads/dev", "workflow": "Tests",
                          "workflowName": "Tests", "headBranch": "dev", "event": "push", "runId": 7,
                          "attempt": 1, "repository": "pgorbachev/ikpk", "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/7"}
            config = {"releaseRoot": str(root / "releases"), "backupRoot": str(backup_root),
                      "cmsDatabase": str(root / "live.db"), "cmsUnit": "ikpk-cms-prototype193.service",
                      "cmsHealthUrl": "http://127.0.0.1:1338/_health"}
            source_root = root / "candidate"
            args = Namespace(operation_id=operation_id, source_sha=sha_value,
                             provenance_b64=base64.b64encode(json.dumps(provenance).encode()).decode(),
                             archive_sha256=None, offhost_sha256="b" * 64)
            events = []
            host_stdin = type("HostStdin", (), {"buffer": type("NoRead", (), {
                "read": lambda *_args: self.fail("off-host follow-up must not read a new archive")})()})()
            with patch.object(rehearsal_host.sys, "stdin", host_stdin), \
                 patch.object(rehearsal_host, "_candidate_root", return_value=source_root), \
                 patch.object(rehearsal_host, "_validate_prepared_cms_candidate",
                              side_effect=lambda *_args: events.append("validate-prepared") or (source_root, source_root / "artifact", source_root / "deps/node_modules")), \
                 patch.object(rehearsal_host, "_prepare_cms_candidate",
                              side_effect=AssertionError("follow-up must not rebuild or install")), \
                 patch.object(rehearsal_host, "_start_acquisition", return_value=state.phase(operation_id)), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=AssertionError("follow-up must not run npm")), \
                 patch.object(rehearsal_host, "_verify_fence"), \
                 patch.object(rehearsal_host, "_backup_manifest", return_value={"archiveSha256": "b" * 64}), \
                 patch.object(rehearsal_host, "_install_migrated_database",
                              return_value=(root / "candidate.db", root / "artifact", "c" * 64)), \
                 patch.object(rehearsal_host, "_create_capture_bundle", return_value=root / "capture"), \
                 patch.object(rehearsal_host, "_activate_cms", return_value={"db": "accepted"}), \
                 patch.object(rehearsal_host, "_wait_health"):
                result = rehearsal_host._cms_update(config, state, args)

            self.assertEqual(events, ["validate-prepared"])
            self.assertEqual(result["phase"], "cms-activated")

    def test_static_build_uses_capture_snapshot_for_prepare_and_build(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-capture-env-") as temporary:
            source = Path(temporary) / "candidate"
            web = source / "web"
            snapshot_dir = web / ".snapshot"
            snapshot_dir.mkdir(parents=True)
            (snapshot_dir / "snapshot.json").write_text('{"snapshotId":"snap:editor-data"}', encoding="utf-8")
            (source / ".ikpk-rehearsal-ci.json").write_text(json.dumps({"sourceSha": "a" * 40}), encoding="utf-8")
            retained = Path(temporary) / "releases"
            old_public = retained / "old" / "public"
            (old_public / "_astro").mkdir(parents=True)
            (old_public / "_astro/legacy.0123456789.css").write_text("previous hash asset", encoding="utf-8")
            calls = []

            def run_build(_config, cwd, argv, **kwargs):
                calls.append((argv, kwargs.get("environment")))
                if argv[:3] == ["/usr/bin/npm", "run", "build:demo193"]:
                    dist = web / "dist-demo193"
                    dist.mkdir()
                    (dist / "index.html").write_text("candidate", encoding="utf-8")
                return ""

            with patch.object(rehearsal_host, "_validate_prepared_web_dependencies"), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=run_build):
                dist, _ = rehearsal_host._build_static({"staticReleaseRoot": str(retained),
                                                        "siteBaseUrl": "https://194.226.99.10"}, source,
                                                       Path(temporary) / "capture")
            self.assertFalse(any(argv[:2] == ["/usr/bin/npm", "ci"] for argv, _ in calls),
                             "static build must reuse web dependencies prepared before the fence")
            expected = {"CONTENT_SNAPSHOT_DIR": str(snapshot_dir), "DEMO_PROFILE": "demo193",
                        "DEPLOY_MODE": "stand", "PAYMENT_ROLE": "ci", "DEMO_FORMS": "stub",
                        "CHAT_LOADER_SRC": "none", "CHAT_OFFLINE_MESSAGE": "absent",
                        "DEMO_SITE_URL": "https://194.226.99.10"}
            snapshot_call = next(item for item in calls if "capture-content-snapshot.ts" in " ".join(item[0]))
            build_call = next(item for item in calls if item[0][:3] == ["/usr/bin/npm", "run", "build:demo193"])
            self.assertEqual(snapshot_call[1], expected)
            self.assertEqual(build_call[1], expected)
            release = json.loads((dist / "release.json").read_text(encoding="utf-8"))
            self.assertEqual(release["commit"], "a" * 40)
            self.assertEqual((dist / "_astro/legacy.0123456789.css").read_text(encoding="utf-8"),
                             "previous hash asset")

    def test_exported_candidate_contains_exact_retained_static_bytes(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-export-") as temporary:
            root = Path(temporary)
            release_root = root / "releases"
            release = release_root / f"{'a' * 40}-export-op"
            release.mkdir(parents=True)
            (release / "index.html").write_text("candidate", encoding="utf-8")
            (release / "release.json").write_text(json.dumps({"commit": "a" * 40}), encoding="utf-8")
            candidate = root / "sources" / f"{'a' * 40}-export-op"
            snapshot = candidate / "web/.snapshot/snapshot.json"
            capture = candidate / ".staging193-rehearsal/export-op/capture/manifest.json"
            snapshot.parent.mkdir(parents=True)
            capture.parent.mkdir(parents=True)
            snapshot.write_text('{"snapshotId":"snap:captured"}', encoding="utf-8")
            capture.write_text('{"operationId":"export-op"}', encoding="utf-8")

            class State:
                @staticmethod
                def phase(_operation_id):
                    return {"phase": "cms-activated", "sourceSha": "a" * 40}

            payload = rehearsal_host._export_static({"staticReleaseRoot": str(release_root),
                                                       "releaseRoot": str(root / "sources")}, State(),
                                                       "export-op", "a" * 40)
            with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
                self.assertEqual(archive.extractfile("static/index.html").read(), b"candidate")
                self.assertEqual(json.loads(archive.extractfile("static/release.json").read()), {"commit": "a" * 40})
                self.assertEqual(json.loads(archive.extractfile("snapshot/snapshot.json").read()), {"snapshotId": "snap:captured"})
                self.assertEqual(json.loads(archive.extractfile("snapshot/capture-manifest.json").read()), {"operationId": "export-op"})

    def test_post_switch_checks_old_hashed_asset_url_against_serving_origin(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-hash-check-") as temporary:
            root = Path(temporary)
            old_assets = root / "old/public/_astro"
            new_assets = root / ("new-" + "a" * 40 + "/_astro")
            old_assets.mkdir(parents=True)
            new_assets.mkdir(parents=True)
            old_pagefind = root / "old/public/pagefind/fragment"
            new_pagefind = root / ("new-" + "a" * 40 + "/pagefind/fragment")
            old_pagefind.mkdir(parents=True)
            new_pagefind.mkdir(parents=True)
            (old_assets / "old.0123456789.css").write_bytes(b"old hashed CSS")
            (new_assets / "new.abcdef0123.js").write_bytes(b"new hashed JS")
            (old_pagefind / "ru_2cf1958.pf_fragment").write_bytes(b"old Pagefind fragment")
            (new_pagefind / "ru_7a12345.pf_fragment").write_bytes(b"new Pagefind fragment")
            commands = []

            def request(argv, **_kwargs):
                commands.append(argv)
                return subprocess.CompletedProcess(argv, 0, "200", "")

            with patch.object(rehearsal_host, "run", side_effect=request):
                rehearsal_host._verify_retained_hashed_assets({"staticReleaseRoot": str(root),
                                                                 "siteBaseUrl": "https://194.226.99.10"})
            urls = {argv[-1] for argv in commands}
            self.assertIn("https://194.226.99.10/_astro/old.0123456789.css", urls)
            self.assertIn("https://194.226.99.10/_astro/new.abcdef0123.js", urls)
            self.assertIn("https://194.226.99.10/pagefind/fragment/ru_2cf1958.pf_fragment", urls)

    def test_capture_builder_invokes_existing_sealer_path(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-capture-entrypoint-") as temporary:
            root = Path(temporary)
            source = root / "candidate"
            (source / "scripts/lib").mkdir(parents=True)
            (source / "web").mkdir()
            (source / "cms/src").mkdir(parents=True)
            sealer = source / "scripts/lib/seal-staging193-capture.mjs"
            sealer.write_bytes((ROOT / "scripts/lib/seal-staging193-capture.mjs").read_bytes())
            database = root / "candidate.sqlite"
            db = sqlite3.connect(database)
            db.execute("CREATE TABLE empty (value TEXT)")
            db.commit()
            db.close()
            uploads = root / "uploads"
            uploads.mkdir()
            static_media = root / "static-media"
            static_media.mkdir()
            (uploads / "photo.jpg").write_bytes(b"upload bytes")
            (static_media / "legacy.jpg").write_bytes(b"static media bytes")
            capture_root = source / ".staging193-rehearsal" / "capture-op"
            config = {"cmsUser": getpass.getuser(), "mediaRoots": [
                {"path": str(uploads), "prefix": "/uploads/"},
                {"path": str(static_media), "prefix": "/media/"},
            ]}
            captured = {}

            def run_sealer(_config, cwd, argv, **_kwargs):
                captured["cwd"] = cwd
                captured["argv"] = argv
                self.assertTrue(Path(argv[1]).is_file())
                return ""

            with patch.object(rehearsal_host, "_run_as_cms", side_effect=run_sealer):
                result = rehearsal_host._create_capture_bundle(config, "capture-op", "a" * 40, source, database)
            self.assertEqual(result, capture_root / "capture")
            self.assertEqual(Path(captured["argv"][1]), sealer)
            self.assertEqual(Path(captured["argv"][1]).name, "seal-staging193-capture.mjs")
            media_rows = json.loads((result / "media-manifest.json").read_text(encoding="utf-8"))["media"]
            self.assertEqual({row["url"].split("/", 2)[1] for row in media_rows}, {"uploads", "media"})

    def test_recovery_restores_uploads_by_bytes_and_static_media_by_old_pointer_only(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-static-media-recovery-") as temporary:
            root = Path(temporary)
            state_root = root / "state"
            state_root.mkdir()
            state = rehearsal_host.RehearsalState(state_root)
            operation_id = "static-media-recovery"
            source_sha = "a" * 40
            backup_root = root / "backups"
            backup_root.mkdir()
            cms_releases = root / "cms-releases"
            old_cms = cms_releases / "old"
            candidate_cms = cms_releases / "candidate"
            old_cms.mkdir(parents=True)
            candidate_cms.mkdir()
            current_cms = root / "current-cms"
            current_cms.symlink_to(candidate_cms)
            static_releases = root / "static-releases"
            old_static = static_releases / "old"
            candidate_static = static_releases / "candidate"
            (old_static / "media").mkdir(parents=True)
            (candidate_static / "media").mkdir(parents=True)
            (old_static / "media/legacy.jpg").write_bytes(b"old static media")
            (candidate_static / "media/legacy.jpg").write_bytes(b"candidate static media")
            current_static = root / "current-static"
            current_static.symlink_to(old_static)
            uploads = root / "uploads"
            uploads.mkdir()
            (uploads / "editor.jpg").write_bytes(b"old upload")
            live_database = root / "live.sqlite"

            def write_db(path: Path, value: str) -> None:
                existed = path.exists()
                db = sqlite3.connect(path)
                if existed:
                    db.execute("UPDATE content SET body=?", (value,))
                else:
                    db.execute("CREATE TABLE content (body TEXT NOT NULL)")
                    db.execute("INSERT INTO content VALUES (?)", (value,))
                db.commit()
                db.close()

            write_db(live_database, "old database")
            config = {"stateDir": str(state_root), "backupRoot": str(backup_root),
                      "cmsDatabase": str(live_database), "cmsUnit": "ikpk-cms-test.service",
                      "writerUnits": ["ikpk-cms-test.service"], "cmsHealthUrl": "http://127.0.0.1/health",
                      "siteHealthUrl": "https://127.0.0.1/", "currentCms": str(current_cms),
                      "releaseRoot": str(cms_releases), "currentStatic": str(current_static),
                      "staticReleaseRoot": str(static_releases),
                      "mediaRoots": [{"path": str(uploads), "prefix": "/uploads/"},
                                     {"path": str(current_static / "media"), "prefix": "/media/"}]}
            old_pair = {"cmsPath": str(old_cms.resolve()), "staticPath": str(old_static.resolve()),
                        "staticTreeSha256": rehearsal_host._tree_sha256(old_static)}
            state.begin(operation_id, source_sha, old_pair)
            with patch.object(rehearsal_host, "_assert_no_database_handles"):
                manifest = rehearsal_host._backup(config, operation_id)
            backup_dir = backup_root / operation_id
            offhost = backup_dir / "offhost-backup"
            shutil.copytree(backup_dir, offhost, ignore=shutil.ignore_patterns("offhost-backup"))
            (uploads / "editor.jpg").write_bytes(b"candidate upload")
            write_db(live_database, "candidate database")
            current_static.unlink()
            current_static.symlink_to(candidate_static)
            candidate_media_before = (candidate_static / "media/legacy.jpg").read_bytes()
            active = {"started": False}

            def systemctl(argv, **_kwargs):
                if len(argv) > 1 and argv[1] == "start":
                    active["started"] = True
                if len(argv) > 1 and argv[1] == "is-active":
                    return subprocess.CompletedProcess(argv, 0 if active["started"] else 3, "", "")
                return subprocess.CompletedProcess(argv, 0, "", "")

            with patch.object(rehearsal_host, "_set_flag"), \
                 patch.object(rehearsal_host, "_write_gate"), \
                 patch.object(rehearsal_host, "_verify_fence"), \
                 patch.object(rehearsal_host, "_stop_writers"), \
                 patch.object(rehearsal_host, "_assert_no_database_handles"), \
                 patch.object(rehearsal_host, "_wait_health"), \
                 patch.object(rehearsal_host, "_service_pid", return_value=123), \
                 patch.object(rehearsal_host, "_database_process_proof", return_value={}), \
                 patch.object(rehearsal_host, "run", side_effect=systemctl):
                result = rehearsal_host._recover(config, state, operation_id)

            self.assertEqual(result["phase"], "recovered")
            self.assertEqual(current_static.resolve(), old_static.resolve())
            self.assertEqual(current_cms.resolve(), old_cms.resolve())
            self.assertEqual((candidate_static / "media/legacy.jpg").read_bytes(), candidate_media_before)
            self.assertEqual((old_static / "media/legacy.jpg").read_bytes(), b"old static media")
            self.assertEqual((uploads / "editor.jpg").read_bytes(), b"old upload")
            db = sqlite3.connect(f"file:{live_database}?mode=ro", uri=True)
            try:
                self.assertEqual(db.execute("SELECT body FROM content").fetchone()[0], "old database")
            finally:
                db.close()
            self.assertEqual({row["url"].split("/", 2)[1] for row in manifest["media"]}, {"uploads", "media"})

    def test_bad_static_media_backup_entry_is_rejected_before_upload_restore(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-bad-static-media-") as temporary:
            root = Path(temporary)
            uploads = root / "uploads"
            uploads.mkdir()
            (uploads / "keep.jpg").write_bytes(b"current uploads")
            backup = root / "backup"
            backup.mkdir()
            (backup / "media/sha256:bad").parent.mkdir(parents=True)
            (backup / "media/sha256:bad").write_bytes(b"bad digest")
            config = {"mediaRoots": [{"path": str(uploads), "prefix": "/uploads/"},
                                     {"path": str(root / "unavailable-current-media"), "prefix": "/media/"}]}
            valid_bytes = b"legacy media captured in backup"
            valid_file = backup / "media/sha256:valid"
            valid_file.write_bytes(valid_bytes)
            valid_entry = {"url": "/media/legacy.jpg", "originalName": "legacy.jpg",
                           "file": "media/sha256:valid", "sha256": sha(valid_bytes),
                           "mode": 0o640, "uid": 987, "gid": 987}
            # A recovery with a missing current media tree still succeeds: /media is
            # restored by selecting the old static release, never by writing this path.
            rehearsal_host._restore_media(config, backup, {"media": [valid_entry]})
            self.assertFalse((root / "unavailable-current-media").exists())
            self.assertFalse(list(uploads.iterdir()))

            invalid_cases = [
                ("digest", {**valid_entry, "file": "media/sha256:bad", "sha256": "0" * 64},
                 "media bytes failed digest"),
                ("url-mismatch", {**valid_entry, "originalName": "different.jpg"},
                 "does not match configured URL roots"),
                ("unsafe-path", {**valid_entry, "url": "/media/../escape.jpg",
                                  "originalName": "../escape.jpg"}, "media path is unsafe"),
            ]
            for label, entry, message in invalid_cases:
                with self.subTest(case=label):
                    (uploads / "keep.jpg").write_bytes(b"current uploads")
                    with self.assertRaisesRegex(rehearsal_host.HostFailure, message):
                        rehearsal_host._restore_media(config, backup, {"media": [entry]})
                    self.assertEqual((uploads / "keep.jpg").read_bytes(), b"current uploads")

    def test_imported_offhost_backup_is_bound_to_server_archive_digest(self):
        operation_id = "operator-test"
        archive_bytes = backup_archive(operation_id)
        digest = sha(archive_bytes)
        with tempfile.TemporaryDirectory(prefix="ikpk-offhost-import-") as temporary:
            root = Path(temporary)
            server_backup = root / operation_id
            server_backup.mkdir()
            (server_backup / "manifest.json").write_text(json.dumps({
                "operationId": operation_id, "archiveSha256": digest,
            }))
            (server_backup / "backup.tar").write_bytes(b"corrupt server-side copy")
            config = {"backupRoot": str(root)}
            offhost = rehearsal_host._import_offhost_backup(config, operation_id, archive_bytes, digest)
            manifest = rehearsal_host._backup_manifest({"backupRoot": str(root)}, operation_id, offhost)
            self.assertEqual(manifest["archiveSha256"], digest)
            self.assertEqual(manifest["operationId"], operation_id)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "exact server-captured backup"):
                rehearsal_host._import_offhost_backup(config, operation_id, archive_bytes, "0" * 64)

    def test_nginx_validation_failure_restores_both_previous_gate_files(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-nginx-gate-") as temporary:
            root = Path(temporary)
            map_file = root / "writer-map.conf"
            server_file = root / "writer-server.conf"
            map_file.write_text("previous map\n")
            server_file.write_text("previous server gate\n")
            active = f"{map_file}\n{server_file}\nikpk_rehearsal_write_block"
            calls = [
                __import__("subprocess").CompletedProcess(["nginx", "-T"], 0, active, ""),
                rehearsal_host.HostFailure("simulated nginx -t rejection"),
                __import__("subprocess").CompletedProcess(["nginx", "-t"], 1, "", "old config checked"),
            ]
            config = {"writerPrefixes": ["/admin"], "preservePrefixes": ["/api/payments/status"],
                      "nginxMapFile": str(map_file), "nginxServerGateFile": str(server_file),
                      "nginxBinary": "nginx", "nginxService": "nginx.service"}
            with patch.object(rehearsal_host, "run", side_effect=calls):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "simulated nginx -t rejection"):
                    rehearsal_host._write_gate(config, True)
            self.assertEqual(map_file.read_text(), "previous map\n")
            self.assertEqual(server_file.read_text(), "previous server gate\n")

    def test_writer_fence_keeps_disabled_payment_status_route_at_404(self):
        commands = []
        def probe(argv, **_kwargs):
            commands.append(argv)
            if argv[-1] == "https://194.226.99.10/api/payments/rehearsal/status":
                return subprocess.CompletedProcess(argv, 0, "404", "")
            if argv[-1] == "https://194.226.99.10/":
                return subprocess.CompletedProcess(argv, 0, "200", "")
            return subprocess.CompletedProcess(argv, 0, "503", "")
        config = {"writerProbeUrls": ["https://194.226.99.10/api"],
                  "preserveProbeUrl": "https://194.226.99.10/",
                  "paymentStatusProbeUrl": "https://194.226.99.10/api/payments/rehearsal/status"}
        with patch.object(rehearsal_host, "run", side_effect=probe):
            rehearsal_host._verify_fence(config)
        self.assertTrue(any("--request" in argv for argv in commands))
        self.assertIn(config["paymentStatusProbeUrl"], [argv[-1] for argv in commands])

    def test_database_replacement_removes_stale_wal_and_shm_and_keeps_mode(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-db-replace-") as temporary:
            root = Path(temporary)
            source = root / "candidate.db"
            destination = root / "live.db"
            for path, value in ((source, "candidate"), (destination, "old")):
                db = sqlite3.connect(path)
                db.execute("CREATE TABLE state(value TEXT)")
                db.execute("INSERT INTO state VALUES (?)", (value,))
                db.commit()
                db.close()
            destination.chmod(0o640)
            Path(str(destination) + "-wal").write_bytes(b"stale WAL")
            Path(str(destination) + "-shm").write_bytes(b"stale SHM")
            _copy_atomic(source, destination)
            self.assertEqual(destination.stat().st_mode & 0o777, 0o640)
            self.assertFalse(Path(str(destination) + "-wal").exists())
            self.assertFalse(Path(str(destination) + "-shm").exists())
            db = sqlite3.connect(f"file:{destination}?mode=ro", uri=True)
            try:
                self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(db.execute("SELECT value FROM state").fetchone()[0], "candidate")
            finally:
                db.close()

    def test_release_pointer_switch_is_atomic_and_stays_inside_retained_root(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-pointer-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            old = releases / "old"
            new = releases / "new"
            old.mkdir()
            new.mkdir()
            pointer = root / "current"
            pointer.symlink_to(old)
            _switch_pointer(pointer, new, releases)
            self.assertEqual(pointer.resolve(), new.resolve())
            outside = root / "outside"
            outside.mkdir()
            with self.assertRaisesRegex(Exception, "escapes configured root"):
                _switch_pointer(pointer, outside, releases)
            self.assertEqual(pointer.resolve(), new.resolve())

    def test_offhost_backup_verifies_actual_database_and_media_member_digests(self):
        archive = backup_archive()
        operator.verify_backup_tar(archive, sha(archive))
        with tempfile.TemporaryDirectory(prefix="ikpk-offhost-copy-") as temporary:
            target = operator.persist_offhost_backup(Path(temporary), "operator-test", "a" * 40,
                                                       archive, sha(archive))
            self.assertEqual(target.read_bytes(), archive)
        with self.assertRaisesRegex(operator.Refusal, "digest"):
            operator.verify_backup_tar(archive + b"tampered", sha(archive))


if __name__ == "__main__":
    unittest.main()
