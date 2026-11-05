"""RED contract for explicitly selected stable Releases on production-static."""

import argparse
import base64
import json
import unittest
from unittest.mock import patch

from scripts.rehearsal import staging193


SOURCE_SHA = "a" * 40
RELEASE_TAG = "v2026.1102.1"


class ProductionStaticReleaseAdmissionTests(unittest.TestCase):
    def test_current_release_preflight_requests_and_binds_helper_asset_to_same_ci_attempt(self):
        helper = {"artifactId": 808, "runId": 901, "attempt": 2,
                  "archiveSha256": "b" * 64, "payloadSha256": "c" * 64}
        operator = {"sourceSha": SOURCE_SHA, "runId": 901, "attempt": 2}
        output = {"status": "admitted", "commit": SOURCE_SHA, "historicalRelease": False,
                  "operatorAdmission": operator, "hostHelperArtifact": helper}
        commands = []

        def fake_capture(argv):
            commands.append(argv)
            if argv[:2] == ["gh", "release"]:
                return json.dumps({"tagName": RELEASE_TAG, "isDraft": False,
                    "isPrerelease": False, "publishedAt": "2026-11-02T10:00:00Z"})
            if argv[:2] == ["gh", "api"]:
                return SOURCE_SHA
            if argv[:2] == ["node", "web/scripts/release-preflight.ts"]:
                return json.dumps(output)
            raise AssertionError(f"unexpected command: {argv}")

        provenance = {"sourceSha": SOURCE_SHA, "runId": 901, "attempt": 2}
        with patch.object(staging193, "capture", side_effect=fake_capture):
            admitted = staging193.validate_stable_release(provenance, SOURCE_SHA)
        preflight = next(argv for argv in commands if argv[:2] == ["node", "web/scripts/release-preflight.ts"])
        self.assertIn("--ensure-helper-asset", preflight)
        self.assertEqual(admitted["hostHelperArtifact"], helper)

    def test_cli_accepts_explicit_release_tag_and_keeps_its_exact_sha(self):
        observed = {}

        def fake_invoke(args):
            observed["profile"] = args.profile
            observed["command"] = args.command
            observed["release_tag"] = args.release_tag
            observed["source_sha"] = args.source_sha

        with patch.object(staging193, "invoke", side_effect=fake_invoke):
            try:
                result = staging193.main([
                    "--profile", "production-static", "static-main",
                    "--operation-id", "prod-static-old-release",
                    "--release-tag", RELEASE_TAG, "--source-sha", SOURCE_SHA,
                ])
            except SystemExit as error:
                self.fail(f"production-static CLI rejected explicit Release selection: {error}")

        self.assertEqual(result, 0)
        self.assertEqual(observed, {"profile": "production-static", "command": "static-main",
                                    "release_tag": RELEASE_TAG, "source_sha": SOURCE_SHA})

    def test_default_and_explicit_194_cli_profiles_keep_the_existing_route(self):
        observed = []

        def fake_invoke(args):
            observed.append((args.profile, args.command, getattr(args, "release_tag", None)))

        with patch.object(staging193, "invoke", side_effect=fake_invoke):
            self.assertEqual(staging193.main(["static-main", "--operation-id", "stage-default",
                                              "--source-sha", SOURCE_SHA]), 0)
            self.assertEqual(staging193.main(["--profile", "staging194", "static-main",
                                              "--operation-id", "stage-explicit",
                                              "--source-sha", SOURCE_SHA]), 0)
        self.assertEqual(observed, [("staging194", "static-main", None),
                                    ("staging194", "static-main", None)])

    def test_production_static_still_refuses_failed_exact_sha_ci_before_archive_or_ssh(self):
        failed_run = [{"databaseId": 901, "headSha": SOURCE_SHA, "event": "push",
                       "status": "completed", "conclusion": "failure", "attempt": 1,
                       "workflowName": "Tests", "headBranch": "main", "createdAt": "2026-11-01T10:00:00Z"}]

        def fake_gh_or_git(argv):
            if argv[:2] == ["git", "cat-file"]:
                return ""
            if argv[:2] == ["node", "web/scripts/release-preflight.ts"]:
                raise staging193.Refusal("release-preflight exact-SHA Tests run is not successful")
            if argv[:2] == ["gh", "repo"]:
                return staging193.CANONICAL_REPOSITORY
            if argv[:2] == ["gh", "api"]:
                return SOURCE_SHA
            if argv[:3] == ["gh", "run", "list"]:
                return json.dumps(failed_run)
            if argv[:3] == ["gh", "run", "view"]:
                return json.dumps({"jobs": [{"name": "failed test", "status": "completed",
                                             "conclusion": "failure"}]})
            raise AssertionError(f"unexpected fake command: {argv}")

        args = argparse.Namespace(profile="production-static", command="static-main",
                                  host=staging193.INITIAL_PROD_HOST,
                                  operation_id="prod-static-failed-ci", source_sha=SOURCE_SHA,
                                  release_tag=RELEASE_TAG)
        with patch.object(staging193, "capture", side_effect=fake_gh_or_git), \
             patch.object(staging193, "_check_local_space", return_value=[]), \
             patch.object(staging193, "_check_target_space", return_value={"staticExportEstimateBytes": 0}), \
             patch.object(staging193, "make_archive") as make_archive, \
             patch.object(staging193, "ssh_remote") as ssh:
            with self.assertRaisesRegex(staging193.Refusal, "not successful"):
                staging193.invoke(args)
        make_archive.assert_not_called()
        ssh.assert_not_called()

    def test_selected_release_sha_is_pinned_through_publication_without_rechecking_moved_main(self):
        run_id = 901
        run_url = f"https://github.com/{staging193.CANONICAL_REPOSITORY}/actions/runs/{run_id}"
        additional = [{"workflow": workflow, "headSha": SOURCE_SHA, "event": "push", "headBranch": "main",
            "runId": run_id + index + 1, "attempt": 1, "status": "completed", "conclusion": "success",
            "requiredJobs": ["job"],
            "runUrl": f"https://github.com/{staging193.CANONICAL_REPOSITORY}/actions/runs/{run_id + index + 1}"}
            for index, workflow in enumerate(staging193.STATIC_MAIN_ADDITIONAL_WORKFLOWS)]
        release = {"tag": RELEASE_TAG, "id": 702, "publishedAt": "2026-11-02T10:00:00Z"}
        helper_artifact = {"artifactId": 808, "runId": run_id, "attempt": 1,
                           "archiveSha256": "b" * 64, "payloadSha256": "c" * 64}
        admission = {"repository": staging193.CANONICAL_REPOSITORY, "ref": "refs/heads/main",
            "sourceSha": SOURCE_SHA, "workflow": staging193.WORKFLOW, "workflowName": staging193.WORKFLOW,
            "event": "push", "headBranch": "main", "runId": run_id, "attempt": 1,
            "status": "completed", "conclusion": "success", "requiredJobs": sorted(staging193.REQUIRED_TEST_JOBS),
            "runUrl": run_url, "additionalWorkflows": additional}
        preflight_result = {"status": "admitted", "commit": SOURCE_SHA, "release": release,
            "historicalRelease": True, "operatorAdmission": admission,
            "hostHelperArtifact": helper_artifact}
        responses = [json.dumps({"phase": "browser-check-required", "staticTreeSha256": "c" * 64}).encode(),
                     b"candidate bytes", json.dumps({"phase": "committed"}).encode()]
        calls = []
        captures = []

        def fake_capture(argv):
            captures.append(argv)
            if argv[:2] == ["git", "cat-file"]:
                return ""
            raise AssertionError(f"unexpected capture command: {argv}")

        def fake_ssh(arguments, **kwargs):
            calls.append((arguments, kwargs))
            return responses.pop(0)

        args = argparse.Namespace(profile="production-static", command="static-main",
            host=staging193.INITIAL_PROD_HOST, operation_id="prod-static-old-release",
            source_sha=SOURCE_SHA, release_tag=RELEASE_TAG, reuse_capture_operation_id=None,
            chat_loader_src=None, backup_dir=None)
        with patch.object(staging193, "capture", side_effect=fake_capture), \
             patch.object(staging193, "_check_local_space", return_value=[]), \
             patch.object(staging193, "_check_target_space", return_value={"staticExportEstimateBytes": 0}), \
             patch.object(staging193, "make_archive", return_value=(b"source archive", "a" * 64)) as archive, \
             patch.object(staging193, "ssh_remote", side_effect=fake_ssh), \
             patch.object(staging193, "browser_check"):
            admission = staging193.production_static_admission_from_result(SOURCE_SHA, RELEASE_TAG, preflight_result)
            staging193.invoke(args, admission=admission)

        archive.assert_called_once()
        self.assertEqual(archive.call_args.args[0], SOURCE_SHA)
        self.assertEqual(len(captures), 1)
        self.assertEqual(len(calls), 3)
        encoded_provenance = calls[0][0][calls[0][0].index("--provenance-b64") + 1]
        forwarded = json.loads(base64.b64decode(encoded_provenance))
        self.assertEqual(forwarded["sourceSha"], SOURCE_SHA)
        self.assertEqual(forwarded["release"]["tag"], RELEASE_TAG)
        self.assertEqual(forwarded["releasePreflight"], {"status": "admitted", "commit": SOURCE_SHA,
            "release": release, "historicalRelease": True, "hostHelperArtifact": helper_artifact})
        self.assertNotIn("operatorAdmission", forwarded["releasePreflight"])
        for command, _kwargs in calls:
            if command[0] in ("static-main", "export-static-main") and "--source-sha" in command:
                self.assertEqual(command[command.index("--source-sha") + 1], SOURCE_SHA)

    def test_helper_artifact_must_match_the_preflight_run_and_attempt(self):
        run_id = 901
        additional = [{"workflow": workflow, "headSha": SOURCE_SHA, "event": "push", "headBranch": "main",
            "runId": run_id + index + 1, "attempt": 1, "status": "completed", "conclusion": "success",
            "requiredJobs": ["job"], "runUrl": f"https://github.com/{staging193.CANONICAL_REPOSITORY}/actions/runs/{run_id + index + 1}"}
            for index, workflow in enumerate(staging193.STATIC_MAIN_ADDITIONAL_WORKFLOWS)]
        operator = {"sourceSha": SOURCE_SHA, "runId": run_id, "attempt": 1,
                    "additionalWorkflows": additional, "ref": "refs/heads/main",
                    "repository": staging193.CANONICAL_REPOSITORY, "workflow": staging193.WORKFLOW,
                    "workflowName": staging193.WORKFLOW, "event": "push", "headBranch": "main",
                    "status": "completed", "conclusion": "success",
                    "requiredJobs": sorted(staging193.REQUIRED_TEST_JOBS),
                    "runUrl": f"https://github.com/{staging193.CANONICAL_REPOSITORY}/actions/runs/{run_id}"}
        result = {"status": "admitted", "commit": SOURCE_SHA,
            "release": {"tag": RELEASE_TAG, "id": 702, "publishedAt": "2026-11-02T10:00:00Z"},
            "historicalRelease": True, "operatorAdmission": operator,
            "hostHelperArtifact": {"artifactId": 808, "runId": run_id, "attempt": 2,
                "archiveSha256": "b" * 64, "payloadSha256": "c" * 64}}
        with patch.object(staging193, "capture", return_value=""):
            with self.assertRaisesRegex(staging193.Refusal, "verified exact-run host helper artifact"):
                staging193.production_static_admission_from_result(SOURCE_SHA, RELEASE_TAG, result)


if __name__ == "__main__":
    unittest.main()
