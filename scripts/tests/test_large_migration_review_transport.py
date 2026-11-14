import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import tempfile
import unittest
from unittest.mock import patch

from scripts.lib import rehearsal_host as host
from scripts.lib.rehearsal_state import RehearsalState
from scripts.rehearsal import staging193 as operator


def digest(data):
    return hashlib.sha256(data).hexdigest()

class StopAfterAdmission(Exception):
    pass

class LargeMigrationReviewTransport(unittest.TestCase):
    def test_large_composition_admission_and_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); state_root = root/'state'; state_root.mkdir(); operation=root/'operation';operation.mkdir()
            source = root/'source'; source.mkdir(); artifact = operation/'cms-artifact'; artifact.mkdir()
            review = root/'composition.json'; review.write_bytes(b'{"padding":"'+b'x'*20_721_042+b'"}')
            review_sha = digest(review.read_bytes())
            manifest = {'operationId':'op','sourceSha':'a'*40,'compositionReview':{'reviewFilePath':str(review),'expectedFileSha256':review_sha,'expectedContractDigest':'b'*64}}
            path=root/'manifest.json';path.write_text(json.dumps(manifest)); envelope=operator.migration_review_payload(str(path),digest(path.read_bytes()),'a'*40,'op')
            self.assertGreater(len(envelope),16*1024*1024)
            state = RehearsalState(state_root)
            cms_artifact={'pinned':True}
            state._append({'version':1,'record':'start','operationId':'op','sourceSha':'a'*40,'cmsArtifact':cms_artifact,'oldPair':{'cmsPath':'/old','cmsSourceEnvironment':{}}})
            args=argparse.Namespace(operation_id='op',source_sha='a'*40,provenance_b64='e30=',offhost_sha256='c'*64,migration_review_sha256=digest(envelope))
            config={'profile':'staging194','backupRoot':str(root/'backups'),'cmsUser':pwd.getpwuid(os.getuid()).pw_name}
            backup=root/'backups'/'op';backup.mkdir(parents=True);(backup/'manifest.json').write_text('{}')
            def stop(*args,**kwargs): raise StopAfterAdmission()
            def submit(body):
                with patch.object(host.sys,'stdin',io.TextIOWrapper(io.BytesIO(body))), \
                     patch.object(state,'phase',return_value={'phase':'fenced','sourceSha':'a'*40}), \
                     patch.object(host,'_validate_paired_ci_workflows'),patch.object(host,'_trusted_cms_artifact',return_value=cms_artifact), \
                     patch.object(host,'_candidate_root',return_value=source),patch.object(host,'_cms_artifact_path',return_value=artifact), \
                     patch.object(host,'_validate_prepared_cms_candidate'),patch.object(host,'_start_acquisition',return_value={'phase':'fenced'}), \
                     patch.object(host,'_backup_manifest',return_value={'archiveSha256':'c'*64}),patch.object(host,'_preflight_staging194_source'), \
                     patch.object(host,'_install_migrated_database',side_effect=stop):
                    host._cms_update(config,state,args)
            with self.assertRaises(StopAfterAdmission): submit(envelope)
            rows=state.read_journal_for_cleanup();accepted=[r for r in rows if r['record']=='migration-review-submitted'];self.assertEqual(len(accepted),1)
            actual=accepted[0]['control']['compositionReview'];self.assertEqual(actual['expectedFileSha256'],review_sha)
            stored=operation/'reviews'/f'compositionReview-{review_sha}.json';self.assertEqual(digest(stored.read_bytes()),review_sha)
            with self.assertRaises(StopAfterAdmission): submit(envelope)
            self.assertEqual(len([r for r in state.read_journal_for_cleanup() if r['record']=='migration-review-submitted']),1)
            bad=bytearray(envelope);bad[-4]=ord('A') if bad[-4]!=ord('A') else ord('B')
            with self.assertRaisesRegex(host.HostFailure,'digest mismatch'): submit(bytes(bad))
            self.assertEqual(len([r for r in state.read_journal_for_cleanup() if r['record']=='migration-review-submitted']),1)
            altered=json.loads(envelope)
            encoded=altered['compositionReview']['fileBase64']
            altered['compositionReview']['fileBase64']=('A' if encoded[0]!='A' else 'B')+encoded[1:]
            altered_envelope=json.dumps(altered,sort_keys=True,separators=(',',':')).encode()
            args.migration_review_sha256=digest(altered_envelope)
            with self.assertRaisesRegex(host.HostFailure,'independently approved bytes'): submit(altered_envelope)
            self.assertEqual(len([r for r in state.read_journal_for_cleanup() if r['record']=='migration-review-submitted']),1)

    def test_oversized_transport_refused_before_json(self):
        payload=b'x'*(64*1024*1024+1)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();state_root=root/'state';state_root.mkdir();state=RehearsalState(state_root)
            artifact=root/'operation'/'cms-artifact';artifact.mkdir(parents=True);source=root/'source';source.mkdir();backup=root/'backups'/'op';backup.mkdir(parents=True);(backup/'manifest.json').write_text('{}')
            artifact_evidence={'pinned':True};state._append({'version':1,'record':'start','operationId':'op','sourceSha':'a'*40,'cmsArtifact':artifact_evidence,'oldPair':{'cmsPath':'/old','cmsSourceEnvironment':{}}})
            config={'profile':'staging194','backupRoot':str(root/'backups')};args=argparse.Namespace(operation_id='op',source_sha='a'*40,provenance_b64='e30=',offhost_sha256='c'*64,migration_review_sha256=digest(payload))
            with patch.object(host.sys,'stdin',io.TextIOWrapper(io.BytesIO(payload))),patch.object(state,'phase',return_value={'phase':'fenced','sourceSha':'a'*40}), \
                 patch.object(host,'_validate_paired_ci_workflows'),patch.object(host,'_trusted_cms_artifact',return_value=artifact_evidence), \
                 patch.object(host,'_candidate_root',return_value=source),patch.object(host,'_cms_artifact_path',return_value=artifact), \
                 patch.object(host,'_validate_prepared_cms_candidate'),patch.object(host,'_start_acquisition',return_value={'phase':'fenced'}), \
                 patch.object(host,'_backup_manifest',return_value={'archiveSha256':'c'*64}),patch.object(host,'_preflight_staging194_source'):
                with self.assertRaisesRegex(host.HostFailure,'digest mismatch'):host._cms_update(config,state,args)
            self.assertEqual(len(state.read_journal_for_cleanup()),1)

if __name__=='__main__': unittest.main()
