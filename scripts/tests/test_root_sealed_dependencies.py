import getpass
import json
from types import SimpleNamespace
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.lib import rehearsal_host as host


class RootSealedDependencies(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='.sealed-deps-', dir=Path.cwd()); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.root.chmod(0o755)
        self.source = self.root / 'source'; self.source.mkdir()
        (self.source / 'nested').mkdir(); (self.source / 'nested/code.js').write_bytes(b'installed bytes')
        (self.source / '.bin').mkdir(); (self.source / '.bin/tool').symlink_to('../nested/code.js')

    def copy(self, name='sealed'):
        target = self.root / name
        digest = host._copy_sealed_dependency_tree(self.source, target)
        self.addCleanup(self.make_writable, target)
        return target, digest

    @staticmethod
    def make_writable(root):
        if root.exists():
            root.chmod(0o755)
            for item in root.rglob('*'):
                if not item.is_symlink(): item.chmod(0o755 if item.is_dir() else 0o644)

    def test_seal_uses_fresh_inodes_and_does_not_share_an_existing_writable_handle(self):
        original = self.source / 'nested/code.js'
        with original.open('r+b') as writable:
            sealed, digest = self.copy()
            writable.seek(0); writable.write(b'changed through old fd'); writable.flush()
        self.assertEqual((sealed / 'nested/code.js').read_bytes(), b'installed bytes')
        self.assertNotEqual(original.stat().st_ino, (sealed / 'nested/code.js').stat().st_ino)
        self.assertEqual((sealed / '.bin/tool').read_bytes(), b'installed bytes')
        self.assertEqual(stat.S_IMODE(sealed.stat().st_mode), 0o555)
        self.assertEqual(stat.S_IMODE((sealed / 'nested/code.js').stat().st_mode), 0o444)
        _, next_digest = self.copy('next')
        self.assertNotEqual(digest, next_digest)

    def test_seal_rejects_external_links_and_hardlinks(self):
        outside = self.root / 'outside'; outside.write_text('must not become dependency')
        (self.source / 'external').symlink_to('../outside')
        self.addCleanup(self.make_writable, self.root / 'bad')
        with self.assertRaisesRegex(host.HostFailure, 'escapes'): host._copy_sealed_dependency_tree(self.source, self.root / 'bad')
        (self.source / 'external').unlink(); os.link(outside, self.source / 'alias')
        self.addCleanup(self.make_writable, self.root / 'bad2')
        with self.assertRaisesRegex(host.HostFailure, 'hard link'): host._copy_sealed_dependency_tree(self.source, self.root / 'bad2')

    def test_cms_directory_replacement_cannot_redirect_root_copy(self):
        outside = self.root / 'outside'; outside.mkdir(); (outside / 'secret').write_text('must not be copied')
        original_open = os.open
        def replace_directory(path, flags, *args, **kwargs):
            if path == 'nested' and kwargs.get('dir_fd') is not None:
                (self.source / 'nested').rename(self.source / 'saved-nested')
                (self.source / 'nested').symlink_to(outside)
            return original_open(path, flags, *args, **kwargs)
        target = self.root / 'raced';self.addCleanup(self.make_writable,target)
        with patch.object(host.os,'open',side_effect=replace_directory):
            with self.assertRaises(OSError): host._copy_sealed_dependency_tree(self.source,target)
        self.assertFalse((target / 'nested/secret').exists())

    def test_replaced_regular_file_cannot_block_root_on_fifo(self):
        original_open = os.open
        def replace_file(path, flags, *args, **kwargs):
            if path == 'code.js' and kwargs.get('dir_fd') is not None:
                file = self.source / 'nested/code.js'
                file.unlink(); os.mkfifo(file)
                self.assertTrue(flags & os.O_NONBLOCK, 'root open must not block if file becomes FIFO')
            return original_open(path, flags, *args, **kwargs)
        target = self.root / 'fifo-raced'; self.addCleanup(self.make_writable, target)
        with patch.object(host.os, 'open', side_effect=replace_file):
            with self.assertRaises(host.HostFailure): host._copy_sealed_dependency_tree(self.source, target)

    def test_host_seals_only_observed_private_install_and_reuses_protected_generation(self):
        source_root = self.root / 'checkout'; cms = source_root / 'cms';cms.mkdir(parents=True)
        package = {'dependencies':{'@strapi/strapi':'5.51.2'}}
        lock = {'lockfileVersion':3,'packages':{'node_modules/@strapi/strapi':{'version':'5.51.2'}}}
        (cms / 'package.json').write_text(json.dumps(package));(cms / 'package-lock.json').write_text(json.dumps(lock))
        generation = self.root / 'generation'
        runtime={'nodeBinary':'/usr/bin/node','nodeBinarySha256':'c'*64,'npmCli':'/root/npm-cli.js','npmCliSha256':'d'*64}
        installer=SimpleNamespace(pw_uid=os.getuid()+1,pw_gid=os.getgid()+1,pw_name='ikpk-deps')
        expected = {'version':1,'lockSha256':host.sha256_file(cms/'package-lock.json'),'profile':'full-build-sealed-v3',
                    'nodeAbi':'137','nodeVersion':'v24.1.0','platform':'linux','architecture':'x64',**runtime,
                    'installerUid':installer.pw_uid,'installerGid':installer.pw_gid,
                    'packageJsonSha256':host.sha256_file(cms/'package.json')}
        package_inputs={name:(cms/name).read_bytes() for name in ('package.json','package-lock.json')}
        package_inputs['scripts/run-data-migrations.mjs']=b'export const ROOT_SEALED_DEPENDENCIES_VERSION = 3;'
        original_check = host._protected_dependency_path
        def check(path, **kwargs):
            kwargs['trusted_uid'] = os.getuid();return original_check(path,**kwargs)
        calls=[]
        def install(work,user,actual_runtime,args):
            calls.append(args)
            self.assertEqual(user.pw_uid,installer.pw_uid)
            self.assertEqual((work/'package.json').read_bytes(),package_inputs['package.json'])
            self.assertEqual(stat.S_IMODE(work.parent.stat().st_mode),0o710)
            self.assertEqual(stat.S_IMODE(work.stat().st_mode),0o700)
            if args==['--version']: return '10.9.8\n'
            target=work/'node_modules/@strapi/strapi';target.mkdir(parents=True)
            (target/'package.json').write_text(json.dumps({'version':'5.51.2'}))
            return ''
        config={'cmsUser':getpass.getuser()}
        with patch.object(host,'_cms_build_generation',return_value=(generation,expected)), \
             patch.object(host,'_protected_dependency_path',side_effect=check), \
             patch.object(host,'_dependency_installer_account',return_value=installer), \
             patch.object(host,'_dependency_install_runtime',return_value=runtime), \
             patch.object(host.os,'chown'), \
             patch.object(host,'_run_as_cms',side_effect=AssertionError('CMS UID must not install sealed dependencies')):
            with patch.object(host,'_run_private_dependency_install',side_effect=host.HostFailure('npm failed')):
                with self.assertRaisesRegex(host.HostFailure,'npm failed'): host._prepare_cms_build_dependencies(config,source_root,package_inputs=package_inputs)
            self.assertFalse(generation.exists())
            with self.assertRaisesRegex(host.HostFailure,'CI-admitted'):
                host._prepare_cms_build_dependencies(config,source_root)
            with self.assertRaisesRegex(host.HostFailure,'CI-admitted'):
                host._prepare_cms_build_dependencies(config,source_root,package_inputs={**package_inputs,'package.json':b'tampered'})
            # Installer never rereads the CMS-owned checkout after admitting bytes.
            (cms/'package.json').write_bytes(b'tampered checkout')
            with patch.object(host,'_run_private_dependency_install',side_effect=install):
                actual=host._prepare_cms_build_dependencies(config,source_root,package_inputs=package_inputs)
                self.addCleanup(self.make_writable,generation)
                self.assertEqual(actual,generation/'node_modules')
                first=host.sha256_file(generation/host.SEALED_DEPENDENCY_MARKER)
                self.assertEqual(host._prepare_cms_build_dependencies(config,source_root,package_inputs=package_inputs),actual)
                self.assertEqual(host.sha256_file(generation/host.SEALED_DEPENDENCY_MARKER),first)
            self.assertEqual(calls,[['--version'],['ci','--no-audit','--no-fund']])

    def test_attestation_reuse_rejects_writable_parent_wrong_owner_and_inode(self):
        generation = self.root / 'generation'; generation.mkdir(mode=0o755)
        deps = generation / 'node_modules'; deps.mkdir(mode=0o555)
        runtime={'nodeBinary':'/usr/bin/node','nodeBinarySha256':'c'*64,'npmCli':'/root/npm-cli.js','npmCliSha256':'d'*64,
                 'installerUid':os.getuid()+1,'installerGid':os.getgid()+1}
        expected = {'packageJsonSha256':'e'*64,'lockSha256':'a'*64,'nodeAbi':'137','nodeVersion':'v24.1.0',**runtime}
        info = deps.stat()
        proof = {'schemaVersion':3,**runtime,'installerUser':'ikpk-deps','installIsolation':'dedicated-uid-cgroup-drained-v1','generation':str(generation),'dependencyRoot':str(deps),
                 'dependencyDevice':info.st_dev,'dependencyInode':info.st_ino,'dependencyTreeSha256':'b'*64,
                 'packageJsonSha256':expected['packageJsonSha256'],'packageLockSha256':expected['lockSha256'],'nodeAbi':'137','nodeVersion':'v24.1.0',
                 'installCommand':'npm ci --no-audit --no-fund','exitCode':0}
        marker = generation / host.SEALED_DEPENDENCY_MARKER
        host._registry_write(marker,json.dumps(proof).encode())
        read = lambda: host._sealed_dependency_provenance(generation,expected,trusted_uid=os.getuid())
        self.assertEqual(read(),proof); self.assertEqual(read(),proof)
        generation.chmod(0o777)
        with self.assertRaises(host.HostFailure): read()
        generation.chmod(0o755)
        with self.assertRaises(host.HostFailure): host._sealed_dependency_provenance(generation,expected,trusted_uid=os.getuid()+1)
        proof['dependencyInode'] += 1;host._registry_write(marker,json.dumps(proof).encode())
        with self.assertRaisesRegex(host.HostFailure,'differs'): read()


if __name__ == '__main__': unittest.main()
