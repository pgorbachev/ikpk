import subprocess
import tarfile
import tempfile
import unittest
import hashlib
import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'build-seminar-proof-artifact.sh'
VERIFY_PATH = Path(__file__).resolve().parents[2] / 'cms/scripts/verify-seminar-proof-artifact.py'
SPEC = importlib.util.spec_from_file_location('verify_seminar_proof', VERIFY_PATH)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
REQUIRED = [
    'web/package.json', 'web/package-lock.json', 'web/astro.config.mjs',
    'web/scripts/seminar-migration/render-audit.ts', 'web/scripts/seminar-migration/rehearse.py',
    'web/tests/seminar-real-migration.migration.test.ts', 'web/tests/seminar-separate-fields.migration.test.ts',
    'fixtures/content-snapshot/collapsible_panels.json', 'fixtures/content-snapshot/url_map.csv', 'web/src/page.ts',
    'web/scripts/capture-content-snapshot.ts', 'cms/src/lib/demo193-source-empty-fields.json',
    *['web/scripts/lib/' + x + '.ts' for x in ['capture-snapshot-contract', 'content-field-map', 'content-snapshot', 'content-media-store', 'historical-exceptions', 'content-contract']],
    *['scripts/lib/' + x + '.mjs' for x in ['staging193-capture-bundle', 'server-capture-sqlite', 'seal-staging193-capture']],
    *['cms/src/api/' + x + '/content-types/' + x + '/schema.json' for x in ['institute', 'course-group', 'seminar', 'teacher', 'article', 'schedule-entry', 'news-item', 'promotion', 'page', 'video-playlist']],
    *['cms/src/components/' + x + '.json' for x in ['shared/seo', 'seminar/document-record', 'seminar/registry-fact', 'seminar/nmo-fact']],
]


class ProofArtifactTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'repo'
        self.root.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        for rel in REQUIRED:
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('proof input\n')
        (self.root / '.gitignore').write_text('web/src/ignored*\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'proof inputs')
        self.out = Path(self.tmp.name) / 'proof.tar.gz'

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.root, check=True, capture_output=True)

    def build(self):
        return subprocess.run(['bash', str(SCRIPT), str(self.out)], cwd=self.root, text=True, capture_output=True)

    def test_clean_head_contains_full_tracked_web_and_pinned_sidecar(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(self.out, 'r:gz') as archive:
            names = set(archive.getnames())
        self.assertTrue(set(REQUIRED).issubset(names))
        self.assertNotEqual(self.build().returncode, 0, 'must not overwrite an existing artifact')

    def test_uncommitted_untracked_and_ignored_renderer_inputs_refuse(self):
        for rel in ('web/src/page.ts', 'web/src/new.ts', 'web/src/ignored-file', 'scripts/lib/server-capture-sqlite.mjs', 'cms/src/components/shared/seo.json'):
            with self.subTest(path=rel):
                path = self.root / rel
                original = path.read_text() if path.exists() else None
                path.write_text('changed\n')
                self.assertNotEqual(self.build().returncode, 0)
                if original is None:
                    path.unlink()
                else:
                    path.write_text(original)

    def test_missing_committed_proof_input_refuses(self):
        (self.root / REQUIRED[3]).unlink()
        self.git('add', '-u')
        self.git('commit', '-qm', 'remove required proof')
        self.assertNotEqual(self.build().returncode, 0)

    def test_reviewed_archive_commit_and_renderer_all_must_match(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.root, text=True).strip()
        digest = hashlib.sha256(self.out.read_bytes()).hexdigest()
        renderer = hashlib.sha256()
        paths = sorted(['src/page.ts', *VERIFY.FIXED], key=lambda s: s.encode('utf-16-be'))
        for path in paths:
            content_hash = hashlib.sha256((self.root / 'web' / path).read_bytes()).hexdigest()
            renderer.update((path + '\0' + content_hash + '\n').encode())
        proof = renderer.hexdigest()
        self.assertTrue(VERIFY.verify(str(self.out.resolve()), digest, commit, proof)['passed'])
        for bad in [(digest, '0' * 40, proof), ('0' * 64, commit, proof), (digest, commit, '0' * 64)]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                VERIFY.verify(str(self.out.resolve()), *bad)

    def test_snapshot_generated_media_manifest_is_not_renderer_code(self):
        generated = self.root / 'web/src/lib/media-manifest.json'
        generated.parent.mkdir(parents=True)
        generated.write_text('{"generated":"snapshot-dependent"}')
        self.git('add', '.')
        self.git('commit', '-qm', 'include generated media manifest')
        self.assertEqual(self.build().returncode, 0)
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.root, text=True).strip()
        digest = hashlib.sha256(self.out.read_bytes()).hexdigest()
        renderer = hashlib.sha256()
        for path in sorted(['src/page.ts', *VERIFY.FIXED], key=lambda s: s.encode('utf-16-be')):
            content_hash = hashlib.sha256((self.root / 'web' / path).read_bytes()).hexdigest()
            renderer.update((path + '\0' + content_hash + '\n').encode())
        self.assertTrue(VERIFY.verify(str(self.out.resolve()), digest, commit, renderer.hexdigest())['passed'])


if __name__ == '__main__':
    unittest.main()
