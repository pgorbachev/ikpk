"""Real SQLite/filesystem/durable-journal recovery with injected process failures."""
import json
import shutil
import sqlite3
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch
from scripts.lib import rehearsal_host as host
from scripts.tests import test_historical_cohort as existing


class SimulatedCrash(RuntimeError): pass


class DurableCohortRecovery(unittest.TestCase):
    def scenario(self, crash_at, profile='staging194'):
        fixture = existing.CohortTests(); fixture.setUp()
        try:
            f = fixture
            f.candidate.unlink()
            with sqlite3.connect(f.candidate) as db:
                db.execute('CREATE TABLE example(value TEXT)')
                db.execute("INSERT INTO example VALUES ('baseline')")
            f.binding['candidateDatabaseSha256'] = host.sha256_file(f.candidate)
            f.select()
            previous = json.loads((f.history / 'current.json').read_bytes())
            op = 'durable-recovery'
            offhost = f.root / 'backups' / op / 'offhost-backup'; offhost.mkdir(parents=True)
            backup = offhost / 'database.sqlite'; shutil.copyfile(f.live, backup)
            (offhost.parent / 'manifest.json').write_text('{}')
            backup_sha = host.sha256_file(backup)
            static = f.root / 'static'; static.mkdir()
            static_pointer = f.root / 'current-static'; static_pointer.symlink_to(static)
            old_pair = {'cmsPath': str(f.new), 'staticPath': str(static), 'staticTreeSha256': 'e' * 64,
                        'historicalRegistryManifest': previous}
            uploads = f.root / 'uploads'; uploads.mkdir()
            if profile == 'production-paired':
                old_pair.update(cmsPayloadSha256='c' * 64, mediaStateSha256=host._media_state_sha256([]),
                                cmsSourceEnvironment={key: None for key in host.PAIRED_CMS_ENV_KEYS})
            state_root = f.root / 'state'; state_root.mkdir()
            state = host.RehearsalState(state_root)
            state.begin(op, 'b' * 40, old_pair)
            state.confirm_fence(op, lambda: True)
            config = {**f.config, 'profile': profile, 'mediaRoots': [{'prefix': '/uploads/', 'path': str(uploads)}], 'backupRoot': str(f.root / 'backups'),
                      'releaseRoot': str(f.root), 'currentStatic': str(static_pointer),
                      'staticReleaseRoot': str(f.root), 'cmsUnit': 'test-cms', 'writerUnits': [],
                      'cmsHealthUrl': 'test', 'siteHealthUrl': 'test'}
            with ExitStack() as stack:
                for name in ('_start_acquisition', '_write_gate', '_verify_fence', '_stop_writers',
                             '_assert_no_database_handles', '_restore_media', '_set_flag',
                             '_wait_health', '_database_process_proof', '_write_paired_cms_source_env'):
                    stack.enter_context(patch.object(host, name))
                stack.enter_context(patch.object(host, '_backup_manifest', return_value={'databaseSha256': backup_sha, 'mediaManifestSha256': 'd' * 64, 'media': []}))
                stack.enter_context(patch.object(host, '_tree_sha256', return_value='e' * 64))
                stack.enter_context(patch.object(host, '_cms_payload_sha256', return_value='c' * 64))
                stack.enter_context(patch.object(host, '_media_inventory', return_value=[]))
                stack.enter_context(patch.object(host, '_service_pid', return_value=123))
                stack.enter_context(patch.object(host, '_switch_static_pointer'))
                stack.enter_context(patch.object(host, 'run', return_value=SimpleNamespace(returncode=0)))
                def recover(state):
                    if profile == 'production-paired' and not state._is_recovered(op):
                        host._recover(config, state, op, stage_only=True, expected_fingerprint='sha256:' + 'f' * 64)
                        return host._recover(config, state, op, finalize_restore_fingerprint='sha256:' + 'f' * 64)
                    return host._recover(config, state, op)
                copy, write, append = host._copy_atomic, host._registry_write, state._append
                def crashing_copy(*args):
                    if crash_at == 'before-db': raise SimulatedCrash(crash_at)
                    copy(*args)
                    if crash_at == 'after-db': raise SimulatedCrash(crash_at)
                def crashing_write(*args):
                    write(*args)
                    if crash_at == 'after-manifest': raise SimulatedCrash(crash_at)
                def crashing_append(row):
                    append(row)
                    if (crash_at, row['record']) in (('after-seal', 'historical-cohort-restored'), ('after-terminal', 'recovered')):
                        raise SimulatedCrash(crash_at)
                with patch.object(host, '_copy_atomic', side_effect=crashing_copy), \
                     patch.object(host, '_registry_write', side_effect=crashing_write), \
                     patch.object(state, '_append', side_effect=crashing_append):
                    with self.assertRaises(SimulatedCrash): recover(state)
                # Simulate a fresh process: no reused state object or memory rows.
                resumed = host.RehearsalState(state_root)
                before_retry_inode = f.live.stat().st_ino
                result = recover(resumed)
                self.assertEqual(result['phase'], 'recovered')
                if crash_at in ('after-seal', 'after-terminal'):
                    self.assertEqual(f.live.stat().st_ino, before_retry_inode)
                host._historical_registry_environment(require_cohort=True, config=config)
                resumed.read_journal_for_cleanup(validate_history=True)
                with sqlite3.connect(f.live) as db:
                    self.assertEqual(db.execute('SELECT value FROM example').fetchone()[0], 'baseline')
                    db.execute("UPDATE example SET value='editor saved after reopen'")
                edited_sha, edited_inode = host.sha256_file(f.live), f.live.stat().st_ino
                with patch.object(host, '_copy_atomic', side_effect=AssertionError('terminal retry copied DB')):
                    host._recover(config, host.RehearsalState(state_root), op)
                self.assertEqual(host.sha256_file(f.live), edited_sha)
                self.assertEqual(f.live.stat().st_ino, edited_inode)
                replacement = f.root / 'replaced.db'; shutil.copyfile(f.live, replacement); replacement.replace(f.live)
                before_manifest = (f.history / 'current.json').read_bytes()
                with self.assertRaisesRegex(host.HostFailure, 'database identity changed'):
                    host._recover(config, host.RehearsalState(state_root), op)
                self.assertEqual((f.history / 'current.json').read_bytes(), before_manifest)
        finally:
            fixture.doCleanups()

    def test_crash_recovery_uses_only_verified_baseline_and_never_rebinds_terminal_retry(self):
        for profile in ('staging194', 'production-paired'):
            for step in ('before-db', 'after-db', 'after-manifest', 'after-seal', 'after-terminal'):
                with self.subTest(profile=profile, step=step): self.scenario(step, profile)


if __name__ == '__main__': unittest.main()
