import importlib.util
import json
from pathlib import Path
import unittest

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('migration', here / 'prepare.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root = here.parents[1]
snapshot = (root / 'fixtures/content-snapshot/collapsible_panels.json').read_bytes()
manifest = json.loads((here / 'manifest.json').read_text())

class MigrationTest(unittest.TestCase):
    def test_coverage_and_identity(self):
        rows = m.prepare(snapshot, manifest)
        self.assertEqual(len(rows), 69)
        self.assertEqual({r['group'] for r in rows}, set(range(1, 22)))
        self.assertTrue(all(not r['eligibleForAutomaticWrite'] for r in rows))
        self.assertEqual(sum(bool(r['exception']) for r in rows), 8)

    def test_semantics_and_unknowns(self):
        a = m.group_facts(1)
        self.assertEqual(a['documents'][0]['issuer'], 'Институт Апледжера')
        self.assertEqual(a['documents'][0]['signed_by'], 'teacher')
        self.assertEqual(a['training_registries'][0]['subject'], 'training')
        self.assertTrue(a['documents'][1]['issuer_unknown'])
        self.assertEqual(a['documents'][1]['prior_education'], 'medical')
        self.assertEqual(m.group_facts(6)['documents'][1]['completion_scope'], 'full-cycle')
        self.assertEqual(m.group_facts(3)['documents'][0]['hours_mode'], 'actual-completed')
        self.assertEqual(m.group_facts(13)['nmo']['status'], 'awarded')
        self.assertEqual(m.group_facts(17)['nmo']['status'], 'possible')
        self.assertEqual(m.group_facts(18)['documents'][1]['registry'][0]['subject'], 'document')
        self.assertEqual(m.group_facts(10)['documents_state'], 'not-issued')
        for group in (11, 12):
            other = m.group_facts(group)['documents'][0]
            self.assertTrue(other['document_type_unspecified'])
            self.assertEqual(other['completion_scope'], 'other-seminar')
            self.assertTrue(other['other_seminar_href'])
        self.assertEqual({d.get('outcome') for d in m.group_facts(3)['documents'][1:]},
                         {'assessment-not-completed', 'assessment-failed', 'partially-completed', 'expelled'})
        with self.assertRaises(ValueError): m.group_facts(22)

    def test_source_and_manifest_changes_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'Snapshot SHA-256 mismatch'):
            m.prepare(snapshot + b' ', manifest)
        changed = [dict(x) for x in manifest]; changed[0]['sourceSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Source mismatch'): m.prepare(snapshot, changed)
        changed = [dict(x) for x in manifest]; changed[0]['documentId'] = changed[1]['documentId']
        with self.assertRaisesRegex(ValueError, 'identities'): m.prepare(snapshot, changed)

    def test_original_links_and_fragment_preserved(self):
        rows = m.prepare(snapshot, manifest)
        self.assertIn('/svedeniya-ob-obrazovatelnoy-organizatsii#section-3', next(r for r in rows if r['group'] == 3)['sourceLinks'])
        self.assertIn('https://www.iahe.com/', next(r for r in rows if r['group'] == 1)['sourceLinks'])
        self.assertTrue(next(r for r in rows if r['group'] == 11)['sourceLinks'][0].endswith('antistressovaya-kineziologiya-2'))

if __name__ == '__main__': unittest.main()
