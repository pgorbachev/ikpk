import json
import unittest
from unittest.mock import patch

from scripts.rehearsal import staging193


SHA = "a" * 40
JOBS = sorted(staging193.REQUIRED_TEST_JOBS)


class OperatorAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.runs = [{
            "headSha": SHA,
            "workflowName": "Tests",
            "event": "push",
            "headBranch": "dev",
            "status": "completed",
            "conclusion": "success",
            "databaseId": 123,
            "attempt": 1,
            "createdAt": "2026-10-18T10:00:00Z",
        }]
        self.jobs = [{"name": name, "status": "completed", "conclusion": "success"} for name in JOBS]

    def _capture(self, argv):
        if argv[:3] == ["git", "ls-remote", "origin"]:
            return f"{SHA}\t{staging193.CANONICAL_REF}"
        if argv[:2] == ["gh", "repo"]:
            return "owner/ikpk"
        if argv[:3] == ["gh", "run", "list"]:
            return json.dumps(self.runs)
        if argv[:3] == ["gh", "run", "view"]:
            return json.dumps({"jobs": self.jobs})
        return ""

    def test_admits_only_exact_canonical_tests_push_with_every_mandatory_job(self):
        with patch.object(staging193, "capture", side_effect=self._capture):
            result = staging193.validate_sha_and_ci(SHA)
        self.assertEqual(result["sourceSha"], SHA)
        self.assertEqual(result["runId"], 123)
        self.assertEqual(result["attempt"], 1)

    def test_rejects_a_moved_canonical_ref(self):
        def moved(argv):
            if argv[:3] == ["git", "ls-remote", "origin"]:
                return f"{'b' * 40}\t{staging193.CANONICAL_REF}"
            return self._capture(argv)

        with patch.object(staging193, "capture", side_effect=moved):
            with self.assertRaisesRegex(staging193.Refusal, "current canonical"):
                staging193.validate_sha_and_ci(SHA)

    def test_rejects_skipped_or_cancelled_mandatory_job(self):
        self.jobs[0] = {"name": self.jobs[0]["name"], "status": "completed", "conclusion": "skipped"}
        with patch.object(staging193, "capture", side_effect=self._capture):
            with self.assertRaisesRegex(staging193.Refusal, "not successful"):
                staging193.validate_sha_and_ci(SHA)


if __name__ == "__main__":
    unittest.main()
