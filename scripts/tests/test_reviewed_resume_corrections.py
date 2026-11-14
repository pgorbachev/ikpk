import base64
import hashlib
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from scripts.lib import rehearsal_host as host

class ResumeCorrections(unittest.TestCase):
    def control(self, digest):
        return {'operationId':'op','sourceSha':'a'*40,'reviewedStep':{'id':'step','expectedReviewFileSha256':digest*64,'expectedPlanDigest':digest*64,'fileBase64':base64.b64encode(b'{}').decode()}}
    def test_multiple_rejected_submissions_replay_to_final_bound_review(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt=Path(temp).resolve()/'receipt.json'
            receipt.write_text(json.dumps({'reviewedSteps':{'step':{'expectedReviewFileSha256':'d'*64,'expectedPlanDigest':'d'*64}}}))
            old, rejected, accepted = self.control('b'), self.control('c'), self.control('d')
            self.assertEqual(host._effective_migration_reviews([old,rejected,accepted],receipt),[accepted])
    def test_corrected_rejected_submission_does_not_poison_same_operation(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt=Path(temp).resolve()/'receipt.json';receipt.write_text(json.dumps({'reviewedSteps':{}}))
            old,new=self.control('b'),self.control('c')
            self.assertEqual(host._effective_migration_reviews([old],receipt,new),[new])
            # Simulate the corrected review committing before a crash: replaying
            # the append-only submission history must recover the same approval.
            receipt.write_text(json.dumps({'reviewedSteps':{'step':{'expectedReviewFileSha256':'c'*64,'expectedPlanDigest':'c'*64}}}))
            self.assertEqual(host._effective_migration_reviews([old,new],receipt),[new])
            with self.assertRaisesRegex(host.HostFailure,'replace a bound'):
                host._effective_migration_reviews([old,new],receipt,old)
    def test_completed_original_review_cannot_be_replaced(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt=Path(temp).resolve()/'receipt.json';receipt.write_text(json.dumps({'reviewedSteps':{'step':{'expectedReviewFileSha256':'b'*64,'expectedPlanDigest':'b'*64}}}))
            with self.assertRaisesRegex(host.HostFailure,'replace a bound'):
                host._effective_migration_reviews([self.control('b')],receipt,self.control('c'))
    def test_missing_writable_receipt_binding_does_not_allow_replacing_committed_step(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();receipt=root/'receipt.json';receipt.write_text('{"reviewedSteps":{}}')
            with sqlite3.connect(root/'candidate.db') as db:
                db.execute('CREATE TABLE ikpk_data_migration_history(step_id TEXT)');db.execute("INSERT INTO ikpk_data_migration_history VALUES('step')")
            with self.assertRaisesRegex(host.HostFailure,'replace a committed'):
                host._effective_migration_reviews([self.control('b')],receipt,self.control('c'))
    def test_inherited_admission_rejects_changed_receipt_despite_self_consistent_json(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();release=root/'migration/cms-artifact';release.mkdir(parents=True)
            prior={'phase':'prepared','operationId':'old','sourceCommitSha':'a'*40,'registryBinding':{'registrySha256':'b'*64},'seminarStepHistory':[{}, {}, {}, {}]}
            receipt=release.parent/'receipt.json';receipt.write_text(json.dumps(prior))
            manifest={'cmsRelease':str(release),'receiptSha256':hashlib.sha256(receipt.read_bytes()).hexdigest(),'operationId':'old','sourceCommit':'a'*40,'registrySha256':'b'*64};(root/'current.json').write_text(json.dumps(manifest))
            with patch.object(host,'HISTORICAL_REGISTRY_DIRECTORY',root),patch.object(host,'_historical_registry_environment',return_value={'CONTENT_HISTORICAL_EXCEPTIONS_FILE':str(root/'registry.json')}):
                self.assertEqual(host._admit_inherited_seminar_cohort({},release)['expectedReceiptSha256'],manifest['receiptSha256'])
                prior['seminarStepHistory']=[{'changed':True}]*4;receipt.write_text(json.dumps(prior))
                with self.assertRaisesRegex(host.HostFailure,'root-sealed'):
                    host._admit_inherited_seminar_cohort({},release)
if __name__=='__main__':unittest.main()
