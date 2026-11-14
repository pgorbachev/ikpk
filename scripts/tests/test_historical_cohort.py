"""Host crash boundary tests; no listeners, root writes, or real databases."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.lib import rehearsal_host as host


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Journal:
    def __init__(self): self.rows = []
    def _operation_rows(self, op): return [r for r in self.rows if r['operationId'] == op]
    def _append(self, row): self.rows.append(row)


class CohortTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.cohort-', dir=Path.cwd())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.root.chmod(0o755)
        self.history = self.root / 'history'; self.history.mkdir(mode=0o755)
        self.old = self.root / 'old'; self.old.mkdir()
        self.new = self.root / 'new'; self.new.mkdir()
        self.pointer = self.root / 'current'; self.pointer.symlink_to(self.old)
        self.live = self.root / 'live.db'; self.live.write_bytes(b'old content')
        self.candidate = self.root / 'candidate.db'; self.candidate.write_bytes(b'reviewed content')
        self.config = {'currentCms': str(self.pointer), 'cmsDatabase': str(self.live)}
        self.journal = Journal()
        self.binding = {'version': 1, 'operationId': 'test-cohort', 'sourceCommit': 'a' * 40,
                        'migrationPlanDigest': '1' * 64, 'sourceDatabaseSha256': '2' * 64,
                        'candidateDatabaseSha256': digest(self.candidate.read_bytes()),
                        'registrySha256': digest(b'[]'), 'cmsArtifactSha256': '3' * 64,
                        'proofArtifactSha256': '4' * 64}
        self.intent = {'version': 1, 'record': 'historical-cohort-intent', 'operationId': 'test-cohort',
                       'sourceSha': 'a' * 40, 'cmsArtifact': {'payloadSha256': '6' * 64},
                       'binding': self.binding, 'receiptSha256': '5' * 64, 'cmsRelease': str(self.new),
                       'previousManifest': None}
        self.journal._append(self.intent)
        (self.history / f"registry-{self.binding['registrySha256']}.json").write_bytes(b'[]')
        original = host._historical_registry_environment
        def read(*args, **kwargs):
            kwargs['trusted_uid'] = os.getuid()
            return original(*args, **kwargs)
        self.addCleanup(patch.stopall)
        patch.object(host, 'HISTORICAL_REGISTRY_DIRECTORY', self.history).start()
        patch.object(host, '_historical_registry_environment', side_effect=read).start()

    def select(self):
        self.live.write_bytes(self.candidate.read_bytes())
        self.pointer.unlink(); self.pointer.symlink_to(self.new)
        host._commit_historical_cohort(self.config, self.journal, self.intent)

    def admission(self):
        self.journal.rows.clear()
        registry = self.root / 'approved-registry.json'; registry.write_bytes(b'[]')
        receipt = self.root / 'receipt.json'
        source_files = [{'file': self.live.name, 'sha256': digest(self.live.read_bytes())},
                        {'file': self.live.name + '-wal', 'absent': True}]
        value = {'operationId': 'test-cohort', 'phase': 'prepared', 'sourceCommitSha': 'a' * 40,
                 'artifactSha256': self.binding['cmsArtifactSha256'],
                 'planSha256': self.binding['migrationPlanDigest'],
                 'source': {'snapshotSha256': self.binding['sourceDatabaseSha256'],
                            'sourceFileFingerprint': digest(json.dumps(source_files, separators=(',', ':')).encode())},
                 'registryBinding': self.binding, 'candidateDbPath': str(self.candidate),
                 'sourceDbPath': str(self.live)}
        receipt.write_text(json.dumps(value))
        return {'registryPath': str(registry), 'receiptPath': str(receipt),
                'receiptSha256': digest(receipt.read_bytes()), 'binding': self.binding}

    def prepare(self, admission):
        with patch.object(host, '_verify_fence'), patch.object(host, '_assert_no_database_handles'), \
             patch.object(host, '_backup_manifest', return_value={'postCheckpointLiveSha256': digest(b'old content')}):
            return host._prepare_historical_cohort(self.config, self.journal, 'test-cohort', 'a' * 40,
                self.new, self.candidate, {'payloadSha256': '6' * 64}, admission, trusted_uid=os.getuid())

    def test_prepare_records_intent_before_any_live_mutation(self):
        admission = self.admission()
        self.prepare(admission)
        self.assertEqual(self.journal.rows[0]['record'], 'historical-cohort-intent')
        self.assertEqual(self.live.read_bytes(), b'old content')
        self.assertEqual(self.pointer.resolve(), self.old)
        self.assertFalse((self.history / 'current.json').exists())
        with self.assertRaisesRegex(host.HostFailure, 'already began'):
            self.prepare(admission)

    def test_source_candidate_receipt_and_registry_changes_block_before_intent(self):
        for kind in ('source', 'candidate', 'receipt', 'registry'):
            with self.subTest(kind=kind):
                self.live.write_bytes(b'old content'); self.candidate.write_bytes(b'reviewed content')
                admission = self.admission()
                path = {'source': self.live, 'candidate': self.candidate,
                        'receipt': Path(admission['receiptPath']), 'registry': Path(admission['registryPath'])}[kind]
                path.write_bytes(path.read_bytes() + b'changed')
                with self.assertRaises(host.HostFailure): self.prepare(admission)
                self.assertEqual(self.journal.rows, [])
                self.assertFalse((self.history / 'current.json').exists())

    def restore_verified(self):
        if not any(row.get('record') == 'historical-cohort-baseline' for row in self.journal.rows):
            self.journal._append({'version': 1, 'record': 'historical-cohort-baseline',
                                 'operationId': 'test-cohort', 'sourceSha': 'a' * 40,
                                 'previousManifest': self.intent['previousManifest']})
        host._restore_historical_cohort(self.config, self.journal, 'test-cohort',
                                       verified_database_sha256=digest(self.live.read_bytes()))

    def test_commit_requires_both_selected_code_and_exact_database(self):
        for state in ('old', 'database-only', 'code-only'):
            with self.subTest(state=state):
                self.live.write_bytes(self.candidate.read_bytes() if state == 'database-only' else b'old content')
                self.pointer.unlink(); self.pointer.symlink_to(self.new if state == 'code-only' else self.old)
                with self.assertRaisesRegex(host.HostFailure, 'selection'):
                    host._commit_historical_cohort(self.config, self.journal, self.intent)
                self.assertFalse((self.history / 'current.json').exists())

    def test_cohort_allows_editorial_writes_but_rejects_database_replacement(self):
        self.select()
        self.live.write_bytes(b'legitimate CMS editorial change')
        host._historical_registry_environment(require_cohort=True, config=self.config)
        replacement = self.root / 'replacement.db'; replacement.write_bytes(self.live.read_bytes())
        replacement.replace(self.live)
        with self.assertRaisesRegex(host.HostFailure, 'cohort'):
            host._historical_registry_environment(require_cohort=True, config=self.config)

    def test_swapped_code_pointer_is_rejected(self):
        self.select(); self.pointer.unlink(); self.pointer.symlink_to(self.old)
        with self.assertRaisesRegex(host.HostFailure, 'cohort'):
            host._historical_registry_environment(require_cohort=True, config=self.config)

    def test_recovery_after_manifest_replace_before_selected_journal(self):
        with patch.object(self.journal, '_append', side_effect=RuntimeError('crash')):
            with self.assertRaisesRegex(RuntimeError, 'crash'): self.select()
        self.live.write_bytes(b'old content'); self.pointer.unlink(); self.pointer.symlink_to(self.old)
        self.restore_verified()
        self.assertFalse((self.history / 'current.json').exists())
        self.restore_verified()

    def test_recovery_rebinds_prior_manifest_to_verified_restored_database_inode(self):
        self.select()
        previous = json.loads((self.history / 'current.json').read_bytes())
        previous['operationId'] = 'prior-cohort'; previous['cmsRelease'] = str(self.old)
        self.intent['previousManifest'] = previous
        replacement = self.root / 'restore.db'; replacement.write_bytes(b'old content'); replacement.replace(self.live)
        self.pointer.unlink(); self.pointer.symlink_to(self.old)
        self.restore_verified()
        host._historical_registry_environment(require_cohort=True, config=self.config)
        restored = json.loads((self.history / 'current.json').read_bytes())
        self.assertEqual(restored['operationId'], 'prior-cohort')
        self.assertEqual(restored['database']['inode'], self.live.stat().st_ino)

    def test_recovery_does_not_overwrite_another_operation(self):
        self.select(); manifest = json.loads((self.history / 'current.json').read_bytes())
        manifest['operationId'] = 'other-operation'
        host._registry_write(self.history / 'current.json', json.dumps(manifest).encode())
        with self.assertRaisesRegex(host.HostFailure, 'another historical cohort'):
            self.restore_verified()

    def test_housekeeping_accepts_cohort_records_but_rejects_mismatched_selection(self):
        from scripts.lib.housekeeping_journal import validate_journal_history
        self.select()
        start = {'version': 1, 'record': 'start', 'operationId': 'test-cohort', 'sourceSha': 'a' * 40,
                 'oldPair': {'cmsPath': str(self.old), 'staticPath': str(self.root / 'static')}}
        rows = [start, *self.journal.rows, {'version': 1, 'record': 'recovered',
                'operationId': 'test-cohort', 'sourceSha': 'a' * 40}]
        self.assertIn(str(self.new), validate_journal_history(rows))
        rows[-2]['manifest'] = {**rows[-2]['manifest'], 'registrySha256': 'b' * 64}
        with self.assertRaisesRegex(ValueError, 'differs from intent'): validate_journal_history(rows)

    def test_legacy_manifest_cannot_authorize_production_build(self):
        host._registry_write(self.history / 'current.json', json.dumps(self.binding).encode())
        with self.assertRaisesRegex(host.HostFailure, 'sealed'):
            host._historical_registry_environment(require_cohort=True, config=self.config)


if __name__ == '__main__': unittest.main()
