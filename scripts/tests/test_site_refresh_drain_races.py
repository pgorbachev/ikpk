"""Post-gate drain must tolerate writer handoff races without admitting unsafe state."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.lib import rehearsal_host as host


class DrainRaces(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state.json'
        self.lock = Path(str(self.state) + '.lock')
        self.config = {'profile': 'production-paired', 'siteRefreshState': str(self.state)}
        self.now = 0
        self.sleeps = 0

    def state_write(self, status, **fields):
        self.state.write_text(json.dumps({'status': status, **fields}), encoding='utf-8')

    def run_drain(self, transition=lambda count: None):
        def sleep(seconds):
            self.assertEqual(seconds, 1)
            self.sleeps += 1
            self.assertLessEqual(self.sleeps, 5, 'drain must be bounded')
            transition(self.sleeps)
            self.now += 1200
        with patch.object(host.time, 'monotonic', side_effect=lambda: self.now), \
             patch.object(host.time, 'sleep', side_effect=sleep):
            host._verify_site_refresh_idle(self.config)

    def test_partial_lock_becomes_live_then_worker_unlinks(self):
        for initial in ('', f'{os.getpid()}\nabc'):
            with self.subTest(initial=initial):
                self.sleeps = self.now = 0
                self.lock.write_text(initial, encoding='ascii')
                def advance(count):
                    if count == 1:
                        self.lock.write_text(f'{os.getpid()}\n' + 'a' * 32 + '\n', encoding='ascii')
                    elif count == 2:
                        self.lock.unlink()
                self.run_drain(advance)
                self.assertEqual(self.sleeps, 2, 'must wait through partial and live lock')

    def test_lock_unlinked_between_lstat_and_read_rechecks_new_running_state(self):
        self.state_write('succeeded')
        self.lock.write_text(f'{os.getpid()}\n', encoding='ascii')
        original = Path.read_text
        raced = False
        def read(path, *args, **kwargs):
            nonlocal raced
            if path == self.lock and not raced:
                raced = True
                self.lock.unlink()
                self.state_write('running', pid=os.getpid())
                raise FileNotFoundError('writer unlinked lock')
            return original(path, *args, **kwargs)
        def advance(count):
            self.state_write('succeeded')
        with patch.object(Path, 'read_text', read):
            self.run_drain(advance)
        self.assertTrue(raced)
        self.assertGreaterEqual(self.sleeps, 1, 'new running state must be observed before return')

    def test_lock_pid_exits_after_unlink_and_new_owner_is_waited_for(self):
        old_pid, new_pid = 12341, 12342
        self.lock.write_text(f'{old_pid}\n', encoding='ascii')
        def kill(pid, signal):
            self.assertEqual(signal, 0)
            if pid == old_pid:
                self.lock.unlink()
                self.lock.write_text(f'{new_pid}\n' + 'b' * 32 + '\n', encoding='ascii')
                raise ProcessLookupError()
            self.assertEqual(pid, new_pid)
        with patch.object(host.os, 'kill', side_effect=kill):
            self.run_drain(lambda count: self.lock.unlink())
        self.assertGreaterEqual(self.sleeps, 1, 'replacement owner must drain')

    def test_running_state_finishes_before_pid_check_and_live_lock_drains(self):
        old_pid, new_pid = 12341, 12342
        self.state_write('running', pid=old_pid)
        self.lock.write_text(f'{new_pid}\n', encoding='ascii')
        def kill(pid, signal):
            if pid == old_pid:
                self.state_write('succeeded')
                raise ProcessLookupError()
            self.assertEqual(pid, new_pid)
        with patch.object(host.os, 'kill', side_effect=kill):
            self.run_drain(lambda count: self.lock.unlink())
        self.assertGreaterEqual(self.sleeps, 1)

    def test_persistent_partial_lock_fails_closed_with_bounded_wait(self):
        self.lock.write_text('', encoding='ascii')
        with self.assertRaises(host.HostFailure):
            self.run_drain()
        self.assertTrue(self.lock.exists())
        self.assertLessEqual(self.sleeps, 5)

    def test_stable_dead_pid_and_bad_state_fail_closed(self):
        self.lock.write_text('12341\n', encoding='ascii')
        with patch.object(host.os, 'kill', side_effect=ProcessLookupError), self.assertRaises(host.HostFailure):
            self.run_drain()
        self.lock.unlink()
        for contents in ('{', json.dumps({'status': 'unknown'})):
            self.state.write_text(contents, encoding='utf-8')
            with self.subTest(contents=contents), self.assertRaises(host.HostFailure):
                self.run_drain()

    def test_live_lock_waits_and_idle_without_lock_returns(self):
        self.lock.write_text(f'{os.getpid()}\n', encoding='ascii')
        self.run_drain(lambda count: self.lock.unlink())
        self.assertEqual(self.sleeps, 1)
        self.sleeps = 0
        self.run_drain()
        self.assertEqual(self.sleeps, 0)


if __name__ == '__main__':
    unittest.main()
