import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / 'test.db'
        self.panels = Path(self.tmp.name) / 'panels.json'
        self.panels.write_text(json.dumps({'/institute/course/seminar': {'Для кого подойдет': '<p>Original <a href="/apply">apply</a></p>'}}, ensure_ascii=False))
        c = sqlite3.connect(self.db)
        c.executescript('''CREATE TABLE seminars(id INTEGER, document_id TEXT, locale TEXT, slug TEXT, published_at TEXT, description TEXT, full_text TEXT, learning_plan TEXT, learning_mode TEXT, recommendations TEXT);
            CREATE TABLE seminars_course_group_lnk(seminar_id INTEGER,course_group_id INTEGER);
            CREATE TABLE course_groups(id INTEGER,slug TEXT);
            CREATE TABLE course_groups_institute_lnk(course_group_id INTEGER,institute_id INTEGER);
            CREATE TABLE institutes(id INTEGER,slug TEXT);
            INSERT INTO course_groups VALUES(3,'course'); INSERT INTO institutes VALUES(4,'institute');
            INSERT INTO course_groups_institute_lnk VALUES(3,4); INSERT INTO seminars_course_group_lnk VALUES(1,3); INSERT INTO seminars_course_group_lnk VALUES(2,3);''')
        html = '<div><h2 data-collapsible-title="true">Для кого подойдет</h2></div>'
        c.execute('INSERT INTO seminars VALUES(1,?,?,?,?,?,?,?,?,?)', ('doc', None, 'seminar', None, html+'DRAFT SECRET', None,None,None,None))
        c.execute('INSERT INTO seminars VALUES(2,?,?,?,?,?,?,?,?,?)', ('doc', None, 'seminar', '2026-01-01', html+'PUBLIC', None,None,None,None))
        c.commit(); c.close()

    def test_versions_are_separate_deterministic_and_no_text_leaks(self):
        first = audit.audit(self.db, self.panels)
        self.assertEqual(first, audit.audit(self.db, self.panels))
        draft, published = first['records']
        self.assertEqual((draft['version'], published['version']), ('draft', 'published'))
        self.assertNotEqual(draft['field_sha256']['description'], published['field_sha256']['description'])
        self.assertNotIn('DRAFT SECRET', json.dumps(first))
        self.assertIn('draft-sidecar-provenance-unverified', draft['blocked'])
        self.assertTrue(all(x['blocked'] for x in first['records']))
        self.assertEqual(published['sidecar_url_counts']['Для кого подойдет'], 1)

    def test_changed_content_and_link_change_fingerprints(self):
        before = audit.audit(self.db, self.panels)
        self.panels.write_text(self.panels.read_text().replace('/apply', '/other'))
        after = audit.audit(self.db, self.panels)
        self.assertNotEqual(before['sidecar_sha256'], after['sidecar_sha256'])
        self.assertNotEqual(before['records'][1]['sidecar_body_sha256'], after['records'][1]['sidecar_body_sha256'])
        self.assertEqual([x['id'] for x in before['records']], [x['id'] for x in after['records']])

    def test_unknown_or_missing_section_fails_closed(self):
        row = dict(audit.audit(self.db,self.panels)['records'][0])
        row.update(description='<h2 data-collapsible-title="true">Неизвестно</h2>',full_text=None,learning_plan=None,learning_mode=None,recommendations=None)
        actual = audit.inspect_row(row, ['/institute/course/seminar'], {})
        self.assertIn('unknown-title', actual['blocked'])
        self.assertIn('missing-sidecar-key', actual['blocked'])

    def test_read_only_and_invalid_path(self):
        original = self.db.read_bytes()
        audit.audit(self.db, self.panels)
        self.assertEqual(original, self.db.read_bytes())
        with self.assertRaises(sqlite3.OperationalError): audit.audit(self.db.with_name('missing.db'), self.panels)
        self.assertFalse(self.db.with_name('missing.db').exists())

if __name__ == '__main__': unittest.main()
