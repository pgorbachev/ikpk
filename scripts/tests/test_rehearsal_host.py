import hashlib
import importlib.util
import io
import json
import sqlite3
import tarfile
import tempfile
import unittest
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
            (server_backup / "backup.tar").write_bytes(archive_bytes)
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
