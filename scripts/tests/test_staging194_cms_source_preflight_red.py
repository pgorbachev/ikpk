"""RED coverage for identifying the installed staging194 CMS from durable evidence."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.lib import rehearsal_host
from scripts.lib.rehearsal_state import RehearsalState


SOURCE_SHA = "a" * 40
OPERATION_ID = "cms-source-proof"


class Staging194CmsSourcePreflightRedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ikpk-cms-source-preflight-")
        self.root = Path(self.temp.name)
        self.release_root = self.root / "releases"
        self.release_root.mkdir()
        self.uploads = self.root / "uploads"
        self.uploads.mkdir()
        self.current_cms = self.root / "current-cms"
        self.state = RehearsalState(self.root / "state") if (self.root / "state").mkdir() is None else None
        self.config = {
            "profile": "staging194",
            "releaseRoot": str(self.release_root),
            "currentCms": str(self.current_cms),
            "mediaRoots": [{"prefix": "/uploads/", "path": str(self.uploads)}],
        }
        self.source_root = self.release_root / f"{SOURCE_SHA}-{OPERATION_ID}"
        self.cms_artifact = (self.source_root / ".staging193-rehearsal" / OPERATION_ID
                             / "migration" / "cms-artifact")
        self.cms_artifact.mkdir(parents=True)
        (self.cms_artifact / "package.json").write_text('{"name":"current-cms"}\n', encoding="utf-8")
        self.current_cms.symlink_to(self.cms_artifact, target_is_directory=True)
        self.payload_sha = rehearsal_host._cms_payload_sha256(self.cms_artifact, self.uploads)

    def tearDown(self):
        self.temp.cleanup()

    def _record_committed_release(self, *, source_sha=SOURCE_SHA, cms_sha=SOURCE_SHA,
                                  payload_sha=None, include_commit=True):
        state = self.state
        state.begin(OPERATION_ID, source_sha,
                    {"cmsSha": "old-cms", "staticSha": "old-static", "dbSha256": "0" * 64})
        state.confirm_fence(OPERATION_ID, lambda: True)
        state.mark_cms_activated(OPERATION_ID)
        state.accept_new_pair(OPERATION_ID, {
            "sourceSha": source_sha,
            "cmsSha": cms_sha,
            "staticSha": source_sha,
            "cmsPayloadSha256": payload_sha or self.payload_sha,
        })
        if include_commit:
            state.commit(OPERATION_ID)

    def _source_sha(self):
        return rehearsal_host._staging194_current_cms_source_sha(self.config, self.state)

    def test_current_nested_artifact_requires_matching_committed_bundle_and_payload(self):
        self._record_committed_release()

        self.assertEqual(self._source_sha(), SOURCE_SHA)

    def test_sha_named_path_alone_is_unknown_without_confirmed_journal(self):
        self.assertIsNone(self._source_sha())

    def test_uncommitted_bundle_does_not_establish_current_source(self):
        self._record_committed_release(include_commit=False)

        self.assertIsNone(self._source_sha())

    def test_current_target_must_match_artifact_derived_from_journal_identity(self):
        self._record_committed_release()
        foreign = self.release_root / f"{SOURCE_SHA}-different-operation" / "cms"
        foreign.mkdir(parents=True)
        (foreign / "package.json").write_text('{"name":"current-cms"}\n', encoding="utf-8")
        self.current_cms.unlink()
        self.current_cms.symlink_to(foreign, target_is_directory=True)

        self.assertIsNone(self._source_sha())

    def test_changed_current_payload_is_unknown_even_when_path_and_journal_match(self):
        self._record_committed_release()
        (self.cms_artifact / "package.json").write_text('{"name":"changed-cms"}\n', encoding="utf-8")

        self.assertIsNone(self._source_sha())

    def test_journal_cms_identity_must_match_source_sha(self):
        self._record_committed_release(cms_sha="b" * 40)

        self.assertIsNone(self._source_sha())


if __name__ == "__main__":
    unittest.main()
