"""RED coverage for staging194 paired source admission without a GitHub Release."""

from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from scripts.rehearsal import staging193 as operator


MAIN_SHA = "a" * 40
OLDER_SHA = "b" * 40
WORKFLOWS = (operator.WORKFLOW, *operator.STATIC_MAIN_ADDITIONAL_WORKFLOWS)


def canonical_ci_capture(selected_sha: str, main_sha: str, *, ancestor: bool = True,
                         missing_workflow: str | None = None):
    calls: list[list[str]] = []

    def capture(argv: list[str], **_kwargs) -> str:
        calls.append(argv)
        if argv[:3] == ["git", "cat-file", "-e"]:
            return ""
        if argv[:3] == ["git", "merge-base", "--is-ancestor"]:
            if not ancestor:
                raise operator.Refusal("selected source is not an ancestor of canonical main")
            return ""
        if argv[:3] == ["gh", "repo", "view"]:
            return operator.CANONICAL_REPOSITORY
        if argv[:2] == ["gh", "api"]:
            return main_sha
        if argv[:3] == ["gh", "run", "list"]:
            workflow = argv[argv.index("--workflow") + 1]
            if workflow == missing_workflow:
                return "[]"
            return json.dumps([{
                "databaseId": 700 + WORKFLOWS.index(workflow),
                "headSha": selected_sha,
                "event": "push",
                "headBranch": "main",
                "status": "completed",
                "conclusion": "success",
                "attempt": 2,
                "workflowName": workflow,
                "createdAt": "2026-11-05T10:00:00Z",
            }])
        if argv[:3] == ["gh", "run", "view"]:
            workflow = WORKFLOWS[int(argv[argv.index("view") + 1]) - 700]
            jobs = (operator.REQUIRED_TEST_JOBS if workflow == operator.WORKFLOW
                    else {"required job"})
            return json.dumps({"jobs": [
                {"name": name, "status": "completed", "conclusion": "success"}
                for name in jobs
            ]})
        if argv[:3] == ["gh", "release", "view"]:
            return json.dumps({"tagName": "v2026.11.1", "isDraft": False,
                               "isPrerelease": False, "publishedAt": "2026-11-05T10:00:00Z"})
        if "release-preflight.ts" in " ".join(argv):
            return json.dumps({"status": "passed", "commit": selected_sha,
                               "historicalRelease": False})
        return ""

    return calls, capture


class Staging194PairedAdmissionRedTests(unittest.TestCase):
    def test_paired_staging_admits_four_exact_sha_push_workflows_without_release(self):
        calls, capture = canonical_ci_capture(MAIN_SHA, MAIN_SHA)
        with patch.object(operator, "capture", side_effect=capture):
            provenance = operator.validate_sha_and_ci(MAIN_SHA, "staging194")

        self.assertFalse(any(argv[:3] == ["gh", "release", "view"] for argv in calls),
                         "staging194 paired admission must not require a GitHub Release")
        self.assertEqual(provenance["sourceSha"], MAIN_SHA)
        self.assertEqual(provenance["ref"], "refs/heads/main")
        self.assertEqual({item["workflow"] for item in provenance["additionalWorkflows"]},
                         set(operator.STATIC_MAIN_ADDITIONAL_WORKFLOWS))
        self.assertTrue(all(item["headSha"] == MAIN_SHA and item["attempt"] == 2
                            for item in provenance["additionalWorkflows"]))

    def test_explicit_older_sha_is_admitted_only_when_it_is_an_ancestor_of_main(self):
        calls, capture = canonical_ci_capture(OLDER_SHA, MAIN_SHA)
        with patch.object(operator, "capture", side_effect=capture):
            provenance = operator.validate_sha_and_ci(OLDER_SHA, "staging194")

        self.assertEqual(provenance["sourceSha"], OLDER_SHA)
        self.assertIn(["git", "merge-base", "--is-ancestor", OLDER_SHA, MAIN_SHA], calls)

    def test_explicit_non_ancestor_sha_is_refused(self):
        _, capture = canonical_ci_capture(OLDER_SHA, MAIN_SHA, ancestor=False)
        with patch.object(operator, "capture", side_effect=capture):
            with self.assertRaisesRegex(operator.Refusal, "not an ancestor"):
                operator.validate_sha_and_ci(OLDER_SHA, "staging194")

    def test_missing_required_push_workflow_refuses_paired_staging_admission(self):
        _, capture = canonical_ci_capture(MAIN_SHA, MAIN_SHA, missing_workflow="Security")
        with patch.object(operator, "capture", side_effect=capture):
            with self.assertRaises(operator.Refusal):
                operator.validate_sha_and_ci(MAIN_SHA, "staging194")

    def test_production_paired_admission_keeps_stable_release_gate(self):
        provenance = {"sourceSha": MAIN_SHA}
        with patch.object(operator, "validate_static_main_ci", return_value=provenance) as ci, \
                patch.object(operator, "validate_stable_release", return_value={"release": {"tag": "v1"}}) as release:
            result = operator.validate_production_paired_admission(MAIN_SHA)

        ci.assert_called_once_with(MAIN_SHA)
        release.assert_called_once_with(provenance, MAIN_SHA)
        self.assertIn("release", result)


if __name__ == "__main__":
    unittest.main()
