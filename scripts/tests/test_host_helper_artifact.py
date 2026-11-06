"""RED contract tests for the provenance-bound host helper CI artifact."""

import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from scripts.rehearsal import staging193


REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_SHA = "a" * 40
RUN_ID = 123
ATTEMPT = 2
INSTALLER = "scripts/install-rehearsal-host.sh"
MODULES = (
    "scripts/lib/rehearsal_state.py",
    "scripts/lib/housekeeping_journal.py",
    "scripts/lib/rehearsal_host.py",
    "scripts/lib/rehearsal_config.py",
)
TEMPLATES = (
    "scripts/staging193-rehearsal.json",
    "scripts/initial-prod-rehearsal.json",
    "scripts/production-static-rehearsal.json",
    "scripts/production-paired-rehearsal.json",
)
EXPECTED_FILES = {INSTALLER, *MODULES, *TEMPLATES}


def make_tar(files=None):
    files = files or {name: (REPO_ROOT / name).read_bytes() for name in EXPECTED_FILES}
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name in ("scripts", "scripts/lib"):
            directory = tarfile.TarInfo(name)
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o755
            archive.addfile(directory)
        for name, contents in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents))
    return output.getvalue()


def make_zip(payload, name="host-helper.tar.gz", extra=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, payload)
        for extra_name, contents in (extra or {}).items():
            archive.writestr(extra_name, contents)
    return output.getvalue()


def artifact_record(*, name=None, expired=False, sha=SOURCE_SHA, run_id=RUN_ID):
    zipped = make_zip(make_tar())
    return ({
        "id": 987,
        "name": name or f"host-helper-{RUN_ID}-{ATTEMPT}",
        "expired": expired,
        "digest": "sha256:" + hashlib.sha256(zipped).hexdigest(),
        "workflow_run": {"id": run_id, "head_sha": sha, "head_branch": "main"},
    }, zipped)


