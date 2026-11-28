import copy
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.rehearsal import staging193 as operator


class OgProjectionAdmissionTests(unittest.TestCase):
    def snapshots(self):
        original = {
            "contractVersion": 2,
            "content": {
                "types": {
                    "course_groups": [{"id": 1, "slug": "program", "name": "Program", "seo_title": "SEO"}],
                    "seminars": [{"id": 2, "slug": "seminar", "name": "Seminar", "seo_description": "Desc"}],
                    "articles": [{"id": 3, "slug": "article", "title": "Article", "seo_title": "Article SEO"}],
                },
                "media": [],
            },
        }
        return original, copy.deepcopy(original)

    def validate(self, original, candidate, expected_candidate=None, source_media=None):
        return operator.validate_production_snapshot_composition(
            original, candidate,
            old_projector_sha="059bae78c343508730b095879190273d1eaa87b3",
            candidate_projector_sha="d8ec908b9a98f6ed9f739a6e44ea996453d65855",
            old_projector_contract_sha256="6b7e003dfb4d4905b8635c198c6b979efa90a434284dd794441d868deb8284bc",
            candidate_projector_contract_sha256="baa2b05e3522b1cf645bf2ab2ffd4db6ce17ceb3c0c87742c354c85f26a4134f",
            old_schema_sha256="974abb10127748e47b552edb9c6cc1204ef8b2b2affe9ba876c76728aeee2a90",
            candidate_schema_sha256="a4982acf217e8e2c5f46b9f2187c5195459e8b9342681d65526fb090ebbd832a",
            source_media=[] if source_media is None else source_media,
            expected_candidate=expected_candidate,
        )

    def test_expected_og_delta_is_admissible(self):
        original, candidate = self.snapshots()
        for records in candidate["content"]["types"].values():
            for record in records:
                record["og_title"] = ""
                record["og_description"] = None
                record["og_image_alt"] = "   "
        self.validate(original, candidate, candidate)

    def test_unrelated_public_field_is_refused(self):
        original, candidate = self.snapshots()
        candidate["content"]["types"]["articles"][0]["title"] = "tampered"
        with self.assertRaisesRegex(operator.Refusal, "unrelated|projection"):
            self.validate(original, candidate)

    def test_media_inventory_change_is_refused(self):
        original, candidate = self.snapshots()
        candidate["content"]["media"].append({"ref": "/uploads/extra.webp", "contentId": "sha256:extra"})
        with self.assertRaisesRegex(operator.Refusal, "media"):
            self.validate(original, candidate)

    def test_verified_media_backed_og_delta_is_admissible(self):
        original, expected = self.snapshots()
        expected["content"]["types"]["articles"][0].update(
            og_image="/media/uploads/article.webp", og_image_alt="Article cover")
        expected["content"]["media"] = [{"ref": "/media/uploads/article.webp", "contentId": "sha256:" + "b" * 64}]
        expected["content"]["media"] = [{"ref": "/media/uploads/article.webp", "contentId": "sha256:" + "b" * 64}]
        candidate = copy.deepcopy(expected)
        self.validate(original, candidate, expected,
                      [{"url": "/media/uploads/article.webp", "sha256": "b" * 64}])

    def test_historical_exceptions_cannot_be_dropped(self):
        original, candidate = self.snapshots()
        original["content"]["historicalExceptions"] = [{"id": "kept"}]
        candidate["content"]["historicalExceptions"] = []
        with self.assertRaisesRegex(operator.Refusal, "historical|envelope"):
            self.validate(original, candidate)

    def test_media_alt_substitution_is_refused(self):
        original, expected = self.snapshots()
        expected["content"]["types"]["articles"][0].update(
            og_image="/media/uploads/article.webp", og_image_alt="Article cover")
        expected["content"]["media"] = [{"ref": "/media/uploads/article.webp", "contentId": "sha256:" + "b" * 64}]
        candidate = copy.deepcopy(expected)
        candidate["content"]["types"]["articles"][0]["og_image_alt"] = "Wrong cover"
        with self.assertRaisesRegex(operator.Refusal, "projection"):
            self.validate(original, candidate, expected,
                          [{"url": "/media/uploads/article.webp", "sha256": "b" * 64}])

    def test_wrong_hash_binding_is_refused(self):
        original, candidate = self.snapshots()
        candidate["content"]["types"]["articles"][0]["og_title"] = ""
        with self.assertRaisesRegex(operator.Refusal, "binding"):
            operator.validate_production_snapshot_composition(
                original, candidate,
                old_projector_sha="059bae78c343508730b095879190273d1eaa87b3",
                candidate_projector_sha="d8ec908b9a98f6ed9f739a6e44ea996453d65855",
                old_projector_contract_sha256="0" * 64,
                candidate_projector_contract_sha256="baa2b05e3522b1cf645bf2ab2ffd4db6ce17ceb3c0c87742c354c85f26a4134f",
                old_schema_sha256="974abb10127748e47b552edb9c6cc1204ef8b2b2affe9ba876c76728aeee2a90",
                candidate_schema_sha256="a4982acf217e8e2c5f46b9f2187c5195459e8b9342681d65526fb090ebbd832a",
                source_media=[],
            )

    def test_acceptance_entrypoint_admits_real_og_branch_with_fake_tar(self):
        original, expected = self.snapshots()
        expected["content"]["types"]["articles"][0].update(
            og_image_alt="Article cover")
        expected["fingerprint"] = "sha256:" + "4" * 64
        original["captureProof"] = {"version": 1, "method": "quiesced-sqlite-backup",
                                     "captureId": "og-fake", "sourceSha": "d8ec908b9a98f6ed9f739a6e44ea996453d65855",
                                     "runId": 1, "attempt": 1, "schemaDigest": "a" * 64}
        candidate = copy.deepcopy(expected)
        op, source = "og-fake", "d8ec908b9a98f6ed9f739a6e44ea996453d65855"
        old = "059bae78c343508730b095879190273d1eaa87b3"
        old_contract = "6b7e003dfb4d4905b8635c198c6b979efa90a434284dd794441d868deb8284bc"
        candidate_contract = "baa2b05e3522b1cf645bf2ab2ffd4db6ce17ceb3c0c87742c354c85f26a4134f"
        old_schema = "974abb10127748e47b552edb9c6cc1204ef8b2b2affe9ba876c76728aeee2a90"
        candidate_schema = "a4982acf217e8e2c5f46b9f2187c5195459e8b9342681d65526fb090ebbd832a"
        capture = {"operationId": op, "sourceSha": source, "profile": "production-static",
                   "runId": 1, "attempt": 1, "databaseSha256": "d" * 64,
                   "mediaManifestSha256": "e" * 64, "schemaDigest": candidate_schema,
                   "capturedAt": "2026-11-28T00:00:00.000Z"}
        capture_bytes = json.dumps(capture, sort_keys=True).encode()
        candidate["captureProof"] = {"version": 1, "method": "quiesced-sqlite-backup",
                                      "captureId": op, "databaseDigest": "d" * 64,
                                      "mediaManifestDigest": "e" * 64,
                                      "schemaDigest": candidate_schema,
                                      "bundleDigest": hashlib.sha256(capture_bytes).hexdigest(),
                                      "sourceSha": source, "runId": 1, "attempt": 1}
        archive_bytes = io.BytesIO()
        with tarfile.open(fileobj=archive_bytes, mode="w") as archive:
            for name, payload in (("snapshot/capture-manifest.json", capture_bytes),
                                  ("snapshot/snapshot.json", json.dumps(candidate).encode())):
                info = tarfile.TarInfo(name); info.size = len(payload); archive.addfile(info, io.BytesIO(payload))
        backup_bytes = io.BytesIO()
        manifest = {"operationId": op, "databaseSha256": "0" * 64, "mediaManifestSha256": "1" * 64}
        with tarfile.open(fileobj=backup_bytes, mode="w") as archive:
            for name, payload in (("manifest.json", json.dumps(manifest).encode()),
                                  ("media-manifest.json", b'{"media":[]}'),
                                  ("database.sqlite", b"sqlite")):
                info = tarfile.TarInfo(name); info.size = len(payload); archive.addfile(info, io.BytesIO(payload))
        backup = {"operationId": op, "sourceSha": source, "sha256": "2" * 64, "runId": 1, "attempt": 1,
                  "oldCmsSourceSha": old, "oldCmsSchemaSha256": old_schema,
                  "oldProjectorSourceSha": old, "oldProjectorContractSha256": old_contract,
                  "oldProjectorNodeVersion": "v22", "snapshotFingerprint": "sha256:" + "4" * 64}

        def project(_bytes, _source, _op, _run, _attempt, _schema, _digest, *, projector_sha, projection_output):
            value = original if projector_sha == old else expected
            projection_output.write_text(json.dumps(value), encoding="utf-8")
            return backup["snapshotFingerprint"] if projector_sha == old else expected.get("fingerprint", "sha256:" + "4" * 64)

        with tempfile.TemporaryDirectory() as directory, patch.object(operator, "verify_backup_tar"), \
                patch.object(operator, "production_projector_contract",
                             side_effect=lambda a, b: old_contract if a == old else candidate_contract), \
                patch.object(operator, "production_paired_schema_from_commit", return_value=candidate_schema), \
                patch.object(operator, "production_paired_backup_fingerprint", side_effect=project) as projector_mock:
            path = Path(directory) / "backup.tar"; path.write_bytes(backup_bytes.getvalue())
            operator.validate_production_content_acceptance(
                archive_bytes.getvalue(), "a" * 64, "sha256:" + "4" * 64,
                path, backup, op, source, {"runId": 1, "attempt": 1})
            self.assertEqual(projector_mock.call_count, 2)


if __name__ == "__main__":
    unittest.main()
