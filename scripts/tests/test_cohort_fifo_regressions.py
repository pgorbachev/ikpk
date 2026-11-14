"""Untrusted FIFO leaves must fail closed without blocking the root helper."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class CohortFifoRegressions(unittest.TestCase):
    def run_case(self, function):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            root = Path(temporary).resolve()
            (root / 'reviews').mkdir(mode=0o700)
            os.mkfifo(root / 'reviews' / 'review.json', 0o600)
            code = '''import os,sys
from pathlib import Path
from types import SimpleNamespace
from scripts.lib import rehearsal_host as h
root=Path(sys.argv[1])
try:
    if sys.argv[2] == 'store':
        h._store_migration_review(root,SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid()),'review.json',b'{}')
    else:
        h._cohort_file(root/'reviews'/'review.json')
except h.HostFailure:
    sys.exit(0)
sys.exit(2)
'''
            try:
                result = subprocess.run([sys.executable, '-c', code, str(root), function],
                                        timeout=2, capture_output=True, text=True)
            except subprocess.TimeoutExpired:
                self.fail(f'{function} blocked opening an untrusted FIFO before type validation')
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_retained_review_fifo_is_rejected_without_blocking(self):
        self.run_case('store')

    def test_cohort_receipt_or_registry_fifo_is_rejected_without_blocking(self):
        self.run_case('cohort')


if __name__ == '__main__':
    unittest.main()
