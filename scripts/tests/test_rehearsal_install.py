import os
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import rehearsal_config


ROOT = Path(__file__).resolve().parents[2]


class InstalledEntrypointTests(unittest.TestCase):
    def test_staging194_dev_to_main_migration_is_atomic_backed_up_and_preserves_other_keys(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-config-migration-") as temporary:
            root = Path(temporary)
            template = {"profile": "staging194", "allowedSourceRef": "refs/heads/main",
                        "cmsDatabase": "/var/lib/site/data.db", "customSetting": {"keep": True}}
            current = {**template, "allowedSourceRef": "refs/heads/dev"}
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            original = json.dumps(current, indent=2).encode()
            config_path.write_bytes(original)
            rehearsal_config.check(str(config_path), str(template_path))
            rehearsal_config.migrate(str(config_path), str(template_path))
            self.assertEqual(json.loads(config_path.read_text()), template)
            backups = list(root.glob("rehearsal.json.pre-main-*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)

    def test_staging194_migration_refuses_unrelated_config_differences(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-config-refuse-") as temporary:
            root = Path(temporary)
            template = {"profile": "staging194", "allowedSourceRef": "refs/heads/main", "cmsUser": "cms"}
            current = {**template, "allowedSourceRef": "refs/heads/dev", "cmsUser": "other"}
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            config_path.write_text(json.dumps(current), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unrelated differences"):
                rehearsal_config.check(str(config_path), str(template_path))
            self.assertEqual(json.loads(config_path.read_text()), current)
            self.assertFalse(list(root.glob("*.bak")))

    def test_staging194_migration_replace_failure_preserves_compatible_dev_config(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-config-atomic-failure-") as temporary:
            root = Path(temporary)
            template = {"profile": "staging194", "allowedSourceRef": "refs/heads/main", "cmsUser": "cms"}
            current = {**template, "allowedSourceRef": "refs/heads/dev"}
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            original = json.dumps(current, indent=2)
            config_path.write_text(original, encoding="utf-8")
            with patch.object(rehearsal_config.os, "replace", side_effect=OSError("injected replace failure")):
                with self.assertRaisesRegex(OSError, "injected replace failure"):
                    rehearsal_config.migrate(str(config_path), str(template_path))
            self.assertEqual(json.loads(config_path.read_text()), current)
            backups = list(root.glob("rehearsal.json.pre-main-*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), original)

    def test_installed_package_contains_all_imports_and_has_working_entrypoint(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-install-") as temporary:
            prefix = Path(temporary) / "prefix"
            install = subprocess.run(["bash", str(ROOT / "scripts/install-rehearsal-host.sh"), "--prefix", str(prefix)],
                                     cwd=ROOT, text=True, capture_output=True, check=False)
            self.assertEqual(install.returncode, 0, install.stderr)
            package = prefix / "lib/ikpk-rehearsal"
            self.assertEqual({path.name for path in package.iterdir()}, {"rehearsal_state.py", "rehearsal_host.py"})
            smoke = subprocess.run([str(prefix / "sbin/ikpk-rehearsal"), "--help"],
                                   text=True, capture_output=True, check=False,
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual(smoke.returncode, 0, smoke.stderr)
            self.assertIn("cms-update", smoke.stdout)
            self.assertIn("static-publish", smoke.stdout)


if __name__ == "__main__":
    unittest.main()
