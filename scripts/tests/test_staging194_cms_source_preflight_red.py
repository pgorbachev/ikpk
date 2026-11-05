"""RED coverage for identifying the installed staging194 CMS from durable evidence."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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

    def test_current_pointer_change_during_payload_hash_is_unknown(self):
        self._record_committed_release()
        original_hash = rehearsal_host._cms_payload_sha256
        foreign = self.release_root / f"{SOURCE_SHA}-different-operation" / "cms"
        foreign.mkdir(parents=True)
        (foreign / "package.json").write_text('{"name":"foreign"}\n', encoding="utf-8")

        def hash_and_switch(*args, **kwargs):
            digest = original_hash(*args, **kwargs)
            self.current_cms.unlink()
            self.current_cms.symlink_to(foreign, target_is_directory=True)
            return digest

        with patch.object(rehearsal_host, "_cms_payload_sha256", side_effect=hash_and_switch):
            self.assertIsNone(self._source_sha())

    def test_journal_cms_identity_must_match_source_sha(self):
        self._record_committed_release(cms_sha="b" * 40)

        self.assertIsNone(self._source_sha())

    def _space_config(self):
        static_release = self.root / "static-releases"
        static_release.mkdir()
        static = static_release / "old"
        static.mkdir()
        (static / "index.html").write_text("ok", encoding="utf-8")
        current_static = self.root / "current-static"
        current_static.symlink_to(static, target_is_directory=True)
        database = self.root / "cms.sqlite"
        database.write_bytes(b"db")
        backup = self.root / "backups"
        backup.mkdir()
        temporary = self.root / "temporary"
        temporary.mkdir()
        return {
            "releaseRoot": str(self.release_root), "currentCms": str(self.current_cms),
            "currentStatic": str(current_static), "staticReleaseRoot": str(static_release),
            "stateDir": str(self.state.root), "backupRoot": str(backup),
            "cmsDatabase": str(database), "cmsUser": "cms",
            "mediaRoots": [{"prefix": "/uploads/", "path": str(self.uploads)}],
            "temporaryRoot": str(temporary), "spaceReserveBytes": 0,
        }

    def test_space_preflight_surfaces_proven_cms_sha_with_default_staging_profile(self):
        self._record_committed_release()
        with (patch.object(rehearsal_host.pwd, "getpwnam", return_value=SimpleNamespace(pw_dir=str(self.root))),
              patch.object(rehearsal_host, "_validate_staging194_temporary_root",
                           return_value=self.root / "temporary")):
            report = rehearsal_host._space_preflight(self._space_config(), "space-check", "cms-update")
        self.assertEqual(report["installedSourceSha"], SOURCE_SHA)
        self.assertEqual(report["installedSourceShaStatus"], "known")

    def test_space_preflight_reports_unknown_for_changed_cms_payload(self):
        self._record_committed_release()
        (self.cms_artifact / "package.json").write_text('{"name":"changed"}\n', encoding="utf-8")
        with (patch.object(rehearsal_host.pwd, "getpwnam", return_value=SimpleNamespace(pw_dir=str(self.root))),
              patch.object(rehearsal_host, "_validate_staging194_temporary_root",
                           return_value=self.root / "temporary")):
            report = rehearsal_host._space_preflight(self._space_config(), "space-check", "cms-update")
        self.assertIsNone(report["installedSourceSha"])
        self.assertEqual(report["installedSourceShaStatus"], "unknown")


if __name__ == "__main__":
    unittest.main()
