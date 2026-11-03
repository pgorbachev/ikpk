import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.lib import rehearsal_host
from scripts.rehearsal import staging193 as operator


class ProductionStaticSpacePreflightTest(unittest.TestCase):
    def _fixture(self, root: Path, *, profile: str = "production-static") -> dict:
        old_static = root / "www/releases/old"
        old_static.mkdir(parents=True)
        (old_static / "index.html").write_bytes(b"small")
        current_static = root / "www/current"
        current_static.symlink_to(old_static, target_is_directory=True)
        cms_release = root / "cms/releases/old"
        cms_release.mkdir(parents=True)
        current_cms = root / "cms/current"
        current_cms.symlink_to(cms_release, target_is_directory=True)
        database = root / "var/lib/cms/data.db"
        database.parent.mkdir(parents=True)
        database.write_bytes(b"d" * (1024 * 1024))
        Path(str(database) + "-wal").write_bytes(b"w" * (256 * 1024))
        uploads = root / "cms/shared/uploads"
        uploads.mkdir(parents=True)
        (uploads / "photo.bin").write_bytes(b"u" * (2 * 1024 * 1024))
        site_media = root / "www/current-media"
        site_media.mkdir(parents=True)
        (site_media / "asset.bin").write_bytes(b"m" * (512 * 1024))
        return {
            "profile": profile,
            **({"temporaryRoot": str(root / "tmp")} if profile == "staging194" else {}),
            "currentCms": str(current_cms),
            "currentStatic": str(current_static),
            "releaseRoot": str(root / "source-releases"),
            "staticReleaseRoot": str(root / "www/releases"),
            "stateDir": str(root / "state"),
            "backupRoot": str(root / "backups"),
            "cmsUser": "cms",
            "cmsDatabase": str(database),
            "mediaRoots": [
                {"path": str(uploads), "prefix": "/uploads/"},
                {"path": str(site_media), "prefix": "/media/"},
            ],
            "spaceReserveBytes": 0,
        }

    def test_capture_bytes_are_charged_to_actual_source_release_filesystem(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-space-test-") as temporary:
            root = Path(temporary)
            config = self._fixture(root)
            source_root = Path(config["releaseRoot"])
            source_root.mkdir()
            real_stat = Path.stat
            synthetic_source_device = root.stat().st_dev + 1

            class DeviceStat:
                def __init__(self, result):
                    self._result = result

                def __getattr__(self, name):
                    if name == "st_dev":
                        return synthetic_source_device
                    return getattr(self._result, name)

            def stat_with_separate_source_device(path, *args, **kwargs):
                result = real_stat(path, *args, **kwargs)
                return DeviceStat(result) if path == source_root else result

            # The host has no writable second filesystem. Give just the configured
            # source-root path a distinct device identity to exercise real grouping.
            with patch.object(Path, "stat", new=stat_with_separate_source_device):
                report = rehearsal_host._space_preflight(config, "space-test", "static-main")
            filesystems = report["filesystems"]
            source_fs = next(item for item in filesystems if "static source releases" in item["labels"])
            other_fs = next(item for item in filesystems if "temporary data" in item["labels"])
            db = Path(config["cmsDatabase"])
            input_bytes = (db.stat().st_size + Path(str(db) + "-wal").stat().st_size
                           + rehearsal_host._filesystem_bytes(Path(config["mediaRoots"][0]["path"]), required=True)
                           + rehearsal_host._filesystem_bytes(Path(config["mediaRoots"][1]["path"]), required=True))
            self.assertGreaterEqual(source_fs["estimatedBytes"], input_bytes)
            self.assertGreaterEqual(report["staticCaptureBytes"], input_bytes)
            static_bytes = rehearsal_host._filesystem_bytes(
                rehearsal_host._current_target(Path(config["currentStatic"])), required=True)
            self.assertEqual(report["staticExportEstimateBytes"], static_bytes)
            self.assertNotIn("static source releases", other_fs["labels"])
            self.assertNotEqual(source_fs, other_fs)
            self.assertEqual(report["backupBytes"], 0)

    def test_production_static_fails_closed_for_unsafe_media_tree(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-space-unsafe-") as temporary:
            root = Path(temporary)
            config = self._fixture(root)
            unsafe = Path(config["mediaRoots"][0]["path"]) / "escape"
            unsafe.symlink_to(Path(config["mediaRoots"][1]["path"]), target_is_directory=True)
            with self.assertRaises(rehearsal_host.HostFailure):
                rehearsal_host._space_preflight(config, "space-unsafe", "static-main")

    def test_production_paired_pre_release_gate_requires_capture_space_on_source_device(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-paired-static-space-") as temporary:
            root = Path(temporary)
            config = self._fixture(root, profile="production-paired")
            source_root = Path(config["releaseRoot"])
            source_root.mkdir()
            real_stat = Path.stat
            synthetic_source_device = root.stat().st_dev + 1
            mocked_free = 1_073_741_824 + 4 * 1024 * 1024

            class DeviceStat:
                def __init__(self, result):
                    self._result = result

                def __getattr__(self, name):
                    if name == "st_dev":
                        return synthetic_source_device
                    return getattr(self._result, name)

            def stat_with_separate_source_device(path, *args, **kwargs):
                result = real_stat(path, *args, **kwargs)
                return DeviceStat(result) if path == source_root else result

            def disk_usage(path):
                free = mocked_free if Path(path) == source_root else 1 << 50
                return SimpleNamespace(total=2 * free, used=free, free=free)

            with patch.object(Path, "stat", new=stat_with_separate_source_device), \
                    patch.object(rehearsal_host.shutil, "disk_usage", side_effect=disk_usage), \
                    patch.object(rehearsal_host, "_installed_paired_cms_source_sha", return_value=None):
                report = rehearsal_host._space_preflight(config, "paired-space", "static-main")

            source_fs = next(item for item in report["filesystems"]
                             if "static source releases" in item["labels"])
            db = Path(config["cmsDatabase"])
            capture_inputs = (db.stat().st_size + Path(str(db) + "-wal").stat().st_size
                              + sum(rehearsal_host._required_static_capture_tree_bytes(Path(item["path"]))
                                    for item in config["mediaRoots"]))

            # This is the exact operator target-space gate run before CI/Release
            # admission. A paired profile with insufficient capture space must stop.
            with patch.object(operator, "ssh_remote", return_value=json.dumps(report).encode()) as remote:
                with self.assertRaises(operator.Refusal):
                    operator._check_target_space("production-paired", "paired-space", "static-main")
            self.assertIn("--space-preflight", remote.call_args.args[0])
            self.assertGreaterEqual(source_fs["estimatedBytes"], capture_inputs)
            self.assertGreaterEqual(report["staticCaptureBytes"], capture_inputs)
            self.assertGreater(source_fs["requiredBytes"], source_fs["freeBytes"])
            self.assertEqual(report["backupBytes"], 0)

    def test_staging194_static_main_does_not_require_production_capture_inputs(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-space-194-") as temporary:
            root = Path(temporary)
            config = self._fixture(root, profile="staging194")
            del config["cmsDatabase"]
            del config["mediaRoots"]
            temp_root = root / "configured-temp"
            temp_root.mkdir()
            config["temporaryRoot"] = str(temp_root)
            with patch.object(rehearsal_host, "_validate_staging194_temporary_root", return_value=temp_root):
                report = rehearsal_host._space_preflight(config, "space-194", "static-main")
            self.assertEqual(report["backupBytes"], 0)
            self.assertFalse(any("static capture" in label for item in report["filesystems"]
                                 for label in item["labels"]))
            temp_fs = next(item for item in report["filesystems"] if "temporary data" in item["labels"])
            self.assertEqual(temp_fs["path"], str(temp_root))

    def test_staging194_target_rejects_combined_temp_and_release_space_shortfall(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-194-temp-space-aggregate-") as temporary:
            root = Path(temporary)
            config = self._fixture(root, profile="staging194")
            temp_root = root / "configured-temp"
            temp_root.mkdir()
            config["temporaryRoot"] = str(temp_root)
            static_bytes = rehearsal_host._filesystem_bytes(
                rehearsal_host._current_target(Path(config["currentStatic"])), required=True)
            estimated = 3 * static_bytes + 4096
            real_stat = Path.stat

            class SharedDeviceStat:
                def __init__(self, result):
                    self._result = result
                    self.st_dev = 707

                def __getattr__(self, name):
                    return getattr(self._result, name)

            def same_device(path, *args, **kwargs):
                return SharedDeviceStat(real_stat(path, *args, **kwargs))

            free = (1_073_741_824 + estimated) - 1
            with patch.object(rehearsal_host, "_validate_staging194_temporary_root", return_value=temp_root), \
                 patch.object(Path, "stat", new=same_device), \
                 patch.object(rehearsal_host.shutil, "disk_usage",
                              return_value=SimpleNamespace(total=2_000_000_000, used=0, free=free)):
                report = rehearsal_host._space_preflight(config, "space-194-aggregate", "static-main")
            self.assertGreater(report["filesystems"][0]["requiredBytes"], free)
            with patch.object(operator, "ssh_remote", return_value=json.dumps(report).encode()):
                with self.assertRaisesRegex(operator.Refusal, "short 1 bytes"):
                    operator._check_target_space("staging194", "space-194-aggregate", "static-main")

    def test_staging194_cms_preflight_reports_default_npm_cache_filesystem_without_reconfiguring_it(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-194-npm-cache-space-") as temporary:
            root = Path(temporary)
            config = self._fixture(root, profile="staging194")
            temp_root = root / "configured-temp"
            temp_root.mkdir()
            config["temporaryRoot"] = str(temp_root)
            cms_home = root / "cms-home"
            (cms_home / ".npm").mkdir(parents=True)
            account = SimpleNamespace(pw_dir=str(cms_home), pw_gid=0)
            with patch.object(rehearsal_host, "_validate_staging194_temporary_root", return_value=temp_root), \
                 patch.object(rehearsal_host.pwd, "getpwnam", return_value=account):
                report = rehearsal_host._space_preflight(config, "space-194-npm", "cms-update")
            self.assertTrue(any("CMS npm cache" in item["labels"] for item in report["filesystems"]))
            self.assertIn("cache growth and npmrc/environment overrides are not separately estimated",
                          report["spaceNotes"][0])


if __name__ == "__main__":
    unittest.main()
