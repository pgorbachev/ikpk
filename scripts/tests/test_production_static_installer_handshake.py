import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ProductionStaticInstalledEntrypointTests(unittest.TestCase):
    def test_installed_candidate_accepts_production_static_space_preflight_help(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-production-static-prefix-") as temporary:
            prefix = Path(temporary) / "prefix"
            install = subprocess.run(
                ["bash", str(ROOT / "scripts/install-rehearsal-host.sh"),
                 "--prefix", str(prefix), "--install-disabled"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(install.returncode, 0, install.stderr)

            installed_helper = prefix / "lib/ikpk-rehearsal/rehearsal_host.py"
            self.assertTrue(installed_helper.is_file())
            helper_text = installed_helper.read_text(encoding="utf-8")
            self.assertIn('command.add_argument("--space-preflight"', helper_text)
            self.assertIn('command.add_argument("--space-preflight-for"', helper_text)

            entrypoint = prefix / "sbin/ikpk-rehearsal"
            smoke = subprocess.run(
                [str(entrypoint), "--profile", "production-static", "status", "--help"],
                text=True,
                capture_output=True,
                check=False,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(smoke.returncode, 0, smoke.stderr)
            self.assertIn("--space-preflight", smoke.stdout)
            self.assertIn("--space-preflight-for", smoke.stdout)


if __name__ == "__main__":
    unittest.main()
