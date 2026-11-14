import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from scripts.lib import rehearsal_host as host
from scripts.rehearsal import staging193 as operator


def archive(files, comment='a'*40):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w',format=tarfile.PAX_FORMAT,pax_headers={'comment':comment}) as tar:
        for name,data in files.items():
            info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
    return out.getvalue()

class ReviewedMigrationAdmission(unittest.TestCase):
    def test_claimed_pax_sha_does_not_admit_modified_source(self):
        original=archive({'web/package.json':b'good'})
        forged=archive({'web/package.json':b'bad'})
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'proof.tar';file.write_bytes(forged)
            with patch.object(operator,'capture_bytes',return_value=original):
                with self.assertRaisesRegex(operator.Refusal,'contents differ'):
                    operator.admit_seminar_proof(str(file),hashlib.sha256(forged).hexdigest(),'a'*40,{'sourceSha':'a'*40})
    def test_correct_archive_requires_external_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'proof.tar';file.write_bytes(archive({}))
            with self.assertRaisesRegex(operator.Refusal,'independently supplied'):
                operator.admit_seminar_proof(str(file),'b'*64,'a'*40,{'sourceSha':'a'*40})
    def test_host_rechecks_proof_bytes_against_admitted_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'web/src').mkdir(parents=True)
            files={name:b'content' for name in host.SEMINAR_PROOF_REQUIRED}
            files['web/src/page.astro']=b'page'
            for name,data in files.items():
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
            payload=archive(files);(root/'.ikpk-seminar-proof.tar.gz').write_bytes(payload)
            provenance={'sourceSha':'a'*40,'seminarProofArtifact':{'sourceSha':'a'*40,'payloadSha256':hashlib.sha256(payload).hexdigest()}}
            self.assertEqual(host._verify_seminar_proof(root,provenance)['payloadSha256'],hashlib.sha256(payload).hexdigest())
            (root/'web/src/page.astro').write_text('changed')
            with self.assertRaisesRegex(host.HostFailure,'source'):
                host._verify_seminar_proof(root,provenance)
    def test_capture_sources_must_be_archived_and_match_without_extra_components(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files = {name: b'content' for name in host.SEMINAR_PROOF_REQUIRED}
            files['web/src/page.astro'] = b'page'
            for name, data in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            def check(entries):
                payload = archive(entries)
                (root / '.ikpk-seminar-proof.tar.gz').write_bytes(payload)
                host._verify_seminar_proof(root, {'sourceSha': 'a'*40, 'seminarProofArtifact': {
                    'sourceSha': 'a'*40, 'payloadSha256': hashlib.sha256(payload).hexdigest()}})
            check(files)
            for name in ('web/scripts/capture-content-snapshot.ts', 'scripts/lib/server-capture-sqlite.mjs',
                         'cms/src/api/schedule-entry/content-types/schedule-entry/schema.json'):
                with self.subTest(missing=name), self.assertRaises(host.HostFailure):
                    check({k: v for k, v in files.items() if k != name})
                path = root / name
                path.write_bytes(b'changed')
                with self.subTest(changed=name), self.assertRaises(host.HostFailure):
                    check(files)
                path.write_bytes(files[name])
            extra = root / 'cms/src/components/shared/extra.json'
            extra.write_text('{}')
            with self.assertRaisesRegex(host.HostFailure, 'component source set'):
                check(files)

    def test_review_files_are_immutable_and_hash_bound_across_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();raw=b'{"plan":1}';digest=hashlib.sha256(raw).hexdigest()
            control={'operationId':'op','sourceSha':'a'*40,'reviewedStep':{'id':'step','fileBase64':base64.b64encode(raw).decode(),'expectedReviewFileSha256':digest,'expectedPlanDigest':'b'*64}}
            with patch.object(host.pwd,'getpwnam',return_value=type('User',(),{'pw_uid':os.getuid(),'pw_gid':os.getgid()})()):
                argv=host._migration_review_arguments({'cmsUser':'cms'},root,'op','a'*40,control)
                self.assertIn('--review-step',argv)
                self.assertEqual(host._migration_review_arguments({'cmsUser':'cms'},root,'op','a'*40,control),argv)
                saved=root/'reviews'/f'reviewedStep-{digest}.json';saved.write_text('changed')
                with self.assertRaisesRegex(host.HostFailure,'review'):
                    host._migration_review_arguments({'cmsUser':'cms'},root,'op','a'*40,control)
    def test_wrong_operation_and_source_cannot_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            for control in ({'operationId':'other','sourceSha':'a'*40},{'operationId':'op','sourceSha':'c'*40}):
                with self.assertRaisesRegex(host.HostFailure,'operation'):
                    host._migration_review_arguments({},Path(temp),'op','a'*40,control)

    def test_host_supports_successive_review_pauses_without_replacing_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();source=root/'source';artifact=source/'.staging193-rehearsal/op/migration/cms-artifact'
            (artifact/'scripts').mkdir(parents=True)
            (artifact/'scripts/verify-seminar-proof-artifact.py').write_text('verifier')
            live=root/'live.db';live.write_bytes(b'source')
            candidate=artifact.parent/'candidate.db';receipt=artifact.parent/'receipt.json'
            user=type('User',(),{'pw_uid':os.getuid(),'pw_gid':os.getgid()})()
            config={'cmsDatabase':str(live),'cmsUser':'cms'}
            commands=[];responses=[{'waitingForReview':'schedule'}, {'waitingForReview':'documents'}, {'waitingForCompositionReview':True}, {'waitingForRegistryBinding':True}]
            def run(_config,_cwd,argv,**kwargs):
                commands.append(argv)
                self.assertEqual(argv[2],'prepare','paused migration must not run activation status')
                if not candidate.exists():
                    candidate.write_bytes(b'candidate')
                    receipt.write_text(json.dumps({'sourceCommitSha':'a'*40,'reviewedSteps':{}}))
                else:self.assertEqual(candidate.read_bytes(),b'candidate')
                return json.dumps(responses.pop(0))
            with patch.object(host,'_validate_prepared_cms_candidate',return_value=(source,artifact,root/'deps')), \
                 patch.object(host,'_protected_cms_migration_artifact',return_value=artifact), \
                 patch.object(host,'_verify_seminar_proof',return_value={'sourceSha':'a'*40,'payloadSha256':'b'*64}), \
                 patch.object(host.pwd,'getpwnam',return_value=user), \
                 patch.object(host,'_ensure_empty_candidate_upload_directory'), \
                 patch.object(host,'_run_as_cms',side_effect=run), \
                 patch.object(host,'_configure_candidate_uploads',side_effect=AssertionError('do not activate paused migration')):
                for _ in range(4):
                    result=host._install_migrated_database(config,source,'op',root/'old',provenance={})
                    self.assertTrue(result['migrationPaused'])
                    self.assertEqual(result['stageSnapshotDir'],str(artifact.parent/'stage-snapshots'))
            self.assertEqual(len(commands),4)
            for command in commands:
                self.assertEqual(command[command.index('--source-commit-sha')+1],'a'*40)

    def test_receipt_cannot_self_authorize_review_after_pause(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt=Path(temp)/'receipt.json'
            receipt.write_text(json.dumps({'sourceCommitSha':'a'*40,'reviewedSteps':{'step':{'expectedPlanDigest':'b'*64}}}))
            with self.assertRaisesRegex(host.HostFailure,'root journal'):
                host._verify_migration_receipt_admission(receipt,[],{'sourceSha':'a'*40,'payloadSha256':'c'*64})

if __name__=='__main__':unittest.main()