class HostHelperArtifactBuildTests(unittest.TestCase):
    def test_tests_workflow_uploads_unique_run_attempt_bound_helper_artifact(self):
        workflow = (REPO_ROOT / ".github/workflows/test.yml").read_text(encoding="utf-8")
        self.assertRegex(workflow, r"name:\s*host-helper-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}")
        self.assertIn("scripts/build-host-helper-artifact.sh", workflow)
        self.assertIn("host-helper.tar.gz", workflow)
        self.assertIn("actions/upload-artifact", workflow)
        self.assertIn("github.event_name == 'push'", workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("needs:", workflow)

    def test_builder_packages_only_existing_installer_modules_and_profile_templates(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-host-helper-build-") as temporary:
            output = Path(temporary) / "host-helper.tar.gz"
            subprocess.run(
                ["bash", str(REPO_ROOT / "scripts/build-host-helper-artifact.sh"), str(output)],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            with tarfile.open(output, "r:gz") as archive:
                members = archive.getmembers()
                files = {item.name for item in members if item.isfile()}
                directories = {item.name for item in members if item.isdir()}
                self.assertEqual(files, EXPECTED_FILES)
                self.assertEqual(directories, {"scripts", "scripts/lib"})
                for item in members:
                    if item.isfile():
                        self.assertEqual(archive.extractfile(item).read(), (REPO_ROOT / item.name).read_bytes(), item.name)

    def test_rebuilding_the_same_commit_produces_identical_payload_bytes(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-host-helper-repeat-") as temporary:
            first = Path(temporary) / "first.tar.gz"
            second = Path(temporary) / "second.tar.gz"
            builder = str(REPO_ROOT / "scripts/build-host-helper-artifact.sh")
            subprocess.run(["bash", builder, str(first)], cwd=REPO_ROOT, check=True, capture_output=True, text=True)
            subprocess.run(["bash", builder, str(second)], cwd=REPO_ROOT, check=True, capture_output=True, text=True)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_builder_does_not_package_credentials_or_host_specific_live_config(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-host-helper-build-") as temporary:
            output = Path(temporary) / "host-helper.tar.gz"
            subprocess.run(
                ["bash", str(REPO_ROOT / "scripts/build-host-helper-artifact.sh"), str(output)],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            with tarfile.open(output, "r:gz") as archive:
                names = {item.name for item in archive.getmembers()}
                joined = b"\n".join(archive.extractfile(name).read() for name in sorted(names)
                                       if archive.getmember(name).isfile())
            self.assertFalse(any(".env" in name or "credential" in name.lower() for name in names))
            self.assertNotIn(b"BEGIN OPENSSH PRIVATE KEY", joined)
            self.assertNotIn(b"ghp_", joined)
            self.assertNotIn(b"github_pat_", joined)


class HostHelperArtifactAdmissionTests(unittest.TestCase):
    def test_fetches_unique_exact_run_attempt_and_records_archive_and_payload_digests(self):
        payload = make_tar()
        zipped = make_zip(payload)
        metadata = {"artifacts": [{
            "id": 987,
            "name": f"host-helper-{RUN_ID}-{ATTEMPT}",
            "expired": False,
            "digest": "sha256:" + hashlib.sha256(zipped).hexdigest(),
            "workflow_run": {"id": RUN_ID, "head_sha": SOURCE_SHA, "head_branch": "main"},
        }]}
        provenance = {"sourceSha": SOURCE_SHA, "runId": RUN_ID, "attempt": ATTEMPT}
        with patch.object(staging193, "capture", return_value=json.dumps([metadata])) as capture, \
             patch.object(staging193, "capture_bytes", return_value=zipped) as capture_bytes:
            result = staging193.fetch_host_helper_artifact(provenance, SOURCE_SHA)
        self.assertEqual(result, payload)
        self.assertEqual(provenance["hostHelperArtifact"], {
            "artifactId": 987,
            "runId": RUN_ID,
            "attempt": ATTEMPT,
            "archiveSha256": hashlib.sha256(zipped).hexdigest(),
            "payloadSha256": hashlib.sha256(payload).hexdigest(),
        })
        self.assertIn(f"actions/runs/{RUN_ID}/artifacts", capture.call_args.args[0][2])
        self.assertIn("actions/artifacts/987/zip", capture_bytes.call_args.args[0][2])

    def test_missing_expired_duplicate_wrong_run_sha_or_attempt_refuses_before_download(self):
        base, _ = artifact_record()
        cases = (
            ("missing", []),
            ("expired", [{**base, "expired": True}]),
            ("duplicate", [base, base]),
            ("wrong run", [{**base, "workflow_run": {**base["workflow_run"], "id": RUN_ID + 1}}]),
            ("wrong SHA", [{**base, "workflow_run": {**base["workflow_run"], "head_sha": "c" * 40}}]),
            ("wrong attempt", [{**base, "name": f"host-helper-{RUN_ID}-{ATTEMPT + 1}"}]),
        )
        for label, artifacts in cases:
            with self.subTest(label=label):
                provenance = {"sourceSha": SOURCE_SHA, "runId": RUN_ID, "attempt": ATTEMPT}
                with patch.object(staging193, "capture", return_value=json.dumps([{"artifacts": artifacts}])), \
                     patch.object(staging193, "capture_bytes") as download, \
                     self.assertRaises(staging193.Refusal):
                    staging193.fetch_host_helper_artifact(provenance, SOURCE_SHA)
                download.assert_not_called()

    def test_zip_digest_and_exact_single_payload_are_required(self):
        payload = make_tar()
        zipped = make_zip(payload, extra={"unexpected.txt": b"extra"})
        metadata = {"artifacts": [{
            "id": 987,
            "name": f"host-helper-{RUN_ID}-{ATTEMPT}",
            "expired": False,
            "digest": "sha256:" + hashlib.sha256(zipped).hexdigest(),
            "workflow_run": {"id": RUN_ID, "head_sha": SOURCE_SHA, "head_branch": "main"},
        }]}
        with patch.object(staging193, "capture", return_value=json.dumps([metadata])), \
             patch.object(staging193, "capture_bytes", return_value=zipped), \
             self.assertRaisesRegex(staging193.Refusal, "exactly one"):
            staging193.fetch_host_helper_artifact(
                {"sourceSha": SOURCE_SHA, "runId": RUN_ID, "attempt": ATTEMPT}, SOURCE_SHA)

        good_zip = make_zip(payload)
        metadata["artifacts"][0]["digest"] = "sha256:" + "0" * 64
        with patch.object(staging193, "capture", return_value=json.dumps([metadata])), \
             patch.object(staging193, "capture_bytes", return_value=good_zip), \
             self.assertRaisesRegex(staging193.Refusal, "GitHub"):
            staging193.fetch_host_helper_artifact(
                {"sourceSha": SOURCE_SHA, "runId": RUN_ID, "attempt": ATTEMPT}, SOURCE_SHA)

    def test_payload_must_have_exact_helper_file_set(self):
        payload = make_tar({"scripts/install-rehearsal-host.sh": b"installer", "extra.py": b"unexpected"})
        zipped = make_zip(payload)
        metadata = {"artifacts": [{
            "id": 987,
            "name": f"host-helper-{RUN_ID}-{ATTEMPT}",
            "expired": False,
            "digest": "sha256:" + hashlib.sha256(zipped).hexdigest(),
            "workflow_run": {"id": RUN_ID, "head_sha": SOURCE_SHA, "head_branch": "main"},
        }]}
        with patch.object(staging193, "capture", return_value=json.dumps([metadata])), \
             patch.object(staging193, "capture_bytes", return_value=zipped), \
             self.assertRaises(staging193.Refusal):
            staging193.fetch_host_helper_artifact(
                {"sourceSha": SOURCE_SHA, "runId": RUN_ID, "attempt": ATTEMPT}, SOURCE_SHA)

    def test_payload_rejects_unsafe_tar_paths(self):
        zipped = make_zip(make_tar({"../outside.py": b"unsafe"}))
        metadata = {"artifacts": [{
            "id": 987,
            "name": f"host-helper-{RUN_ID}-{ATTEMPT}",
            "expired": False,
            "digest": "sha256:" + hashlib.sha256(zipped).hexdigest(),
            "workflow_run": {"id": RUN_ID, "head_sha": SOURCE_SHA, "head_branch": "main"},
        }]}
        with patch.object(staging193, "capture", return_value=json.dumps([metadata])), \
             patch.object(staging193, "capture_bytes", return_value=zipped), \
             self.assertRaisesRegex(staging193.Refusal, "unsafe member"):
            staging193.fetch_host_helper_artifact(
                {"sourceSha": SOURCE_SHA, "runId": RUN_ID, "attempt": ATTEMPT}, SOURCE_SHA)


if __name__ == "__main__":
    unittest.main()
