import importlib.util
import copy
from pathlib import Path
import sqlite3
import unittest

spec=importlib.util.spec_from_file_location('rehearse',Path(__file__).with_name('rehearse.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class RehearsalTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:'); self.db.row_factory=sqlite3.Row
        self.db.executescript('''CREATE TABLE seminars (id INTEGER, document_id TEXT, locale TEXT, description TEXT, full_text TEXT, learning_plan TEXT, learning_mode TEXT, recommendations TEXT, slug TEXT, legacy_id TEXT, published_at TEXT, content_format TEXT, audience TEXT, content_section_anchors TEXT, documents_state TEXT);
        CREATE TABLE seminars_course_group_lnk (seminar_id INTEGER,course_group_id INTEGER); CREATE TABLE course_groups(id INTEGER,slug TEXT); CREATE TABLE course_groups_institute_lnk(course_group_id INTEGER,institute_id INTEGER); CREATE TABLE institutes(id INTEGER,slug TEXT);
        INSERT INTO course_groups VALUES(1,'course'); INSERT INTO institutes VALUES(1,'inst'); INSERT INTO course_groups_institute_lnk VALUES(1,1);''')
        self.sources=[];self.reports=[]
        for id,version in ((1,'draft'),(2,'published')):
            self.db.execute('INSERT INTO seminars VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(id,'doc',None,'<p>Text</p>',None,None,None,None,'slug','inst/course/slug',None if id==1 else 'date',None,None,None,None))
            self.db.execute('INSERT INTO seminars_course_group_lnk VALUES(?,1)',(id,))
            source={'id':id,'document_id':'doc','locale':None,'description':'<p>Text</p>','full_text':None,'learning_plan':None,'learning_mode':None,'recommendations':None,'version':version,'path':'/inst/course/slug'}
            self.sources.append({'source':source});self.reports.append({'id':id,'sections':[],'ids':{},'aliases':{},'fields':{'description':'<p>Text</p>'},'source_sha256':m.digest_source(source),'reasons':[] if id==2 else ['draft-sidecar-origin-requires-proof']})
        self.report={'sidecar_sha256':'db77136e25d403c16d0d38b488578a92adcf0b8361b5c2b1afa9dac52346e8ff','entries':self.reports}
        self.renderer_hash=m.renderer_fingerprint()
        self.render=[{'id':2,'path':'/inst/course/slug','errors':[],'entry':copy.deepcopy(self.reports[1]),'rendererSha256':self.renderer_hash,'documentProposal':None}]
    def plan(self): return m.make_plan(self.db,self.sources,self.report,self.render,expected_renderer_sha256=self.renderer_hash)
    def test_pair_has_independent_preimages_and_verified_postimages(self):
        p,e=self.plan();self.assertEqual((len(p),e),(2,[]));self.assertEqual(p[0]['post']['content_format'],'structured');self.assertNotEqual(p[0]['preimage']['published_at'],p[1]['preimage']['published_at'])
    def test_drift_fails_closed(self):
        self.db.execute("update seminars set description='changed' where id=1")
        with self.assertRaisesRegex(ValueError,'Database field changed'):self.plan()
    def test_fingerprint_or_route_tampering_fails_closed(self):
        self.sources[1]['source']['description']='different'
        p,e=self.plan();self.assertEqual(p,[]);self.assertEqual(e[0]['reason'],'draft-published-content-differs')
    def test_missing_actual_renderer_never_creates_proposal(self):
        self.render=[];p,e=self.plan();self.assertEqual(p,[]);self.assertEqual(e[0]['reason'],'actual-render-not-verified')
    def test_existing_structured_fields_rejected(self):
        self.db.execute("update seminars set audience='already changed' where id=2")
        with self.assertRaisesRegex(ValueError,'Existing structured content'):self.plan()
    def test_missing_document_migration_rejected(self):
        self.reports[0].update(sections=['documents'],ids={'documents':'section-1'},aliases={'documents':[]})
        self.reports[1].update(sections=['documents'],ids={'documents':'section-1'},aliases={'documents':[]})
        with self.assertRaisesRegex(ValueError,'Document receipt|Structured documents missing'):self.plan()

if __name__ == '__main__':unittest.main()
