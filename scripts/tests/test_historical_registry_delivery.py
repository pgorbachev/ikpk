import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.lib import rehearsal_host

class HistoricalRegistryDelivery(unittest.TestCase):
    def test_paired_capture_and_build_use_identical_root_owned_pin(self):
        for profile in ('staging194', 'production-paired'):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as temp:
                source = Path(temp); web = source / 'web'; (web / 'scripts/lib').mkdir(parents=True)
                (web / 'scripts/lib/historical-exceptions.ts').write_text('present')
                history = {'CONTENT_HISTORICAL_EXCEPTIONS_FILE': '/fixed/registry.json', 'CONTENT_HISTORICAL_EXCEPTIONS_SHA256': 'a' * 64}
                calls = []
                def run_as_cms(_config, _cwd, argv, **kwargs):
                    calls.append((argv, kwargs['environment']))
                    if argv[:2] == ['/usr/bin/npm', 'run']:
                        raise RuntimeError('checked both stages')
                    return ''
                with patch.object(rehearsal_host, '_validate_prepared_web_dependencies'), \
                     patch.object(rehearsal_host, '_historical_registry_environment', return_value=history), \
                     patch.object(rehearsal_host, '_run_as_cms', side_effect=run_as_cms):
                    with self.assertRaisesRegex(RuntimeError, 'checked both stages'):
                        rehearsal_host._build_static({'profile':profile, 'siteBaseUrl':'https://194.226.99.10'},source,source/'capture')
                self.assertEqual(len(calls), 2)
                for _, environment in calls:
                    self.assertEqual({key:environment[key] for key in history}, history)

    def test_exact_root_owned_registry_and_pin(self):
        with tempfile.TemporaryDirectory(prefix='.registry-test-', dir=Path.cwd()) as temp:
            root = Path(temp); root.chmod(0o755)
            data = b'[{"documentId":"a"}]'; digest = hashlib.sha256(data).hexdigest()
            registry = root / f'registry-{digest}.json'; registry.write_bytes(data); registry.chmod(0o444)
            manifest = root / 'current.json'; manifest.write_text(json.dumps({'version': 1, 'registrySha256': digest, 'migrationPlanDigest':'1'*64, 'sourceDatabaseSha256':'2'*64, 'sourceCommit':'3'*40})); manifest.chmod(0o444)
            environment = rehearsal_host._historical_registry_environment(root, trusted_uid=os.getuid())
            self.assertEqual(environment, {'CONTENT_HISTORICAL_EXCEPTIONS_FILE': str(registry), 'CONTENT_HISTORICAL_EXCEPTIONS_SHA256': digest, 'IKPK_HISTORICAL_REGISTRY_MANIFEST_SHA256':hashlib.sha256(manifest.read_bytes()).hexdigest()})
            registry.chmod(0o644); registry.write_text('[]'); registry.chmod(0o444)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, 'registry'):
                rehearsal_host._historical_registry_environment(root, trusted_uid=os.getuid())
    def test_missing_required_manifest_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix='.registry-test-', dir=Path.cwd()) as temp:
            root=Path(temp);root.chmod(0o755)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, 'registry'):
                rehearsal_host._historical_registry_environment(root, trusted_uid=os.getuid())
