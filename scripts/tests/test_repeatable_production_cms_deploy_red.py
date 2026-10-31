"""RED coverage for the approved repeatable production CMS deployment change."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
OPERATOR_PATH = ROOT / "scripts/rehearsal/staging193.py"
spec = importlib.util.spec_from_file_location("staging193_repeatable_prod_red", OPERATOR_PATH)
operator = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(operator)


SHA = "a" * 40
RELEASE_TAG = "v2026.10.31.1"
RUN = {
    "databaseId": 901,
    "headSha": SHA,
    "event": "push",
    "status": "completed",
    "conclusion": "success",
    "attempt": 1,
    "workflowName": "Tests",
    "headBranch": "main",
    "createdAt": "2026-10-31T10:00:00Z",
}
JOBS = {"jobs": [
    {"name": name, "status": "completed", "conclusion": "success"}
    for name in operator.REQUIRED_TEST_JOBS
]}


def admitted_main_capture(calls: list[list[str]]):
    """Supply deterministic main/Release/CI evidence without network or server access."""
    def capture(argv: list[str], **_kwargs) -> str:
        calls.append(argv)
        if argv[:3] == ["git", "cat-file", "-e"]:
            return ""
        if argv[:3] == ["gh", "repo", "view"]:
            return operator.CANONICAL_REPOSITORY
        if argv[:2] == ["gh", "api"]:
            return SHA
        if argv[:3] == ["gh", "run", "list"]:
            return json.dumps([RUN])
        if argv[:3] == ["gh", "run", "view"]:
            return json.dumps(JOBS)
        if argv[:3] == ["gh", "release", "view"]:
            return json.dumps({"id": 777, "tag_name": RELEASE_TAG, "isDraft": False,
                               "isPrerelease": False, "publishedAt": "2026-10-31T09:00:00Z"})
        if "release-preflight.ts" in " ".join(argv):
            return json.dumps({"tag": RELEASE_TAG, "commit": SHA, "result": "passed"})
        return ""
    return capture


class RepeatableProductionCmsDeployRedTests(unittest.TestCase):
    def test_paired_staging_admission_uses_current_main_and_release_preflight(self):
        calls: list[list[str]] = []
        with patch.object(operator, "capture", side_effect=admitted_main_capture(calls)):
            provenance = operator.validate_sha_and_ci(SHA, "staging194")

        self.assertEqual(provenance["ref"], "refs/heads/main")
        self.assertEqual(provenance["headBranch"], "main")
        self.assertTrue(any(argv[:3] == ["gh", "release", "view"] for argv in calls),
                        "paired staging admission must bind a stable published Release")
        self.assertTrue(any("release-preflight.ts" in " ".join(argv) for argv in calls),
                        "paired staging admission must pass release-preflight")

    def test_cli_exposes_reusable_production_paired_operations(self):
        invocations = []
        with patch.object(operator, "invoke", side_effect=invocations.append):
            for action in ("cms-update", "static-publish", "recover"):
                result = operator.main(["--profile", "production-paired", action,
                                        "--operation-id", "prod-run-20261031-02",
                                        *( ["--source-sha", SHA] if action != "recover" else [] )])
                self.assertEqual(result, 0)

        self.assertEqual([args.command for args in invocations], ["cms-update", "static-publish", "recover"])
        self.assertTrue(all(args.profile == "production-paired" for args in invocations))

    def test_production_paired_offhost_backups_have_a_separate_default_root(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-prod-paired-backup-red-") as temporary:
            with patch.object(operator.Path, "home", return_value=Path(temporary)):
                production = operator.backup_root(None, "production-paired")
                staging = operator.backup_root(None, "staging194")
                initial = operator.backup_root(None, "initial-prod")

        self.assertNotEqual(production, staging)
        self.assertNotEqual(production, initial)
        self.assertIn("production-paired", str(production))


if __name__ == "__main__":
    unittest.main()
