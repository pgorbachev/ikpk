import base64
import getpass
import hashlib
import io
import json
import os
import sqlite3
import stat
import tarfile
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host


def sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def provenance(source_sha: str, *, include_strapi: bool = True) -> dict:
    result = {
        "sourceSha": source_sha, "ref": "refs/heads/main", "workflow": "Tests",
        "workflowName": "Tests", "headBranch": "main", "event": "push", "runId": 7,
        "attempt": 1, "repository": "pgorbachev/ikpk", "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/7",
        "status": "completed", "conclusion": "success",
        "requiredJobs": sorted(rehearsal_host.STATIC_MAIN_REQUIRED_JOBS),
        "additionalWorkflows": [{
            "workflow": workflow, "headSha": source_sha, "event": "push", "headBranch": "main",
            "status": "completed", "conclusion": "success", "runId": 10 + index, "attempt": 1,
            "runUrl": f"https://github.com/pgorbachev/ikpk/actions/runs/{10 + index}",
            "requiredJobs": ["required job"],
        } for index, workflow in enumerate(rehearsal_host.STATIC_MAIN_ADDITIONAL_WORKFLOWS)],
    }
    members = {
        "package.json": b'{"dependencies":{"@strapi/strapi":"5.51.2"}}',
        "package-lock.json": b'{"lockfileVersion":3,"packages":{"node_modules/@strapi/strapi":{"version":"5.51.2"}}}',
        "tsconfig.json": b'{}', "dist/config/database.js": b"original config",
        "database/.migrations-expected": b"v1", "scripts/run-data-migrations.mjs": b"migration runner",
    }
    payload_io = io.BytesIO()
    with tarfile.open(fileobj=payload_io, mode="w:gz") as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        if include_strapi:
            directory = tarfile.TarInfo(".strapi")
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o755
            archive.addfile(directory)
    payload = payload_io.getvalue()
    result["cmsArtifact"] = {"artifactId": 99, "runId": 7, "attempt": 1,
                              "archiveSha256": "c" * 64, "payloadSha256": sha(payload)}
    return result, payload, members


def prepared_artifact(root: Path, operation_id: str = "artifact-op", *,
                      include_strapi: bool = True) -> dict:
    root = root.resolve()
    source_sha = "a" * 40
    admitted, payload, members = provenance(source_sha, include_strapi=include_strapi)
    source = root / f"{source_sha}-{operation_id}"
    cms = source / "cms"
    cms.mkdir(parents=True)
    (source / ".ikpk-rehearsal-ci.json").write_text(json.dumps(admitted), encoding="utf-8")
    (source / ".ikpk-cms-artifact.tar.gz").write_bytes(payload)
    lock_bytes = members["package-lock.json"]
    (cms / "package.json").write_bytes(members["package.json"])
    (cms / "package-lock.json").write_bytes(lock_bytes)

    dependencies = root / "generation/node_modules"
    strapi = dependencies / "@strapi/strapi"
    strapi.mkdir(parents=True)
    (strapi / "package.json").write_text('{"version":"5.51.2"}', encoding="utf-8")
    (cms / "node_modules").symlink_to(dependencies, target_is_directory=True)

    artifact = rehearsal_host._extract_ci_cms_artifact(
        {"cmsUser": getpass.getuser()}, source, operation_id, admitted["cmsArtifact"])
    (artifact / "node_modules").symlink_to(dependencies, target_is_directory=True)
    web_dependencies = source / "web/node_modules"
    for package in ("astro", "tsx"):
        package_dir = web_dependencies / package
        package_dir.mkdir(parents=True)
        (package_dir / "package.json").write_text("{}", encoding="utf-8")
        (package_dir / "bin.js").write_text("", encoding="utf-8")
    bin_dir = web_dependencies / ".bin"
    bin_dir.mkdir()
    for package in ("astro", "tsx"):
        (bin_dir / package).symlink_to(f"../{package}/bin.js")
    config = {"profile": "staging194", "allowedSourceRef": "refs/heads/main",
              "cmsUser": getpass.getuser(), "releaseRoot": str(root / "releases"),
              "backupRoot": str(root / "backups")}
    expected_generation = {"lockSha256": sha(lock_bytes), "profile": "full-build",
                           "nodeVersion": "v24.1.0", "nodeAbi": "137",
                           "platform": "linux", "architecture": "x64"}
    return {"sourceSha": source_sha, "operationId": operation_id, "source": source,
            "artifact": artifact, "dependencies": dependencies, "config": config,
            "provenance": admitted, "evidence": admitted["cmsArtifact"],
            "expectedGeneration": expected_generation}


