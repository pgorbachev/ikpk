import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.lib import rehearsal_host as host

class CandidateCaptureGate(unittest.TestCase):
    def test_capture_failure_mutation_and_success(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root = Path(temp).resolve(); (root/'web').mkdir()
            candidate = root/'candidate.db'; candidate.write_bytes(b'database')
            capture = root/'capture'; capture.mkdir(); (capture/'database.sqlite').write_bytes(b'database')
            digest = hashlib.sha256(b'database').hexdigest()
            (capture/'manifest.json').write_text(json.dumps({'databaseSha256': digest, 'sourceSha': 'a'*40, 'operationId': 'op'}))
            registry = root/'registry.json'; registry.write_text('[]')
            binding = {'candidateDatabaseSha256': digest, 'registrySha256': hashlib.sha256(b'[]').hexdigest(),
                       'registryPath': str(registry), 'proofArtifactSha256':'b'*64, 'sourceCommit':'a'*40, 'operationId':'op'}
            provenance = {'seminarProofArtifact': {'sourceSha':'a'*40, 'payloadSha256':'b'*64}}
            def extract(_archive, _digest, source, _sha):
                (source/'web/scripts').mkdir(parents=True)
            def dependencies(_config, _source, sealed):
                deps = sealed/'node_modules'; (deps/'.bin').mkdir(parents=True); return deps
            def run(_config, _cwd, _output, env, args):
                self.assertNotEqual(env['CONTENT_HISTORICAL_EXCEPTIONS_FILE'], str(registry))
                self.assertEqual(env['CONTENT_HISTORICAL_EXCEPTIONS_SHA256'], binding['registrySha256'])
                self.assertEqual(args[0], '--server-capture')
                self.assertEqual(os.stat(_output.parent).st_mode & 0o777, 0o710)
                (Path(env['CONTENT_SNAPSHOT_DIR'])/'snapshot.json').write_text(json.dumps({'captureProof':{'databaseDigest':digest}}))
            user = type('U', (), {'pw_uid':os.getuid(), 'pw_gid':os.getgid()})()
            from contextlib import contextmanager
            @contextmanager
            def workspace(_config, _operation, _installer, _capture):
                with tempfile.TemporaryDirectory(dir=root) as temporary:
                    sealed = Path(temporary); os.chmod(sealed, 0o710)
                    host.os.chown(sealed, 0, user.pw_gid)
                    yield sealed
            with patch.object(host, '_capture_seal_workspace', side_effect=workspace), patch.object(host, '_protected_dependency_path'), \
                 patch.object(host, '_extract_candidate_capture_source', side_effect=extract), \
                 patch.object(host, '_prepare_capture_web_dependencies', side_effect=dependencies), \
                 patch.object(host, '_dependency_installer_account', return_value=user, create=True), \
                 patch.object(host.pwd, 'getpwnam', return_value=user), patch.object(host.os, 'chown') as chown:
                def invoke():
                    return host._verify_candidate_capture({'cmsUser':'x','profile':'staging194'}, root, capture, candidate, binding, provenance)
                with patch.object(host, '_run_private_candidate_capture', side_effect=RuntimeError('contract refused')):
                    with self.assertRaisesRegex(RuntimeError, 'contract refused'):
                        with invoke(): pass
                def mutate(*args, **kwargs): candidate.write_bytes(b'changed')
                with patch.object(host, '_run_private_candidate_capture', side_effect=mutate):
                    with self.assertRaisesRegex(host.HostFailure, 'candidate'):
                        with invoke(): pass
                candidate.write_bytes(b'database')
                with patch.object(host, '_run_private_candidate_capture', side_effect=run):
                    with invoke() as proof:
                        self.assertEqual(proof['sealedDatabase'].read_bytes(), b'database')
                        self.assertNotEqual(proof['sealedDatabase'], candidate)
                    self.assertFalse(proof['sealedDatabase'].exists())
                    self.assertTrue(any(call.args[1:] == (0, user.pw_gid) for call in chown.call_args_list))

    def test_proof_extraction_rejects_unreviewed_and_unsafe_members(self):
        import io
        import tarfile
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            def payload(name, data):
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                    entry = tarfile.TarInfo(name); entry.size = len(data)
                    archive.addfile(entry, io.BytesIO(data))
                return stream.getvalue()
            raw = payload('../escape', b'bad'); archive = root/'proof.tar.gz'; archive.write_bytes(raw)
            with self.assertRaises(host.HostFailure):
                host._extract_candidate_capture_source(archive, hashlib.sha256(raw).hexdigest(), root/'extract')
            self.assertFalse((root.parent/'escape').exists())
            with self.assertRaises(host.HostFailure):
                host._extract_candidate_capture_source(archive, '0'*64, root/'other')

    def test_capture_resume_reuses_only_exact_candidate(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root = Path(temp).resolve(); operation = root/'.staging193-rehearsal'/'op'; operation.mkdir(parents=True)
            capture = operation/'capture'; capture.mkdir()
            candidate = root/'candidate.db'; candidate.write_bytes(b'database')
            (capture/'database.sqlite').write_bytes(b'database')
            (capture/'manifest.json').write_text(json.dumps({'operationId':'op', 'sourceSha':'a'*40,
                'databaseSha256':hashlib.sha256(b'database').hexdigest()}))
            self.assertEqual(host._create_capture_bundle({}, 'op', 'a'*40, root, candidate), capture)
            candidate.write_bytes(b'new database')
            with self.assertRaisesRegex(host.HostFailure, 'recover before retrying'):
                host._create_capture_bundle({}, 'op', 'a'*40, root, candidate)

    def test_wal_and_symlink_sidecars_are_rejected(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root = Path(temp).resolve(); candidate = root/'candidate.db'; candidate.write_bytes(b'db')
            digest = hashlib.sha256(b'db').hexdigest()
            host._candidate_capture_identity(candidate, digest)
            wal = Path(str(candidate) + '-wal'); wal.write_bytes(b'pending')
            with self.assertRaisesRegex(host.HostFailure, 'pending WAL'):
                host._candidate_capture_identity(candidate, digest)
            wal.unlink(); wal.symlink_to(root/'missing')
            with self.assertRaises(host.HostFailure):
                host._candidate_capture_identity(candidate, digest)

    def test_web_install_uses_only_admitted_package_inputs_and_rejects_mutation(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root = Path(temp).resolve(); source = root/'source'; web = source/'web'; web.mkdir(parents=True)
            (web/'package.json').write_text('{"name":"web"}')
            (web/'package-lock.json').write_text('{"lockfileVersion":3}')
            sealed = root/'sealed'; sealed.mkdir()
            installer = type('U', (), {'pw_uid':os.getuid(), 'pw_gid':os.getgid()})()
            def install(work, _installer, _runtime, args):
                self.assertEqual(args, ['ci', '--no-audit', '--no-fund'])
                (work/'node_modules').mkdir(); (work/'node_modules/index.js').write_text('sealed')
            with patch.object(host, '_dependency_installer_account', return_value=installer, create=True), \
                 patch.object(host, '_dependency_install_runtime', return_value={'nodeBinary':'/node'}, create=True), \
                 patch.object(host, '_run_private_dependency_install', side_effect=install, create=True), \
                 patch.object(host.os, 'chown'):
                deps = host._prepare_capture_web_dependencies({}, source, sealed)
                self.assertEqual((deps/'index.js').read_text(), 'sealed')
                self.assertFalse((sealed/'install').exists())

            other = root/'other'; other.mkdir()
            def tamper(work, _installer, _runtime, _args):
                (work/'package-lock.json').write_text('{"tampered":true}')
            with patch.object(host, '_dependency_installer_account', return_value=installer, create=True), \
                 patch.object(host, '_dependency_install_runtime', return_value={'nodeBinary':'/node'}, create=True), \
                 patch.object(host, '_run_private_dependency_install', side_effect=tamper, create=True), \
                 patch.object(host.os, 'chown'):
                with self.assertRaisesRegex(host.HostFailure, 'package input'):
                    host._prepare_capture_web_dependencies({}, source, other)

    def test_capture_runs_under_separate_installer_with_empty_environment_and_idle_checks(self):
        installer = type('U', (), {'pw_uid':1234, 'pw_gid':1235})()
        calls = []
        def run(args, **kwargs): calls.append(args)
        with patch.object(host, '_dependency_installer_account', return_value=installer, create=True), \
             patch.object(host, '_dependency_install_runtime', return_value={'nodeBinary':'/usr/bin/node'}, create=True), \
             patch.object(host, '_assert_dependency_installer_idle', create=True) as idle, patch.object(host, 'run', side_effect=run):
            host._run_private_candidate_capture({}, Path('/run/proof/web'), Path('/run/proof/output'),
                {'CONTENT_SNAPSHOT_DIR':'/run/proof/output'}, ['--server-capture', '/run/proof/bundle'])
        self.assertEqual(idle.call_count, 2)
        self.assertIn('--uid=1234', calls[0]); self.assertIn('--gid=1235', calls[0])
        self.assertIn('--property=ProtectSystem=strict', calls[0])
        self.assertIn('--property=ReadWritePaths=/run/proof/output', calls[0])
        self.assertEqual(calls[0][calls[0].index('/usr/bin/env')+1], '-i')
        self.assertEqual(calls[1][0:2], ['/usr/bin/systemctl', 'stop'])

    def test_resume_replaces_only_expected_upload_link_with_empty_sandbox(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root = Path(temp).resolve(); artifact = root/'artifact'; (artifact/'public').mkdir(parents=True)
            media = root/'media'; media.mkdir(); (media/'existing.jpg').write_bytes(b'preserve')
            uploads = artifact/'public/uploads'; uploads.symlink_to(media)
            config = {'cmsUser':'x', 'mediaRoots':[{'prefix':'/uploads/', 'path':str(media)}]}
            def create(_config, _cwd, argv, **kwargs): Path(argv[-1]).mkdir()
            with patch.object(host, '_run_as_cms', side_effect=create):
                self.assertEqual(host._ensure_empty_candidate_upload_directory(config, artifact), uploads)
                self.assertTrue(uploads.is_dir()); self.assertFalse(uploads.is_symlink())
                self.assertEqual(list(uploads.iterdir()), []); self.assertTrue((media/'existing.jpg').exists())
                uploads.rmdir(); uploads.symlink_to(root)
                with self.assertRaises(host.HostFailure):
                    host._ensure_empty_candidate_upload_directory(config, artifact)

    def test_disk_workspace_recovers_only_same_operation_and_checks_space(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root = Path(temp).resolve(); releases = root/'releases'; releases.mkdir()
            capture = root/'capture'; capture.mkdir(); (capture/'media').write_bytes(b'bytes')
            installer = type('U', (), {'pw_uid':os.getuid(), 'pw_gid':os.getgid()})()
            config = {'releaseRoot': str(releases)}
            with patch.object(host, '_protected_dependency_path'), \
                 patch.object(host.shutil.rmtree, 'avoids_symlink_attacks', True), \
                 patch.object(host, '_assert_dependency_installer_idle', create=True) as idle, \
                 patch.object(host, '_capture_filesystem_type', return_value='ext4', create=True), \
                 patch.object(host.shutil, 'disk_usage', return_value=type('D', (), {'free':10*1024**3})()):
                with host._capture_seal_workspace(config, 'op-one', installer, capture, trusted_uid=os.getuid()) as work:
                    self.assertEqual(work.stat().st_mode & 0o777, 0o710)
                    base = work.parent; other = base/'op-two'; other.mkdir(mode=0o700)
                    (work/'partial').write_bytes(b'private')
                    with self.assertRaisesRegex(host.HostFailure, 'already in use'):
                        with host._capture_seal_workspace(config, 'op-one', installer, capture, trusted_uid=os.getuid()): pass
                    # Simulate a process crash by leaving this exact workspace behind.
                    with self.assertRaisesRegex(RuntimeError, 'crash'):
                        raise RuntimeError('crash')
                self.assertFalse(work.exists()); self.assertTrue(other.exists())
                stale = base/'op-one'; stale.mkdir(mode=0o710); stale.chmod(0o710); os.chown(stale, os.getuid(), installer.pw_gid)
                (stale/'partial').write_bytes(b'old private data')
                with host._capture_seal_workspace(config, 'op-one', installer, capture, trusted_uid=os.getuid()) as work:
                    self.assertFalse((work/'partial').exists()); self.assertTrue(other.exists())
                idle.assert_called()
                unsafe = base/'op-one'; unsafe.symlink_to(other, target_is_directory=True)
                with self.assertRaisesRegex(host.HostFailure, 'orphan is unsafe'):
                    with host._capture_seal_workspace(config, 'op-one', installer, capture, trusted_uid=os.getuid()): pass
                self.assertTrue(unsafe.is_symlink()); self.assertTrue(other.exists()); unsafe.unlink()
                with patch.object(host.shutil, 'disk_usage', return_value=type('D', (), {'free':1})()):
                    with self.assertRaisesRegex(host.HostFailure, 'free space'):
                        with host._capture_seal_workspace(config, 'op-one', installer, capture, trusted_uid=os.getuid()): pass
                with patch.object(host, '_capture_filesystem_type', return_value='tmpfs'):
                    with self.assertRaisesRegex(host.HostFailure, 'filesystem'):
                        with host._capture_seal_workspace(config, 'op-one', installer, capture, trusted_uid=os.getuid()): pass
                with patch.object(host, '_capture_filesystem_type', side_effect=lambda path: 'tmpfs' if path == base else 'ext4'):
                    with self.assertRaisesRegex(host.HostFailure, 'filesystem'):
                        with host._capture_seal_workspace(config, 'op-one', installer, capture, trusted_uid=os.getuid()): pass
