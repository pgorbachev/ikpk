"""An unchanged-production recovery seal is not a staged restore admission."""
import json
import shutil
import sqlite3
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch
from scripts.lib import rehearsal_host as host
from scripts.tests import test_historical_cohort as existing


class UnchangedProductionRecovery(unittest.TestCase):
    def exercise(self, blocker=None):
        f = existing.CohortTests(); f.setUp()
        self.addCleanup(f.doCleanups)
        f.candidate.unlink()
        with sqlite3.connect(f.candidate) as db:
            db.execute('CREATE TABLE example(value TEXT)')
            db.execute("INSERT INTO example VALUES ('baseline')")
        f.binding['candidateDatabaseSha256'] = host.sha256_file(f.candidate)
        f.select()
        manifest = json.loads((f.history / 'current.json').read_bytes())
        state_root = f.root / 'state'; state_root.mkdir()
        state = host.RehearsalState(state_root)
        static = f.root / 'static'; static.mkdir()
        static_pointer = f.root / 'static-current'; static_pointer.symlink_to(static)
        uploads = f.root / 'uploads'; uploads.mkdir()
        old = {'cmsPath': str(f.new), 'staticPath': str(static), 'staticTreeSha256': 'e' * 64,
               'historicalRegistryManifest': manifest, 'cmsPayloadSha256': 'c' * 64,
               'mediaStateSha256': host._media_state_sha256([]),
               'cmsSourceEnvironment': {key: None for key in host.PAIRED_CMS_ENV_KEYS}}
        op = 'unchanged-prod-recovery'
        state.begin(op, 'b' * 40, old)
        state.confirm_fence(op, lambda: True)
        state._append({'version': 1, 'record': 'fenced-baseline', 'operationId': op,
                       'sourceSha': 'b' * 40, 'oldPair': old})
        backup_root = f.root / 'backups'; backup = backup_root / op; backup.mkdir(parents=True)
        shutil.copyfile(f.live, backup / 'database.sqlite')
        digest = host.sha256_file(f.live)
        (backup / 'manifest.json').write_text(json.dumps({'databaseSha256': digest, 'postCheckpointLiveSha256': digest}))
        # Exact durable boundary of the production unchanged fast path: baseline
        # and cohort-restored appended, process dies before state.recover appends
        # recovered. There is no offhost import or restore-prepared record.
        state._append({'version': 1, 'record': 'historical-cohort-baseline', 'operationId': op,
                       'sourceSha': 'b' * 40, 'previousManifest': manifest})
        state._append({'version': 1, 'record': 'historical-cohort-restored', 'operationId': op,
                       'sourceSha': 'b' * 40, 'manifest': manifest,
                       'database': host._cohort_database_identity(f.live), 'databaseSha256': digest})
        config = {**f.config, 'profile': 'production-paired', 'currentStatic': str(static_pointer),
                  'mediaRoots': [{'prefix': '/uploads/', 'path': str(uploads)}], 'backupRoot': str(backup_root),
                  'releaseRoot': str(f.root), 'staticReleaseRoot': str(f.root),
                  'cmsUnit': 'cms', 'writerUnits': [], 'cmsHealthUrl': 'test', 'siteHealthUrl': 'test'}
        if blocker == 'imported':
            (backup / 'offhost-backup').mkdir()
        elif blocker == 'prepared':
            state._append({'version': 1, 'record': 'restore-prepared', 'operationId': op, 'sourceSha': 'b' * 40})
        inode = f.live.stat().st_ino
        with ExitStack() as stack:
            for name in ('_wait_health', '_database_process_proof', '_write_paired_cms_source_env',
                         '_set_flag', '_write_gate', '_start_acquisition', '_verify_fence',
                         '_stop_writers', '_assert_no_database_handles'):
                stack.enter_context(patch.object(host, name))
            stack.enter_context(patch.object(host, '_tree_sha256', return_value='e' * 64))
            stack.enter_context(patch.object(host, '_cms_payload_sha256', return_value='c' * 64))
            stack.enter_context(patch.object(host, '_media_inventory', return_value=[]))
            stack.enter_context(patch.object(host, '_service_pid', return_value=123))
            stack.enter_context(patch.object(host, 'run', return_value=SimpleNamespace(returncode=0)))
            stack.enter_context(patch.object(host, '_copy_atomic', side_effect=AssertionError('unchanged recovery copied DB')))
            if blocker is not None:
                before = (f.history / 'current.json').read_bytes()
                with self.assertRaisesRegex(host.HostFailure, 'resume staged restore and provenance finalize'):
                    host._recover(config, host.RehearsalState(state_root), op)
                self.assertFalse(host.RehearsalState(state_root)._is_recovered(op))
                self.assertEqual(f.live.stat().st_ino, inode)
                self.assertEqual((f.history / 'current.json').read_bytes(), before)
                return
            result = host._recover(config, host.RehearsalState(state_root), op)
        self.assertEqual(result['phase'], 'recovered')
        self.assertEqual(f.live.stat().st_ino, inode)
        self.assertEqual(host.sha256_file(f.live), digest)
        host.RehearsalState(state_root).read_journal_for_cleanup(validate_history=True)

    def test_retry_after_unchanged_recovery_seal_before_terminal_record(self):
        self.exercise()

    def test_imported_backup_cannot_use_unchanged_recovery_seal(self):
        self.exercise('imported')

    def test_staged_restore_cannot_use_unchanged_recovery_seal(self):
        self.exercise('prepared')


if __name__ == '__main__': unittest.main()
