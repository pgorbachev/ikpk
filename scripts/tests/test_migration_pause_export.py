import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.lib import rehearsal_host as host
from scripts.lib.housekeeping_journal import validate_journal_history
from scripts.lib.rehearsal_state import RehearsalState
from scripts.rehearsal import staging193 as operator
from contextlib import redirect_stdout
import io


class MigrationPauseExport(unittest.TestCase):
    def test_secure_capture_rejects_links_and_wal_and_detects_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'stage-snapshots').mkdir(mode=0o700)
            (root / 'candidate.db').write_bytes(b'db')
            (root / 'candidate.db').chmod(0o600)
            (root / 'receipt.json').write_bytes(json.dumps({'operationId': 'op', 'sourceCommitSha': 'a'*40, 'candidateDbPath': str(root / 'candidate.db'), 'stageSnapshotDir': str(root / 'stage-snapshots'), 'stageSnapshots': {}}).encode())
            (root / 'receipt.json').chmod(0o600)
            with patch.object(host, '_assert_no_database_handles'):
                captured = host._capture_migration_pause(root, 'op', 'a'*40)
                self.assertEqual(captured['files']['candidate.db'], hashlib.sha256(b'db').hexdigest())
                (root / 'candidate.db-wal').write_bytes(b'wal')
                with self.assertRaises(host.HostFailure):
                    host._capture_migration_pause(root, 'op', 'a'*40)
                (root / 'candidate.db-wal').unlink()
                os.link(root / 'candidate.db', root / 'extra')
                with self.assertRaises(host.HostFailure):
                    host._capture_migration_pause(root, 'op', 'a'*40)

    def test_fifo_substitution_cannot_block_or_be_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'stage-snapshots').mkdir(mode=0o700)
            candidate = root / 'candidate.db'
            candidate.write_bytes(b'db')
            candidate.chmod(0o600)
            receipt = root / 'receipt.json'
            receipt.write_text(json.dumps({'operationId':'op', 'sourceCommitSha':'a'*40,
                'candidateDbPath':str(candidate), 'stageSnapshotDir':str(root/'stage-snapshots'), 'stageSnapshots':{}}))
            receipt.chmod(0o600)
            real_open = os.open
            def substitute(path, flags, *args, **kwargs):
                if path == 'candidate.db':
                    self.assertTrue(flags & os.O_NONBLOCK, 'opening substituted FIFO must not block')
                    candidate.unlink()
                    os.mkfifo(candidate, 0o600)
                return real_open(path, flags, *args, **kwargs)
            with patch.object(host, '_assert_no_database_handles'), patch.object(host.os, 'open', side_effect=substitute):
                with self.assertRaises(host.HostFailure):
                    host._capture_migration_pause(root, 'op', 'a'*40)

    def test_change_after_individual_read_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'stage-snapshots').mkdir(mode=0o700)
            candidate = root / 'candidate.db'
            candidate.write_bytes(b'before')
            candidate.chmod(0o600)
            receipt = root / 'receipt.json'
            receipt.write_text(json.dumps({'operationId': 'op', 'sourceCommitSha': 'a'*40,
                'candidateDbPath': str(candidate), 'stageSnapshotDir': str(root/'stage-snapshots'), 'stageSnapshots': {}}))
            receipt.chmod(0o600)
            real_listdir = os.listdir
            calls = []
            def mutate(directory):
                calls.append(1)
                if len(calls) == 2:
                    candidate.write_bytes(b'changed')
                return real_listdir(directory)
            with patch.object(host, '_assert_no_database_handles'), patch.object(host.os, 'listdir', side_effect=mutate):
                with self.assertRaises(host.HostFailure):
                    host._capture_migration_pause(root, 'op', 'a'*40)

    def test_active_or_orphaned_runner_lock_refuses_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            lock = root / 'candidate.db.migration-lock'
            lock.write_text('999999:orphan\n')
            with self.assertRaises(host.HostFailure):
                with host._migration_export_lock(root):
                    pass
            self.assertTrue(lock.exists())
            lock.unlink()
            with host._migration_export_lock(root):
                self.assertTrue(lock.is_file())
                with self.assertRaises(host.HostFailure):
                    with host._migration_export_lock(root):
                        pass
            self.assertFalse(lock.exists())

    def test_snapshot_fingerprint_must_match_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            directory = root / 'stage-snapshots'
            directory.mkdir(mode=0o700)
            (root / 'candidate.db').write_bytes(b'db')
            (root / 'candidate.db').chmod(0o600)
            snapshot = directory / 'op.schema.db'
            snapshot.write_bytes(b'snapshot')
            snapshot.chmod(0o400)
            receipt = {'operationId': 'op', 'sourceCommitSha': 'a'*40, 'candidateDbPath': str(root / 'candidate.db'),
                       'stageSnapshotDir': str(directory), 'stageSnapshots': {'schema': {'path': str(snapshot), 'snapshotFingerprint': 'bad'}}}
            (root / 'receipt.json').write_text(json.dumps(receipt))
            (root / 'receipt.json').chmod(0o600)
            with patch.object(host, '_assert_no_database_handles'):
                with self.assertRaises(host.HostFailure):
                    host._capture_migration_pause(root, 'op', 'a'*40)

    def test_journal_validates_seal_and_rejects_orphan_seal(self):
        op, sha, attempt = 'op', 'a'*40, 'b'*32
        def row(record, **kwargs):
            return {'version': 1, 'operationId': op, 'sourceSha': sha, 'record': record, **kwargs}
        start = row('start', oldPair={'cmsPath': '/old/cms', 'staticPath': '/old/static'})
        began = row('migration-attempt-started', attempt=attempt)
        seal = row('migration-pause-sealed', attempt=attempt, files={'candidate.db':'c'*64}, resultSha256='d'*64)
        recovered = row('recovered')
        validate_journal_history([start, began, seal, recovered])
        with self.assertRaises(ValueError):
            validate_journal_history([start, seal, recovered])
        with tempfile.TemporaryDirectory() as tmp:
            state = RehearsalState(Path(tmp).resolve())
            for item in (start, began, seal, recovered):
                state._append(item)
            self.assertEqual(state.read_journal_for_cleanup(validate_history=True), [start, began, seal, recovered])

    def test_operator_summary_does_not_log_migration_results(self):
        result = {'operationId':'op', 'sourceSha':'a'*40, 'migration':{
            'waitingForReview':'schedule', 'steps':[{'result': {'private':'secret'}}]}}
        summary = operator.migration_pause_summary(result)
        self.assertEqual(summary['pause'], {'waitingForReview':'schedule'})
        self.assertNotIn('secret', json.dumps(summary))

    def test_local_export_is_private_and_records_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(operator, 'ssh_remote', return_value=b'archive'), redirect_stdout(io.StringIO()) as output:
                result = operator.main(['export-migration-pause', '--operation-id', 'op', '--source-sha', 'a'*40,
                                        '--output-parent', tmp])
            self.assertEqual(result, 0)
            directory = Path(json.loads(output.getvalue())['directory'])
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual((directory/'pause.tar').read_bytes(), b'archive')
            self.assertEqual((directory/'pause.tar').stat().st_mode & 0o777, 0o600)
            self.assertEqual((directory/'pause.tar.sha256').read_text(), hashlib.sha256(b'archive').hexdigest() + '  pause.tar\n')

    def test_interrupted_attempt_and_later_submission_invalidate_seal(self):
        seal = {'record':'migration-pause-sealed', 'attempt':'1'*32}
        for rows in ([{'record':'migration-attempt-started','attempt':'1'*32}, seal,
                      {'record':'migration-attempt-started','attempt':'2'*32}],
                     [{'record':'migration-attempt-started','attempt':'1'*32}, seal,
                      {'record':'migration-review-submitted'}],
                     [{'record':'migration-attempt-started','attempt':'1'*32}, seal,
                      {'record':'recovered'}]):
            with self.assertRaises(host.HostFailure):
                host._latest_migration_pause(rows)
        self.assertEqual(host._latest_migration_pause([{'record':'migration-attempt-started','attempt':'1'*32},seal]), seal)

if __name__ == '__main__': unittest.main()
