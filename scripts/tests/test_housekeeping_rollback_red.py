"""Rollback after cleanup fails explicitly without touching the served site."""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host as host
from scripts.tests import test_rehearsal_host as host_tests


class CleanupRollbackTests(unittest.TestCase):
    def test_deleted_old_release_refuses_committed_rollback_without_switch(self):
        with tempfile.TemporaryDirectory(prefix='ikpk-rollback-cleaned-') as temporary:
            fixture = host_tests.StaticMainAdmissionTests()
            config, state, pointer, old, candidate, _ = fixture._committed_static_main_fixture(Path(temporary))
            before = pointer.resolve(strict=True)
            self.assertEqual(before, candidate.resolve(strict=True))
            shutil.rmtree(old)
            with patch.object(host, '_switch_pointer', wraps=host._switch_pointer) as switch:
                with self.assertRaisesRegex(host.HostFailure, '(?i)(rollback|откат).*(missing|unavailable|недоступ)'):
                    host._static_main_recover(config, state, 'main-op', rollback_committed=True,
                        operator_name='operator', reason='quick rollback')
                switch.assert_not_called()
            self.assertEqual(pointer.resolve(strict=True), before)
            self.assertFalse(any(row.get('record') == 'static-main-rollback-intent'
                                 for row in state._operation_rows('main-op')))


    def test_cleanup_refuses_unfinished_rollback_intent_and_keeps_target(self):
        with tempfile.TemporaryDirectory(prefix='ikpk-rollback-intent-') as temporary:
            fixture = host_tests.StaticMainAdmissionTests()
            config, state, pointer, old, candidate, _ = fixture._committed_static_main_fixture(Path(temporary))
            state._append({'version':1, 'record':'static-main-rollback-intent',
                           'operationKind':'static-main', 'operationId':'main-op',
                           'sourceSha':'a'*40, 'oldStaticPath':str(old)})
            old_before = host._tree_sha256(old)
            current_before = pointer.resolve(strict=True)
            with patch.object(host, '_read_site_publication_marker', return_value=None, create=True), \
                 patch.object(host, '_switch_pointer', wraps=host._switch_pointer) as switch:
                with self.assertRaisesRegex(host.HostFailure, '(?i)(unfinished|recovery|rollback|незаверш|inconsistent)'):
                    host._cleanup_site_releases(config, state, 'main-op')
                switch.assert_not_called()
            self.assertTrue(old.is_dir())
            self.assertEqual(host._tree_sha256(old), old_before)
            self.assertEqual(pointer.resolve(strict=True), current_before)
            self.assertEqual(current_before, candidate.resolve(strict=True))


if __name__ == '__main__':
    unittest.main()
