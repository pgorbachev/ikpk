"""Host marker lifecycle: observable effects across separate dispatch calls."""
import base64
import hashlib
import io
import json
import os
import stat
import tempfile
import unittest
from argparse import Namespace
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host as host


class HostMarkerFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ikpk-marker-flow-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.releases = root / 'releases'
        self.releases.mkdir(mode=0o755)
        self.state_dir = root / 'state'
        self.state_dir.mkdir()
        self.publication_lock = root / '.publication.lock'
        self.publication_lock.write_bytes(b'')
        self.publication_lock.chmod(0o600)
        marker_dir = root / 'site-publication'
        marker_dir.mkdir(mode=0o750)
        self.config = {'profile':'staging194', 'stateDir':str(self.state_dir),
                       'cmsUser':'root',
                       'sitePublicationMarker':str(marker_dir / 'host-publication.json'),
                       'publicationLock':str(self.publication_lock),
                       'currentStatic':str(root / 'current'),
                       'staticReleaseRoot':str(self.releases),
                       'siteRefreshState':str(root / 'refresh' / 'state.json')}
        Path(self.config['siteRefreshState']).parent.mkdir()
        self.marker = marker_dir / 'host-publication.json'
        self.data = b'source archive'
        self.args = Namespace(profile='staging194', action='static-main', operation_id='flow-one',
            source_sha='a'*40, archive_sha256=hashlib.sha256(self.data).hexdigest(),
            provenance_b64=base64.b64encode(b'{}').decode(), browser_digest=None,
            reuse_capture_operation_id=None)
        self._real_lstat = Path.lstat
        def root_owned(path, *args, **kwargs):
            result = self._real_lstat(path, *args, **kwargs)
            if path == marker_dir or path == self.marker:
                fields = list(result)
                fields[4] = 0
                fields[5] = 0
                fields[0] = stat.S_IFDIR | 0o750 if path == marker_dir else stat.S_IFREG | 0o640
                return os.stat_result(fields)
            return result
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(Path, 'lstat', root_owned))
        stack.enter_context(patch.object(host.os, 'geteuid', return_value=0))
        stack.enter_context(patch.object(host.os, 'fchown'))
        stack.enter_context(patch.object(host, 'SITE_PUBLICATION_MARKER_DIR', marker_dir))
        stack.enter_context(patch.object(host, 'PRODUCTION_PUBLICATION_LOCK', self.publication_lock))
        stack.enter_context(patch.object(host.pwd, 'getpwnam',
                                         return_value=type('Account', (), {'pw_uid': os.getuid(), 'pw_gid': 0})()))
        stack.enter_context(patch.object(host, '_root_config', return_value=self.config))
        stack.enter_context(patch.object(host, '_validate_static_main_admission'))

    def dispatch_prepare(self, extract):
        with patch.object(host.sys, 'stdin', io.TextIOWrapper(io.BytesIO(self.data))), \
             patch.object(host, '_extract_source_archive', side_effect=extract):
            return host.dispatch(self.args)

    def test_marker_durable_before_first_archive_side_effect_and_after_crash(self):
        def crash(*args):
            self.assertTrue(self.marker.exists(), 'marker missing before extraction')
            record = json.loads(self.marker.read_text())
            self.assertEqual(record['operationId'], 'flow-one')
            self.assertEqual(record['phase'], 'active')
            raise RuntimeError('simulated process crash')
        with self.assertRaisesRegex(RuntimeError, 'simulated process crash'):
            self.dispatch_prepare(crash)
        self.assertEqual(json.loads(self.marker.read_text())['operationId'], 'flow-one')

    def test_unknown_marker_refuses_before_extract_without_changing_marker(self):
        self.marker.write_text('{ broken JSON')
        before = self.marker.read_bytes()
        extracted = []
        with self.assertRaises((host.HostFailure, ValueError)):
            self.dispatch_prepare(lambda *args: self.fail('extraction ran despite existing marker'))
        self.assertEqual(extracted, [])
        self.assertEqual(self.marker.read_bytes(), before)

    def test_foreign_operation_cannot_take_over_marker(self):
        raw = json.dumps({'version':1, 'operationId':'another-op', 'profile':'staging194', 'phase':'active'})
        self.marker.write_text(raw)
        extracted = []
        with self.assertRaises((host.HostFailure, ValueError)):
            self.dispatch_prepare(lambda *args: self.fail('extraction ran despite existing marker'))
        self.assertEqual(extracted, [])
        self.assertEqual(self.marker.read_text(), raw)

    def test_marker_survives_between_prepare_and_acceptance(self):
        def prepare(config, state, operation_id, source_sha, provenance, reuse):
            self.assertTrue(self.marker.exists(), 'marker missing during prepare')
            self.assertEqual(json.loads(self.marker.read_text())['operationId'], operation_id)
            state._append({'version':1, 'record':'static-main-start', 'operationKind':'static-main',
                           'operationId':operation_id, 'sourceSha':source_sha})
            return {'phase':'browser-check-required'}
        with patch.object(host, '_static_main_prepare', side_effect=prepare):
            result = self.dispatch_prepare(lambda *args: self.releases)
        self.assertEqual(result['phase'], 'browser-check-required')
        self.assertEqual(json.loads(self.marker.read_text())['operationId'], 'flow-one')
        self.assertFalse(Path(self.config['siteRefreshState'] + '.lock').exists())


    def test_terminal_recovery_clears_marker_and_repeat_is_idempotent(self):
        state = host.RehearsalState(self.state_dir)
        state._append({'version':1, 'record':'static-main-start', 'operationKind':'static-main',
                       'operationId':'flow-one', 'sourceSha':'a'*40})
        self.marker.write_text(json.dumps({'version':1, 'operationId':'flow-one',
                                          'profile':'staging194', 'phase':'active'}))
        args = Namespace(profile='staging194', action='static-main-recover', operation_id='flow-one',
                         rollback_committed=False, operator=None, reason=None)
        calls = []
        def recover(config, state, operation_id):
            if not calls:
                self.assertTrue(self.marker.exists(), 'marker dropped before terminal recovery')
                state._append({'version':1, 'record':'static-main-recovered', 'operationKind':'static-main',
                               'operationId':operation_id})
            calls.append(True)
            return {'phase':'recovered'}
        with patch.object(host, '_static_main_recover', side_effect=recover):
            self.assertEqual(host.dispatch(args)['phase'], 'recovered')
            self.assertFalse(self.marker.exists(), 'terminal recovery did not close marker')
            self.assertEqual(host.dispatch(args)['phase'], 'recovered')
            self.assertFalse(self.marker.exists(), 'repeated recovery left marker')


    def test_successful_commit_closes_marker_only_after_durable_commit(self):
        state = host.RehearsalState(self.state_dir)
        state._append({'version':1, 'record':'static-main-start', 'operationKind':'static-main',
                       'operationId':'flow-one', 'sourceSha':'a'*40})
        self.marker.write_text(json.dumps({'version':1, 'operationId':'flow-one',
                                          'profile':'staging194', 'phase':'active'}))
        self.args.browser_digest = 'b'*64
        def commit(config, state, operation_id, source_sha, provenance, browser_digest):
            self.assertTrue(self.marker.exists(), 'marker removed before durable commit')
            state._append({'version':1, 'record':'static-main-committed', 'operationKind':'static-main',
                           'operationId':operation_id, 'sourceSha':source_sha})
            return {'phase':'committed'}
        def cleanup(config, state, operation_id):
            self.assertIn('static-main-committed', [row['record'] for row in state._operation_rows(operation_id)])
            host._clear_site_publication_marker(config, operation_id)
            return []
        with patch.object(host, '_static_main_commit', side_effect=commit), \
             patch.object(host, '_cleanup_site_releases', side_effect=cleanup):
            self.assertEqual(host.dispatch(self.args)['phase'], 'committed')
        self.assertFalse(self.marker.exists(), 'completed publication left active marker')

    def test_cleanup_failure_preserves_committed_result_and_durable_retry_signal(self):
        state = host.RehearsalState(self.state_dir)
        state._append({'version':1, 'record':'static-main-start', 'operationKind':'static-main',
                       'operationId':'flow-one', 'sourceSha':'a'*40})
        self.args.browser_digest = 'b'*64
        def commit(config, state, operation_id, source_sha, provenance, browser_digest):
            state._append({'version':1, 'record':'static-main-committed', 'operationKind':'static-main',
                           'operationId':operation_id, 'sourceSha':source_sha})
            return {'phase':'committed'}
        with patch.object(host, '_static_main_commit', side_effect=commit), \
             patch.object(host, '_cleanup_site_releases', side_effect=host.HostFailure('injected cleanup I/O failure')):
            result = host.dispatch(self.args)
        self.assertEqual(result['phase'], 'committed')
        self.assertTrue(result['cleanupPending'])
        self.assertIn('injected cleanup I/O failure', result['cleanupError'])
        marker = json.loads(self.marker.read_text())
        self.assertEqual(marker['phase'], 'cleanup-pending')
        self.assertIn('injected cleanup I/O failure', marker['lastError'])


if __name__ == '__main__':
    unittest.main()
