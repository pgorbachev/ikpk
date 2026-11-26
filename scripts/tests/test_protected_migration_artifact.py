"""Immutable migration execution must not share CMS-controlled code inodes."""
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from scripts.lib import rehearsal_host as host
from scripts.tests.test_cms_artifact_host_consumer import prepared_artifact


class ProtectedMigrationArtifact(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path.cwd());self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.root.chmod(0o755)
        self.f=prepared_artifact(self.root)
        Path(self.f['config']['releaseRoot']).mkdir()
        payload_path=self.f['source']/'.ikpk-cms-artifact.tar.gz'
        stream=io.BytesIO();self.runner=b'export const ROOT_SEALED_DEPENDENCIES_VERSION = 3;\n'
        with tarfile.open(fileobj=io.BytesIO(payload_path.read_bytes()),mode='r:gz') as source, tarfile.open(fileobj=stream,mode='w:gz') as target:
            for info in source.getmembers():
                data=self.runner if info.name=='scripts/run-data-migrations.mjs' else (source.extractfile(info).read() if info.isfile() else None)
                if data is not None:info.size=len(data)
                target.addfile(info,io.BytesIO(data) if data is not None else None)
        payload=stream.getvalue();payload_path.write_bytes(payload)
        self.f['provenance']['cmsArtifact']['payloadSha256']=host.sha256_file_bytes(payload)
        (self.f['source']/'.ikpk-rehearsal-ci.json').write_text(json.dumps(self.f['provenance']))
        (self.f['artifact']/'scripts/run-data-migrations.mjs').write_bytes(self.runner)
        self.check=host._protected_dependency_path
        self.patcher=patch.object(host,'_protected_dependency_path',side_effect=lambda path,**kwargs:self.check(path,**{**kwargs,'trusted_uid':os.getuid()}))
        self.patcher.start();self.addCleanup(self.patcher.stop)
        self.addCleanup(self.writable)

    def writable(self):
        for path in [self.root,*self.root.rglob('*')]:
            if path.is_dir() and not path.is_symlink():path.chmod(0o755)

    def protect(self):
        f=self.f
        return host._protected_cms_migration_artifact(f['config'],f['source'],f['operationId'],f['provenance'],f['dependencies'])

    def test_copy_uses_admitted_bytes_and_reuses_immutable_identity(self):
        original=self.f['artifact']/'scripts/run-data-migrations.mjs'
        with original.open('r+b') as handle:
            copy=self.protect();inode=copy.stat().st_ino
            handle.write(b'attacker changes executable after validation');handle.flush()
            self.assertEqual((copy/'scripts/run-data-migrations.mjs').read_bytes(),self.runner)
            self.assertNotEqual(original.stat().st_ino,(copy/'scripts/run-data-migrations.mjs').stat().st_ino)
        self.assertEqual(self.protect(),copy);self.assertEqual(copy.stat().st_ino,inode)
        self.assertEqual(os.readlink(copy/'node_modules'),str(self.f['dependencies']))
        self.assertFalse(copy.is_relative_to(self.f['source']))

    def test_restrictive_root_umask_does_not_hide_published_code_from_cms(self):
        import stat
        previous=os.umask(0o077)
        try:copy=self.protect()
        finally:os.umask(previous)
        self.assertEqual(stat.S_IMODE(copy.parent.parent.stat().st_mode),0o755)
        self.assertEqual(stat.S_IMODE(copy.parent.stat().st_mode),0o555)
        self.assertEqual(stat.S_IMODE(copy.stat().st_mode),0o555)

    def test_changed_archive_and_writable_ancestor_cannot_reuse_copy(self):
        copy=self.protect()
        copy.parent.chmod(0o777)
        with self.assertRaises(host.HostFailure):self.protect()
        copy.parent.chmod(0o555)
        archive=self.f['source']/'.ikpk-cms-artifact.tar.gz';archive.write_bytes(archive.read_bytes()+b'changed')
        with self.assertRaisesRegex(host.HostFailure,'digest'):self.protect()

    @unittest.skipUnless(hasattr(os,'fork'),'requires POSIX crash process')
    def test_process_crash_before_and_after_publication_resumes_without_partial_selection(self):
        rename=os.rename
        for after in (False, True):
            # Each interruption uses a distinct operation/source generation.
            if after:
                self.f['operationId']='after-publish'
                source=self.f['source'];new_source=source.with_name('a'*40+'-after-publish')
                source.rename(new_source);self.f['source']=new_source
            pid=os.fork()
            if pid==0:
                def crash(source,target):
                    if after:rename(source,target)
                    os._exit(73)
                with patch.object(host.os,'rename',side_effect=crash):self.protect()
                os._exit(1)
            _,status=os.waitpid(pid,0);self.assertEqual(os.waitstatus_to_exitcode(status),73)
            copy=self.protect();self.assertEqual((copy/'scripts/run-data-migrations.mjs').read_bytes(),self.runner)
            inode=copy.stat().st_ino;self.assertEqual(self.protect().stat().st_ino,inode)

    def test_installer_executes_protected_code_with_separate_writable_database_and_receipt(self):
        import sqlite3
        f=self.f;live=self.root/'live.sqlite';sqlite3.connect(live).close();f['config']['cmsDatabase']=str(live)
        calls=[]
        def run(config,cwd,argv,**kwargs):
            calls.append((cwd,argv))
            self.assertFalse(cwd.is_relative_to(f['source']))
            self.assertEqual(Path(argv[1]).read_bytes(),self.runner)
            if argv[2]=='prepare':
                self.assertEqual(Path(argv[argv.index('--artifact-dir')+1]),cwd)
                candidate=Path(argv[argv.index('--candidate-db')+1]);receipt=Path(argv[argv.index('--receipt')+1])
                self.assertEqual(candidate.parent,f['artifact'].parent);self.assertEqual(receipt.parent,candidate.parent)
                sqlite3.connect(candidate).close();return ''
            return json.dumps({'phase':'prepared','passed':True})
        with patch.object(host,'_validate_prepared_cms_candidate',return_value=(f['source'],f['artifact'],f['dependencies'])), \
             patch.object(host,'_ensure_empty_candidate_upload_directory'), \
             patch.object(host,'_configure_candidate_uploads',return_value=self.root/'uploads'), \
             patch.object(host,'_cms_payload_sha256',return_value='e'*64), \
             patch.object(host,'_assert_no_database_handles'),patch.object(host,'_run_as_cms',side_effect=run):
            candidate,active,digest=host._install_migrated_database(f['config'],f['source'],f['operationId'],self.root/'old',provenance=f['provenance'])
        self.assertEqual(active,f['artifact']);self.assertEqual(len(calls),2);self.assertEqual(calls[0][0],calls[1][0])

    def test_protected_copy_preserves_logical_fingerprint_with_same_dependency_link(self):
        import subprocess
        copy=self.protect();original=self.f['artifact']
        (original/'scripts/run-data-migrations.mjs').write_bytes(self.runner)
        # Exercise the actual fingerprint implementation with only its separately
        # tested root proof reader substituted; this test concerns path identity.
        script=r"""
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
const text=fs.readFileSync('cms/scripts/run-data-migrations.mjs','utf8');
const source=text.slice(text.indexOf('function artifactFingerprint('),text.indexOf('function assertNoOpenHandles('));
const hash=value=>createHash('sha256').update(value).digest('hex');
const proof={receipt:{dependencyTreeSha256:'a'.repeat(64)},proofSha256:'b'.repeat(64)};
const context={...fs,...path,hash,jsonHash:value=>hash(JSON.stringify(value)),readJson:file=>JSON.parse(fs.readFileSync(file,'utf8')),
 isWithin:(root,target)=>target===root||target.startsWith(root+path.sep),fail:message=>{throw Error(message)},
 ROOT_SEALED_DEPENDENCY_MARKER:'.ikpk-install-provenance-v3.json',readRootSealedDependencyProvenance:()=>proof};
delete context.default;
const fingerprint=Function(...Object.keys(context),source+';return artifactFingerprint;')(...Object.values(context));
const [left,right]=process.argv.slice(1);
const a=fingerprint(left,'5.51.2'),b=fingerprint(right,'5.51.2');
if(JSON.stringify(a)!==JSON.stringify(b))throw Error('relocation changed logical fingerprint');
"""
        marker=self.f['dependencies'].parent/host.SEALED_DEPENDENCY_MARKER;marker.write_text('{}')
        result=subprocess.run(['node','--input-type=module','-e',script,str(original),str(copy)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_corrupt_active_artifact_still_refuses_before_activation(self):
        copy=self.protect();f=self.f
        (f['artifact']/'scripts/run-data-migrations.mjs').write_bytes(b'CMS changed active code')
        self.assertEqual((copy/'scripts/run-data-migrations.mjs').read_bytes(),self.runner)
        with self.assertRaisesRegex(host.HostFailure,'bytes differ'):
            host._activate_cms(f['config'],f['artifact'],self.root/'candidate.db',self.root/'capture',
                              source_root=f['source'],cms_artifact=f['provenance']['cmsArtifact'])

    def test_selected_copy_is_revalidated_before_resume(self):
        copy=self.protect();runner=copy/'scripts/run-data-migrations.mjs'
        runner.chmod(0o644);runner.write_bytes(b'root-side drift')
        with self.assertRaisesRegex(host.HostFailure,'bytes|differs'):self.protect()


if __name__=='__main__':unittest.main()
