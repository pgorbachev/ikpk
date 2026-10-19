import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class InstalledEntrypointTests(unittest.TestCase):
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
