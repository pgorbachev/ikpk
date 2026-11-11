"""OpenSpec deploy-gating: old hashed assets must not accumulate across builds."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host


class OldAssetsMustNotAccumulate(unittest.TestCase):
    def test_each_static_build_contains_only_its_own_hashed_assets(self):
        with tempfile.TemporaryDirectory(prefix='.housekeeping-assets-', dir=Path.cwd()) as temporary:
            root = Path(temporary)
            releases = root / 'releases'
            previous = releases / 'A' / '_astro'
            previous.mkdir(parents=True)
            (previous / 'a.aaaaaaaa.css').write_text('A', encoding='utf-8')
            outputs = {}
            for version in ('B', 'C'):
                source = root / f'source-{version}'
                web = source / 'web'
                snapshot = web / '.snapshot'
                snapshot.mkdir(parents=True)
                (snapshot / 'snapshot.json').write_text('{"snapshotId":"snap:fixture"}', encoding='utf-8')
                (source / '.ikpk-rehearsal-ci.json').write_text(json.dumps({'sourceSha': 'a' * 40}), encoding='utf-8')

                def run_build(_config, _cwd, args, **_kwargs):
                    if args[:3] == ['/usr/bin/npm', 'run', 'build:demo193']:
                        assets = web / 'dist-demo193' / '_astro'
                        assets.mkdir(parents=True)
                        (assets / f'{version.lower()}.{version.lower() * 8}.css').write_text(version, encoding='utf-8')
                    return ''

                with patch.object(rehearsal_host, '_validate_prepared_web_dependencies'), \
                     patch.object(rehearsal_host, '_run_as_cms', side_effect=run_build):
                    dist, _ = rehearsal_host._build_static(
                        {'staticReleaseRoot': str(releases), 'siteBaseUrl': 'https://194.226.99.10'},
                        source, root / 'capture')
                outputs[version] = sorted(p.name for p in (dist / '_astro').iterdir())
                shutil.copytree(dist, releases / version)
            self.assertEqual(outputs, {'B': ['b.bbbbbbbb.css'], 'C': ['c.cccccccc.css']},
                             'the old A and B assets must not be copied into newer candidates')


if __name__ == '__main__':
    unittest.main()
