"""Regression tests: no CMS-owned pre-seal install and no mixed Node runtimes."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from scripts.lib import rehearsal_host as host


class PrivateDependencyInstaller(unittest.TestCase):
    def accounts(self, installer_uid=720, installer_gid=720, members=()):
        cms = SimpleNamespace(pw_name='cms',pw_uid=710,pw_gid=710,pw_shell='/usr/sbin/nologin')
        installer = SimpleNamespace(pw_name='ikpk-deps',pw_uid=installer_uid,pw_gid=installer_gid,pw_shell='/usr/sbin/nologin')
        return cms,installer,SimpleNamespace(gr_mem=list(members))

    def test_install_inputs_require_exact_pinned_archive_even_when_source_is_tampered(self):
        import io, tarfile
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root=Path(temp); (root/'cms').mkdir()
            (root/'cms/package.json').write_bytes(b'malicious checkout')
            stream=io.BytesIO()
            with tarfile.open(fileobj=stream,mode='w:gz') as tar:
                for name,data in [('package.json',b'approved package'),('package-lock.json',b'approved lock'),('scripts/run-data-migrations.mjs',b'export const ROOT_SEALED_DEPENDENCIES_VERSION = 3;')]:
                    info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
            payload=stream.getvalue();archive=root/'.ikpk-cms-artifact.tar.gz';archive.write_bytes(payload)
            evidence={'payloadSha256':host.sha256_file_bytes(payload)}
            self.assertEqual(host._admitted_cms_install_inputs(root,evidence)['package.json'],b'approved package')
            archive.write_bytes(payload+b'tampered')
            with self.assertRaisesRegex(host.HostFailure,'digest'):
                host._admitted_cms_install_inputs(root,evidence)

    def test_generation_capability_is_pinned_to_ci_inputs_not_checkout_runner(self):
        import json
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            root=Path(temp);cms=root/'cms';(cms/'scripts').mkdir(parents=True)
            (cms/'scripts/run-data-migrations.mjs').write_text('legacy or attacker runner')
            (cms/'package-lock.json').write_bytes(b'{}');(cms/'package.json').write_bytes(b'{}')
            releases=root/'releases';releases.mkdir()
            inputs={'package.json':b'{}','package-lock.json':b'{}',
                    'scripts/run-data-migrations.mjs':b'export const ROOT_SEALED_DEPENDENCIES_VERSION = 3;'}
            with patch.object(host,'_dependency_installer_account',side_effect=host.HostFailure('v3 installer required')):
                with self.assertRaisesRegex(host.HostFailure,'v3 installer required'):
                    host._cms_build_generation({'releaseRoot':str(releases)},root,admitted_inputs=inputs)

    def test_prepared_validation_uses_admitted_capability_despite_legacy_checkout(self):
        import io,json,tarfile
        from scripts.tests.test_cms_artifact_host_consumer import prepared_artifact
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            f=prepared_artifact(Path(temp))
            archive_path=f['source']/'.ikpk-cms-artifact.tar.gz'
            data=b'export const ROOT_SEALED_DEPENDENCIES_VERSION = 3;'
            stream=io.BytesIO()
            with tarfile.open(fileobj=io.BytesIO(archive_path.read_bytes()),mode='r:gz') as source, tarfile.open(fileobj=stream,mode='w:gz') as target:
                for info in source.getmembers():
                    payload=data if info.name=='scripts/run-data-migrations.mjs' else (source.extractfile(info).read() if info.isfile() else None)
                    if payload is not None:info.size=len(payload)
                    target.addfile(info,io.BytesIO(payload) if payload is not None else None)
            payload=stream.getvalue();archive_path.write_bytes(payload)
            f['provenance']['cmsArtifact']['payloadSha256']=host.sha256_file_bytes(payload)
            (f['source']/'.ikpk-rehearsal-ci.json').write_text(json.dumps(f['provenance']))
            (f['artifact']/'scripts/run-data-migrations.mjs').write_bytes(data)
            (f['source']/'cms/scripts').mkdir()
            (f['source']/'cms/scripts/run-data-migrations.mjs').write_text('legacy checkout replacement')
            with patch.object(host,'_dependency_installer_account',side_effect=host.HostFailure('v3 installer required')):
                with self.assertRaisesRegex(host.HostFailure,'v3 installer required'):
                    host._validate_prepared_cms_candidate(f['config'],f['source'],f['operationId'],f['provenance'])
            with self.assertRaisesRegex(host.HostFailure,'trusted CI provenance'):
                host._validate_prepared_cms_candidate(f['config'],f['source'],f['operationId'])

    def test_installer_uid_and_group_cannot_be_shared_with_cms(self):
        for uid,gid,members in ((710,720,()),(720,710,()),(720,720,('cms',))):
            cms,installer,group=self.accounts(uid,gid,members)
            with patch.object(host.pwd,'getpwnam',side_effect=lambda name:cms if name=='cms' else installer), \
                 patch.object(host.pwd,'getpwall',return_value=[cms,installer]), \
                 patch('grp.getgrgid',return_value=group), patch.object(host.os,'getgrouplist',return_value=[710]):
                with self.assertRaises(host.HostFailure): host._dependency_installer_account({'cmsUser':'cms'})

    def test_installer_supplementary_groups_cannot_access_cms_or_privileged_services(self):
        cms,installer,group=self.accounts()
        with patch.object(host.pwd,'getpwnam',side_effect=lambda name:cms if name=='cms' else installer), \
             patch.object(host.pwd,'getpwall',return_value=[cms,installer]), \
             patch('grp.getgrgid',return_value=group), \
             patch.object(host.os,'getgrouplist',side_effect=lambda name,gid:[710] if name=='cms' else [720,999]):
            with self.assertRaisesRegex(host.HostFailure,'dedicated'): host._dependency_installer_account({'cmsUser':'cms'})
        with patch.object(host.pwd,'getpwnam',side_effect=lambda name:cms if name=='cms' else installer), \
             patch.object(host.pwd,'getpwall',return_value=[cms,installer]), \
             patch('grp.getgrgid',return_value=group), \
             patch.object(host.os,'getgrouplist',side_effect=lambda name,gid:[gid]):
            self.assertEqual(host._dependency_installer_account({'cmsUser':'cms'}),installer)

    def test_process_probe_checks_saved_uids_and_refuses_unavailable_proc(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            proc=Path(temp);(proc/'self').mkdir();(proc/'self/status').write_text('Uid: 0 0 0 0\n')
            (proc/'23').mkdir();(proc/'23/status').write_text('Name: escaped\nUid: 100 100 720 100\n')
            with self.assertRaisesRegex(host.HostFailure,'live process'): host._assert_dependency_installer_idle(720,proc)
            (proc/'23/status').write_text('Uid: 100 100 100 100\n')
            host._assert_dependency_installer_idle(720,proc)
            (proc/'self/status').unlink()
            with self.assertRaisesRegex(host.HostFailure,'Linux process'):host._assert_dependency_installer_idle(720,proc)

    def test_private_unit_uses_exact_node_npm_clean_environment_and_drains_installer(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            work=Path(temp)/'work';work.mkdir()
            installer=self.accounts()[1]
            runtime={'nodeBinary':'/usr/bin/node','npmCli':'/usr/share/nodejs/npm/bin/npm-cli.js'}
            calls=[]
            def run(argv,**kwargs): calls.append(argv);return SimpleNamespace(stdout='11.1.0\n',returncode=0)
            with patch.object(host,'run',side_effect=run), \
                 patch.object(host,'_assert_dependency_installer_idle') as idle:
                result=host._run_private_dependency_install(work,installer,runtime,['ci','--no-audit','--no-fund'])
            unit=calls[0]
            self.assertIn('--uid=720',unit);self.assertNotIn('--uid=710',unit)
            self.assertIn('--property=KillMode=control-group',unit)
            self.assertIn('--property=NoNewPrivileges=yes',unit)
            index=unit.index('/usr/bin/env');self.assertEqual(unit[index+1],'-i')
            user_config=next(value.split('=',1)[1] for value in unit if value.startswith('NPM_CONFIG_USERCONFIG='))
            global_config=next(value.split('=',1)[1] for value in unit if value.startswith('NPM_CONFIG_GLOBALCONFIG='))
            self.assertNotEqual(user_config,global_config,'npm refuses double-loading one path as user and global config')
            self.assertEqual(unit[-5:],['/usr/bin/node','/usr/share/nodejs/npm/bin/npm-cli.js','ci','--no-audit','--no-fund'])
            self.assertIn('/usr/bin/systemctl',calls[-1]);self.assertIn('stop',calls[-1])
            self.assertEqual(idle.call_count,2)

    def test_restrictive_umask_keeps_runtime_readable_and_npm_config_paths_distinct(self):
        import stat
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            work=Path(temp)/'work';work.mkdir();calls=[]
            node=Path(temp)/'node-runtime';node.write_bytes(b'fixture runtime')
            def run(argv,**kwargs):
                if argv[0]=='/usr/bin/systemd-run':
                    runtime=work.parent/'runtime'
                    self.assertEqual(stat.S_IMODE(runtime.stat().st_mode),0o755)
                    user=next(value.split('=',1)[1] for value in argv if value.startswith('NPM_CONFIG_USERCONFIG='))
                    global_=next(value.split('=',1)[1] for value in argv if value.startswith('NPM_CONFIG_GLOBALCONFIG='))
                    self.assertNotEqual(user,global_)
                    for filename in (user,global_):
                        self.assertEqual(Path(filename).read_bytes(),b'')
                        self.assertEqual(stat.S_IMODE(Path(filename).stat().st_mode),0o444)
                    calls.append(argv)
                return SimpleNamespace(stdout='10.9.9',returncode=0)
            previous=os.umask(0o077)
            try:
                with patch.object(host,'run',side_effect=run),patch.object(host,'_assert_dependency_installer_idle'):
                    for args in (['--version'],['ci','--no-audit','--no-fund']):
                        host._run_private_dependency_install(work,self.accounts()[1],{'nodeBinary':str(node),'npmCli':'/usr/share/nodejs/npm/bin/npm-cli.js'},args)
            finally:os.umask(previous)
            self.assertEqual(len(calls),2)

    def test_background_installer_process_prevents_successful_install_admission(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            work=Path(temp)/'work';work.mkdir()
            with patch.object(host,'run',return_value=SimpleNamespace(stdout='',returncode=0)), \
                 patch.object(host,'_assert_dependency_installer_idle',side_effect=[None,host.HostFailure('installer still running')]):
                with self.assertRaisesRegex(host.HostFailure,'still running'):
                    host._run_private_dependency_install(work,self.accounts()[1],{'nodeBinary':'/usr/bin/node','npmCli':'/usr/share/nodejs/npm/bin/npm-cli.js'},['ci'])

    def test_failed_install_still_stops_cgroup_and_never_reports_completion(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temp:
            work=Path(temp)/'work';work.mkdir();calls=[]
            def run(argv,**kwargs):
                calls.append(argv)
                if argv[0]=='/usr/bin/systemd-run': raise host.HostFailure('npm failed')
                return SimpleNamespace(stdout='',returncode=0)
            with patch.object(host,'run',side_effect=run), patch.object(host,'_assert_dependency_installer_idle'):
                with self.assertRaisesRegex(host.HostFailure,'npm failed'):
                    host._run_private_dependency_install(work,self.accounts()[1],{'nodeBinary':'/usr/bin/node','npmCli':'/usr/share/nodejs/npm/bin/npm-cli.js'},['ci'])
            self.assertEqual(calls[-1][0:2],['/usr/bin/systemctl','stop'])


if __name__ == '__main__': unittest.main()
