import json
import hashlib
import os
import sqlite3
import stat
import tempfile
import tarfile
import unittest
from argparse import Namespace
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host as host
from scripts.lib.rehearsal_state import RehearsalState


class ReleaseCleanupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ikpk-release-cleanup-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.releases = root / 'releases'
        self.releases.mkdir()
        self.current = self.releases / ('a' * 40 + '-flow-one')
        self.old = self.releases / ('b' * 40 + '-flow-zero')
        for path, commit in ((self.current, 'a' * 40), (self.old, 'b' * 40)):
            path.mkdir()
            (path / 'release.json').write_text(json.dumps({'commit': commit, 'snapshotId': 'snap:test'}))
        self.pointer = root / 'current'
        self.pointer.symlink_to(self.current)
        self.next_pointer = root / f'.current-next-{self.old.name}'
        self.next_pointer.symlink_to(f'releases/{self.old.name}')
        self.state_dir = root / 'operations'
        self.state_dir.mkdir()
        self.state = RehearsalState(self.state_dir)
        old_digest = host._tree_sha256(self.old)
        current_digest = host._tree_sha256(self.current)
        self.state._append({'version': 1, 'record': 'static-main-start', 'operationKind': 'static-main',
                            'operationId': 'flow-one', 'sourceSha': 'a' * 40,
                            'oldStaticPath': str(self.old.resolve()), 'oldStaticTreeSha256': old_digest})
        self.state._append({'version': 1, 'record': 'static-main-prepared', 'operationKind': 'static-main',
                            'operationId': 'flow-one', 'sourceSha': 'a' * 40,
                            'staticTreeSha256': current_digest, 'snapshotId': 'snap:test'})
        self.state._append({'version': 1, 'record': 'static-main-switch-intent', 'operationKind': 'static-main',
                            'operationId': 'flow-one', 'sourceSha': 'a' * 40,
                            'oldStaticPath': str(self.old.resolve()), 'candidateStaticPath': str(self.current.resolve()),
                            'staticTreeSha256': current_digest})
        self.state._append({'version': 1, 'record': 'static-main-switched', 'operationKind': 'static-main',
                            'operationId': 'flow-one', 'sourceSha': 'a' * 40, 'staticTreeSha256': current_digest})
        self.state._append({'version': 1, 'record': 'static-main-committed', 'operationKind': 'static-main',
                            'operationId': 'flow-one', 'sourceSha': 'a' * 40,
                            'staticTreeSha256': current_digest, 'snapshotId': 'snap:test'})
        self.cms_state = root / 'refresh' / 'state.json'
        self.cms_state.parent.mkdir()
        self.cms_state.write_text(json.dumps({'status': 'succeeded', 'phase': 'done', 'switched': True,
            'releaseId': self.current.name, 'previousReleaseId': 'releases/' + self.old.name,
            'cleanupPending': True, 'startedAt': '2026-01-01T00:00:00Z'}))
        self.marker_dir = root / 'marker'
        self.marker_dir.mkdir(mode=0o750)
        self.marker = self.marker_dir / host.SITE_PUBLICATION_MARKER
        self.marker.write_text(json.dumps({'version': 1, 'operationId': 'flow-one',
            'profile': 'staging194', 'phase': 'active'}))
        self.config = {'profile': 'staging194', 'cmsUser': 'root',
            'sitePublicationMarker': str(self.marker), 'siteRefreshState': str(self.cms_state),
            'staticReleaseRoot': str(self.releases), 'currentStatic': str(self.pointer),
            'stateDir': str(self.state_dir)}
        real_lstat = Path.lstat
        def lstat(path, *args, **kwargs):
            result = real_lstat(path, *args, **kwargs)
            if path in (self.marker_dir, self.marker):
                fields = list(result)
                fields[0] = stat.S_IFDIR | 0o750 if path == self.marker_dir else stat.S_IFREG | 0o640
                fields[4] = fields[5] = 0
                return os.stat_result(fields)
            return result
        self.stack = patch.object(Path, 'lstat', lstat)
        self.stack.start()
        self.addCleanup(self.stack.stop)
        self.fchown = patch.object(host.os, 'fchown')
        self.fchown.start()
        self.addCleanup(self.fchown.stop)
        self.marker_root = patch.object(host, 'SITE_PUBLICATION_MARKER_DIR', self.marker_dir)
        self.marker_root.start()
        self.addCleanup(self.marker_root.stop)
        self.mounts = patch.object(host, '_mount_points', return_value=set())
        self.mounts.start()
        self.addCleanup(self.mounts.stop)

    def test_previous_target_is_closed_before_delete_and_cleanup_retries_after_io_failure(self):
        real_remove = host._remove_release_tree
        calls = []
        def fail_first(path, mounts):
            calls.append(path)
            if len(calls) == 1:
                raise host.HostFailure('simulated unlink failure')
            return real_remove(path, mounts)
        with patch.object(host, '_remove_release_tree', side_effect=fail_first):
            with self.assertRaisesRegex(host.HostFailure, 'simulated unlink failure'):
                host._cleanup_site_releases(self.config, self.state, 'flow-one')
        partial = json.loads(self.cms_state.read_text())
        self.assertIsNone(partial['previousReleaseId'])
        self.assertTrue(partial['cleanupPending'])
        self.assertTrue(self.marker.exists())
        self.assertFalse(self.next_pointer.exists())
        self.assertEqual(json.loads(self.marker.read_text())['phase'], 'cleanup-pending')

        removed = host._cleanup_site_releases(self.config, self.state, None)
        self.assertEqual(removed, [str(self.old.resolve())])
        self.assertFalse(self.old.exists())
        self.assertTrue(self.current.exists())
        finished = json.loads(self.cms_state.read_text())
        self.assertFalse(finished['cleanupPending'])
        self.assertIsNone(finished['previousReleaseId'])
        self.assertFalse(self.marker.exists())

    def test_backup_retention_keeps_two_verified_terminal_operations_and_skips_unknown(self):
        backup_root = self.state_dir / 'backups'
        backup_root.mkdir()
        for operation in ('old-op', 'middle-op', 'latest-op', 'older-op', 'incomplete-op', 'static-op'):
            (backup_root / operation).mkdir()
        history = []
        database_path = str((self.state_dir / 'cms.sqlite').resolve())
        for operation, sha in (('older-op', '1' * 40), ('old-op', '2' * 40),
                               ('middle-op', '3' * 40), ('latest-op', '4' * 40)):
            history.extend((
                {'operationId': operation, 'record': 'start', 'sourceSha': sha,
                 'oldPair': {'cmsDatabaseProof': {'database': database_path}}},
                {'operationId': operation, 'record': 'new-bundle', 'sourceSha': sha},
                {'operationId': operation, 'record': 'committed', 'sourceSha': sha},
            ))
        history.append({'operationId': 'incomplete-op', 'record': 'start', 'sourceSha': '5' * 40,
                        'oldPair': {'cmsDatabaseProof': {'database': database_path}}})
        history.extend((
            {'operationId': 'static-op', 'record': 'static-main-start', 'sourceSha': '6' * 40,
             'operationKind': 'static-main'},
            {'operationId': 'static-op', 'record': 'static-main-committed', 'sourceSha': '6' * 40,
             'operationKind': 'static-main'},
        ))

        with patch.object(host, '_verified_cleanup_backup', side_effect=lambda path, op, db: op != 'middle-op'):
            candidates, reason = host._operation_backup_cleanup_candidates(backup_root, history, database_path, keep=2)

        self.assertEqual(candidates, [backup_root / 'older-op'])
        self.assertIsNone(reason)
        self.assertTrue((backup_root / 'old-op').exists())
        self.assertTrue((backup_root / 'middle-op').exists())
        self.assertTrue((backup_root / 'incomplete-op').exists())
        self.assertTrue((backup_root / 'static-op').exists())

        with patch.object(host, '_verified_cleanup_backup', return_value=False):
            skipped, reason = host._operation_backup_cleanup_candidates(backup_root, history, database_path, keep=2)
        self.assertEqual(skipped, [])
        self.assertIn('0 verified terminal operation backups', reason)

        other_database_history = [
            {'operationId': 'latest-op', 'record': 'start', 'sourceSha': '4' * 40,
             'oldPair': {'cmsDatabaseProof': {'database': '/different/database.sqlite'}}},
            {'operationId': 'latest-op', 'record': 'new-bundle', 'sourceSha': '4' * 40},
            {'operationId': 'latest-op', 'record': 'committed', 'sourceSha': '4' * 40},
        ]
        with patch.object(host, '_verified_cleanup_backup', return_value=True) as verify:
            mismatched, reason = host._operation_backup_cleanup_candidates(
                backup_root, other_database_history, database_path, keep=2)
        self.assertEqual(mismatched, [])
        self.assertIn('0 verified terminal operation backups', reason)
        verify.assert_not_called()

    def test_backup_verification_checks_archive_database_and_media_without_extracting(self):
        backup = self.state_dir / 'backups' / 'valid-op'
        media_dir = backup / 'media'
        media_dir.mkdir(parents=True)
        database = backup / 'database.sqlite'
        connection = sqlite3.connect(database)
        connection.execute('CREATE TABLE proof (value TEXT)')
        connection.execute("INSERT INTO proof VALUES ('ok')")
        connection.commit()
        connection.close()
        media = b'preserved media'
        media_sha = hashlib.sha256(media).hexdigest()
        (media_dir / f'sha256:{media_sha}').write_bytes(media)
        media_inventory = [{'url': '/uploads/proof.txt', 'sha256': media_sha, 'size': len(media),
                            'originalName': 'proof.txt', 'mode': 0o600, 'uid': 0, 'gid': 0,
                            'file': f'media/sha256:{media_sha}'}]
        media_doc = {'media': media_inventory}
        media_bytes = json.dumps(media_doc, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        (backup / 'media-manifest.json').write_bytes(media_bytes)
        database_sha = hashlib.sha256(database.read_bytes()).hexdigest()
        manifest = {'version': 1, 'operationId': 'valid-op', 'database': '/srv/cms.sqlite',
                    'postCheckpointLiveSha256': database_sha, 'databaseSha256': database_sha,
                    'mediaManifestSha256': hashlib.sha256(media_bytes).hexdigest(), 'media': media_inventory}
        manifest_path = backup / 'manifest.json'
        manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n')
        archive = backup / 'backup.tar'
        with tarfile.open(archive, 'w') as output:
            for path in sorted(backup.rglob('*')):
                if path == archive:
                    continue
                output.add(path, arcname=str(path.relative_to(backup)), recursive=False)
        manifest['archiveSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n')

        self.assertTrue(host._verified_cleanup_backup(backup, 'valid-op', '/srv/cms.sqlite'))
        database.write_bytes(database.read_bytes() + b'corruption')
        self.assertFalse(host._verified_cleanup_backup(backup, 'valid-op', '/srv/cms.sqlite'))
        self.assertFalse(host._verified_cleanup_backup(backup, 'valid-op', '/different/database.sqlite'))

    def test_cleanup_marker_survives_backup_stage_failure_after_site_cleanup_and_retry(self):
        cms_release_root = self.state_dir / 'cms-releases'
        cms_release_root.mkdir()
        stale_cms = cms_release_root / ('c' * 40 + '-cms-old')
        stale_cms.mkdir()
        backup_root = self.state_dir / 'backups'
        backup_root.mkdir()
        database = self.state_dir / 'cms.sqlite'
        database.write_bytes(b'fixture')
        self.config['backupRoot'] = str(backup_root)
        self.config['cmsDatabase'] = str(database)

        with patch.object(host, '_operation_backup_cleanup_candidates',
                          side_effect=[host.HostFailure('simulated backup inspection failure'), ([], None)]):
            with self.assertRaisesRegex(host.HostFailure, 'simulated backup inspection failure'):
                host._cleanup_site_releases(self.config, self.state, 'flow-one')
            self.assertFalse(self.old.exists())
            self.assertTrue(self.current.exists())
            self.assertTrue(stale_cms.exists())
            self.assertTrue(self.marker.exists())
            self.assertEqual(json.loads(self.marker.read_text())['phase'], 'cleanup-pending')

            host._cleanup_site_releases(self.config, self.state, None)

        self.assertTrue(stale_cms.exists())
        self.assertTrue(self.current.exists())
        self.assertFalse(self.marker.exists())

    def test_unfinished_operation_blocks_cleanup_before_pointer_expiry(self):
        unfinished = RehearsalState(self.state_dir)
        unfinished._append({'version': 1, 'record': 'static-main-start', 'operationKind': 'static-main',
                            'operationId': 'in-flight', 'sourceSha': 'c' * 40})
        before = json.loads(self.cms_state.read_text())
        with self.assertRaisesRegex(host.HostFailure, 'unfinished|inconsistent'):
            host._cleanup_site_releases(self.config, unfinished, 'flow-one')
        self.assertEqual(json.loads(self.cms_state.read_text()), before)
        self.assertTrue(self.old.exists())

    def test_partial_rollback_intent_is_read_only_and_blocks_cleanup(self):
        raw = self.state.journal_path.read_bytes() + (
            b'{"version":1,"record":"static-main-rollback-intent",'
            b'"operationKind":"static-main","operationId":"flow-one",'
            b'"oldStaticPath":"'
        )
        self.state.journal_path.write_bytes(raw)
        with self.assertRaisesRegex(host.HostFailure, "incomplete tail"):
            host._cleanup_site_releases(self.config, self.state, "flow-one")
        self.assertEqual(self.state.journal_path.read_bytes(), raw)
        self.assertTrue(self.old.exists())
        self.assertEqual(json.loads(self.marker.read_text())["phase"], "active")

    def test_dispatch_preflights_torn_rollback_before_any_repairing_journal_reader(self):
        raw = self.state.journal_path.read_bytes() + (
            b'{"version":1,"record":"static-main-rollback-intent",'
            b'"operationKind":"static-main","operationId":"flow-one",'
            b'"oldStaticPath":"'
        )
        self.state.journal_path.write_bytes(raw)
        publication_lock = self.state_dir / ".publication.lock"
        publication_lock.write_bytes(b"")
        publication_lock.chmod(0o600)
        config = {**self.config, "publicationLock": str(publication_lock)}
        with patch.object(host.os, "geteuid", return_value=0), \
             patch.object(host, "_root_config", return_value=config), \
             patch.object(host, "_destination_publication_lock", return_value=nullcontext()), \
             patch.object(host, "_reserve_site_refresh_lock") as reserve, \
             patch.object(host, "_remove_release_tree") as remove:
            with self.assertRaisesRegex(host.HostFailure, "incomplete tail"):
                host.dispatch(Namespace(profile="staging194", action="static-main", operation_id="flow-one"))
        self.assertEqual(self.state.journal_path.read_bytes(), raw)
        self.assertTrue(self.old.exists())
        reserve.assert_not_called()
        remove.assert_not_called()

    def test_cleanup_rejects_rollback_intent_without_valid_operation_identity(self):
        row = {"version": 1, "record": "static-main-rollback-intent",
               "operationKind": "static-main", "operationId": "invalid id"}
        self.state._append(row)
        before = self.state.journal_path.read_bytes()
        with self.assertRaisesRegex(host.HostFailure, "malformed"):
            host._cleanup_site_releases(self.config, self.state, "flow-one")
        self.assertEqual(self.state.journal_path.read_bytes(), before)
        self.assertTrue(self.old.exists())

    def test_cleanup_rejects_terminal_record_before_start_for_each_writer_family(self):
        for terminal, start in (
            ({'version': 1, 'record': 'committed', 'operationId': 'orphan-paired', 'sourceSha': 'c' * 40},
             {'version': 1, 'record': 'start', 'operationId': 'orphan-paired', 'sourceSha': 'c' * 40}),
            ({'version': 1, 'record': 'static-main-committed', 'operationKind': 'static-main',
              'operationId': 'orphan-static', 'sourceSha': 'd' * 40},
             {'version': 1, 'record': 'static-main-start', 'operationKind': 'static-main',
              'operationId': 'orphan-static', 'sourceSha': 'd' * 40}),
        ):
            with self.subTest(kind=terminal['record']):
                state = RehearsalState(self.state_dir)
                state._append(terminal)
                state._append(start)
                before = state.journal_path.read_bytes()
                with self.assertRaisesRegex(host.HostFailure, 'inconsistent'):
                    host._cleanup_site_releases(self.config, state, 'flow-one')
                self.assertEqual(state.journal_path.read_bytes(), before)
                self.assertTrue(self.old.exists())

    def test_cleanup_rejects_rollback_intent_after_completed_rollback(self):
        source_sha = 'a' * 40
        old_digest = host._tree_sha256(self.old)
        candidate_digest = host._tree_sha256(self.current)
        details = {'version': 1, 'operationKind': 'static-main', 'operationId': 'flow-one',
                   'sourceSha': source_sha, 'oldStaticPath': str(self.old.resolve()),
                   'oldStaticTreeSha256': old_digest, 'candidateStaticPath': str(self.current.resolve()),
                   'candidateStaticTreeSha256': candidate_digest, 'committedStaticTreeSha256': candidate_digest,
                   'snapshotId': 'snap:test', 'operator': 'operator', 'reason': 'recovery test'}
        self.state._append({'record': 'static-main-rollback-intent', **details})
        self.state._append({'record': 'static-main-rollback-completed', 'restoredStaticPath': str(self.old.resolve()),
                            **details})
        self.state._append({'record': 'static-main-rollback-intent', **details})
        before = self.state.journal_path.read_bytes()
        with self.assertRaisesRegex(host.HostFailure, 'inconsistent'):
            host._cleanup_site_releases(self.config, self.state, 'flow-one')
        self.assertEqual(self.state.journal_path.read_bytes(), before)
        self.assertTrue(self.old.exists())

    def test_status_then_cleanup_never_repairs_torn_rollback_intent(self):
        raw = self.state.journal_path.read_bytes() + (
            b'{"version":1,"record":"static-main-rollback-intent",'
            b'"operationKind":"static-main","operationId":"flow-one",'
            b'"oldStaticPath":"'
        )
        self.state.journal_path.write_bytes(raw)
        config = {**self.config, "publicationLock": str(self.state_dir / ".publication.lock")}
        (self.state_dir / ".publication.lock").write_bytes(b"")
        (self.state_dir / ".publication.lock").chmod(0o600)
        with patch.object(host.os, "geteuid", return_value=0), \
             patch.object(host, "_root_config", return_value=config), \
             patch.object(host, "_destination_publication_lock", side_effect=AssertionError("status must not take destination lock")) as destination_lock:
            with self.assertRaisesRegex(host.HostFailure, "incomplete tail"):
                host.dispatch(Namespace(profile="staging194", action="status", operation_id="flow-one"))
            destination_lock.assert_not_called()
            with self.assertRaisesRegex(host.HostFailure, "incomplete tail"):
                host._cleanup_site_releases(config, self.state, "flow-one")
        self.assertEqual(self.state.journal_path.read_bytes(), raw)
        self.assertTrue(self.old.exists())


if __name__ == '__main__':
    unittest.main()
