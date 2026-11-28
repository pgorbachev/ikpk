import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile
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
        self.current.mkdir()
        (self.current / 'index.html').write_text('current release')
        self.current_static_payload_digest = host._tree_sha256(self.current)
        (self.current / 'release.json').write_text(json.dumps({'commit': 'a' * 40,
            'operationId': 'flow-one', 'snapshotId': 'snap:test',
            'staticTreeSha256': self.current_static_payload_digest}))
        self.old.mkdir()
        (self.old / 'index.html').write_text('previous release')
        (self.old / 'release.json').write_text(json.dumps({'commit': 'b' * 40,
            'operationId': 'flow-zero', 'snapshotId': 'snap:old'}))
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
                            'operationId': 'flow-one', 'sourceSha': 'a' * 40,
                            'staticTreeSha256': current_digest})
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
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))
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

        result = host._cleanup_site_releases(self.config, self.state, None)
        self.assertEqual(result['removedReleases'], [str(stale.resolve())])
        self.assertTrue(self.old.exists(), 'the rollback target survives retry')
        self.assertFalse(stale.exists())
        self.assertTrue(self.current.exists())
        finished = json.loads(self.cms_state.read_text())
        self.assertFalse(finished['cleanupPending'])
        self.assertIsNone(finished['previousReleaseId'])
        self.assertFalse(self.marker.exists())

    def test_static_main_cleanup_retains_exact_journal_rollback_target(self):
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))

        result = host._cleanup_site_releases(self.config, self.state, 'flow-one')

        self.assertEqual(result['removedReleases'], [str(stale.resolve())])
        self.assertTrue(self.current.is_dir(), 'the active release must remain')
        self.assertTrue(self.old.is_dir(), 'the journal-bound previous release must remain rollbackable')
        self.assertEqual(host._tree_sha256(self.old), self.state._operation_rows('flow-one')[0]['oldStaticTreeSha256'])
        self.assertFalse(stale.exists(), 'unrelated verified stale releases remain eligible for cleanup')

    def test_journal_identified_legacy_rollback_tree_is_retained_without_manifest(self):
        (self.old / 'release.json').unlink()
        rows = self.state.read_journal_for_cleanup()
        rows[0]['oldStaticTreeSha256'] = host._tree_sha256(self.old)
        self.state.journal_path.write_text('')
        for row in rows:
            self.state._append(row)
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))

        result = host._cleanup_site_releases(self.config, self.state, 'flow-one')

        self.assertEqual(result['removedReleases'], [str(stale.resolve())])
        self.assertTrue(self.current.is_dir())
        self.assertTrue(self.old.is_dir(), 'the old path and recorded tree digest identify this legacy rollback target')
        self.assertFalse((self.old / 'release.json').exists(), 'retention must not fabricate release metadata')
        self.assertFalse(stale.exists())

    def test_unidentified_legacy_directory_is_retained_and_reported_while_verified_cleanup_continues(self):
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))
        unknown = self.releases / 'legacy-unidentified'
        unknown.mkdir()
        (unknown / 'payload.txt').write_text('unidentified data')

        result = host._cleanup_after_commit(self.config, self.state, 'flow-one')

        self.assertEqual(result['removedReleases'], [str(stale.resolve())])
        self.assertEqual(result['retainedLegacy'], [{
            'path': str(unknown.resolve()), 'reason': 'release metadata is missing or unreadable'}])
        self.assertTrue(self.current.is_dir())
        self.assertTrue(self.old.is_dir())
        self.assertFalse(stale.exists(), 'verified old releases remain eligible for cleanup')
        self.assertTrue(unknown.is_dir())
        self.assertFalse(self.next_pointer.exists())
        self.assertFalse(self.marker.exists(), 'cleanup completes while explicitly reporting retained legacy data')

    def test_missing_journal_rollback_target_reports_degraded_before_cleanup(self):
        shutil.rmtree(self.old)
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))

        result = host._cleanup_after_commit(self.config, self.state, 'flow-one')

        self.assertTrue(result['cleanupPending'])
        self.assertIn('rollback target expired or unavailable', result['cleanupError'])
        self.assertTrue(self.current.is_dir())
        self.assertTrue(stale.is_dir(), 'unavailable rollback must prevent cleanup from claiming success')
        self.assertTrue(self.next_pointer.is_symlink())
        self.assertTrue(self.marker.exists())
        self.assertEqual(json.loads(self.marker.read_text())['phase'], 'cleanup-pending')

    def test_tampered_static_candidate_cannot_fall_back_to_matching_cms_state(self):
        (self.current / 'tampered.txt').write_text('changed after commit')
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))

        result = host._cleanup_after_commit(self.config, self.state, 'flow-one')

        self.assertTrue(result['cleanupPending'])
        self.assertIn('static-main candidate differs', result['cleanupError'])
        self.assertTrue(self.current.is_dir())
        self.assertTrue(self.old.is_dir())
        self.assertTrue(stale.is_dir())
        self.assertEqual(json.loads(self.marker.read_text())['phase'], 'cleanup-pending')

    def test_tampered_paired_candidate_cannot_fall_back_to_matching_cms_state(self):
        digest = 'd' * 64
        database = self.state_dir / 'cms.sqlite'
        database.write_bytes(b'fixture database')
        old_pair = {'cmsPath': str(self.old.resolve()), 'staticPath': str(self.old.resolve()),
                    'staticTreeSha256': host._tree_sha256(self.old)}
        new_pair = {'sourceSha': 'a' * 40, 'cmsSha': 'a' * 40, 'staticSha': 'a' * 40,
                    'cmsPayloadSha256': digest, 'staticTreeSha256': host._tree_sha256(self.current),
                    'cmsDatabaseSha256': digest, 'cmsMediaManifestSha256': digest,
                    'cmsCaptureBundleSha256': digest, 'oldDatabaseSha256': digest,
                    'oldMediaManifestSha256': digest, 'configSha256': digest,
                    'snapshotId': 'snap:test',
                    'cmsDatabaseProof': {'pid': 123, 'device': 1, 'inode': 1, 'database': str(database)}}
        paired_rows = [
            {'version': 1, 'record': 'start', 'operationId': 'flow-one', 'sourceSha': 'a' * 40,
             'oldPair': old_pair},
            {'version': 1, 'record': 'new-bundle', 'operationId': 'flow-one',
             'sourceSha': 'a' * 40, 'newPair': new_pair},
            {'version': 1, 'record': 'committed', 'operationId': 'flow-one', 'sourceSha': 'a' * 40},
        ]
        self.state.journal_path.write_text('')
        for row in paired_rows:
            self.state._append(row)
        (self.current / 'tampered.txt').write_text('changed after commit')
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))

        result = host._cleanup_after_commit(self.config, self.state, 'flow-one')

        self.assertTrue(result['cleanupPending'])
        self.assertIn('paired candidate differs', result['cleanupError'])
        self.assertTrue(self.current.is_dir())
        self.assertTrue(self.old.is_dir())
        self.assertTrue(stale.is_dir())
        self.assertEqual(json.loads(self.marker.read_text())['phase'], 'cleanup-pending')

    def test_cms_refresh_cleanup_accepts_current_identity_without_static_main_journal(self):
        self.state.journal_path.write_text('')
        self.marker.write_text(json.dumps({'version': 1, 'operationId': 'flow-one',
            'profile': 'staging194', 'phase': 'cleanup-pending'}))
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))

        result = host._cleanup_site_releases(self.config, self.state, None)

        self.assertEqual(result['removedReleases'], [str(self.old.resolve()), str(stale.resolve())])
        self.assertEqual(result['retainedLegacy'], [])
        self.assertTrue(self.current.is_dir())
        self.assertFalse(self.old.exists())
        self.assertFalse(self.marker.exists())

    def test_paired_terminal_commit_cleanup_does_not_require_static_main_journal(self):
        self.state.journal_path.write_text('')
        database = self.state_dir / 'cms.sqlite'
        database.write_bytes(b'fixture database')
        old_pair = {'cmsPath': str(self.old.resolve()), 'staticPath': str(self.old.resolve()),
                    'staticTreeSha256': host._tree_sha256(self.old)}
        digest = 'd' * 64
        new_pair = {'sourceSha': 'a' * 40, 'cmsSha': 'a' * 40, 'staticSha': 'a' * 40,
                    'cmsPayloadSha256': digest, 'staticTreeSha256': host._tree_sha256(self.current),
                    'cmsDatabaseSha256': digest, 'cmsMediaManifestSha256': digest,
                    'cmsCaptureBundleSha256': digest, 'oldDatabaseSha256': digest,
                    'oldMediaManifestSha256': digest, 'configSha256': digest,
                    'snapshotId': 'snap:test',
                    'cmsDatabaseProof': {'pid': 123, 'device': 1, 'inode': 1, 'database': str(database)}}
        for row in (
            {'version': 1, 'record': 'start', 'operationId': 'flow-one', 'sourceSha': 'a' * 40,
             'oldPair': old_pair},
            {'version': 1, 'record': 'new-bundle', 'operationId': 'flow-one', 'sourceSha': 'a' * 40,
             'newPair': new_pair},
            {'version': 1, 'record': 'committed', 'operationId': 'flow-one', 'sourceSha': 'a' * 40},
        ):
            self.state._append(row)
        stale = self.releases / ('c' * 40 + '-stale')
        stale.mkdir()
        (stale / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))

        result = host._cleanup_site_releases(self.config, self.state, 'flow-one')

        self.assertEqual(result['removedReleases'], [str(self.old.resolve()), str(stale.resolve())])
        self.assertEqual(result['retainedLegacy'], [])
        self.assertTrue(self.current.is_dir())

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
        backup_root = self.state_dir / 'backups'
        backup_root.mkdir()
        database = self.state_dir / 'cms.sqlite'
        media_root = self.state_dir / 'uploads'
        media_root.mkdir()
        (media_root / 'proof.txt').write_bytes(b'preserved media')
        connection = sqlite3.connect(database)
        connection.execute('CREATE TABLE proof (value TEXT)')
        connection.execute("INSERT INTO proof VALUES ('ok')")
        connection.commit()
        connection.close()
        with patch.object(host, '_assert_no_database_handles'):
            host._backup({'cmsDatabase': str(database), 'backupRoot': str(backup_root),
                          'mediaRoots': [{'path': str(media_root), 'prefix': '/uploads/'}]}, 'valid-op')
        backup = backup_root / 'valid-op'

        self.assertTrue(host._verified_cleanup_backup(backup, 'valid-op', str(database.resolve())))
        backup_database = backup / 'database.sqlite'
        backup_database.write_bytes(backup_database.read_bytes() + b'corruption')
        self.assertFalse(host._verified_cleanup_backup(backup, 'valid-op', str(database.resolve())))
        self.assertFalse(host._verified_cleanup_backup(backup, 'valid-op', '/different/database.sqlite'))

    def test_production_backup_cleanup_checks_the_bound_registry(self):
        directory = self.state_dir.resolve() / 'registry'
        directory.mkdir()
        registry = b'[]'
        digest = hashlib.sha256(registry).hexdigest()
        (directory / f'registry-{digest}.json').write_bytes(registry)
        backup_root = self.state_dir.resolve() / 'backups'
        backup_root.mkdir()
        database = self.state_dir.resolve() / 'cms.sqlite'
        with sqlite3.connect(database) as connection:
            connection.execute('CREATE TABLE proof (value TEXT)')
        media_root = self.state_dir / 'uploads'
        media_root.mkdir()
        with patch.object(host, '_assert_no_database_handles'), \
             patch.object(host, '_current_historical_manifest', return_value={'registrySha256': digest}), \
             patch.object(host, 'HISTORICAL_REGISTRY_DIRECTORY', directory):
            host._backup({'profile': 'production-paired', 'cmsDatabase': str(database), 'backupRoot': str(backup_root),
                          'mediaRoots': [{'path': str(media_root), 'prefix': '/uploads/'}]}, 'registry-op')
        backup = backup_root / 'registry-op'
        self.assertTrue(host._verified_cleanup_backup(backup, 'registry-op', str(database)))
        (backup / 'historical-registry.json').write_bytes(b'[1]')
        self.assertFalse(host._verified_cleanup_backup(backup, 'registry-op', str(database)))
        (backup / 'historical-registry.json').unlink()
        self.assertFalse(host._verified_cleanup_backup(backup, 'registry-op', str(database)))

    def test_cleanup_marker_survives_backup_stage_failure_after_site_cleanup_and_retry(self):
        cms_release_root = self.state_dir / 'cms-releases'
        cms_release_root.mkdir()
        stale_cms = cms_release_root / ('c' * 40 + '-cms-old')
        stale_cms.mkdir()
        stale_site = self.releases / ('c' * 40 + '-stale')
        stale_site.mkdir()
        (stale_site / 'release.json').write_text(json.dumps({'commit': 'c' * 40, 'snapshotId': 'snap:stale'}))
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
            self.assertTrue(self.old.exists(), 'the rollback target survives a later backup-stage failure')
            self.assertFalse(stale_site.exists(), 'the verified site cleanup stage completed before backup failure')
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
             patch.object(host, "_remove_release_tree") as remove:
            with self.assertRaisesRegex(host.HostFailure, "incomplete tail"):
                host.dispatch(Namespace(profile="staging194", action="static-main", operation_id="flow-one"))
        self.assertEqual(self.state.journal_path.read_bytes(), raw)
        self.assertTrue(self.old.exists())
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

    def test_production_static_commit_reports_no_cms_cleanup_pending(self):
        static_root = self.releases.parent / 'production-static-sources'
        static_root.mkdir()
        for name in ('a' * 40 + '-flow-one', 'b' * 40 + '-flow-zero'):
            (static_root / name).mkdir()
            (static_root / name / 'index.html').write_text('static source')
        cms_current = self.releases.parent / 'opt-cms-current'
        cms_current.mkdir()
        config = {**self.config, 'profile': 'production-static',
                  'releaseRoot': str(static_root), 'currentCms': str(cms_current)}

        result = host._cleanup_after_commit(config, self.state, 'flow-one')

        self.assertFalse(result.get('cleanupPending'), result)
        self.assertNotIn('cleanupError', result)
        self.assertEqual(result['removedCmsReleases'], [])
        # static-source-retention: the committed source goes; flow-zero has no journal rows, so it is kept and reported.
        self.assertFalse((static_root / ('a' * 40 + '-flow-one')).exists())
        self.assertEqual(result['retainedUnknownStaticSources'],
                         [str((static_root / ('b' * 40 + '-flow-zero')).resolve())])

    # Production source retention. Sources live in releaseRoot (`<sha>-<operationId>`); the served
    # static releases stay in staticReleaseRoot, which self.config already provides.
    def _production_sources(self):
        sources = Path(self.tmp.name) / 'production-static-sources'
        sources.mkdir(exist_ok=True)
        self.production_config = {**self.config, 'profile': 'production-static', 'releaseRoot': str(sources)}
        return sources

    def _source_tree(self, sources, name):
        tree = sources / name
        tree.mkdir()
        (tree / 'index.html').write_text(name, encoding='utf-8')
        return tree

    def _static_op(self, operation_id, source_sha, records):
        """Append static-main rows for one operation; `records` lists the record names in order.

        Field values follow the validator in housekeeping_journal.validate_journal_history.
        """
        digest = 'e' * 64
        old_path = str(self.old.resolve())
        candidate_path = str((Path(self.production_config['releaseRoot']) / f'{source_sha}-{operation_id}').resolve())
        old_digest = host._tree_sha256(self.old)
        fields = {
            'static-main-start': {'oldStaticPath': old_path, 'oldStaticTreeSha256': old_digest},
            'static-main-prepared': {'staticTreeSha256': digest, 'snapshotId': 'snap:fixture'},
            'static-main-switch-intent': {'oldStaticPath': old_path, 'candidateStaticPath': candidate_path,
                                          'staticTreeSha256': digest},
            'static-main-switched': {'staticTreeSha256': digest},
            'static-main-committed': {'staticTreeSha256': digest, 'snapshotId': 'snap:fixture'},
            'static-main-rolled-back': {'restoredStaticPath': old_path},
            'static-main-recovered': {'restoredStaticPath': old_path},
            'static-main-rollback-expired': {
                'oldStaticPath': old_path, 'oldStaticTreeSha256': old_digest,
                'candidateStaticPath': candidate_path, 'candidateStaticTreeSha256': digest,
                'committedStaticTreeSha256': digest, 'snapshotId': 'snap:fixture', 'targetState': 'absent',
                'operator': 'operator', 'reason': 'fixture expiry'},
        }
        for record in records:
            self.state._append({'version': 1, 'record': record, 'operationKind': 'static-main',
                                'operationId': operation_id, 'sourceSha': source_sha,
                                **fields.get(record, {})})

    # Guard P1: every terminal static-main source under releaseRoot, including the just-committed one, is removed.
    # Mutation: in _cleanup_after_commit drop the production source-removal step.
    def test_production_commit_removes_every_terminal_static_source(self):
        sources = self._production_sources()
        self._static_op('flow-zero', 'b' * 40, ['static-main-start', 'static-main-prepared', 'static-main-recovered'])
        self._source_tree(sources, 'a' * 40 + '-flow-one')
        self._source_tree(sources, 'b' * 40 + '-flow-zero')

        result = host._cleanup_after_commit(self.production_config, self.state, 'flow-one')

        self.assertFalse(result.get('cleanupPending'), result)
        self.assertFalse((sources / ('a' * 40 + '-flow-one')).exists(), 'the just-committed source must be removed')
        self.assertFalse((sources / ('b' * 40 + '-flow-zero')).exists(), 'an older terminal source must be removed')

    # Guard P2 (GREEN today, guard): an unfinished operation refuses cleanup and no source is removed.
    # Mutation: remove the `_unfinished_operation_ids` refusal before the source-removal step.
    def test_production_unfinished_operation_refuses_source_cleanup(self):
        sources = self._production_sources()
        self._static_op('flow-zero', 'b' * 40, ['static-main-start', 'static-main-prepared', 'static-main-recovered'])
        self._static_op('in-flight', 'c' * 40, ['static-main-start'])
        self._source_tree(sources, 'a' * 40 + '-flow-one')
        self._source_tree(sources, 'b' * 40 + '-flow-zero')

        result = host._cleanup_after_commit(self.production_config, self.state, 'flow-one')

        self.assertTrue(result.get('cleanupPending'), result)
        self.assertIn('unfinished', result.get('cleanupError', ''))
        self.assertTrue((sources / ('a' * 40 + '-flow-one')).is_dir())
        self.assertTrue((sources / ('b' * 40 + '-flow-zero')).is_dir())

    # Guard P3: an entry matching no static-main operation is kept and listed in retainedUnknownStaticSources.
    # Mutation: treat every `<sha>-<id>` directory as removable without consulting the journal.
    def test_production_unknown_source_is_kept_and_reported(self):
        sources = self._production_sources()
        self._static_op('flow-zero', 'b' * 40, ['static-main-start', 'static-main-prepared', 'static-main-recovered'])
        self._source_tree(sources, 'a' * 40 + '-flow-one')
        self._source_tree(sources, 'b' * 40 + '-flow-zero')
        ghost = self._source_tree(sources, 'd' * 40 + '-ghost-op')

        result = host._cleanup_after_commit(self.production_config, self.state, 'flow-one')

        self.assertEqual(result.get('retainedUnknownStaticSources'), [str(ghost.resolve())], result)
        self.assertTrue(ghost.is_dir())
        self.assertFalse((sources / ('b' * 40 + '-flow-zero')).exists())

    # Guard P4: rolled-back and rollback-expired operations are terminal, so their sources are removable.
    # Mutation: drop 'static-main-rolled-back' / 'static-main-rollback-expired' from the terminal set.
    def test_production_rolled_back_and_expired_sources_are_removable(self):
        sources = self._production_sources()
        self._static_op('flow-rb', 'd' * 40, ['static-main-start', 'static-main-prepared',
                                              'static-main-switch-intent', 'static-main-rolled-back'])
        self._static_op('flow-exp', 'e' * 40, ['static-main-start', 'static-main-prepared',
                                               'static-main-switch-intent', 'static-main-switched',
                                               'static-main-committed', 'static-main-rollback-expired'])
        self._source_tree(sources, 'a' * 40 + '-flow-one')
        rolled_back = self._source_tree(sources, 'd' * 40 + '-flow-rb')
        expired = self._source_tree(sources, 'e' * 40 + '-flow-exp')

        result = host._cleanup_after_commit(self.production_config, self.state, 'flow-one')

        self.assertFalse(result.get('cleanupPending'), result)
        self.assertFalse(rolled_back.exists(), 'a rolled-back operation is terminal')
        self.assertFalse(expired.exists(), 'a rollback-expired operation is terminal')

    # Guard P5 (GREEN today, guard): a corrupt or non-regular journal removes nothing and reports cleanupPending.
    # A missing journal is NOT covered here: it reads as empty history by design.
    # Mutation: catch RehearsalRefusal around read_journal_for_cleanup and continue with an empty history.
    def test_production_corrupt_or_unsafe_journal_removes_nothing(self):
        sources = self._production_sources()
        self._static_op('flow-zero', 'b' * 40, ['static-main-start', 'static-main-prepared', 'static-main-recovered'])
        self._source_tree(sources, 'a' * 40 + '-flow-one')
        self._source_tree(sources, 'b' * 40 + '-flow-zero')
        raw = self.state.journal_path.read_bytes()
        real_copy = Path(self.tmp.name) / 'journal-copy'
        real_copy.write_bytes(raw)
        for label in ('corrupt-line', 'symlink-journal'):
            with self.subTest(label=label):
                self.state.journal_path.unlink()
                if label == 'corrupt-line':
                    self.state.journal_path.write_bytes(raw + b'{not json}\n')
                else:
                    self.state.journal_path.symlink_to(real_copy)
                try:
                    result = host._cleanup_after_commit(self.production_config, self.state, 'flow-one')
                finally:
                    self.state.journal_path.unlink()
                    self.state.journal_path.write_bytes(raw)
                self.assertTrue(result.get('cleanupPending'), result)
                self.assertTrue((sources / ('a' * 40 + '-flow-one')).is_dir())
                self.assertTrue((sources / ('b' * 40 + '-flow-zero')).is_dir())

    # Guard P6 (GREEN today, guard): a symlink candidate is not followed; a candidate holding a mount point is not removed.
    # Mutation: call shutil.rmtree on candidates without the lstat/symlink check, or skip the mount check.
    def test_production_symlink_and_mount_candidates_are_not_followed_or_removed(self):
        sources = self._production_sources()
        outside = Path(self.tmp.name) / 'outside-tree'
        outside.mkdir()
        (outside / 'keep.txt').write_text('outside', encoding='utf-8')
        self._static_op('flow-link', 'e' * 40, ['static-main-start', 'static-main-prepared', 'static-main-recovered'])
        self._static_op('flow-mnt', 'f' * 40, ['static-main-start', 'static-main-prepared', 'static-main-recovered'])
        link = sources / ('e' * 40 + '-flow-link')
        link.symlink_to(outside, target_is_directory=True)
        mounted = self._source_tree(sources, 'f' * 40 + '-flow-mnt')
        self._source_tree(sources, 'a' * 40 + '-flow-one')

        with patch.object(host, '_mount_points', return_value={mounted.resolve()}):
            host._cleanup_after_commit(self.production_config, self.state, 'flow-one')

        self.assertTrue((outside / 'keep.txt').is_file(), 'a symlink candidate must not be followed')
        self.assertTrue(link.is_symlink(), 'a symlink candidate must not be removed')
        self.assertTrue(mounted.is_dir(), 'a candidate containing a mount point must not be removed')

    # Guard P7: a second cleanup run after a successful first run reports nothing pending and changes nothing.
    # Mutation: make the first run leave the marker or a retained entry in place.
    def test_production_cleanup_is_idempotent(self):
        sources = self._production_sources()
        self._static_op('flow-zero', 'b' * 40, ['static-main-start', 'static-main-prepared', 'static-main-recovered'])
        self._source_tree(sources, 'a' * 40 + '-flow-one')
        self._source_tree(sources, 'b' * 40 + '-flow-zero')

        first = host._cleanup_after_commit(self.production_config, self.state, 'flow-one')
        self.assertFalse(first.get('cleanupPending'), first)
        self.assertFalse((sources / ('a' * 40 + '-flow-one')).exists())

        second = host._cleanup_after_commit(self.production_config, self.state, 'flow-one')
        self.assertFalse(second.get('cleanupPending'), second)
        self.assertEqual(second.get('retainedUnknownStaticSources', []), [])
        self.assertFalse((sources / ('a' * 40 + '-flow-one')).exists())
        self.assertFalse((sources / ('b' * 40 + '-flow-zero')).exists())