def artifact_validation_patches(f):
    return (
        patch.object(rehearsal_host, "_cms_build_generation",
                     return_value=(f["source"].parent / "generation", f["expectedGeneration"])),
        patch.object(rehearsal_host, "_validate_cms_build_generation",
                     return_value=f["dependencies"].resolve()),
    )


class CmsArtifactHostConsumerTests(unittest.TestCase):
    def test_corrupt_artifact_is_refused_before_migration_runner(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-host-artifact-before-migration-") as temporary:
            root = Path(temporary)
            f = prepared_artifact(root)
            (f["artifact"] / "dist/config/database.js").write_bytes(b"corrupt after CI admission")
            live = root / "live.sqlite"
            db = sqlite3.connect(live)
            db.execute("CREATE TABLE content (body TEXT)")
            db.commit()
            db.close()
            config = {**f["config"], "cmsDatabase": str(live)}
            with artifact_validation_patches(f)[0], artifact_validation_patches(f)[1], \
                 patch.object(rehearsal_host, "_run_as_cms") as runner:
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "artifact bytes differ"):
                    rehearsal_host._install_migrated_database(config, f["source"], f["operationId"], root / "old-cms")
            runner.assert_not_called()
            operation_root = f["artifact"].parent
            self.assertFalse((operation_root / "candidate.db").exists())
            self.assertFalse((operation_root / "receipt.json").exists())

    def test_retry_after_journal_start_refuses_corrupt_artifact_before_fencing_or_migration(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-host-artifact-retry-") as temporary:
            root = Path(temporary)
            f = prepared_artifact(root, "retry-op")
            (f["artifact"] / "dist/config/database.js").write_bytes(b"corrupt after journal start")
            start = {"record": "start", "cmsArtifact": f["evidence"],
                     "oldPair": {"cmsPath": str(root / "old-cms")}}

            class State:
                def phase(self, _operation_id):
                    return {"phase": "acquiring", "sourceSha": f["sourceSha"]}
                def _operation_rows(self, _operation_id): return [start]

            args = Namespace(operation_id=f["operationId"], source_sha=f["sourceSha"],
                             provenance_b64=base64.b64encode(json.dumps(f["provenance"]).encode()).decode(),
                             archive_sha256=None, offhost_sha256="b" * 64)
            with artifact_validation_patches(f)[0], artifact_validation_patches(f)[1], \
                 patch.object(rehearsal_host, "_candidate_root", return_value=f["source"]), \
                 patch.object(rehearsal_host, "_start_acquisition") as fence, \
                 patch.object(rehearsal_host, "_install_migrated_database") as migrate, \
                 patch.object(rehearsal_host, "_backup_manifest") as backup:
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "artifact bytes differ"):
                    rehearsal_host._cms_update(f["config"], State(), args)
            fence.assert_not_called()
            migrate.assert_not_called()
            backup.assert_not_called()

    def test_artifact_corrupted_during_migration_is_refused_before_activation(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-host-artifact-before-activation-") as temporary:
            root = Path(temporary)
            f = prepared_artifact(root, "activate-op")
            backup_dir = Path(f["config"]["backupRoot"]) / f["operationId"]
            backup_dir.mkdir(parents=True)
            (backup_dir / "manifest.json").write_text("{}", encoding="utf-8")
            start = {"record": "start", "cmsArtifact": f["evidence"],
                     "oldPair": {"cmsPath": str(root / "old-cms")}}

            class State:
                def phase(self, _operation_id):
                    return {"phase": "fenced", "sourceSha": f["sourceSha"]}
                def _operation_rows(self, _operation_id): return [start]

            args = Namespace(operation_id=f["operationId"], source_sha=f["sourceSha"],
                             provenance_b64=base64.b64encode(json.dumps(f["provenance"]).encode()).decode(),
                             archive_sha256=None, offhost_sha256="e" * 64)

            def corrupt_after_migration(*_args):
                (f["artifact"] / "dist/config/database.js").write_bytes(b"changed during migration")
                return root / "candidate.db", f["artifact"], "f" * 64

            with artifact_validation_patches(f)[0], artifact_validation_patches(f)[1], \
                 patch.object(rehearsal_host, "_candidate_root", return_value=f["source"]), \
                 patch.object(rehearsal_host, "_start_acquisition", return_value={"phase": "fenced"}), \
                 patch.object(rehearsal_host, "_backup_manifest", return_value={"archiveSha256": "e" * 64}), \
                 patch.object(rehearsal_host, "_install_migrated_database", side_effect=corrupt_after_migration), \
                 patch.object(rehearsal_host, "_create_capture_bundle", return_value=root / "capture"), \
                 patch.object(rehearsal_host, "_activate_cms") as activate:
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "artifact bytes differ"):
                    rehearsal_host._cms_update(f["config"], State(), args)
                activate.assert_not_called()

    def test_missing_strapi_directory_is_refused_before_live_database_replacement(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-missing-strapi-") as temporary:
            root = Path(temporary).resolve()
            operation_id = "strapi-op"
            source_sha = "a" * 40
            admitted, payload, members = provenance(source_sha, include_strapi=False)
            source = root / f"{source_sha}-{operation_id}"
            source.mkdir()
            (source / ".ikpk-rehearsal-ci.json").write_text(json.dumps(admitted), encoding="utf-8")
            (source / ".ikpk-cms-artifact.tar.gz").write_bytes(payload)
            artifact = source / ".staging193-rehearsal" / operation_id / "migration" / "cms-artifact"
            for name, data in members.items():
                target = artifact / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            live = root / "data.db"
            live.write_bytes(b"live-database")
            candidate = root / "candidate.db"
            candidate.write_bytes(b"replacement-database")
            current = root / "current"
            (root / "releases").mkdir()
            config = {"profile": "production-paired", "cmsUser": getpass.getuser(),
                      "cmsDatabase": str(live), "currentCms": str(current),
                      "releaseRoot": str(root / "releases")}
            with self.assertRaisesRegex(rehearsal_host.HostFailure, r"\.strapi"):
                rehearsal_host._activate_cms(
                    config, artifact, candidate, root / "capture", source, source_sha,
                    cms_artifact=admitted["cmsArtifact"])
            self.assertEqual(live.read_bytes(), b"live-database")
            self.assertFalse(current.exists() or current.is_symlink())

    def test_unpacked_strapi_directory_is_writable_by_the_cms_user(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-strapi-permissions-") as temporary:
            f = prepared_artifact(Path(temporary), "strapi-mode")
            cache = f["artifact"] / ".strapi"
            info = cache.lstat()
            self.assertTrue(stat.S_ISDIR(info.st_mode))
            self.assertFalse(cache.is_symlink())
            self.assertEqual(info.st_uid, os.getuid())
            self.assertEqual(info.st_gid, os.getgid())
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o755)
            probe = cache / "cache-probe"
            probe.write_text("writable", encoding="utf-8")
            self.assertEqual(probe.read_text(encoding="utf-8"), "writable")
