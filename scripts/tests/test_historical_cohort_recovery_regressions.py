"""Independent regression coverage for cohort recovery inode boundaries.

The fixture uses disposable files and stubs only the OS user expected by the
registry reader; no server, service, or production path is touched.
"""
import json
import shutil
import sqlite3
from contextlib import ExitStack
from unittest.mock import patch
from types import SimpleNamespace
import unittest

from scripts.lib import rehearsal_host as host
from scripts.tests import test_historical_cohort as existing


class CohortRecoveryRegressions(unittest.TestCase):
    def setUp(self):
        self.fixture = existing.CohortTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_recovery_before_new_cohort_intent_preserves_existing_registry(self):
        f = self.fixture
        f.candidate.unlink()
        db = sqlite3.connect(str(f.candidate))
        db.execute('CREATE TABLE example(value TEXT)')
        db.execute("INSERT INTO example VALUES ('verified baseline')")
        db.commit(); db.close()
        f.binding['candidateDatabaseSha256'] = host.sha256_file(f.candidate)
        f.select()
        before = json.loads((f.history / 'current.json').read_bytes())
        op = 'later-failed-deploy'
        backup_root = f.root / 'backups'
        operation_backup = backup_root / op
        offhost = operation_backup / 'offhost-backup'
        offhost.mkdir(parents=True)
        (operation_backup / 'manifest.json').write_text('{}')
        backup = offhost / 'database.sqlite'
        shutil.copyfile(f.live, backup)
        backup_sha = host.sha256_file(backup)
        static_root = f.root / 'static-releases'; static_root.mkdir()
        static = static_root / 'old'; static.mkdir()
        static_pointer = f.root / 'current-static'; static_pointer.symlink_to(static)
        old_pair = {'cmsPath': str(f.new), 'staticPath': str(static), 'staticTreeSha256': 'e' * 64}
        f.journal._append({'version': 1, 'record': 'start',
                           'operationId': op, 'sourceSha': 'b' * 40, 'oldPair': old_pair})
        f.journal._is_committed = lambda _: False
        f.journal._is_recovered = lambda _: False
        f.journal.confirm_fence = lambda *args: None
        f.journal.require_restore_allowed = lambda _: None
        verified = []
        def recover(operation_id, verify_restored, reopen):
            self.assertEqual(operation_id, op)
            self.assertTrue(verify_restored())
            verified.append(host.sha256_file(f.live))
            self.assertTrue(reopen())
        f.journal.recover = recover
        config = {**f.config, 'profile': 'staging194', 'backupRoot': str(backup_root),
                  'releaseRoot': str(f.root), 'currentStatic': str(static_pointer),
                  'staticReleaseRoot': str(static_root), 'cmsUnit': 'test-cms',
                  'writerUnits': [], 'cmsHealthUrl': 'test', 'siteHealthUrl': 'test'}
        # Only unrelated OS/service operations are stubbed. _recover reads and
        # integrity-checks a real SQLite off-host backup, atomically restores it,
        # and verifies its externally supplied backup digest before reopening.
        with ExitStack() as stack:
            for name in ('_start_acquisition', '_write_gate', '_verify_fence', '_stop_writers',
                         '_assert_no_database_handles', '_restore_media', '_set_flag',
                         '_wait_health', '_database_process_proof'):
                stack.enter_context(patch.object(host, name))
            stack.enter_context(patch.object(host, '_backup_manifest', return_value={'databaseSha256': backup_sha}))
            stack.enter_context(patch.object(host, '_tree_sha256', return_value='e' * 64))
            stack.enter_context(patch.object(host, '_service_pid', return_value=123))
            stack.enter_context(patch.object(host, '_switch_static_pointer'))
            stack.enter_context(patch.object(host, 'run', return_value=SimpleNamespace(returncode=0)))
            host._recover(config, f.journal, op)
        self.assertEqual(verified, [backup_sha])
        self.assertNotEqual(f.live.stat().st_ino, before['database']['inode'])
        host._historical_registry_environment(require_cohort=True, config=f.config)

    def test_recovery_without_verified_restore_cannot_rebind_existing_registry(self):
        f = self.fixture
        f.select()
        f.journal._append({'version': 1, 'record': 'start',
                           'operationId': 'unverified-retry', 'sourceSha': 'b' * 40})
        replacement = f.root / 'unverified.db'
        replacement.write_bytes(b'unverified replacement')
        replacement.replace(f.live)
        before = (f.history / 'current.json').read_bytes()
        with self.assertRaises(host.HostFailure):
            host._restore_historical_cohort(f.config, f.journal, 'unverified-retry')
        self.assertEqual((f.history / 'current.json').read_bytes(), before)

    def test_recovery_retry_does_not_admit_an_unverified_replacement_inode(self):
        f = self.fixture
        f.select()
        previous = json.loads((f.history / 'current.json').read_bytes())
        previous['operationId'] = 'prior-cohort'
        previous['cmsRelease'] = str(f.old)
        f.intent['previousManifest'] = previous
        f.pointer.unlink()
        f.pointer.symlink_to(f.old)
        f.journal._append({'version': 1, 'record': 'historical-cohort-baseline',
                           'operationId': 'test-cohort', 'sourceSha': 'a' * 40,
                           'previousManifest': previous})
        host._copy_atomic(f.candidate, f.live)
        host._restore_historical_cohort(f.config, f.journal, 'test-cohort',
                                        verified_database_sha256=host.sha256_file(f.candidate))
        f.journal._append({'version': 1, 'record': 'recovered',
                           'operationId': 'test-cohort', 'sourceSha': 'a' * 40})
        # Editors have reopened. Their normal in-place changes are allowed;
        # replacing the DB is explicitly outside the selected cohort.
        replacement = f.root / 'unverified.db'
        replacement.write_bytes(b'not the verified restored database')
        replacement.replace(f.live)
        with self.assertRaises(host.HostFailure):
            host._historical_registry_environment(require_cohort=True, config=f.config)
        # The already-recovered retry path calls this callback again without
        # verify_restored; it must not silently make the substituted DB trusted.
        with self.assertRaises(host.HostFailure):
            host._restore_historical_cohort(f.config, f.journal, 'test-cohort')


if __name__ == '__main__':
    unittest.main()