class CmsReleaseCleanupTests(unittest.TestCase):
    def _state(self, history, unfinished=()):
        return type("State", (), {
            "read_journal_for_cleanup": lambda self, validate_history=False: history,
            "_unfinished_operation_ids": staticmethod(lambda _rows: set(unfinished)),
        })()

    def _layout(self):
        temporary = tempfile.TemporaryDirectory(prefix="ikpk-cms-cleanup-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / "releases"
        root.mkdir()
        current = root / "current-release"
        rollback = root / "rollback-release"
        stale = root / "stale-release"
        for directory in (current, rollback, stale):
            directory.mkdir()
            (directory / "marker").write_text(directory.name, encoding="utf-8")
        pointer = Path(temporary.name) / "current"
        pointer.symlink_to(current / "cms-artifact")
        (current / "cms-artifact").mkdir()
        history = [{
            "record": "start", "operationId": "op-current",
            "oldPair": {"cmsPath": str((rollback / "cms-artifact").resolve())},
        }, {
            "record": "committed", "operationId": "op-current",
        }]
        (rollback / "cms-artifact").mkdir()
        config = {"releaseRoot": str(root), "currentCms": str(pointer)}
        return config, current, rollback, stale, history

    def test_cms_cleanup_removes_only_finished_release_outside_current_and_rollback(self):
        config, current, rollback, stale, history = self._layout()
        with patch.object(host, "_mount_points", return_value=set()):
            removed = host._cleanup_cms_releases(config, self._state(history))
        self.assertEqual(removed, [str(stale.resolve())])
        self.assertTrue(current.exists())
        self.assertTrue(rollback.exists())
        self.assertFalse(stale.exists())

    def test_cms_cleanup_still_runs_for_production_paired_profile(self):
        config, current, rollback, stale, history = self._layout()
        config["profile"] = "production-paired"
        with patch.object(host, "_mount_points", return_value=set()):
            removed = host._cleanup_cms_releases(config, self._state(history))
        self.assertEqual(removed, [str(stale.resolve())])
        self.assertFalse(stale.exists())

    def test_cms_cleanup_refuses_while_a_publication_is_unfinished(self):
        config, current, rollback, stale, history = self._layout()
        with self.assertRaisesRegex(host.HostFailure, "unfinished"):
            host._cleanup_cms_releases(config, self._state(history, unfinished={"op-next"}))
        self.assertTrue(stale.exists())
        self.assertTrue(current.exists())
        self.assertTrue(rollback.exists())

    def test_cms_cleanup_deletes_nothing_when_rollback_target_is_already_gone(self):
        config, current, rollback, stale, history = self._layout()
        shutil.rmtree(rollback)
        removed = host._cleanup_cms_releases(config, self._state(history))
        self.assertEqual(removed, [])
        self.assertTrue(stale.exists())
        self.assertTrue(current.exists())

    def test_cms_cleanup_keeps_restart_workspace_named_by_the_environment_file(self):
        config, current, rollback, stale, history = self._layout()
        restart = stale.parent / "restart-release"
        restart.mkdir()
        env_file = stale.parent.parent / "cms.env"
        env_file.write_text(f"CMS_DIR={(restart / 'cms-artifact').resolve()}\n", encoding="utf-8")
        config["cmsEnvironmentFile"] = str(env_file)
        with patch.object(host, "_mount_points", return_value=set()):
            removed = host._cleanup_cms_releases(config, self._state(history))
        self.assertEqual(removed, [str(stale.resolve())])
        self.assertTrue(restart.exists())

    def test_cms_cleanup_skips_when_the_profile_has_no_cms_root(self):
        self.assertEqual(host._cleanup_cms_releases({}, self._state([])), [])


    def _dependent_workspace(self, config, stale, name, *, operation_id=None):
        """A workspace under the fixed root whose web and cms node_modules link into `stale`."""
        workspace_root = Path(config["releaseRoot"]).parent / "workspace"
        workspace_root.mkdir(exist_ok=True)
        workspace = workspace_root / name
        workspace.mkdir()
        for part in ("web", "cms"):
            dependency = stale / part / "node_modules"
            dependency.mkdir(parents=True)
            (workspace / part).mkdir()
            (workspace / part / "node_modules").symlink_to(dependency, target_is_directory=True)
        if operation_id is not None:
            # Identity that does not match any completed operation: the workspace is retained.
            (workspace / ".ikpk-workspace-identity.json").write_text(
                json.dumps({"operationId": operation_id, "sourceSha": "c" * 40}), encoding="utf-8")
        config["siteBuildWorkspaceRoot"] = str(workspace_root)
        return workspace

    # Guard 6: a workspace that is referenced keeps the CMS release its web/node_modules links into.
    # Mutation: in _cleanup_cms_releases replace `protected.add(_cms_release_dir(root, dependency))` with `pass`.
    def test_dependency_of_protected_workspace_keeps_its_cms_release(self):
        config, current, rollback, stale, history = self._layout()
        config["profile"] = "staging194"  # the referenced-workspace path is staging194's; production uses the filesystem scan
        workspace = self._dependent_workspace(config, stale, "a" * 40 + "-referenced")
        with patch.object(host, "_mount_points", return_value=set()), \
                patch.object(host, "_protected_paired_workspace_paths", return_value={workspace}):
            removed = host._cleanup_cms_releases(config, self._state(history))
        self.assertNotIn(str(stale.resolve()), removed)
        self.assertTrue(stale.exists())

    # Scenario b: a retained (unreferenced, marker-mismatched) workspace keeps its dependency release.
    # Red now: only dependencies of referenced workspaces are protected.
    def test_dependency_of_retained_workspace_keeps_its_cms_release(self):
        config, current, rollback, stale, history = self._layout()
        config["profile"] = "production-paired"
        workspace = self._dependent_workspace(config, stale, "a" * 40 + "-retained", operation_id="retained")
        with patch.object(host, "_mount_points", return_value=set()), \
                patch.object(host, "_protected_paired_workspace_paths", return_value=set()):
            removed = host._cleanup_cms_releases(config, self._state(history))
        self.assertTrue(workspace.is_dir())
        self.assertNotIn(str(stale.resolve()), removed)
        self.assertTrue(stale.exists())


class Staging194CaptureRetentionTests(unittest.TestCase):
    """staging194 shares one releaseRoot between CMS releases and static source trees."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ikpk-staging-capture-retention-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.releases = root / "releases"
        self.releases.mkdir()
        self.cms_current = self.releases / "current-release"
        rollback = self.releases / "rollback-release"
        self.cms_stale = self.releases / "stale-release"
        for directory in (self.cms_current, rollback, self.cms_stale):
            directory.mkdir()
            (directory / "marker").write_text(directory.name, encoding="utf-8")
        (self.cms_current / "cms-artifact").mkdir()
        (rollback / "cms-artifact").mkdir()
        pointer = root / "current-cms"
        pointer.symlink_to(self.cms_current / "cms-artifact")
        self.state_dir = root / "state"
        self.state_dir.mkdir()
        self.state = RehearsalState(self.state_dir)
        self.static_old = str((root / "static-old").resolve())
        self.static_old_digest = "f" * 64
        # The paired publication whose post-commit cleanup removes stale CMS releases.
        digest = "d" * 64
        database = self.state_dir / "cms.sqlite"
        database.write_bytes(b"fixture database")
        old_pair = {"cmsPath": str((rollback / "cms-artifact").resolve()), "staticPath": self.static_old,
                    "staticTreeSha256": self.static_old_digest}
        new_pair = {"sourceSha": "9" * 40, "cmsSha": "9" * 40, "staticSha": "9" * 40,
                    "cmsPayloadSha256": digest, "staticTreeSha256": digest,
                    "cmsDatabaseSha256": digest, "cmsMediaManifestSha256": digest,
                    "cmsCaptureBundleSha256": digest, "oldDatabaseSha256": digest,
                    "oldMediaManifestSha256": digest, "configSha256": digest, "snapshotId": "snap:test",
                    "cmsDatabaseProof": {"pid": 123, "device": 1, "inode": 1, "database": str(database)}}
        for row in ({"version": 1, "record": "start", "operationId": "op-current", "sourceSha": "9" * 40,
                     "oldPair": old_pair},
                    {"version": 1, "record": "new-bundle", "operationId": "op-current", "sourceSha": "9" * 40,
                     "newPair": new_pair},
                    {"version": 1, "record": "committed", "operationId": "op-current", "sourceSha": "9" * 40}):
            self.state._append(row)
        self.config = {"profile": "staging194", "releaseRoot": str(self.releases), "currentCms": str(pointer),
                       "stateDir": str(self.state_dir), "siteRefreshState": str(root / "refresh-state.json"),
                       "staticReleaseRoot": str(self.releases), "currentStatic": str(root / "static-current"),
                       "sitePublicationMarker": str(root / "marker.json")}
        self.shas = {}
        mounts = patch.object(host, "_mount_points", return_value=set())
        mounts.start()
        self.addCleanup(mounts.stop)

    def _static_capture(self, operation_id, source_sha, *, reused=None):
        """Append a committed static-main operation; `reused` names the operation whose capture it reused."""
        fingerprint = {"cms": "same"}
        candidate = str((self.releases / f"{source_sha}-{operation_id}").resolve())
        digest = "e" * 64
        reference = None
        if reused is not None:
            reference = {"operationId": reused, "sourceSha": self.shas[reused], "bundleDigest": "d" * 64}
        start = {"version": 1, "record": "static-main-start", "operationKind": "static-main",
                 "operationId": operation_id, "sourceSha": source_sha, "cmsFingerprint": fingerprint,
                 "oldStaticPath": self.static_old, "oldStaticTreeSha256": self.static_old_digest}
        prepared = {"version": 1, "record": "static-main-prepared", "operationKind": "static-main",
                    "operationId": operation_id, "sourceSha": source_sha, "cmsFingerprint": fingerprint,
                    "staticTreeSha256": digest, "snapshotId": "snap:fixture"}
        if reference is not None:
            start["reusedCapture"] = reference
            prepared["reusedCapture"] = reference
        self.state._append(start)
        self.state._append(prepared)
        self.state._append({"version": 1, "record": "static-main-switch-intent", "operationKind": "static-main",
                            "operationId": operation_id, "sourceSha": source_sha,
                            "oldStaticPath": self.static_old, "candidateStaticPath": candidate,
                            "staticTreeSha256": digest})
        self.state._append({"version": 1, "record": "static-main-switched", "operationKind": "static-main",
                            "operationId": operation_id, "sourceSha": source_sha, "staticTreeSha256": digest})
        self.state._append({"version": 1, "record": "static-main-committed", "operationKind": "static-main",
                            "operationId": operation_id, "sourceSha": source_sha,
                            "staticTreeSha256": digest, "snapshotId": "snap:fixture"})
        self.shas[operation_id] = source_sha
        tree = self.releases / f"{source_sha}-{operation_id}"
        tree.mkdir()
        (tree / "index.html").write_text(operation_id, encoding="utf-8")
        return tree

    # Guard S1: the latest eligible operation's own fresh capture survives CMS release cleanup.
    # Mutation: in _cleanup_cms_releases skip adding the referent to `protected`.
    def test_latest_fresh_capture_survives_cms_release_cleanup(self):
        older = self._static_capture("cap-a", "a" * 40)
        latest = self._static_capture("cap-c", "c" * 40)

        removed = host._cleanup_cms_releases(self.config, self.state)

        self.assertTrue(latest.is_dir(), "the latest eligible capture referent must be kept")
        self.assertFalse(older.exists(), "other static sources stay removable as today")
        self.assertIn(str(self.cms_stale.resolve()), removed)

    # Guard S2: when the latest operation reused A's capture, A's tree is kept and C's tree is removable.
    # Mutation: protect the latest operation's own tree instead of the `reusedCapture` referent.
    def test_latest_reused_capture_protects_the_referent_not_the_operation(self):
        referent = self._static_capture("cap-a", "a" * 40)
        latest = self._static_capture("cap-c", "c" * 40, reused="cap-a")

        host._cleanup_cms_releases(self.config, self.state)

        self.assertTrue(referent.is_dir(), "the reused capture's source tree must be kept")
        self.assertFalse(latest.exists(), "the reusing operation's own tree is removable")

    # Guard S3 (GREEN today, guard): a referent already absent adds no protection and raises nothing.
    # Mutation: raise when the referent is missing instead of protecting nothing.
    def test_absent_referent_protects_nothing_and_does_not_fail(self):
        referent = self._static_capture("cap-a", "a" * 40)
        latest = self._static_capture("cap-c", "c" * 40, reused="cap-a")
        shutil.rmtree(referent)

        removed = host._cleanup_cms_releases(self.config, self.state)

        self.assertFalse(latest.exists())
        self.assertIn(str(self.cms_stale.resolve()), removed)

    # Guard S4: the protection holds on every path that runs CMS release cleanup.
    # Mutation: in _cleanup_after_commit or the cleanup-site dispatch, call _cleanup_cms_releases with a
    # state that hides the static-main journal rows.
    def _post_commit_keeps_capture(self, operation_id):
        latest = self._static_capture("cap-c", "c" * 40)
        with patch.object(host, "_cleanup_site_releases", return_value={"removedReleases": [], "retainedLegacy": []}), \
                patch.object(host, "_workspace_step", return_value=({}, None)), \
                patch.object(host, "_record_workspace_run"):
            result = host._cleanup_after_commit(self.config, self.state, operation_id)
        self.assertFalse(result.get("cleanupPending"), result)
        self.assertTrue(latest.is_dir(), "post-commit cleanup must keep the latest eligible capture")

    def test_post_commit_of_paired_operation_keeps_latest_capture(self):
        self._post_commit_keeps_capture("op-current")

    def test_post_commit_of_static_operation_keeps_latest_capture(self):
        self._post_commit_keeps_capture("cap-c")

    def test_cleanup_site_timer_dispatch_keeps_latest_capture(self):
        latest = self._static_capture("cap-c", "c" * 40)
        with patch.object(host.os, "geteuid", return_value=0), \
                patch.object(host, "_root_config", return_value=self.config), \
                patch.object(host, "_select_cleanup_profile", return_value=(self.config, "staging194", None)), \
                patch.object(host, "_read_site_publication_marker", return_value=None), \
                patch.object(host, "_destination_publication_lock", return_value=nullcontext()), \
                patch.object(host, "_consume_site_cleanup_request"), \
                patch.object(host, "_cleanup_site_releases", return_value={"removedReleases": [], "retainedLegacy": []}), \
                patch.object(host, "_workspace_step", return_value=({}, None)), \
                patch.object(host, "_record_workspace_run"):
            host.dispatch(Namespace(profile="staging194", action="cleanup-site", operation_id=None,
                                    preview_workspaces=False))
        self.assertTrue(latest.is_dir(), "the timer's CMS release cleanup must keep the latest eligible capture")


if __name__ == '__main__':
    unittest.main()
