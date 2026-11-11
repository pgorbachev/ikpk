"""Production paired fencing must drain legacy and PID+token CMS lock formats."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.lib import rehearsal_host


class RefreshLockDrain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='.drain-red-', dir=Path.cwd())
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state.json'
        self.lock = Path(str(self.state) + '.lock')
        self.config = {'profile': 'production-paired', 'siteRefreshState': str(self.state)}

    def assert_waits_then_drains(self, contents):
        self.lock.write_text(contents, encoding='ascii')
        observed = []
        def finishes(seconds):
            self.assertEqual(seconds, 1)
            self.assertTrue(self.lock.exists(), 'the verifier must not release the writer lock')
            observed.append(self.lock.read_text(encoding='ascii'))
            self.lock.unlink()  # Model the live worker releasing its own lock.
        with patch.object(rehearsal_host.time, 'sleep', side_effect=finishes):
            rehearsal_host._verify_site_refresh_idle(self.config)
        self.assertEqual(observed, [contents], 'a live writer must be waited for before fencing continues')

    def test_live_pid_and_token_is_waited_for_until_worker_finishes(self):
        self.assert_waits_then_drains(f'{os.getpid()}\n' + 'a' * 32 + '\n')

    def test_live_legacy_pid_is_still_waited_for(self):
        self.assert_waits_then_drains(f'{os.getpid()}\n')

    def test_empty_and_malformed_token_locks_fail_closed(self):
        for contents in ('', '\n', f'{os.getpid()}\n\n', f' {os.getpid()}\n'):
            self.lock.write_text(contents, encoding='ascii')
            with self.subTest(contents=contents), self.assertRaises(rehearsal_host.HostFailure):
                rehearsal_host._verify_site_refresh_idle(self.config)
            self.assertEqual(self.lock.read_text(encoding='ascii'), contents)
        for token in ('a' * 31, 'a' * 33, 'G' * 32, 'abc\nextra'):
            contents = f'{os.getpid()}\n{token}\n'
            self.lock.write_text(contents, encoding='ascii')
            with self.subTest(token=token), self.assertRaises(rehearsal_host.HostFailure):
                rehearsal_host._verify_site_refresh_idle(self.config)
            self.assertEqual(self.lock.read_text(encoding='ascii'), contents)

    def test_non_ascii_and_unrepresentable_pid_fail_closed(self):
        for contents in (b'123\n\xff\n', b'999999999999999999999999999999999999999999999\n'):
            self.lock.write_bytes(contents)
            with self.subTest(contents=contents), self.assertRaises(rehearsal_host.HostFailure):
                rehearsal_host._verify_site_refresh_idle(self.config)
            self.assertEqual(self.lock.read_bytes(), contents)

    def test_dead_pid_with_token_fails_closed(self):
        contents = f'{os.getpid()}\n' + 'f' * 32 + '\n'
        self.lock.write_text(contents, encoding='ascii')
        with patch.object(rehearsal_host.os, 'kill', side_effect=ProcessLookupError), \
             self.assertRaisesRegex(rehearsal_host.HostFailure, 'stale'):
            rehearsal_host._verify_site_refresh_idle(self.config)
        self.assertEqual(self.lock.read_text(encoding='ascii'), contents)


if __name__ == '__main__':
    unittest.main()
