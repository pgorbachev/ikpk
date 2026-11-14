"""Regression tests: renderer proof and DB document graphs must bind the same proposal."""
import copy
import importlib.util
import inspect
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('reviewed_rehearse', HERE / 'rehearse.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class ReviewEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path = Path(self.temp.name)
        subprocess.run(['node', str(HERE / 'content-proof-fixture.mjs'), str(path / 'db.sqlite'), str(path / 'proof.json')], check=True, capture_output=True)
        self.db = sqlite3.connect(path / 'db.sqlite')
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        proof = json.loads((path / 'proof.json').read_text())
        self.receipt, self.item = proof['receipt'], proof['item']
        self.sources, entries = [], []
        for row in self.db.execute('SELECT * FROM seminars ORDER BY id'):
            source = {key: row[key] for key in ('id', 'document_id', 'locale', 'description', 'full_text', 'learning_plan', 'learning_mode', 'recommendations')}
            source.update(version='published' if row['published_at'] else 'draft', path='/inst/course/slug')
            self.sources.append({'source': source})
            entries.append({'id': row['id'], 'document_id': 'doc', 'version': source['version'], 'path': source['path'],
                            'source_sha256': m.digest_source(source), 'sections': ['documents'],
                            'ids': {'documents': 'section-documents'}, 'aliases': {'documents': ['legacy-documents']},
                            'fields': {'description': '<p>Text</p>'}, 'reasons': ['documents-require-separate-structured-review']})
        self.report = {'sidecar_sha256': 'db77136e25d403c16d0d38b488578a92adcf0b8361b5c2b1afa9dac52346e8ff', 'entries': entries}
        self.renderer_hash = m.renderer_fingerprint() if hasattr(m, 'renderer_fingerprint') else 'b' * 64
        self.rendered = [{'id': 2, 'path': '/inst/course/slug', 'errors': [], 'entry': copy.deepcopy(entries[1]),
                          'rendererSha256': self.renderer_hash, 'documentProposal': copy.deepcopy(self.item['proposal'])}]

    def plan(self):
        # The pre-fix implementation has no evidence kwargs. Do not mistake a
        # missing parameter/TypeError for a successful security regression test.
        evidence = {'documents_receipt': self.receipt, 'expected_documents_receipt_digest': self.receipt['digest'],
                    'expected_documents_plan_digest': self.receipt['payload']['planDigest'],
                    'expected_renderer_sha256': self.renderer_hash}
        accepted = inspect.signature(m.make_plan).parameters
        return m.make_plan(self.db, self.sources, self.report, self.rendered, **{k: v for k, v in evidence.items() if k in accepted})

    def assertRefused(self):
        before = list(self.db.iterdump())
        try:
            plan, exclusions = self.plan()
        except ValueError:
            pass
        else:
            self.assertEqual(len(plan), 0, 'stale proof must never authorize content_format=structured')
            self.assertTrue(exclusions, 'refusal must explain the excluded record')
        self.assertEqual(list(self.db.iterdump()), before, 'planning remains read-only')

    def test_unmodified_renderer_and_independent_document_graphs_are_accepted(self):
        plan, exclusions = self.plan()
        self.assertEqual((len(plan), exclusions), (2, []))

    def test_old_renderer_evidence_cannot_authorize_changed_target_fields(self):
        for entry in self.report['entries']:
            entry['fields']['description'] = '<p>Unreviewed replacement</p>'
        self.assertRefused()

    def test_old_renderer_evidence_cannot_authorize_changed_anchor_ids(self):
        for entry in self.report['entries']:
            entry['ids']['documents'] = 'unreviewed-anchor'
        self.assertRefused()

    def test_old_renderer_evidence_cannot_authorize_removed_anchor_aliases(self):
        for entry in self.report['entries']:
            entry['aliases']['documents'] = []
        self.assertRefused()

    def test_old_renderer_evidence_cannot_authorize_removing_document_section(self):
        for entry in self.report['entries']:
            entry.update(sections=[], ids={}, aliases={})
        self.assertRefused()

    def test_renderer_fingerprint_must_match_current_reviewed_renderer(self):
        self.rendered[0]['rendererSha256'] = '0' * 64
        self.assertRefused()

    def test_renderer_document_proposal_must_match_reviewed_document_receipt(self):
        self.rendered[0]['documentProposal']['documents'][0]['document'] = 'Different certificate'
        self.assertRefused()

    def test_unbound_legacy_evidence_with_only_id_path_errors_is_refused(self):
        self.rendered = [{key: self.rendered[0][key] for key in ('id', 'path', 'errors')}]
        self.assertRefused()

    def test_each_physical_version_requires_the_exact_document_postimage(self):
        mutations = [
            "DELETE FROM seminars_cmps WHERE entity_id=? AND field='documents'",
            "DELETE FROM components_seminar_document_records WHERE id IN (SELECT cmp_id FROM seminars_cmps WHERE entity_id=? AND field='documents')",
            "UPDATE components_seminar_document_records SET document='changed' WHERE id IN (SELECT cmp_id FROM seminars_cmps WHERE entity_id=? AND field='documents')",
            "UPDATE components_seminar_registry_facts SET url='https://example.test/changed' WHERE id IN (SELECT c.cmp_id FROM components_seminar_document_records_cmps c JOIN seminars_cmps s ON s.cmp_id=c.entity_id WHERE s.entity_id=? AND s.field='documents')",
            "UPDATE components_seminar_registry_facts SET url='https://example.test/changed' WHERE id IN (SELECT cmp_id FROM seminars_cmps WHERE entity_id=? AND field='training_registries')",
            "UPDATE components_seminar_nmo_facts SET status='awarded' WHERE id IN (SELECT cmp_id FROM seminars_cmps WHERE entity_id=? AND field='nmo')",
            "UPDATE seminars SET documents_state='not-issued' WHERE id=?",
        ]
        for version_id in (1, 2):
            for sql in mutations:
                with self.subTest(version_id=version_id, mutation=sql):
                    self.db.execute('SAVEPOINT mutation')
                    try:
                        self.db.execute(sql, (version_id,))
                        self.assertRefused()
                    finally:
                        self.db.execute('ROLLBACK TO mutation')
                        self.db.execute('RELEASE mutation')


if __name__ == '__main__':
    unittest.main()
