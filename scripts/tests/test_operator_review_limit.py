import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.lib import rehearsal_host as host
from scripts.rehearsal import staging193 as operator

class OperatorReviewLimit(unittest.TestCase):
    def test_exact_serialized_size_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();review=root/'composition.json';review.write_bytes(b'{"test":"abc"}')
            review_sha=hashlib.sha256(review.read_bytes()).hexdigest()
            manifest={'operationId':'op','sourceSha':'a'*40,'compositionReview':{'reviewFilePath':str(review),'expectedFileSha256':review_sha,'expectedContractDigest':'b'*64}}
            file=root/'manifest.json';file.write_text(json.dumps(manifest));sha=hashlib.sha256(file.read_bytes()).hexdigest()
            payload=operator.migration_review_payload(str(file),sha,'a'*40,'op')
            with patch.object(operator,'MIGRATION_REVIEW_TRANSPORT_LIMIT',len(payload)):
                self.assertEqual(operator.migration_review_payload(str(file),sha,'a'*40,'op'),payload)
            with patch.object(operator,'MIGRATION_REVIEW_TRANSPORT_LIMIT',len(payload)-1):
                with self.assertRaisesRegex(operator.Refusal,'transport.*limit'):
                    operator.migration_review_payload(str(file),sha,'a'*40,'op')
        self.assertEqual(operator.MIGRATION_REVIEW_TRANSPORT_LIMIT,64*1024*1024)
        self.assertEqual(operator.MIGRATION_REVIEW_TRANSPORT_LIMIT,host.MIGRATION_REVIEW_TRANSPORT_LIMIT)

    def test_real_limit_with_large_composition_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();review=root/'composition.json';file=root/'manifest.json'
            for size, accepted in ((50_000_000, True), (50_331_648, False)):
                with self.subTest(size=size):
                    review.write_bytes(b'x' * size)
                    review_sha=hashlib.sha256(review.read_bytes()).hexdigest()
                    manifest={'operationId':'op','sourceSha':'a'*40,'compositionReview':{'reviewFilePath':str(review),'expectedFileSha256':review_sha,'expectedContractDigest':'b'*64}}
                    file.write_text(json.dumps(manifest));sha=hashlib.sha256(file.read_bytes()).hexdigest()
                    if accepted:
                        payload=operator.migration_review_payload(str(file),sha,'a'*40,'op')
                        self.assertLessEqual(len(payload),64*1024*1024)
                        self.assertGreater(len(payload),16*1024*1024)
                        del payload
                    else:
                        with self.assertRaisesRegex(operator.Refusal,'transport.*limit'):
                            operator.migration_review_payload(str(file),sha,'a'*40,'op')

    def test_rejects_before_remote_preflight_and_acquisition(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();review=root/'review';review.write_bytes(b'{}')
            manifest={'operationId':'op','sourceSha':'a'*40,'compositionReview':{'reviewFilePath':str(review),'expectedFileSha256':hashlib.sha256(b'{}').hexdigest(),'expectedContractDigest':'b'*64}}
            file=root/'manifest';file.write_text(json.dumps(manifest));sha=hashlib.sha256(file.read_bytes()).hexdigest()
            for profile,install in [('production-paired',False),('staging194',True)]:
                args=argparse.Namespace(profile=profile,command='cms-update',operation_id='op',host=None,source_sha='a'*40,install_host_helper=install,migration_review=str(file),migration_review_sha256=sha)
                with self.subTest(profile=profile),patch.object(operator,'MIGRATION_REVIEW_TRANSPORT_LIMIT',1), \
                     patch.object(operator,'ssh_remote',side_effect=AssertionError('SSH called')), \
                     patch.object(operator,'_check_target_space',side_effect=AssertionError('preflight called')), \
                     patch.object(operator,'validate_sha_and_ci',side_effect=AssertionError('acquisition called')):
                    with self.assertRaisesRegex(operator.Refusal,'transport.*limit'):operator.invoke(args)

    def test_direct_invoke_rejects_review_without_source_before_remote_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest=Path(tmp)/"manifest.json"; manifest.write_text(json.dumps({"operationId":"op","sourceSha":None}))
            sha=hashlib.sha256(manifest.read_bytes()).hexdigest()
            args=argparse.Namespace(profile="staging194",command="cms-update",operation_id="op",host=None,install_host_helper=True,migration_review=str(manifest),migration_review_sha256=sha)
            with patch.object(operator,"_check_target_space",side_effect=AssertionError("preflight called")):
                with self.assertRaisesRegex(operator.Refusal,"source SHA"):
                    operator.invoke(args)

    def test_review_requires_source_before_any_remote_lookup(self):
        with patch.object(operator,'ssh_remote',side_effect=AssertionError('SSH called')):
            rc=operator.main(['cms-update','--operation-id','op','--migration-review','/unused','--migration-review-sha256','a'*64])
        self.assertEqual(rc,2)

if __name__=='__main__':unittest.main()
