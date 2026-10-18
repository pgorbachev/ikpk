import hashlib
import base64
import getpass
import importlib.util
import io
import json
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host
from scripts.lib.rehearsal_host import _copy_atomic, _switch_pointer


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
            (uploads / "photo.jpg").write_bytes(b"photo")
            (root / "backups").mkdir()
            config = {"cmsDatabase": str(database), "backupRoot": str(root / "backups"),
                      "mediaRoots": [{"path": str(uploads), "prefix": "/uploads/"}]}
            # /proc handle inspection is Linux-specific; exercise the real SQLite backup,
            # media walk, lstat checks, tar creation and digest verification on this host.
            with patch.object(rehearsal_host, "_assert_no_database_handles"):
                manifest = rehearsal_host._backup(config, "lstat-op")
            backup_dir = root / "backups/lstat-op"
            self.assertEqual(sha((backup_dir / "backup.tar").read_bytes()), manifest["archiveSha256"])
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

    def test_archive_sha256_length_reaches_real_extraction_and_retry_marker(self):
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
            operation_backup = Path(config["backupRoot"]) / "source-op"
            operation_backup.mkdir(parents=True)
            (operation_backup / "manifest.json").write_text("{}", encoding="utf-8")
            args = Namespace(operation_id="source-op", source_sha=sha_value,
                             provenance_b64=base64.b64encode(json.dumps(provenance).encode()).decode(),
                             offhost_sha256="b" * 64, archive_sha256=digest)

            class Phase:
                @staticmethod
                def phase(_operation_id):
                    return {"phase": "acquiring", "sourceSha": sha_value}

            with patch.object(rehearsal_host, "_start_acquisition", return_value={"phase": "acquiring"}), \
                 patch.object(rehearsal_host, "_backup_manifest", return_value={"archiveSha256": "b" * 64}), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=rehearsal_host.HostFailure("stop after extract")), \
                 patch.object(rehearsal_host, "sys") as host_sys:
                host_sys.stdin.buffer.read.return_value = payload
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "stop after extract"):
                    rehearsal_host._cms_update(config, Phase(), args)
            candidate = releases / f"{sha_value}-source-op"
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
            bad_args = Namespace(**{**vars(args), "archive_sha256": digest[:40]})
            with patch.object(rehearsal_host, "_start_acquisition", return_value={"phase": "acquiring"}), \
                 patch.object(rehearsal_host, "_backup_manifest", return_value={"archiveSha256": "b" * 64}), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=AssertionError("must reject before install")), \
                 patch.object(rehearsal_host, "sys") as host_sys:
                host_sys.stdin.buffer.read.return_value = payload
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "source archive SHA-256"):
                    rehearsal_host._cms_update(config, Phase(), bad_args)

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

            with patch.object(rehearsal_host, "_run_as_cms", side_effect=run_build):
                dist, _ = rehearsal_host._build_static({"staticReleaseRoot": str(retained)}, source,
                                                       Path(temporary) / "capture")
            expected = {"CONTENT_SNAPSHOT_DIR": str(snapshot_dir), "DEMO_PROFILE": "demo193",
                        "DEPLOY_MODE": "stand", "PAYMENT_ROLE": "ci", "DEMO_FORMS": "stub",
                        "CHAT_LOADER_SRC": "none", "CHAT_OFFLINE_MESSAGE": "absent",
                        "DEMO_SITE_URL": "https://193.124.115.99"}
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

            class State:
                @staticmethod
                def phase(_operation_id):
                    return {"phase": "cms-activated", "sourceSha": "a" * 40}

            payload = rehearsal_host._export_static({"staticReleaseRoot": str(release_root)}, State(),
                                                       "export-op", "a" * 40)
            with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
                self.assertEqual(archive.extractfile("index.html").read(), b"candidate")
                self.assertEqual(json.loads(archive.extractfile("release.json").read()), {"commit": "a" * 40})

    def test_post_switch_checks_old_hashed_asset_url_against_serving_origin(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-hash-check-") as temporary:
            root = Path(temporary)
            old_assets = root / "old/public/_astro"
            new_assets = root / ("new-" + "a" * 40 + "/_astro")
            old_assets.mkdir(parents=True)
            new_assets.mkdir(parents=True)
            (old_assets / "old.0123456789.css").write_bytes(b"old hashed CSS")
            (new_assets / "new.abcdef0123.js").write_bytes(b"new hashed JS")
            commands = []

            def request(argv, **_kwargs):
                commands.append(argv)
                return subprocess.CompletedProcess(argv, 0, "200", "")

            with patch.object(rehearsal_host, "run", side_effect=request):
                rehearsal_host._verify_retained_hashed_assets({"staticReleaseRoot": str(root),
                                                                 "siteBaseUrl": "https://staging.ikpk.su"})
            urls = {argv[-1] for argv in commands}
            self.assertIn("https://staging.ikpk.su/_astro/old.0123456789.css", urls)
            self.assertIn("https://staging.ikpk.su/_astro/new.abcdef0123.js", urls)

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
            capture_root = source / ".staging193-rehearsal" / "capture-op"
            config = {"cmsUser": getpass.getuser(), "mediaRoots": [{"path": str(uploads), "prefix": "/uploads/"}]}
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
