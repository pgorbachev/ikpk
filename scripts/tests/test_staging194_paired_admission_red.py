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
        if argv[:3] == ["gh", "repo", "view"]:
            return operator.CANONICAL_REPOSITORY
        if argv[:2] == ["gh", "api"]:
            if "/compare/" in argv[2]:
                if argv[-1] != '.status + ":" + .merge_base_commit.sha':
                    return "ahead:null"
                status = ('identical' if selected_sha == main_sha else 'ahead') if ancestor else 'diverged'
                return f"{status}:{selected_sha if ancestor else 'c' * 40}"
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
    def test_cli_accepts_successful_idle_status_as_a_new_operation_without_source_sha(self):
        with patch.object(operator, "ssh_remote", return_value=json.dumps({
                "operationId": "new-staging-operation", "phase": "idle"}).encode()) as status, \
                patch.object(operator, "capture", return_value=MAIN_SHA) as capture, \
                patch.object(operator, "invoke") as invoke:
            result = operator.main(["cms-update", "--operation-id", "new-staging-operation"])

        self.assertEqual(result, 0)
        status.assert_called_once_with(["status", "--operation-id", "new-staging-operation"])
        capture.assert_called_once_with(["gh", "api", f"repos/{operator.CANONICAL_REPOSITORY}/git/ref/heads/main",
                                         "--jq", ".object.sha"])
        self.assertEqual(invoke.call_args.args[0].source_sha, MAIN_SHA)

    def test_cli_without_source_sha_still_refuses_non_idle_successful_status(self):
        for phase in ("acquiring", "fenced", "cms-activated", "committed", "recovered", None):
            with self.subTest(phase=phase), \
                    patch.object(operator, "ssh_remote", return_value=json.dumps({"phase": phase}).encode()), \
                    patch.object(operator, "capture") as capture, \
                    patch.object(operator, "invoke") as invoke:
                result = operator.main(["cms-update", "--operation-id", "existing-staging-operation"])

            self.assertEqual(result, 2)
            capture.assert_not_called()
            invoke.assert_not_called()

    def test_cli_without_source_sha_requires_idle_status_for_the_requested_operation_id(self):
        with patch.object(operator, "ssh_remote", return_value=json.dumps({
                "operationId": "different-operation", "phase": "idle"}).encode()), \
                patch.object(operator, "capture") as capture, \
                patch.object(operator, "invoke") as invoke:
            result = operator.main(["cms-update", "--operation-id", "requested-operation"])

        self.assertEqual(result, 2)
        capture.assert_not_called()
        invoke.assert_not_called()

    def test_cli_without_source_sha_does_not_treat_a_similar_status_refusal_as_fresh(self):
        refusal = "operation has no maintenance marker or terminal journal record; another lock is held"
        with patch.object(operator, "ssh_remote", side_effect=operator.Refusal(refusal)), \
                patch.object(operator, "capture") as capture, \
                patch.object(operator, "invoke") as invoke:
            result = operator.main(["cms-update", "--operation-id", "ambiguous-staging-operation"])

        self.assertEqual(result, 2)
        capture.assert_not_called()
        invoke.assert_not_called()

    def test_cli_without_source_sha_accepts_only_exact_wrapped_legacy_status_refusal(self):
        legacy = "operation has no maintenance marker or terminal journal record"
        wrapped = f"host operation failed (2): ikpk-rehearsal: {legacy}"
        with patch.object(operator, "ssh_remote", side_effect=operator.Refusal(wrapped)), \
                patch.object(operator, "capture", return_value=MAIN_SHA) as capture, \
                patch.object(operator, "invoke") as invoke:
            result = operator.main(["cms-update", "--operation-id", "wrapped-fresh-operation"])

        self.assertEqual(result, 0)
        capture.assert_called_once()
        self.assertEqual(invoke.call_args.args[0].source_sha, MAIN_SHA)

        with patch.object(operator, "ssh_remote", side_effect=operator.Refusal(wrapped + "; retry later")), \
                patch.object(operator, "capture") as capture, \
                patch.object(operator, "invoke") as invoke:
            result = operator.main(["cms-update", "--operation-id", "wrapped-ambiguous-operation"])

        self.assertEqual(result, 2)
        capture.assert_not_called()
        invoke.assert_not_called()

    def test_cli_defaults_only_new_staging_cms_update_to_exact_main_ref(self):
        with patch.object(operator, "ssh_remote",
                          side_effect=operator.Refusal("operation has no maintenance marker or terminal journal record")) as status, \
                patch.object(operator, "capture", return_value=MAIN_SHA) as capture, \
                patch.object(operator, "invoke") as invoke:
            result = operator.main(["cms-update", "--operation-id", "new-staging-operation"])

        self.assertEqual(result, 0)
        status.assert_called_once_with(["status", "--operation-id", "new-staging-operation"])
        self.assertEqual(invoke.call_args.args[0].source_sha, MAIN_SHA)
        self.assertIn(["gh", "api", f"repos/{operator.CANONICAL_REPOSITORY}/git/ref/heads/main",
                       "--jq", ".object.sha"], [call.args[0] for call in capture.call_args_list])

    def test_cli_requires_explicit_sha_for_static_continuations(self):
        for command in ("static-publish", "static-main"):
            with self.subTest(command=command), patch.object(operator, "invoke") as invoke:
                with self.assertRaises(SystemExit):
                    operator.main([command, "--operation-id", f"continuation-{command}"])
                invoke.assert_not_called()

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
        self.assertIn(["gh", "api", f"repos/{operator.CANONICAL_REPOSITORY}/compare/{OLDER_SHA}...{MAIN_SHA}",
                       "--jq", ".status + \":\" + .merge_base_commit.sha"], calls)
        self.assertNotIn(["git", "cat-file", "-e", f"{MAIN_SHA}^{{commit}}"], calls)
        self.assertFalse(any(argv[:3] == ["git", "merge-base", "--is-ancestor"] for argv in calls))

    def test_explicit_non_ancestor_sha_is_refused(self):
        _, capture = canonical_ci_capture(OLDER_SHA, MAIN_SHA, ancestor=False)
        with patch.object(operator, "capture", side_effect=capture):
            with self.assertRaisesRegex(operator.Refusal, "not an ancestor"):
                operator.validate_sha_and_ci(OLDER_SHA, "staging194")

    def test_compare_rejects_behind_or_unrelated_merge_base(self):
        for response in (f"behind:{OLDER_SHA}", f"ahead:{'c' * 40}", "ahead:null"):
            with self.subTest(response=response), patch.object(operator, "capture", return_value=response):
                with self.assertRaisesRegex(operator.Refusal, "not an ancestor"):
                    operator._require_canonical_main_ancestor(OLDER_SHA, MAIN_SHA)

    def test_missing_required_push_workflow_refuses_paired_staging_admission(self):
        _, capture = canonical_ci_capture(MAIN_SHA, MAIN_SHA, missing_workflow="Security")
        with patch.object(operator, "capture", side_effect=capture):
            with self.assertRaises(operator.Refusal):
                operator.validate_sha_and_ci(MAIN_SHA, "staging194")

    def test_canonical_main_can_advance_during_admission_when_source_remains_ancestor(self):
        calls, base_capture = canonical_ci_capture(MAIN_SHA, MAIN_SHA)
        main_ref_calls = 0
        newer_main = "c" * 40

        def moving_main(argv: list[str], **kwargs) -> str:
            nonlocal main_ref_calls
            if argv[:2] == ["gh", "api"] and "/git/ref/heads/main" in argv[2]:
                main_ref_calls += 1
                return MAIN_SHA if main_ref_calls == 1 else newer_main
            result = base_capture(argv, **kwargs)
            return result

        with patch.object(operator, "capture", side_effect=moving_main):
            provenance = operator.validate_sha_and_ci(MAIN_SHA, "staging194")

        self.assertEqual(main_ref_calls, 4)
        self.assertNotIn("canonicalMainSha", provenance)
        compare_commands = [argv[2] for argv in calls if argv[:2] == ["gh", "api"] and "/compare/" in argv[2]]
        self.assertIn(f"repos/{operator.CANONICAL_REPOSITORY}/compare/{MAIN_SHA}...{MAIN_SHA}",
                      compare_commands)
        self.assertIn(f"repos/{operator.CANONICAL_REPOSITORY}/compare/{MAIN_SHA}...{newer_main}",
                      compare_commands)

    def test_existing_staging_cms_operation_requires_explicit_sha_to_continue(self):
        with patch.object(operator, "ssh_remote", return_value=json.dumps({"phase": "cms-activated"}).encode()), \
                patch.object(operator, "capture") as capture, patch.object(operator, "invoke") as invoke:
            result = operator.main(["cms-update", "--operation-id", "existing-staging-operation"])

        self.assertEqual(result, 2)
        capture.assert_not_called()
        invoke.assert_not_called()

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
