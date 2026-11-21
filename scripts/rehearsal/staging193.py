#!/usr/bin/env python3
"""Local authenticated operator for exact-source staging194 rehearsal commands."""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import http.server
import io
import json
import os
import re
import shlex
import shutil
import socketserver
import subprocess
import sys
import tarfile
import tempfile
import threading
import zipfile
from pathlib import Path, PurePosixPath
from typing import Optional


ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r"[a-f0-9]{40}\Z")
OP = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
MIGRATION_REVIEW_TRANSPORT_LIMIT = 64 * 1024 * 1024
TARGET_HOST = "194.226.99.10"
TARGET_USER = "root"
TARGET_OPERATOR_DIR = Path.home() / ".local/share/ikpk-rehearsal/staging194/ssh"
TARGET_IDENTITY = TARGET_OPERATOR_DIR / "id_rsa"
TARGET_KNOWN_HOSTS = TARGET_OPERATOR_DIR / "known_hosts"
INITIAL_PROD_HOST = "89.111.184.196"
INITIAL_PROD_USER = "root"
INITIAL_PROD_IDENTITY = Path.home() / ".ssh/id_ed25519_ikpk_vps"
INITIAL_PROD_KNOWN_HOSTS = Path.home() / ".ssh/known_hosts"
INITIAL_PROD_OPERATION_ID = "initial-prod-20261019-A-01"
INITIAL_PROD_CHAT_LOADER_SRC = "https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js"
STAGING194_CHAT_LOADER_SRC = INITIAL_PROD_CHAT_LOADER_SRC
CANONICAL_REPOSITORY = "pgorbachev/ikpk"
WORKFLOW = "Tests"
REQUIRED_TEST_JOBS = {
    "Capture content snapshot",
    "Unit and build tests",
    "Dependency update invariants",
    "Scripts unit tests",
    "Playwright smoke (desktop + mobile)",
}
STATIC_MAIN_ADDITIONAL_WORKFLOWS = ("Lint and Typecheck", "Security", "Lighthouse CI")
FRESH_OPERATION_STATUS_ERRORS = frozenset({
    "operation has no maintenance marker or terminal journal record",
    "host operation failed (2): ikpk-rehearsal: "
    "operation has no maintenance marker or terminal journal record",
})


class Refusal(RuntimeError):
    pass


def capture(argv: list[str], *, input_bytes: Optional[bytes] = None) -> str:
    result = subprocess.run(argv, cwd=ROOT, input=input_bytes, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise Refusal(f"{argv[0]} failed ({result.returncode}): {result.stderr.decode(errors='replace').strip()}")
    return result.stdout.decode().strip()


def capture_bytes(argv: list[str]) -> bytes:
    result = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise Refusal(f"{argv[0]} failed ({result.returncode}): {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def validate_sha_and_ci(sha: str, profile: str = "staging194", *, require_current_head: bool = True) -> dict:
    if profile not in ("staging194", "staging194-dev", "staging194-main", "initial-prod"):
        raise Refusal("unknown fixed rehearsal profile")
    if not SHA.fullmatch(sha):
        raise Refusal("source SHA must be a full lowercase commit ID")
    capture(["git", "cat-file", "-e", f"{sha}^{{commit}}"])
    if profile == "staging194":
        return validate_staging194_paired_admission(sha)
    repo = capture(["gh", "repo", "view", CANONICAL_REPOSITORY,
                    "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    if repo != CANONICAL_REPOSITORY:
        raise Refusal("GitHub CLI resolved a repository other than the pinned IKPK repository")
    branch = "main" if profile in ("staging194", "staging194-main", "initial-prod") else "dev"
    canonical_ref = f"refs/heads/{branch}"
    canonical_head = capture(["gh", "api", f"repos/{repo}/git/ref/heads/{branch}", "--jq", ".object.sha"])
    if require_current_head and canonical_head != sha:
        raise Refusal(f"source SHA is not the current canonical pgorbachev/ikpk {branch} head")
    raw = capture(["gh", "run", "list", "--repo", repo, "--commit", sha,
                   "--workflow", WORKFLOW, "--limit", "50", "--json",
                   "databaseId,headSha,event,status,conclusion,attempt,workflowName,headBranch,createdAt"])
    try:
        runs = json.loads(raw)
    except ValueError as error:
        raise Refusal("gh returned malformed workflow-run metadata") from error
    matching = [run for run in runs if run.get("headSha") == sha and run.get("workflowName") == WORKFLOW
                and run.get("event") == "push" and run.get("headBranch") == branch]
    if not matching:
        raise Refusal("no canonical Tests push run exists for exact source SHA")
    latest = max(matching, key=lambda item: item.get("createdAt", ""))
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        raise Refusal("latest canonical Tests push run for exact SHA is not successful")
    if (type(latest.get("databaseId")) is not int or latest["databaseId"] <= 0
            or type(latest.get("attempt")) is not int or latest["attempt"] <= 0):
        raise Refusal("gh omitted canonical run ID or attempt")
    jobs_raw = capture(["gh", "run", "view", str(latest["databaseId"]), "--repo", repo,
                        "--attempt", str(latest["attempt"]), "--json", "jobs"])
    try:
        jobs = json.loads(jobs_raw).get("jobs")
    except (ValueError, AttributeError) as error:
        raise Refusal("gh returned malformed canonical job metadata") from error
    if not isinstance(jobs, list):
        raise Refusal("gh omitted canonical job list")
    observed = {job.get("name") for job in jobs if isinstance(job, dict)}
    missing = REQUIRED_TEST_JOBS - observed
    if missing:
        raise Refusal(f"canonical Tests run omitted mandatory jobs: {', '.join(sorted(missing))}")
    failed = sorted(job.get("name", "?") for job in jobs if isinstance(job, dict)
                    if job.get("name") in REQUIRED_TEST_JOBS
                    and (job.get("status") != "completed" or job.get("conclusion") != "success"))
    if failed:
        raise Refusal(f"canonical Tests mandatory jobs are not successful: {', '.join(failed)}")
    return {"repository": repo, "ref": canonical_ref, "sourceSha": sha,
            "workflow": WORKFLOW, "workflowName": WORKFLOW, "event": "push", "headBranch": branch, "runId": latest["databaseId"],
            "attempt": latest["attempt"], "status": latest["status"], "conclusion": latest["conclusion"],
            "requiredJobs": sorted(REQUIRED_TEST_JOBS),
            "runUrl": f"https://github.com/{repo}/actions/runs/{latest['databaseId']}"}


def validate_static_main_ci(sha: str, *, release_tag: Optional[str] = None,
                            require_current_head: bool = True) -> dict:
    historical_release = release_tag is not None
    provenance = validate_sha_and_ci(sha, "staging194-main",
                                    require_current_head=require_current_head and not historical_release)
    workflow_proofs = []
    for workflow in STATIC_MAIN_ADDITIONAL_WORKFLOWS:
        raw = capture(["gh", "run", "list", "--repo", CANONICAL_REPOSITORY, "--commit", sha,
                       "--workflow", workflow, "--limit", "50", "--json",
                       "databaseId,headSha,event,status,conclusion,attempt,workflowName,headBranch,createdAt"])
        try:
            runs = json.loads(raw)
        except ValueError as error:
            raise Refusal(f"gh returned malformed {workflow} workflow-run metadata") from error
        matching = [run for run in runs if run.get("headSha") == sha and run.get("workflowName") == workflow
                    and run.get("event") == "push" and run.get("headBranch") == "main"]
        if not matching:
            raise Refusal(f"no canonical {workflow} push run exists for exact main SHA")
        latest = max(matching, key=lambda item: item.get("createdAt", ""))
        if latest.get("status") != "completed" or latest.get("conclusion") != "success":
            raise Refusal(f"latest canonical {workflow} run for exact main SHA is not successful")
        if (type(latest.get("databaseId")) is not int or latest["databaseId"] <= 0
                or type(latest.get("attempt")) is not int or latest["attempt"] <= 0):
            raise Refusal(f"gh omitted canonical {workflow} run ID or attempt")
        jobs_raw = capture(["gh", "run", "view", str(latest["databaseId"]), "--repo", CANONICAL_REPOSITORY,
                            "--attempt", str(latest["attempt"]), "--json", "jobs"])
        try:
            jobs = json.loads(jobs_raw).get("jobs")
        except (ValueError, AttributeError) as error:
            raise Refusal(f"gh returned malformed {workflow} job metadata") from error
        if not isinstance(jobs, list) or not jobs:
            raise Refusal(f"canonical {workflow} run omitted its required jobs")
        invalid = sorted((job.get("name") if isinstance(job, dict) else "?") for job in jobs
                         if not isinstance(job, dict) or not isinstance(job.get("name"), str)
                         or job.get("status") != "completed" or job.get("conclusion") != "success")
        if invalid:
            raise Refusal(f"canonical {workflow} jobs are not successful: {', '.join(invalid)}")
        job_names = [job["name"] for job in jobs]
        if len(set(job_names)) != len(job_names):
            raise Refusal(f"canonical {workflow} run contains duplicate job names")
        workflow_proofs.append({"workflow": workflow, "headSha": sha, "event": "push", "headBranch": "main",
            "runId": latest["databaseId"], "attempt": latest["attempt"], "status": latest["status"],
            "conclusion": latest["conclusion"], "requiredJobs": sorted(job_names),
            "runUrl": f"https://github.com/{CANONICAL_REPOSITORY}/actions/runs/{latest['databaseId']}"})
    canonical_head = capture(["gh", "api", f"repos/{CANONICAL_REPOSITORY}/git/ref/heads/main",
                              "--jq", ".object.sha"])
    if require_current_head and not historical_release and canonical_head != sha:
        raise Refusal("canonical main head moved during CI admission")
    provenance["additionalWorkflows"] = workflow_proofs
    if historical_release:
        provenance = validate_stable_release(provenance, sha, release_tag=release_tag, historical_release=True)
    return provenance


def validate_staging194_paired_admission(sha: str) -> dict:
    """Admit staging194 from exact-SHA canonical main push CI, without a Release."""
    if not SHA.fullmatch(sha):
        raise Refusal("source SHA must be a full lowercase commit ID")
    capture(["git", "cat-file", "-e", f"{sha}^{{commit}}"])
    repo = capture(["gh", "repo", "view", CANONICAL_REPOSITORY,
                    "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    if repo != CANONICAL_REPOSITORY:
        raise Refusal("GitHub CLI resolved a repository other than the pinned IKPK repository")
    canonical_head = capture(["gh", "api", f"repos/{repo}/git/ref/heads/main", "--jq", ".object.sha"])
    if not SHA.fullmatch(canonical_head):
        raise Refusal("canonical main returned an invalid head SHA")
    _require_canonical_main_ancestor(sha, canonical_head)
    provenance = validate_static_main_ci(sha, require_current_head=False)
    final_head = capture(["gh", "api", f"repos/{repo}/git/ref/heads/main", "--jq", ".object.sha"])
    if not SHA.fullmatch(final_head):
        raise Refusal("canonical main returned an invalid head SHA after CI admission")
    _require_canonical_main_ancestor(sha, final_head)
    return provenance


def _require_canonical_main_ancestor(sha: str, main_sha: str) -> None:
    """Use GitHub's canonical comparison so local remote-tracking refs may be stale."""
    comparison = capture(["gh", "api", f"repos/{CANONICAL_REPOSITORY}/compare/{sha}...{main_sha}",
                         "--jq", ".status + \":\" + .merge_base_commit.sha"])
    try:
        status, merge_base = comparison.split(":", 1)
    except ValueError as error:
        raise Refusal("gh returned malformed canonical main ancestry metadata") from error
    if status not in ("ahead", "identical") or merge_base != sha:
        raise Refusal("selected source is not an ancestor of canonical main")


def validate_stable_release(provenance: dict, sha: str, *, release_tag: Optional[str] = None,
                            historical_release: bool = False) -> dict:
    """Bind exact-SHA CI proof to a published stable Release and release preflight."""
    command = ["gh", "release", "view"]
    if release_tag is not None:
        command.append(release_tag)
    raw = capture([*command, "--repo", CANONICAL_REPOSITORY,
                   "--json", "tagName,isDraft,isPrerelease,publishedAt"])
    try:
        release = json.loads(raw)
    except ValueError as error:
        raise Refusal("gh returned malformed stable Release metadata") from error
    tag = release.get("tagName", release.get("tag_name"))
    draft = release.get("isDraft", release.get("is_draft"))
    prerelease = release.get("isPrerelease", release.get("is_prerelease"))
    published_at = release.get("publishedAt", release.get("published_at"))
    if (not isinstance(tag, str) or not re.fullmatch(r"v[0-9][A-Za-z0-9._-]{0,127}", tag)
            or draft is not False or prerelease is not False
            or not isinstance(published_at, str) or not published_at
            or (release_tag is not None and tag != release_tag)):
        raise Refusal("production paired admission requires a published stable GitHub Release")
    tag_object = capture(["gh", "api", f"repos/{CANONICAL_REPOSITORY}/git/ref/tags/{tag}",
                          "--jq", ".object.sha"])
    if tag_object != sha:
        peeled = capture(["gh", "api", f"repos/{CANONICAL_REPOSITORY}/git/tags/{tag_object}",
                          "--jq", ".object.sha"])
        if peeled != sha:
            raise Refusal("stable Release tag does not resolve to the exact selected SHA")
    preflight_command = ["node", "web/scripts/release-preflight.ts"]
    if historical_release:
        preflight_command.append("--historical-release")
    else:
        preflight_command.append("--ensure-helper-asset")
    preflight = capture([*preflight_command, "--release-tag", tag,
                         "--commit", sha])
    try:
        preflight_result = json.loads(preflight)
    except ValueError as error:
        raise Refusal("release-preflight returned malformed admission evidence") from error
    if (preflight_result.get("status", preflight_result.get("result")) not in ("admitted", "passed")
            or preflight_result.get("commit") != sha
            or preflight_result.get("historicalRelease", False) != historical_release):
        raise Refusal("release-preflight did not admit the exact selected Release SHA")
    helper = _verified_preflight_helper_artifact(preflight_result, sha)
    if helper["runId"] != provenance.get("runId") or helper["attempt"] != provenance.get("attempt"):
        raise Refusal("release-preflight helper artifact run/attempt changed during current-source admission")
    provenance["release"] = {"tag": tag, "publishedAt": published_at}
    provenance["releasePreflight"] = preflight_result
    provenance["hostHelperArtifact"] = helper
    provenance["historicalRelease"] = historical_release
    return provenance


def _verified_preflight_helper_artifact(result: dict, sha: str) -> dict:
    helper = result.get("hostHelperArtifact")
    admission = result.get("operatorAdmission")
    if (not isinstance(helper, dict) or type(helper.get("artifactId")) is not int or helper["artifactId"] <= 0
            or type(helper.get("runId")) is not int or helper["runId"] <= 0
            or type(helper.get("attempt")) is not int or helper["attempt"] <= 0
            or not re.fullmatch(r"[a-f0-9]{64}", helper.get("archiveSha256", ""))
            or not re.fullmatch(r"[a-f0-9]{64}", helper.get("payloadSha256", ""))
            or not isinstance(admission, dict) or admission.get("sourceSha") != sha
            or admission.get("runId") != helper.get("runId") or admission.get("attempt") != helper.get("attempt")):
        raise Refusal("release-preflight omitted the verified exact-run host helper artifact digest")
    return helper


def validate_production_paired_admission(sha: str) -> dict:
    """Require the current main release admission before every new paired phase."""
    return validate_stable_release(validate_static_main_ci(sha), sha)


def production_static_admission_from_result(sha: str, tag: str, result: dict) -> dict:
    """Validate trusted release-preflight output before the caller reuses it in memory."""
    if not SHA.fullmatch(sha):
        raise Refusal("source SHA must be a full lowercase commit ID")
    if not isinstance(result, dict):
        raise Refusal("release-preflight returned malformed admission evidence")
    capture(["git", "cat-file", "-e", f"{sha}^{{commit}}"])
    release = result.get("release")
    provenance = result.get("operatorAdmission")
    additional = provenance.get("additionalWorkflows") if isinstance(provenance, dict) else None
    additional_by_name = ({item.get("workflow"): item for item in additional if isinstance(item, dict)}
                          if isinstance(additional, list) else {})
    valid_additional = (isinstance(additional, list) and len(additional) == len(STATIC_MAIN_ADDITIONAL_WORKFLOWS)
        and set(additional_by_name) == set(STATIC_MAIN_ADDITIONAL_WORKFLOWS)
        and all(item.get("headSha") == sha and item.get("event") == "push" and item.get("headBranch") == "main"
                and item.get("status") == "completed" and item.get("conclusion") == "success"
                and type(item.get("runId")) is int and item["runId"] > 0
                and type(item.get("attempt")) is int and item["attempt"] > 0
                and isinstance(item.get("requiredJobs"), list) and bool(item["requiredJobs"])
                and all(isinstance(job, str) and job for job in item["requiredJobs"])
                and item["requiredJobs"] == sorted(set(item["requiredJobs"]))
                and item.get("runUrl") == f"https://github.com/{CANONICAL_REPOSITORY}/actions/runs/{item['runId']}"
                for item in additional_by_name.values()))
    if (result.get("status") != "admitted" or result.get("commit") != sha
            or result.get("historicalRelease") is not True or not isinstance(release, dict)
            or release.get("tag") != tag or type(release.get("id")) is not int or release["id"] <= 0
            or not isinstance(release.get("publishedAt"), str) or not release["publishedAt"]
            or not isinstance(provenance, dict) or not valid_additional
            or provenance.get("sourceSha") != sha or provenance.get("ref") != "refs/heads/main"
            or provenance.get("repository") != CANONICAL_REPOSITORY
            or provenance.get("workflow") != WORKFLOW or provenance.get("workflowName") != WORKFLOW
            or provenance.get("event") != "push" or provenance.get("headBranch") != "main"
            or provenance.get("status") != "completed" or provenance.get("conclusion") != "success"
            or type(provenance.get("runId")) is not int or provenance["runId"] <= 0
            or type(provenance.get("attempt")) is not int or provenance["attempt"] <= 0
            or provenance.get("requiredJobs") != sorted(REQUIRED_TEST_JOBS)
            or provenance.get("runUrl") != f"https://github.com/{CANONICAL_REPOSITORY}/actions/runs/{provenance['runId']}"):
        raise Refusal("release-preflight did not admit the selected stable Release and exact SHA")
    helper = _verified_preflight_helper_artifact(result, sha)
    provenance["release"] = release
    provenance["hostHelperArtifact"] = helper
    provenance["releasePreflight"] = {"status": result["status"], "commit": result["commit"],
                                      "release": release, "historicalRelease": True,
                                      "hostHelperArtifact": helper}
    provenance["historicalRelease"] = True
    return provenance


def validate_production_static_release(sha: str, tag: str) -> dict:
    """Admit one explicitly selected stable Release through the single exact-SHA preflight."""
    raw = capture(["node", "web/scripts/release-preflight.ts", "--historical-release",
                   "--release-tag", tag, "--commit", sha])
    try:
        result = json.loads(raw)
    except ValueError as error:
        raise Refusal("release-preflight returned malformed admission evidence") from error
    return production_static_admission_from_result(sha, tag, result)


def _fetch_tests_run_artifact_payload(provenance: dict, sha: str, *, artifact_prefix: str,
                                      payload_name: str, evidence_key: str, label: str) -> bytes:
    """Fetch one digest-verified payload bound to the admitted Tests run and SHA."""
    run_id = provenance.get("runId")
    attempt = provenance.get("attempt")
    if (type(run_id) is not int or run_id <= 0 or type(attempt) is not int or attempt <= 0
            or provenance.get("sourceSha") != sha):
        raise Refusal(f"{label} admission omitted the exact workflow run identity")

    artifact_name = f"{artifact_prefix}-{run_id}-{attempt}"
    endpoint = f"repos/{CANONICAL_REPOSITORY}/actions/runs/{run_id}/artifacts"
    raw = capture(["gh", "api", endpoint, "--paginate", "--slurp"])
    try:
        pages = json.loads(raw)
    except ValueError as error:
        raise Refusal(f"gh returned malformed {label} artifact metadata") from error
    if not isinstance(pages, list):
        raise Refusal(f"gh returned malformed {label} artifact metadata")
    artifacts = []
    for page in pages:
        if isinstance(page, dict) and isinstance(page.get("artifacts"), list):
            artifacts.extend(page["artifacts"])
    matches = [item for item in artifacts if isinstance(item, dict) and item.get("name") == artifact_name]
    if len(matches) != 1:
        raise Refusal(f"exact {label} artifact is missing or duplicated")
    artifact = matches[0]
    workflow_run = artifact.get("workflow_run")
    digest = artifact.get("digest")
    if (type(artifact.get("id")) is not int or artifact["id"] <= 0
            or artifact.get("expired") is not False
            or not isinstance(workflow_run, dict)
            or workflow_run.get("id") != run_id or workflow_run.get("head_sha") != sha
            or workflow_run.get("head_branch") != "main"
            or not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)):
        raise Refusal(f"{label} artifact is expired or not bound to the admitted run and SHA")

    archive = capture_bytes(["gh", "api",
        f"repos/{CANONICAL_REPOSITORY}/actions/artifacts/{artifact['id']}/zip"])
    archive_sha256 = hashlib.sha256(archive).hexdigest()
    if digest.removeprefix("sha256:") != archive_sha256:
        raise Refusal(f"downloaded {label} ZIP does not match GitHub's artifact digest")
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            entries = bundle.infolist()
            if (len(entries) != 1 or entries[0].filename != payload_name
                    or entries[0].is_dir() or entries[0].flag_bits & 0x1):
                raise Refusal(f"{label} ZIP must contain exactly one unencrypted tar payload")
            payload = bundle.read(entries[0])
    except Refusal:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise Refusal(f"{label} ZIP is unreadable") from error
    provenance[evidence_key] = {"artifactId": artifact["id"], "runId": run_id, "attempt": attempt,
        "archiveSha256": archive_sha256, "payloadSha256": hashlib.sha256(payload).hexdigest()}
    return payload


def fetch_cms_candidate_artifact(provenance: dict, sha: str) -> bytes:
    """Fetch and verify the CMS payload bound to this exact Tests run and SHA."""
    return _fetch_tests_run_artifact_payload(
        provenance, sha, artifact_prefix="cms-candidate", payload_name="cms-artifact.tar.gz",
        evidence_key="cmsArtifact", label="CMS candidate")


HOST_HELPER_ARTIFACT_FILES = frozenset({
    "scripts/install-rehearsal-host.sh",
    "scripts/lib/rehearsal_state.py",
    "scripts/lib/housekeeping_journal.py",
    "scripts/lib/rehearsal_host.py",
    "scripts/lib/rehearsal_config.py",
    "scripts/staging193-rehearsal.json",
    "scripts/initial-prod-rehearsal.json",
    "scripts/production-static-rehearsal.json",
    "scripts/production-paired-rehearsal.json",
})
HOST_HELPER_RUNTIME_FILES = (
    "scripts/lib/rehearsal_host.py",
    "scripts/lib/rehearsal_state.py",
    "scripts/lib/housekeeping_journal.py",
)


def _host_helper_runtime_identity(payload: bytes) -> str:
    """Return a stable identity for the modules installed by the host installer."""
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            members = {member.name: member for member in archive.getmembers() if member.isfile()}
            hashes = {}
            for name in HOST_HELPER_RUNTIME_FILES:
                member = members.get(name)
                source = archive.extractfile(member) if member is not None else None
                if source is None:
                    raise Refusal("host helper artifact omitted an installed runtime module")
                hashes[name] = hashlib.sha256(source.read()).hexdigest()
            host_source = archive.extractfile(members["scripts/lib/rehearsal_host.py"]).read()
            if b'STAGING194_PAIRED_HELPER_IDENTITY_CAPABILITY = "paired-helper-identity-v1"' not in host_source:
                raise Refusal("selected host helper SHA does not support paired helper identity admission")
    except (OSError, tarfile.TarError, KeyError, AttributeError) as error:
        raise Refusal("host helper runtime identity could not be read from its CI artifact") from error
    encoded = json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def fetch_host_helper_artifact(provenance: dict, sha: str) -> bytes:
    """Fetch the exact helper package and bind its digests to admitted provenance."""
    payload = _fetch_tests_run_artifact_payload(
        provenance, sha, artifact_prefix="host-helper", payload_name="host-helper.tar.gz",
        evidence_key="hostHelperArtifact", label="host helper")
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            members = archive.getmembers()
            names = [member.name for member in members]
            for member in members:
                raw_parts = member.name.split("/")
                path = PurePosixPath(member.name)
                if (not member.name or path.is_absolute()
                        or any(part in ("", ".", "..") for part in raw_parts)
                        or (member.isdir() and member.name not in {"scripts", "scripts/lib"})
                        or (not member.isdir() and not member.isfile())):
                    raise Refusal(f"host helper payload contains an unsafe member: {member.name!r}")
            file_names = {member.name for member in members if member.isfile()}
            directories = {member.name for member in members if member.isdir()}
            if (len(names) != len(set(names)) or file_names != HOST_HELPER_ARTIFACT_FILES
                    or directories != {"scripts", "scripts/lib"}):
                raise Refusal("host helper payload does not contain exactly the expected files")
    except Refusal:
        provenance.pop("hostHelperArtifact", None)
        raise
    except (OSError, tarfile.TarError, EOFError) as error:
        provenance.pop("hostHelperArtifact", None)
        raise Refusal("host helper payload is unreadable") from error
    return payload


def install_staging194_host_helper(payload: bytes, digest: str, operation_id: str) -> None:
    """Install a verified helper artifact through the existing staging194 SSH channel."""
    if not isinstance(payload, bytes) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise Refusal("host helper payload or digest is invalid")
    if not isinstance(operation_id, str) or not OP.fullmatch(operation_id):
        raise Refusal("host helper install requires an explicit valid operation ID")
    if hashlib.sha256(payload).hexdigest() != digest:
        raise Refusal("host helper payload digest does not match its CI evidence")
    if not TARGET_IDENTITY.is_file() or not TARGET_KNOWN_HOSTS.is_file():
        raise Refusal("authorized staging194 SSH identity or known-hosts file is unavailable")

    remote_dir_prefix = "/var/tmp/ikpk-staging194/host-helper."
    ssh_options = ["-i", str(TARGET_IDENTITY), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                   "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={TARGET_KNOWN_HOSTS}",
                   "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=15",
                   f"{TARGET_USER}@{TARGET_HOST}"]
    def remote(command: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(["ssh", *ssh_options, shlex.join(command)], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, check=False, cwd=ROOT)

    created = remote(["mktemp", "-d", f"{remote_dir_prefix}XXXXXX"])
    if created.returncode:
        raise Refusal("could not create a private staging194 host-helper directory")
    remote_dir = created.stdout.decode(errors="replace").strip()
    if not re.fullmatch(re.escape(remote_dir_prefix) + r"[A-Za-z0-9]{6}", remote_dir):
        raise Refusal("remote mktemp returned an unexpected staging194 path")
    remote_archive = f"{remote_dir}/host-helper.tar.gz"
    with tempfile.NamedTemporaryFile(prefix="ikpk-host-helper-", suffix=".tar.gz", delete=False) as source:
        source.write(payload)
        local_archive = Path(source.name)
    failure = None
    try:
        transfer = ["scp", "-i", str(TARGET_IDENTITY), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                    "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={TARGET_KNOWN_HOSTS}",
                    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=15",
                    str(local_archive), f"{TARGET_USER}@{TARGET_HOST}:{remote_archive}"]
        result = subprocess.run(transfer, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, cwd=ROOT)
        if result.returncode:
            raise Refusal(f"staging194 host helper transfer failed ({result.returncode}): "
                          f"{result.stderr.decode(errors='replace').strip()}")
        remote_python = r'''import fcntl, hashlib, json, os, pwd, re, shutil, stat, subprocess, sys, tarfile
temporary, expected_digest, requested_operation_id = sys.argv[1:]
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", requested_operation_id):
    raise SystemExit("fresh staging194 helper bootstrap requires a valid operation ID")
archive_path = os.path.join(temporary, "host-helper.tar.gz")
if not re.fullmatch(r"/var/tmp/ikpk-staging194/host-helper\.[A-Za-z0-9]{6}", temporary):
    raise SystemExit("staging194 temporary directory is not a pinned mktemp path")
try:
    directory = os.lstat(temporary)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or stat.S_IMODE(directory.st_mode) != 0o700:
        raise SystemExit("staging194 helper directory is not root-owned and private")
    config_path = "/etc/ikpk/rehearsal.json"
    config_info = os.lstat(config_path)
    if not stat.S_ISREG(config_info.st_mode):
        raise SystemExit("staging194 configuration is not a regular file")
    with open(config_path, "rb") as stream:
        config_before = stream.read()
    config = json.loads(config_before)
    if (config.get("profile", "staging194") != "staging194"
            or config.get("stateDir") != "/var/lib/ikpk-rehearsal/staging194"
            or config.get("cmsUser") != "ikpk-cms"
            or config.get("publicationLock") != "/var/www/ikpk/.publication.lock"
            or config.get("maintenanceFlag") != "/var/lib/ikpk-rehearsal/staging194/fenced"
            or config.get("sitePublicationMarker") != "/var/lib/ikpk-rehearsal/site-publication/host-publication.json"):
        raise SystemExit("staging194 config differs from the validated helper-install lock profile")
    fds, snapshots = [], []
    try:
        locks = [config["publicationLock"], os.path.join(config["stateDir"], ".operation.lock")]
        for path in locks:
            before = os.lstat(path)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise SystemExit("existing staging194 lock is unsafe")
            fd = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
            fds.append(fd)
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise SystemExit("staging194 lock changed while opening")
            if path == locks[0] and (info.st_uid != pwd.getpwnam(config["cmsUser"]).pw_uid or stat.S_IMODE(info.st_mode) != 0o600):
                raise SystemExit("staging194 publication lock has unsafe owner or mode")
            if stat.S_IMODE(info.st_mode) != 0o600:
                raise SystemExit("staging194 state lock has unsafe mode")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            snapshots.append((path, info.st_dev, info.st_ino))
        if any(os.path.lexists(path) for path in (config["maintenanceFlag"],
                os.path.join(config["stateDir"], "maintenance.json"), config["sitePublicationMarker"])):
            raise SystemExit("staging194 publication or maintenance marker exists; recover with the previous operation ID, then use a new operation ID")
        for path, device, inode in snapshots:
            named = os.lstat(path)
            if (named.st_dev, named.st_ino) != (device, inode) or not stat.S_ISREG(named.st_mode) or named.st_nlink != 1:
                raise SystemExit("staging194 lock inode changed before installation")
        subprocess.run(["/usr/local/sbin/ikpk-rehearsal", "--profile", "staging194", "validate-config"], check=True)
        archive_info = os.lstat(archive_path)
        if not stat.S_ISREG(archive_info.st_mode) or archive_info.st_uid != 0 or archive_info.st_nlink != 1:
            raise SystemExit("transferred host helper is not a root-owned regular file")
        with open(archive_path, "rb") as stream:
            actual_digest = hashlib.sha256(stream.read()).hexdigest()
        if actual_digest != expected_digest:
            raise SystemExit("transferred host helper SHA-256 does not match CI evidence")
        with tarfile.open(archive_path, "r:gz") as bundle:
            members = bundle.getmembers()
            names = [member.name for member in members]
            files = {member.name for member in members if member.isfile()}
            directories = {member.name for member in members if member.isdir()}
            if (len(names) != len(set(names)) or files != EXPECTED_FILES
                    or directories != {"scripts", "scripts/lib"}
                    or any(not (member.isfile() or member.isdir()) for member in members)):
                raise SystemExit("host helper archive contents differ from the admitted package")
            bundle.extractall(os.path.join(temporary, "payload"))
        sys.path.insert(0, os.path.join(temporary, "payload", "scripts", "lib"))
        from rehearsal_state import RehearsalState
        state = RehearsalState(config["stateDir"])
        # The caller already holds both locks; this journal reader does not lock again.
        history = state.read_journal_for_cleanup(validate_history=True)
        if any(row.get("operationId") == requested_operation_id for row in history):
            raise SystemExit("requested operation ID already exists in the staging194 journal")
        if RehearsalState._unfinished_operation_ids(history):
            raise SystemExit("staging194 journal has an unfinished operation; helper replacement refused")
        if state._read_marker() is not None or any(os.path.lexists(path) for path in (
                config["maintenanceFlag"], state.marker_path, config["sitePublicationMarker"])):
            raise SystemExit("staging194 maintenance or publication marker appeared before helper replacement")
        subprocess.run(["bash", os.path.join(temporary, "payload/scripts/install-rehearsal-host.sh"),
                        "--staging193-existing-config"], check=True)
        subprocess.run(["/usr/local/sbin/ikpk-rehearsal", "--profile", "staging194", "validate-config"], check=True)
        with open(config_path, "rb") as stream:
            if stream.read() != config_before:
                raise SystemExit("staging194 configuration changed during helper installation")
        for path, device, inode in snapshots:
            named = os.lstat(path)
            if (named.st_dev, named.st_ino) != (device, inode) or not stat.S_ISREG(named.st_mode) or named.st_nlink != 1:
                raise SystemExit("staging194 lock inode changed during helper installation")
    finally:
        for fd in reversed(fds):
            os.close(fd)
finally:
    shutil.rmtree(temporary)
'''.replace("EXPECTED_FILES", repr(set(HOST_HELPER_ARTIFACT_FILES)))
        install = remote(["python3", "-c", remote_python, remote_dir, digest, operation_id])
        if install.returncode:
            raise Refusal(f"staging194 host helper installation or config validation failed ({install.returncode}): "
                          f"{install.stderr.decode(errors='replace').strip()}")
    except Exception as error:
        failure = error
    finally:
        local_archive.unlink(missing_ok=True)
        cleanup = remote(["rm", "-rf", "--", remote_dir])
        if cleanup.returncode and failure is None:
            failure = Refusal("could not clean the private staging194 host-helper directory")
    if failure is not None:
        if isinstance(failure, Refusal):
            raise failure
        raise Refusal(f"staging194 host helper installation failed: {failure}") from failure


def _proof_members(payload: bytes) -> dict:
    """Compare content, names and executable bits, never trust a PAX comment."""
    result = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as archive:
            for member in archive.getmembers():
                path = PurePosixPath(member.name)
                if (path.is_absolute() or not path.parts or ".." in path.parts
                        or path.as_posix() in result or not (member.isfile() or member.isdir())):
                    raise Refusal("proof artifact contains an unsafe, duplicate or unsupported member")
                content = archive.extractfile(member).read() if member.isfile() else b""
                result[path.as_posix()] = ("file" if member.isfile() else "dir", bool(member.mode & 0o111) if member.isfile() else False, hashlib.sha256(content).hexdigest())
    except (tarfile.TarError, OSError) as error:
        raise Refusal("proof artifact is not a readable source archive") from error
    return result


def admit_seminar_proof(path: str, digest: str, sha: str, provenance: dict) -> bytes:
    if not re.fullmatch(r"[a-f0-9]{64}", digest or "") or provenance.get("sourceSha") != sha:
        raise Refusal("proof artifact requires an independent digest and admitted source SHA")
    archive_path = Path(path)
    if archive_path.is_symlink() or not archive_path.is_file():
        raise Refusal("proof artifact must be a regular non-symlink file")
    payload = archive_path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != digest:
        raise Refusal("proof artifact differs from the independently supplied SHA-256")
    capture_types = ("institute", "course-group", "seminar", "teacher", "article", "schedule-entry", "news-item", "promotion", "page", "video-playlist")
    capture_paths = ["web", "cms/src/components", "cms/src/lib/demo193-source-empty-fields.json",
        "fixtures/content-snapshot/collapsible_panels.json", "fixtures/content-snapshot/url_map.csv",
        *(f"scripts/lib/{name}.mjs" for name in ("staging193-capture-bundle", "server-capture-sqlite", "seal-staging193-capture")),
        *(f"cms/src/api/{name}/content-types/{name}/schema.json" for name in capture_types)]
    expected = capture_bytes(["git", "archive", "--format=tar", sha, *capture_paths])
    members = _proof_members(payload)
    if members != _proof_members(expected):
        raise Refusal("proof artifact contents differ from the exact CI-admitted source commit")
    required = {"web/package.json", "web/package-lock.json", "web/astro.config.mjs", "web/scripts/seminar-migration/render-audit.ts", "web/scripts/seminar-migration/rehearse.py", "web/tests/seminar-real-migration.migration.test.ts", "web/tests/seminar-separate-fields.migration.test.ts", "fixtures/content-snapshot/collapsible_panels.json"}
    if not required.issubset(members) or not any(name.startswith("web/src/") for name in members):
        raise Refusal("proof artifact is missing mandatory render proof sources")
    provenance["seminarProofArtifact"] = {"sourceSha": sha, "payloadSha256": digest}
    return payload


def migration_review_payload(path: Optional[str], digest: Optional[str], sha: str, operation_id: str) -> Optional[bytes]:
    if path is None and digest is None:
        return None
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise Refusal("migration review requires a full source SHA")
    if not path or not re.fullmatch(r"[a-f0-9]{64}", digest or ""):
        raise Refusal("migration review requires both file and independent SHA-256")
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise Refusal("migration review manifest digest mismatch")
    try:
        control = json.loads(raw)
    except ValueError as error:
        raise Refusal("migration review manifest is not JSON") from error
    if not isinstance(control, dict) or control.get("sourceSha") != sha or control.get("operationId") != operation_id:
        raise Refusal("migration review manifest belongs to another source or operation")
    for kind, digest_key in (("reviewedStep", "expectedReviewFileSha256"), ("compositionReview", "expectedFileSha256"), ("registryReview", "expectedFileSha256")):
        if kind not in control:
            continue
        binding = control[kind]
        if not isinstance(binding, dict) or not isinstance(binding.get("reviewFilePath"), str):
            raise Refusal("migration review binding is malformed")
        review_path = Path(binding.pop("reviewFilePath"))
        if not review_path.is_absolute() or review_path.is_symlink() or not review_path.is_file():
            raise Refusal("migration review file must be an absolute regular non-symlink file")
        content = review_path.read_bytes()
        if hashlib.sha256(content).hexdigest() != binding.get(digest_key):
            raise Refusal("migration review file digest mismatch")
        if kind == "registryReview":
            registry_path = Path(binding.pop("registryFilePath", ""))
            if not registry_path.is_absolute() or registry_path.is_symlink() or not registry_path.is_file():
                raise Refusal("registry file must be an absolute regular non-symlink file")
            registry = registry_path.read_bytes()
            if hashlib.sha256(registry).hexdigest() != json.loads(content).get("registrySha256"):
                raise Refusal("registry bytes differ from the approved binding")
            binding["registryBase64"] = base64.b64encode(registry).decode("ascii")
        binding["fileBase64"] = base64.b64encode(content).decode("ascii")
    payload = json.dumps(control, sort_keys=True, separators=(",", ":")).encode()
    if len(payload) > MIGRATION_REVIEW_TRANSPORT_LIMIT:
        raise Refusal("migration review transport exceeds the 64 MiB limit")
    return payload


def make_archive(sha: str, provenance: dict, *, cms_artifact: Optional[bytes] = None, seminar_proof: Optional[bytes] = None) -> tuple[bytes, str]:
    source = capture_bytes(["git", "archive", "--format=tar", sha])
    tar_buffer = io.BytesIO(source)
    out = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="r:") as src, tarfile.open(fileobj=out, mode="w:") as dst:
        for member in src.getmembers():
            if member.isfile():
                file = src.extractfile(member)
                if file is None:
                    raise Refusal(f"cannot read source member {member.name}")
                dst.addfile(member, file)
            elif member.isdir():
                dst.addfile(member)
            elif member.issym():
                if member.linkname.startswith("/") or ".." in Path(member.linkname).parts:
                    raise Refusal(f"source archive contains unsafe symlink {member.name}")
                dst.addfile(member)
            else:
                raise Refusal(f"source archive contains unsupported entry {member.name}")
        if cms_artifact is not None:
            if any(member.name == ".ikpk-cms-artifact.tar.gz" for member in src.getmembers()):
                raise Refusal("source archive already contains the reserved CMS artifact member")
            info = tarfile.TarInfo(".ikpk-cms-artifact.tar.gz")
            info.size = len(cms_artifact)
            info.mode = 0o600
            dst.addfile(info, io.BytesIO(cms_artifact))
        if seminar_proof is not None:
            if any(member.name == ".ikpk-seminar-proof.tar.gz" for member in src.getmembers()):
                raise Refusal("source archive contains reserved seminar proof member")
            info = tarfile.TarInfo(".ikpk-seminar-proof.tar.gz")
            info.size, info.mode = len(seminar_proof), 0o600
            dst.addfile(info, io.BytesIO(seminar_proof))
        payload = json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        info = tarfile.TarInfo(".ikpk-rehearsal-ci.json")
        info.size = len(payload)
        info.mode = 0o600
        dst.addfile(info, io.BytesIO(payload))
    data = out.getvalue()
    return data, hashlib.sha256(data).hexdigest()


def ssh_remote(arguments: list[str], *, profile: str = "staging194", input_bytes: Optional[bytes] = None, binary: bool = False) -> bytes:
    if profile in ("initial-prod", "production-static", "production-paired"):
        host, user, identity, known_hosts = INITIAL_PROD_HOST, INITIAL_PROD_USER, INITIAL_PROD_IDENTITY, INITIAL_PROD_KNOWN_HOSTS
        arguments = ["--profile", profile, *arguments]
    else:
        host, user, identity, known_hosts = TARGET_HOST, TARGET_USER, TARGET_IDENTITY, TARGET_KNOWN_HOSTS
    if not identity.is_file():
        raise Refusal(f"authorized {profile} SSH identity is unavailable: {identity}")
    if not known_hosts.is_file():
        raise Refusal(f"authorized {profile} known-hosts file is unavailable: {known_hosts}")
    command = ["ssh", "-i", str(identity), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
               "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}",
               "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=15",
               f"{user}@{host}", shlex.join(["/usr/local/sbin/ikpk-rehearsal", *arguments])]
    result = subprocess.run(command, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            check=False, cwd=ROOT)
    if result.returncode:
        raise Refusal(f"host operation failed ({result.returncode}): {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def migration_pause_summary(completed: dict) -> dict:
    migration = completed.get("migration")
    pause = {key: migration[key] for key in ("waitingForReview", "waitingForCompositionReview",
             "waitingForRegistryBinding", "pausedAfterStage") if isinstance(migration, dict) and key in migration}
    return {"operationId": completed["operationId"], "sourceSha": completed["sourceSha"],
            "phase": "fenced", "migrationPaused": True, "pause": pause}


def parse_host_json(payload: bytes) -> dict:
    try:
        result = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise Refusal("host command returned malformed JSON") from error
    if not isinstance(result, dict):
        raise Refusal("host command returned a non-object response")
    return result


def backup_root(requested: Optional[str], profile: str = "staging194") -> Path:
    defaults = {
        "initial-prod": Path.home() / ".local/share/ikpk-initial-prod/backups",
        "production-static": Path.home() / ".local/share/ikpk-production-static/backups",
        "production-paired": Path.home() / ".local/share/ikpk-production-paired/backups",
        "staging194": Path.home() / ".local/share/ikpk-rehearsal/staging194/backups",
    }
    default = defaults.get(profile)
    if default is None:
        raise Refusal("unknown fixed rehearsal profile")
    root = Path(requested).expanduser() if requested else default
    if not root.is_absolute() or root == Path("/"):
        raise Refusal("off-host backup directory must be an absolute non-root path")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise Refusal("off-host backup directory must be a real directory")
    if root.stat().st_mode & 0o077:
        raise Refusal("off-host backup directory must not be accessible by group or other")
    return root


def _space_reserve_bytes(estimated_bytes: int) -> int:
    value = os.environ.get("IKPK_REHEARSAL_SPACE_RESERVE_BYTES", "0")
    baseline = max(1_073_741_824, (estimated_bytes + 3) // 4)
    try:
        reserve = int(value)
    except ValueError as error:
        raise Refusal("IKPK_REHEARSAL_SPACE_RESERVE_BYTES must be a non-negative integer") from error
    if reserve < 0:
        raise Refusal("IKPK_REHEARSAL_SPACE_RESERVE_BYTES must be a non-negative integer")
    return max(baseline, reserve)


def _existing_path(path: Path) -> Path:
    path = path.expanduser().absolute()
    while not path.exists():
        path = path.parent
    return path


def _source_tree_bytes(sha: str) -> int:
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise Refusal("cannot determine selected source tree size: a canonical source SHA is required")
    try:
        listing = capture_bytes(["git", "ls-tree", "-rlz", sha])
        records = [record for record in listing.split(b"\0") if record]
        sizes = [int(record.split(b"\t", 1)[0].split()[-1]) for record in records]
        if not records or any(size < 0 for size in sizes):
            raise ValueError("empty or invalid git tree listing")
        return sum(sizes)
    except (Refusal, ValueError, IndexError) as error:
        raise Refusal(f"cannot determine selected source tree size for {sha}: {error}") from error


def _check_local_space(sha: Optional[str], profile: str, command: str, backup_dir: Optional[str],
                       *, static_export_estimate_bytes: Optional[int] = None,
                       backup_required_bytes: Optional[int] = None) -> list[dict]:
    estimated_bytes = _source_tree_bytes(sha or "")
    paths = {"temporary data": Path(tempfile.gettempdir()), "source checkout": ROOT}
    if command == "cms-update":
        default = Path.home() / (".local/share/ikpk-production-paired/backups" if profile == "production-paired"
                                 else ".local/share/ikpk-initial-prod/backups" if profile == "initial-prod"
                                 else ".local/share/ikpk-rehearsal/staging194/backups")
        paths["off-host backup"] = Path(backup_dir).expanduser() if backup_dir else default
    if static_export_estimate_bytes is not None:
        if (profile != "production-static" or command != "static-main"
                or type(static_export_estimate_bytes) is not int or static_export_estimate_bytes < 0):
            raise Refusal("static export estimate is valid only for production-static static-main")
        # The Git archive is held in memory; browser export extraction writes
        # only below tempfile.gettempdir(). If temp and checkout use different
        # devices, preserve the former source-size headroom on each and use the
        # larger of source or export on temp. If they share a device, count the
        # source headroom once plus the target-derived export proxy.
        estimates = [("temporary data", paths["temporary data"]),
                     ("source checkout", paths["source checkout"])]
        by_device: dict[int, dict] = {}
        for label, raw_path in estimates:
            checked_path = _existing_path(raw_path)
            disk = shutil.disk_usage(checked_path)
            device = checked_path.stat().st_dev
            item = by_device.get(device)
            if item is None:
                by_device[device] = {"path": str(checked_path), "labels": [label],
                                     "freeBytes": disk.free}
            else:
                item["labels"].append(label)
                item["freeBytes"] = min(item["freeBytes"], disk.free)
        report = []
        for item in by_device.values():
            if "temporary data" in item["labels"] and "source checkout" in item["labels"]:
                estimated = estimated_bytes + static_export_estimate_bytes
            elif "temporary data" in item["labels"]:
                estimated = max(estimated_bytes, static_export_estimate_bytes)
            else:
                estimated = estimated_bytes
            item["estimatedBytes"] = estimated
            reserve = _space_reserve_bytes(item["estimatedBytes"])
            required = item["estimatedBytes"] + reserve
            if item["freeBytes"] < required:
                label = " + ".join(item["labels"])
                raise Refusal(f"insufficient free space on {label} filesystem ({item['path']}): "
                              f"need {required} bytes, have {item['freeBytes']} bytes, "
                              f"short {required - item['freeBytes']} bytes")
            report.append({"label": " + ".join(item["labels"]), "path": item["path"],
                           "freeBytes": item["freeBytes"], "estimatedBytes": item["estimatedBytes"],
                           "reserveBytes": reserve, "requiredBytes": required,
                           "staticExportEstimateBytes": static_export_estimate_bytes
                           if "temporary data" in item["labels"] else 0})
        return report
    by_device: dict[int, dict] = {}
    for label, raw_path in paths.items():
        checked_path = _existing_path(raw_path)
        disk = shutil.disk_usage(checked_path)
        device = checked_path.stat().st_dev
        item = by_device.get(device)
        if item is None:
            item = {"label": label, "path": str(checked_path), "freeBytes": disk.free,
                    "estimatedBytes": 0}
            by_device[device] = item
        else:
            item["label"] += f" + {label}"
            item["freeBytes"] = min(item["freeBytes"], disk.free)
        item["estimatedBytes"] += (backup_required_bytes if label == "off-host backup"
                                   and backup_required_bytes is not None else estimated_bytes)
    report = []
    for item in by_device.values():
        reserve = _space_reserve_bytes(item["estimatedBytes"])
        required = item["estimatedBytes"] + reserve
        if item["freeBytes"] < required:
            raise Refusal(f"insufficient free space on {item['label']} filesystem ({item['path']}): "
                          f"need {required} bytes, have {item['freeBytes']} bytes, "
                          f"short {required - item['freeBytes']} bytes")
        item["reserveBytes"] = reserve
        item["requiredBytes"] = required
        report.append(item)
    return report


def _check_target_space(profile: str, operation_id: str, command: str) -> dict:
    report = parse_host_json(ssh_remote(["status", "--operation-id", operation_id, "--space-preflight",
                                         "--space-preflight-for", command],
                                        profile=profile))
    filesystems = report.get("filesystems")
    if not isinstance(filesystems, list) or not filesystems:
        raise Refusal("target free-space preflight returned no filesystem estimates")
    for item in filesystems:
        if (not isinstance(item, dict) or not isinstance(item.get("path"), str)
                or type(item.get("freeBytes")) is not int or type(item.get("requiredBytes")) is not int):
            raise Refusal("target free-space preflight returned a malformed filesystem estimate")
        if item["freeBytes"] < item["requiredBytes"]:
            missing = item["requiredBytes"] - item["freeBytes"]
            raise Refusal(f"insufficient free space on target filesystem {item['path']}: "
                          f"need {item['requiredBytes']} bytes, have {item['freeBytes']} bytes, "
                          f"short {missing} bytes")
    return report


def _check_local_backup_space(backup_dir: Optional[str], profile: str, required: int) -> dict:
    default = Path.home() / (".local/share/ikpk-production-paired/backups" if profile == "production-paired"
                             else ".local/share/ikpk-initial-prod/backups" if profile == "initial-prod"
                             else ".local/share/ikpk-production-static/backups" if profile == "production-static"
                             else ".local/share/ikpk-rehearsal/staging194/backups")
    path = Path(backup_dir).expanduser() if backup_dir else default
    disk = shutil.disk_usage(_existing_path(path))
    if disk.free < required:
        raise Refusal(f"insufficient free space on off-host backup filesystem ({path}): need {required} bytes, "
                      f"have {disk.free} bytes, short {required - disk.free} bytes")
    return {"label": "off-host backup", "path": str(_existing_path(path)), "freeBytes": disk.free,
            "estimatedBytes": required, "reserveBytes": 0, "requiredBytes": required}


def verify_backup_tar(payload: bytes, expected_sha256: str) -> None:
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        raise Refusal("downloaded backup bytes do not match the host capture digest")
    files: dict[str, bytes] = {}
    directories = set()
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
            for member in archive.getmembers():
                path = Path(member.name)
                if path.is_absolute() or any(part in (".", "..") for part in path.parts):
                    raise Refusal("host backup contains an unsafe path")
                if not (member.isfile() or member.isdir()):
                    raise Refusal("host backup contains a non-regular object")
                name = path.as_posix()
                if name in files or name in directories:
                    raise Refusal("host backup contains duplicate paths")
                if member.isdir():
                    directories.add(name)
                else:
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise Refusal("host backup contains an unreadable member")
                    files[name] = stream.read()
    except tarfile.TarError as error:
        raise Refusal("host backup is not a readable tar archive") from error
    if not {"database.sqlite", "manifest.json", "media-manifest.json"}.issubset(files) or not any(name.startswith("media/") for name in files):
        raise Refusal("host backup is missing its database, media manifest, or media bytes")
    try:
        manifest = json.loads(files["manifest.json"])
        media_bytes = files["media-manifest.json"]
        media_manifest = json.loads(media_bytes)
    except (ValueError, TypeError) as error:
        raise Refusal("host backup manifests are malformed") from error
    media = media_manifest.get("media") if isinstance(media_manifest, dict) else media_manifest
    if not isinstance(media, list) or hashlib.sha256(files["database.sqlite"]).hexdigest() != manifest.get("databaseSha256"):
        raise Refusal("host backup database bytes do not match the captured manifest")
    if hashlib.sha256(media_bytes).hexdigest() != manifest.get("mediaManifestSha256"):
        raise Refusal("host backup media manifest bytes do not match the captured manifest")
    registry = files.get("historical-registry.json")
    registry_sha = manifest.get("historicalRegistrySha256")
    if (registry is not None or registry_sha is not None) and (
            registry is None or hashlib.sha256(registry).hexdigest() != registry_sha):
        raise Refusal("host backup historical registry differs from the captured manifest")
    for item in media:
        if not isinstance(item, dict) or not isinstance(item.get("file"), str):
            raise Refusal("host backup media inventory is malformed")
        name = item["file"]
        path = Path(name)
        if path.is_absolute() or any(part in (".", "..") for part in path.parts):
            raise Refusal("host backup media path is unsafe")
        if name not in files or hashlib.sha256(files[name]).hexdigest() != item.get("sha256"):
            raise Refusal("host backup media bytes do not match the captured inventory")
        if len(files[name]) != item.get("size"):
            raise Refusal("host backup media size does not match the captured inventory")


CMS_CAPTURE_SCHEMA_PATHS = tuple(
    [f"cms/src/api/{name}/content-types/{name}/schema.json" for name in
     ("institute", "course-group", "seminar", "teacher", "article", "schedule-entry",
      "news-item", "promotion", "page", "video-playlist")] +
    ["cms/src/components/shared/seo.json", "cms/src/components/seminar/document-record.json"])
CMS_CAPTURE_MIGRATION_SCHEMA_PATHS = (
    "cms/src/components/seminar/registry-fact.json",
    "cms/src/components/seminar/nmo-fact.json",
)


def production_paired_schema_from_commit(source_sha: str, schema_root: Path) -> str:
    if not SHA.fullmatch(source_sha):
        raise Refusal("old CMS source SHA must be a full lowercase commit ID")
    capture(["git", "cat-file", "-e", f"{source_sha}^{{commit}}"])
    # Older admitted sources lack these component files. Archive only the paths tracked
    # in the bound commit. The capture reader requires referenced component schemas.
    migration_paths = capture(["git", "ls-tree", "--full-tree", "--name-only", source_sha,
                               "--", *CMS_CAPTURE_MIGRATION_SCHEMA_PATHS]).splitlines()
    schema_paths = set(CMS_CAPTURE_SCHEMA_PATHS) | set(migration_paths)
    archive = capture_bytes(["git", "archive", "--format=tar", source_sha, *sorted(schema_paths)])
    schema_root.mkdir(mode=0o700, parents=True, exist_ok=False)
    seen = set()
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as source:
            for member in source.getmembers():
                if member.isdir():
                    continue
                if member.issym() or member.islnk() or not member.isfile() or member.name not in schema_paths:
                    raise Refusal("old CMS source archive has an unexpected schema member")
                if member.name in seen:
                    raise Refusal("old CMS source archive repeats a schema member")
                seen.add(member.name)
                relative = Path(member.name).relative_to("cms/src")
                output = schema_root / relative
                output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                stream = source.extractfile(member)
                if stream is None:
                    raise Refusal("old CMS source schema member is unreadable")
                output.write_bytes(stream.read())
    except tarfile.TarError as error:
        raise Refusal("old CMS source archive is not readable") from error
    if seen != schema_paths:
        raise Refusal("old CMS source commit lacks the exact capture schema contract")
    digest = hashlib.sha256()
    for path in sorted(schema_paths):
        relative = Path(path).relative_to("cms/src").as_posix().encode()
        payload = (schema_root / relative.decode()).read_bytes()
        digest.update(len(relative).to_bytes(4, "big")); digest.update(relative)
        digest.update(bytes.fromhex(hashlib.sha256(payload).hexdigest()))
    for directory in sorted((path for path in schema_root.rglob("*") if path.is_dir()), reverse=True):
        directory.chmod(0o550)
    for schema_file in schema_root.rglob("*.json"):
        schema_file.chmod(0o440)
    schema_root.chmod(0o550)
    return digest.hexdigest()


def production_paired_schema_source(cms_path: str) -> tuple[str, str]:
    match = re.search(r"/releases/([a-f0-9]{40})-[^/]+(?:/|$)", cms_path)
    if not match:
        raise Refusal("journaled old CMS path does not bind a full source commit")
    with tempfile.TemporaryDirectory(prefix="ikpk-old-cms-schema-preflight-") as temporary:
        digest = production_paired_schema_from_commit(match.group(1), Path(temporary) / "schema")
    return match.group(1), digest


def persist_offhost_backup(directory: Path, operation_id: str, source_sha: str, payload: bytes,
                           expected_sha256: str, admission: Optional[dict] = None,
                           old_cms_path: Optional[str] = None,
                           *, old_projector_sha: Optional[str] = None) -> Path:
    verify_backup_tar(payload, expected_sha256)
    target = directory / f"{operation_id}.tar"
    metadata = target.with_suffix(".json")
    schema_metadata = {}
    base = {"operationId": operation_id, "sourceSha": source_sha, "sha256": expected_sha256}
    old = None
    # Persist verified bytes and a minimal binding before schema projection/tsx work.
    # A later local tooling failure must not strand the fenced operation without a copy.
    verify_backup_tar(payload, expected_sha256)
    if target.exists() or metadata.exists():
        if target.is_symlink() or metadata.is_symlink() or not target.is_file() or not metadata.is_file():
            raise Refusal("existing off-host backup path is not a regular file")
        try:
            old = json.loads(metadata.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise Refusal("existing off-host backup metadata is unreadable") from error
        if (not isinstance(old, dict) or hashlib.sha256(target.read_bytes()).hexdigest() != expected_sha256
                or any(old.get(k) != v for k, v in base.items())):
            raise Refusal("existing off-host backup belongs to different bytes or operation")
        if admission is None:
            if old != base:
                raise Refusal("existing backup has production admission and cannot be rewritten for another profile")
            return target
    else:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(target, flags, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(payload); output.flush(); os.fsync(output.fileno())
        fd = os.open(metadata, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(base, output, sort_keys=True); output.write("\n"); output.flush(); os.fsync(output.fileno())
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    if admission is not None:
        schema_sha, schema_digest = production_paired_schema_source(old_cms_path or "")
        if old_projector_sha is None or not SHA.fullmatch(old_projector_sha):
            raise Refusal("verified production backup lacks its independent historical projector source")
        if (type(admission.get("runId")) is not int or admission["runId"] <= 0 or
                type(admission.get("attempt")) is not int or admission["attempt"] <= 0):
            raise Refusal("production backup admission is missing its exact run and attempt")
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
            registry_sha = json.load(archive.extractfile("manifest.json")).get("historicalRegistrySha256")
        if old is not None and old != base:
            if (old.get("oldCmsSourceSha") != schema_sha or old.get("oldCmsSchemaSha256") != schema_digest
                    or any(old.get(key) != admission.get(key) for key in ("runId", "attempt"))
                    or old.get("oldHistoricalRegistrySha256") != registry_sha
                    or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(old.get("snapshotFingerprint")))):
                raise Refusal("existing completed production backup binds different or incomplete recovery evidence")
            if "oldProjectorSourceSha" in old and (
                    old["oldProjectorSourceSha"] != old_projector_sha
                    or old.get("oldProjectorNodeVersion") != production_projector_node_version()
                    or old.get("oldProjectorContractSha256") != production_projector_contract(old_projector_sha, schema_sha)):
                raise Refusal("existing completed production backup binds a different projector or runtime")
            if "oldProjectorSourceSha" not in old and any(key in old for key in (
                    "oldProjectorNodeVersion", "oldProjectorContractSha256", "oldHistoricalRegistrySha256")):
                raise Refusal("existing completed production backup has partial projector evidence")
            return target
        fingerprint = production_paired_backup_fingerprint(payload, source_sha, operation_id,
            admission["runId"], admission["attempt"], schema_sha, schema_digest, projector_sha=old_projector_sha)
        schema_metadata = {"oldCmsSourceSha": schema_sha, "oldCmsSchemaSha256": schema_digest,
                           "oldProjectorSourceSha": old_projector_sha, "oldHistoricalRegistrySha256": registry_sha,
                           "oldProjectorContractSha256": production_projector_contract(old_projector_sha, schema_sha),
                           "oldProjectorNodeVersion": production_projector_node_version(),
                           "snapshotFingerprint": fingerprint}
    metadata_record = {"operationId": operation_id, "sourceSha": source_sha, "sha256": expected_sha256}
    if admission is not None:
        metadata_record.update({"runId": admission["runId"], "attempt": admission["attempt"]})
        metadata_record.update(schema_metadata)
    metadata_payload = json.dumps(metadata_record, sort_keys=True).encode() + b"\n"
    temporary = metadata.with_suffix(".json.new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(metadata_payload); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, metadata)
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    return target


def production_projector_node_version() -> str:
    return subprocess.check_output(["node", "--version"], text=True).strip()


def production_projector_contract(projector_sha: str, schema_sha: str) -> str:
    if not SHA.fullmatch(projector_sha) or not SHA.fullmatch(schema_sha):
        raise Refusal("production projector or schema revision is invalid")
    projector_tree = capture_bytes(["git", "ls-tree", "--full-tree", "-r", projector_sha, "--",
        "web/scripts/capture-content-snapshot.ts", "web/scripts/lib", "web/src/lib", "web/package.json",
        "web/package-lock.json", "web/tsconfig.json", "cms/src/lib/demo193-source-empty-fields.json",
        "scripts/lib/staging193-capture-bundle.mjs", "scripts/lib/server-capture-sqlite.mjs",
        "scripts/lib/seal-staging193-capture.mjs", "fixtures/content-snapshot"])
    schema_tree = capture_bytes(["git", "ls-tree", "--full-tree", "-r", schema_sha, "--",
        *CMS_CAPTURE_SCHEMA_PATHS, *CMS_CAPTURE_MIGRATION_SCHEMA_PATHS])
    if not projector_tree or not schema_tree:
        raise Refusal("production projector or schema contract is unavailable")
    return hashlib.sha256(projector_tree + b"\0" + schema_tree).hexdigest()


REVIEWED_ORDINARY_PROJECTOR_PAIRS = {
    (
        "62744c31283e2c9b31e84512d3b8cfc793e8d5f7",
        "3928819713b00cfbf982186d67ed2e29f47b913c9a9ba019ee0106b7255904b9",
        "cf536b99bc5815a8b5a76f8315f07c60200c0d1d5728960e9a9593b1c113bcf0",
    ),
}


def validate_ordinary_projector_equivalence(original: dict, candidate: dict, *,
                                             old_projector_sha: str, candidate_projector_sha: str,
                                             old_projector_contract_sha256: str,
                                             candidate_projector_contract_sha256: str,
                                             old_schema_sha256: str, candidate_schema_sha256: str) -> None:
    """Permit only a reviewed projector-contract pair with identical full snapshot semantics."""
    pair = (old_projector_sha, old_projector_contract_sha256, candidate_projector_contract_sha256)
    if (not SHA.fullmatch(candidate_projector_sha) or pair not in REVIEWED_ORDINARY_PROJECTOR_PAIRS):
        raise Refusal("ordinary production projector pair has no reviewed equivalence binding")
    if (not re.fullmatch(r"[a-f0-9]{64}", old_schema_sha256)
            or not re.fullmatch(r"[a-f0-9]{64}", candidate_schema_sha256)
            or old_schema_sha256 != candidate_schema_sha256):
        raise Refusal("ordinary production projector schema contract changed")

    def semantic_snapshot(snapshot: dict) -> str:
        if not isinstance(snapshot, dict):
            raise Refusal("ordinary production projection is not an object")
        if (type(snapshot.get("contractVersion")) is not int or snapshot["contractVersion"] not in (1, 2)
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(snapshot.get("fingerprint", "")))
                or not isinstance(snapshot.get("content"), dict)
                or not isinstance(snapshot["content"].get("types"), dict)
                or not isinstance(snapshot["content"].get("media"), list)):
            raise Refusal("ordinary production projection has an invalid content contract")
        if (any(not isinstance(records, list) or any(not isinstance(record, dict) for record in records)
                for records in snapshot["content"]["types"].values())
                or any(not isinstance(media, dict) for media in snapshot["content"]["media"])
                or ("historicalExceptions" in snapshot["content"]
                    and (not isinstance(snapshot["content"]["historicalExceptions"], list)
                         or any(not isinstance(item, dict) for item in snapshot["content"]["historicalExceptions"])) )):
            raise Refusal("ordinary production projection has an invalid public record shape")
        proof = snapshot.get("captureProof")
        if (not isinstance(proof, dict)
                or not re.fullmatch(r"[a-f0-9]{64}", str(proof.get("schemaDigest", "")))
                or type(proof.get("version")) is not int or proof.get("version") != 1
                or proof.get("method") != "quiesced-sqlite-backup"
                or proof.get("sourceSha") != candidate_projector_sha
                or type(proof.get("runId")) is not int or type(proof.get("attempt")) is not int):
            raise Refusal("ordinary production projection is not bound to the verified schema and release")
        if snapshot.get("sourcePolicy") != "production-static" or snapshot.get("sourceAge") != "source-bound":
            raise Refusal("ordinary production projection has an unsupported source policy")
        if not isinstance(snapshot.get("referenceDate"), str):
            raise Refusal("ordinary production projection has no reference date")
        stable = copy.deepcopy(snapshot)
        stable["captureProof"].pop("databaseDigest", None)
        stable["captureProof"].pop("mediaManifestDigest", None)
        stable["captureProof"].pop("bundleDigest", None)
        origin = stable.get("origin")
        if isinstance(origin, dict):
            origin.pop("capturedAt", None)
        try:
            return json.dumps(stable, sort_keys=True, separators=(",", ":"),
                              ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as error:
            raise Refusal("ordinary production projection contains unsupported JSON values") from error

    if semantic_snapshot(original) != semantic_snapshot(candidate):
        raise Refusal("ordinary production projector public projection differs")


def _strict_archive_json(archive: tarfile.TarFile, name: str) -> tuple[dict, bytes]:
    entries = [member for member in archive.getmembers() if member.name == name]
    if len(entries) != 1 or not entries[0].isfile() or entries[0].size > 16 * 1024 * 1024:
        raise Refusal(f"candidate archive has no unique regular {name}")
    stream = archive.extractfile(entries[0])
    if stream is None:
        raise Refusal(f"candidate archive member {name} is unreadable")

    def reject_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    try:
        raw = stream.read()
        value = json.loads(raw, object_pairs_hook=reject_duplicate_keys,
                           parse_constant=lambda item: (_ for _ in ()).throw(ValueError(item)))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise Refusal(f"candidate archive member {name} is invalid JSON") from error
    if not isinstance(value, dict):
        raise Refusal(f"candidate archive member {name} is not an object")
    return value, raw


def _prepare_historical_projector(projector_sha: str, destination: Path) -> dict[str, str]:
    """Materialize only from the exact Git revision and install its locked runtime offline."""
    if not SHA.fullmatch(projector_sha):
        raise Refusal("historical projector source must be an exact commit")
    payload = capture_bytes(["git", "archive", "--format=tar", projector_sha,
                             "cms/src", "fixtures", "scripts/lib", "web"])
    destination.mkdir(mode=0o700)
    roots = ("cms/src", "fixtures", "scripts/lib", "web")
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
            if archive.pax_headers.get("comment") != projector_sha:
                raise Refusal("historical projector archive does not identify the exact Git commit")
            seen = set()
            for member in archive:
                relative = PurePosixPath(member.name)
                name = relative.as_posix()
                if (relative.is_absolute() or ".." in relative.parts or name in seen
                        or not (member.isfile() or member.isdir())
                        or not any(name == root or name.startswith(root + "/")
                                   or (member.isdir() and root.startswith(name + "/")) for root in roots)):
                    raise Refusal("historical projector archive has an unsafe member")
                seen.add(name)
                target = destination / relative
                if member.isdir():
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with target.open("xb") as output:
                    shutil.copyfileobj(archive.extractfile(member), output)
    except (OSError, tarfile.TarError) as error:
        raise Refusal("historical projector archive could not be materialized") from error
    web = destination / "web"
    lock = web / "package-lock.json"
    if not lock.is_file() or not (web / "scripts/capture-content-snapshot.ts").is_file():
        raise Refusal("historical projector lacks its source or dependency lock")
    user_config, global_config = destination / ".npm-user-empty", destination / ".npm-global-empty"
    for config in (user_config, global_config):
        config.touch(exist_ok=False)
    install_env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "CI": "1", "npm_config_cache": str(Path.home() / ".npm"),
        "npm_config_userconfig": str(user_config), "npm_config_globalconfig": str(global_config),
    }
    try:
        result = subprocess.run(["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
                                cwd=web, env=install_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=300, check=False)
    except subprocess.TimeoutExpired as error:
        raise Refusal("historical projector locked dependency installation timed out after 300 seconds") from error
    except OSError as error:
        raise Refusal("historical projector locked dependency installation could not start") from error
    if result.returncode:
        raise Refusal("historical projector requires the exact locked packages in the local offline npm cache")
    if not (web / "node_modules/.bin/tsx").is_file():
        raise Refusal("historical projector cannot start its pinned TS runtime")
    return {"PATH": install_env["PATH"], "ASTRO_TELEMETRY_DISABLED": "1", "CI": "1"}


def production_paired_backup_fingerprint(payload: bytes, source_sha: str, operation_id: str,
                                         run_id: int, attempt: int, old_cms_source_sha: str,
                                         expected_schema_digest: str, *, projector_sha: Optional[str] = None,
                                         projection_output: Optional[Path] = None) -> str:
    """Project the verified pre-migration backup with its exact schema and projector."""
    projector_sha = projector_sha or source_sha
    verify_backup_tar(payload, hashlib.sha256(payload).hexdigest())
    with tempfile.TemporaryDirectory(prefix="ikpk-paired-restore-capture-") as temporary:
        root = Path(temporary) / "capture"
        root.mkdir(mode=0o700)
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
            for member in archive.getmembers():
                relative = Path(member.name)
                if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
                    raise Refusal("verified backup contains an unsafe capture path")
                target = root / relative
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                stream = archive.extractfile(member)
                if stream is None:
                    raise Refusal("verified backup capture member is unreadable")
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open("xb") as output:
                    shutil.copyfileobj(stream, output)
        manifest_file = root / "manifest.json"
        try:
            backup_manifest = json.loads(manifest_file.read_bytes())
            manifest_file.unlink()
        except (OSError, ValueError) as error:
            raise Refusal("verified production backup lacks its capture manifest") from error
        registry_sha = backup_manifest.get("historicalRegistrySha256")
        registry = root / "historical-registry.json"
        schema_root = Path(temporary) / "old-cms-schema"
        schema_digest = production_paired_schema_from_commit(old_cms_source_sha, schema_root)
        if schema_digest != expected_schema_digest:
            raise Refusal("old CMS schema bytes differ from the digest bound to this verified backup")
        workspace = Path(temporary) / "projector"
        environment = _prepare_historical_projector(projector_sha, workspace)
        seal = subprocess.run(["node", "scripts/lib/seal-staging193-capture.mjs", str(root), operation_id, source_sha,
                               str(schema_root), "production-static", str(run_id), str(attempt)],
                              cwd=workspace, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if seal.returncode:
            raise Refusal("historical projector could not seal the verified backup and media")
        snapshot_dir = Path(temporary) / "snapshot"
        environment.update({"CONTENT_SNAPSHOT_DIR": str(snapshot_dir), "CONTENT_CAPTURE_SCHEMA_ROOT": str(schema_root)})
        if registry_sha is not None:
            if not (workspace / "web/scripts/lib/historical-exceptions.ts").is_file():
                raise Refusal("historical projector cannot read the original declared registry")
            environment.update({"CONTENT_HISTORICAL_EXCEPTIONS_FILE": str(registry),
                                "CONTENT_HISTORICAL_EXCEPTIONS_SHA256": registry_sha})
        result = subprocess.run(["web/node_modules/.bin/tsx", "web/scripts/capture-content-snapshot.ts",
                                 "--server-capture", "--profile", "production-static", str(root)],
                                cwd=workspace, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode:
            raise Refusal(f"verified backup CMS content projection failed ({result.returncode}): "
                          f"{result.stderr.decode(errors='replace').strip()}")
        try:
            snapshot = json.loads((snapshot_dir / "snapshot.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise Refusal("verified backup content snapshot was not produced") from error
        fingerprint = snapshot.get("fingerprint") if isinstance(snapshot, dict) else None
        if not isinstance(fingerprint, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", fingerprint):
            raise Refusal("verified backup content snapshot has an invalid fingerprint")
        if projection_output is not None:
            with projection_output.open("x", encoding="utf-8") as output:
                json.dump(snapshot, output)
        return fingerprint


def _static_tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative == "release.json":
            continue
        if path.is_symlink():
            raise Refusal("exported static candidate contains a symlink")
        if path.is_dir():
            continue
        if not path.is_file():
            raise Refusal("exported static candidate contains a non-regular object")
        name = relative.encode()
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update(bytes.fromhex(hashlib.sha256(path.read_bytes()).hexdigest()))
    return digest.hexdigest()


def registration_checker_workspace(source_sha: str, destination: Path) -> Path:
    if not SHA.fullmatch(source_sha):
        raise Refusal("registration checker requires an exact source commit")
    source = capture_bytes(["git", "archive", "--format=tar", source_sha, "--",
                            "web/package.json", "web/package-lock.json", "web/tsconfig.json", "web/scripts", "web/src/lib",
                            "scripts/publication-launcher.mjs"])
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(source), mode="r:") as archive:
        for member in archive.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isdir() or member.isfile()):
                raise Refusal("registration checker source contains an unsupported member")
            if member.isfile():
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                handle = archive.extractfile(member)
                if handle is None:
                    raise Refusal("registration checker source is unreadable")
                target.write_bytes(handle.read())
    web = destination / "web"
    if not (web / "scripts/check-staging194-registration-links.ts").is_file():
        raise Refusal("exact source has no staging194 registration checker")
    return web


def _expected_public_media(types: dict, source_media: list[dict]) -> dict[str, str]:
    from urllib.parse import urlsplit
    inventory = {item["url"]: item["sha256"] for item in source_media}
    if len(inventory) != len(source_media):
        raise Refusal("verified backup media has ambiguous source addresses")
    pattern = re.compile(r"""(?:^|["'])((?:https?://[^/"'\s]+)?/(?:uploads|media)/[A-Za-z0-9._~!$&()*+,;=@%/-]+)""")
    expected = {}

    def collect(value):
        if isinstance(value, str):
            for match in pattern.finditer(value):
                ref = match.group(1)
                if not ref.startswith("/"):
                    parsed = urlsplit(ref)
                    if parsed.scheme != "https" or parsed.netloc != "ikpk.su" or not parsed.path.startswith("/uploads/"):
                        continue
                    ref = parsed.path
                if PurePosixPath(ref).suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp", ".pdf"):
                    continue
                digest = inventory.get(ref)
                if not re.fullmatch(r"[a-f0-9]{64}", str(digest)):
                    raise Refusal("reviewed public result references media missing from its verified source")
                destination = ref if ref.startswith("/media/") else "/media" + ref
                value_hash = "sha256:" + digest
                if destination in expected and expected[destination] != value_hash:
                    raise Refusal("reviewed public media references disagree about verified bytes")
                expected[destination] = value_hash
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)

    collect(types)
    return expected


def _expected_public_history(schedule: list[dict], registry: list[dict]) -> list[dict]:
    events = {event["documentId"]: event for event in schedule}
    pairs = [(entry, events.get(entry.get("documentId"))) for entry in registry]
    applicable = [(entry, event) for entry, event in pairs
                  if event is not None and entry.get("condition") == "paid-zero-price"
                  and event.get("isFree") is False and event.get("price") not in (None, "")
                  and event["price"] == 0 and event.get("publishedAt") == entry.get("publishedAt")
                  and event.get("updatedAt") == entry.get("updatedAt")]
    if not applicable:
        return []
    # The retained registry hashes the exact canonical JSON representation used by the CMS.
    code = """
const {createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const events = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(events.map(event => 'sha256:' + createHash('sha256')
  .update(JSON.stringify({types:{schedule_entries:[canonical(event)]},media:[]})).digest('hex'))));
"""
    result = subprocess.run(["node", "-e", code], input=json.dumps([event for _, event in applicable]).encode(),
                            env={"PATH": os.environ.get("PATH", os.defpath)}, capture_output=True, check=False)
    if result.returncode != 0:
        raise Refusal("cannot independently compare reviewed historical exception fingerprints")
    fingerprints = json.loads(result.stdout)
    return [entry for (entry, _), digest in zip(applicable, fingerprints) if entry.get("recordFingerprint") == digest]


def validate_migrated_public_projection(original: dict, target: dict, reviewed: dict,
                                       source_media: Optional[list[dict]] = None,
                                       registry: Optional[list[dict]] = None) -> None:
    """Reconstruct the v2 public result from the v1 backup and reviewed per-record changes."""
    original_version = original.get("contractVersion", 1)
    if (original_version not in (1, 2) or target.get("contractVersion") != 2
            or not isinstance(reviewed, dict) or reviewed.get("version") != 1):
        raise Refusal("production public projection versions have no reviewed comparison")
    expected = copy.deepcopy(original["content"])
    actual = target["content"]
    expected.pop("historicalExceptions", None)
    if set(expected) != {"types", "media"} or set(actual) - {"historicalExceptions"} != set(expected):
        raise Refusal("production migration changed unreviewed public content properties")
    pairs = reviewed["documentIds"]
    if expected["types"].keys() != pairs.keys() or actual["types"].keys() != pairs.keys():
        raise Refusal("production migration changes the published collection set")
    for kind, records in expected["types"].items():
        ids = {str(record["id"]) for record in records}
        if len(ids) != len(records) or ids != pairs[kind].keys():
            raise Refusal(f"production migration changes published record identities in {kind}")
        for record in records:
            document_id = pairs[kind][str(record["id"])]
            if (not isinstance(document_id, str) or not document_id
                    or (original_version == 2 and record.get("documentId") != document_id)
                    or (original_version == 1 and "documentId" in record)):
                raise Refusal(f"production migration has invalid reviewed document identities in {kind}")
            record["documentId"] = document_id
    if original_version == 1:
        teachers = {}
        for teacher in expected["types"]["teachers"]:
            key = (str(teacher.get("legacy_id")), teacher["name"])
            if key in teachers:
                raise Refusal("production migration cannot unambiguously match the historical teacher identities")
            teachers[key] = teacher["documentId"]
        for record in expected["types"]["seminars"]:
            for ref in record.get("teachers", []):
                ref["documentId"] = teachers[(str(ref.get("legacy_id")), ref["name"])]
        for record in expected["types"]["schedule_entries"]:
            for ref in record.get("teachers", []):
                ref["documentId"] = teachers[(str(ref["id"]), ref["fullName"])]
            if record.get("seminar") is not None:
                record["seminar"]["documentId"] = pairs["seminars"][str(record["seminar"]["id"])]
    permitted = {
        "schedule_entries": ("schedule", {"price", "isFree", "city", "isOnline", "duration"}),
        "seminars": ("seminars", {"duration", "audience", "content_format", "content_section_anchors", "documents_state",
            "documents", "training_registries", "nmo", "description_html", "description_text",
            "full_text_html", "learning_mode", "learning_plan", "recommendations"}),
    }
    for kind, (changes, fields) in permitted.items():
        if reviewed[changes].keys() != pairs[kind].keys():
            raise Refusal(f"reviewed public projection is incomplete for {kind}")
        for record in expected["types"][kind]:
            updates = reviewed[changes][str(record["id"])]
            if updates.keys() - fields:
                raise Refusal(f"reviewed public projection changes unsupported fields in {kind}")
            record.update(updates)
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"))
    for kind in expected["types"]:
        if canonical(expected["types"][kind]) != canonical(actual["types"][kind]):
            raise Refusal(f"production migration public projection differs from reviewed expected content in {kind}")
    if source_media is not None:
        expected_media = _expected_public_media(expected["types"], source_media)
        media = {item["ref"]: item["contentId"] for item in actual["media"]}
        if (len(media) != len(actual["media"]) or media != expected_media
                or any(media.get(item["ref"]) != item["contentId"] for item in original["content"]["media"])):
            raise Refusal("production migration changes public media references outside the reviewed content")
    elif canonical(expected["media"]) != canonical(actual["media"]):
        raise Refusal("production migration changes public media references")
    history = _expected_public_history(expected["types"]["schedule_entries"], registry or [])
    if (history and canonical(actual.get("historicalExceptions")) != canonical(history)
            or not history and "historicalExceptions" in actual):
        raise Refusal("production migration changes the independently approved historical exemptions")


def validate_production_content_acceptance(candidate_archive: bytes, static_digest: str, snapshot_fingerprint: str,
                                           backup_path: Path, backup: dict, operation_id: str, source_sha: str,
                                           admitted_run: dict) -> None:
    if (not isinstance(admitted_run, dict)
            or any(type(admitted_run.get(key)) is not int or admitted_run[key] < 1 for key in ("runId", "attempt"))
            or backup.get("operationId") != operation_id or backup.get("sourceSha") != source_sha
            or any(type(backup.get(key)) is not int or backup[key] != admitted_run[key]
                   for key in ("runId", "attempt"))):
        raise Refusal("production backup sidecar belongs to a different operation or exact release admission")
    try:
        with tarfile.open(fileobj=io.BytesIO(candidate_archive), mode="r:") as archive:
            names = [entry for entry in archive.getmembers() if entry.name == "snapshot/production-migration-proof.json"]
            if len(names) > 1 or (names and (not names[0].isfile() or names[0].size > 16 * 1024 * 1024)):
                raise Refusal("unexpected production migration proof archive member")
            proof = json.load(archive.extractfile(names[0])) if names else None
            if names:
                capture_bytes = archive.extractfile("snapshot/capture-manifest.json").read()
                projected = json.load(archive.extractfile("snapshot/snapshot.json"))
            else:
                candidate_manifest, capture_bytes = _strict_archive_json(archive, "snapshot/capture-manifest.json")
                projected, _ = _strict_archive_json(archive, "snapshot/snapshot.json")
        projector_sha = backup.get("oldProjectorSourceSha", backup.get("sourceSha"))
        schema_sha = backup.get("oldCmsSourceSha")
        if not isinstance(projector_sha, str) or not isinstance(schema_sha, str):
            raise Refusal("production backup does not identify the original projector and CMS schema")
        old_contract = production_projector_contract(projector_sha, schema_sha)
        if backup.get("oldProjectorContractSha256", old_contract) != old_contract:
            raise Refusal("production original projector contract does not match its verified backup")
        if proof is None:
            candidate_contract = production_projector_contract(source_sha, source_sha)
            if old_contract != candidate_contract:
                if (backup.get("oldProjectorContractSha256") is None
                        or backup.get("oldProjectorNodeVersion") != production_projector_node_version()):
                    raise Refusal("ordinary production projector equivalence lacks exact original runtime evidence")
                if backup_path.is_symlink() or not backup_path.is_file():
                    raise Refusal("ordinary production original backup path is unsafe")
                backup_bytes = backup_path.read_bytes()
                verify_backup_tar(backup_bytes, backup["sha256"])
                with tempfile.TemporaryDirectory(prefix="ikpk-ordinary-projector-equivalence-") as directory:
                    original_path = Path(directory) / "original-snapshot.json"
                    candidate_schema_root = Path(directory) / "candidate-schema"
                    original_fingerprint = production_paired_backup_fingerprint(
                        backup_bytes, source_sha, operation_id, backup["runId"], backup["attempt"],
                        schema_sha, backup["oldCmsSchemaSha256"], projector_sha=projector_sha,
                        projection_output=original_path)
                    if original_fingerprint != backup.get("snapshotFingerprint"):
                        raise Refusal("production historical public projection differs from the verified backup")
                    original = json.loads(original_path.read_bytes())
                    actual_candidate_schema = production_paired_schema_from_commit(source_sha, candidate_schema_root)
                    original_proof = original.get("captureProof") if isinstance(original, dict) else None
                    if (not isinstance(original_proof, dict)
                            or type(original_proof.get("version")) is not int or original_proof.get("version") != 1
                            or original_proof.get("method") != "quiesced-sqlite-backup"
                            or original_proof.get("captureId") != operation_id
                            or original_proof.get("sourceSha") != source_sha
                            or type(original_proof.get("runId")) is not int
                            or original_proof.get("runId") != admitted_run["runId"]
                            or type(original_proof.get("attempt")) is not int
                            or original_proof.get("attempt") != admitted_run["attempt"]
                            or not re.fullmatch(r"[a-f0-9]{64}", str(original_proof.get("schemaDigest", "")))):
                        raise Refusal("original production projection is not bound to the verified backup and release")
                capture = candidate_manifest
                if (capture.get("operationId") != operation_id or capture.get("sourceSha") != source_sha
                        or capture.get("profile") != "production-static"
                        or any(type(capture.get(key)) is not int or capture.get(key) != admitted_run[key]
                               for key in ("runId", "attempt"))
                        or not re.fullmatch(r"[a-f0-9]{64}", str(capture.get("databaseSha256", "")))
                        or not re.fullmatch(r"[a-f0-9]{64}", str(capture.get("mediaManifestSha256", "")))
                        or actual_candidate_schema != backup.get("oldCmsSchemaSha256")):
                    raise Refusal("ordinary production candidate capture is not bound to the exact release and schema")
                candidate_proof = projected.get("captureProof") if isinstance(projected, dict) else None
                if (not isinstance(candidate_proof, dict)
                        or type(candidate_proof.get("version")) is not int
                        or candidate_proof.get("version") != 1
                        or candidate_proof.get("method") != "quiesced-sqlite-backup"
                        or candidate_proof.get("captureId") != operation_id
                        or candidate_proof.get("databaseDigest") != capture["databaseSha256"]
                        or candidate_proof.get("mediaManifestDigest") != capture["mediaManifestSha256"]
                        or candidate_proof.get("schemaDigest") != capture.get("schemaDigest")
                        or candidate_proof.get("bundleDigest") != hashlib.sha256(capture_bytes).hexdigest()
                        or candidate_proof.get("sourceSha") != source_sha
                        or type(candidate_proof.get("runId")) is not int
                        or candidate_proof.get("runId") != admitted_run["runId"]
                        or type(candidate_proof.get("attempt")) is not int
                        or candidate_proof.get("attempt") != admitted_run["attempt"]):
                    raise Refusal("ordinary production candidate projection differs from its browser-checked capture")
                validate_ordinary_projector_equivalence(
                    original, projected,
                    old_projector_sha=projector_sha,
                    candidate_projector_sha=source_sha,
                    old_projector_contract_sha256=old_contract,
                    candidate_projector_contract_sha256=candidate_contract,
                    old_schema_sha256=backup["oldCmsSchemaSha256"],
                    candidate_schema_sha256=actual_candidate_schema,
                )
                if (original_fingerprint != snapshot_fingerprint
                        or projected.get("fingerprint") != snapshot_fingerprint):
                    raise Refusal("ordinary production browser fingerprint differs from the reviewed projections")
            elif snapshot_fingerprint != backup.get("snapshotFingerprint"):
                raise Refusal("built production snapshot differs from the fingerprint captured in the verified backup")
            return
        capture = json.loads(capture_bytes)
        if (not isinstance(proof, dict) or proof.get("version") != 1 or proof.get("operationId") != operation_id
                or proof.get("sourceSha") != source_sha or proof.get("staticTreeSha256") != static_digest
                or proof.get("captureSha256") != hashlib.sha256(capture_bytes).hexdigest()
                or any(proof.get(key) != admitted_run.get(key) for key in ("runId", "attempt"))):
            raise Refusal("production migration proof differs from browser-checked candidate and release admission")
        if any(not re.fullmatch(r"[a-f0-9]{64}", str(proof.get(key))) for key in (
                "receiptSha256", "registrySha256", "migrationPlanDigest")):
            raise Refusal("production migration proof has malformed evidence digests")
        composition = proof.get("composition")
        if not isinstance(composition, dict) or composition.get("backupArchiveSha256") != backup.get("sha256"):
            raise Refusal("production migration proof belongs to another verified backup")
        target = composition.get("targetProjection")
        if (not isinstance(target, dict) or target.get("fingerprint") != snapshot_fingerprint
                or target.get("captureSha256") != proof["captureSha256"]
                or target.get("databaseSha256") != capture.get("databaseSha256")
                or target.get("schemaDigest") != capture.get("schemaDigest")
                or target.get("mediaManifestSha256") != capture.get("mediaManifestSha256")
                or target.get("contentSha256") != hashlib.sha256(json.dumps(
                    projected.get("content"), sort_keys=True, separators=(",", ":")).encode()).hexdigest()):
            raise Refusal("production migration target projection differs from the accepted candidate")
        if backup_path.is_symlink():
            raise Refusal("production migration off-host backup is unsafe")
        backup_bytes = backup_path.read_bytes()
        verify_backup_tar(backup_bytes, backup["sha256"])
        with tarfile.open(fileobj=io.BytesIO(backup_bytes), mode="r:") as archive:
            source = json.load(archive.extractfile("manifest.json"))
            source_media_document = json.load(archive.extractfile("media-manifest.json"))
        source_media = (source_media_document.get("media") if isinstance(source_media_document, dict)
                        else source_media_document)
        if (source.get("operationId") != operation_id
                or source.get("databaseSha256") != composition.get("backupDatabaseSha256")
                or source.get("mediaManifestSha256") != composition.get("backupMediaManifestSha256")):
            raise Refusal("production migration proof does not bind the verified source database and media")
        if (not isinstance(composition.get("publicProjection"), dict)
                or backup.get("oldProjectorNodeVersion") != production_projector_node_version()):
            raise Refusal("production migration has no complete independent public comparison")
        with tempfile.TemporaryDirectory(prefix="ikpk-original-public-projection-") as directory:
            original = Path(directory) / "snapshot.json"
            fingerprint = production_paired_backup_fingerprint(
                backup_bytes, source_sha, operation_id, backup["runId"], backup["attempt"],
                schema_sha, backup["oldCmsSchemaSha256"], projector_sha=projector_sha,
                projection_output=original)
            if fingerprint != backup.get("snapshotFingerprint"):
                raise Refusal("production historical public projection differs from the verified backup")
            approved_registry = base64.b64decode(composition["targetRegistryBase64"], validate=True)
            if hashlib.sha256(approved_registry).hexdigest() != proof["registrySha256"]:
                raise Refusal("production target registry bytes differ from the reviewed cohort")
            registry = json.loads(approved_registry)
            if not isinstance(registry, list) or not isinstance(source_media, list):
                raise Refusal("production source media or target registry has an invalid shape")
            validate_migrated_public_projection(json.loads(original.read_bytes()), projected,
                                                composition["publicProjection"], source_media, registry)
    except (OSError, ValueError, tarfile.TarError, AttributeError, KeyError) as error:
        raise Refusal("production content acceptance evidence is unreadable") from error


def browser_check(source_sha: str, operation_id: str, static_digest: str, archive: bytes,
                  profile: str = "staging194", admitted_run: Optional[dict] = None,
                  chat_loader_src: Optional[str] = None,
                  registration_links: bool = False) -> Optional[str]:
    executable = ROOT / "web/node_modules/.bin/playwright"
    if not executable.is_file():
        raise Refusal("local Playwright dependencies are missing; browser acceptance was not run")
    with tempfile.TemporaryDirectory(prefix="ikpk-staging193-static-") as temporary:
        root = Path(temporary)
        static_root = root / "static"
        snapshot_root = root / "snapshot"
        static_root.mkdir()
        snapshot_root.mkdir()
        try:
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
                for member in bundle.getmembers():
                    name = Path(member.name)
                    normalized = member.name.rstrip("/")
                    if name.is_absolute() or normalized != name.as_posix() or any(part in ("", ".", "..") for part in normalized.split("/")):
                        raise Refusal("static candidate archive contains an unsafe path")
                    if not (member.isfile() or member.isdir()):
                        raise Refusal("static candidate archive contains a non-regular object")
                    if member.isdir():
                        continue
                    stream = bundle.extractfile(member)
                    if stream is None:
                        raise Refusal("candidate export contains an unreadable file")
                    if normalized.startswith("static/"):
                        relative = Path(normalized.removeprefix("static/"))
                        target_root = static_root
                    elif normalized in ("snapshot/snapshot.json", "snapshot/capture-manifest.json") or (
                            profile == "production-paired" and normalized == "snapshot/production-migration-proof.json"):
                        relative = Path(normalized).relative_to("snapshot")
                        target_root = snapshot_root
                    else:
                        raise Refusal("candidate export contains an unexpected member")
                    target = target_root / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(stream.read())
        except tarfile.TarError as error:
            raise Refusal("static candidate export is not a readable tar archive") from error
        if _static_tree_sha256(static_root) != static_digest:
            raise Refusal("off-host static candidate bytes do not match the admitted tree digest")
        try:
            release = json.loads((static_root / "release.json").read_text(encoding="utf-8"))
            snapshot = json.loads((snapshot_root / "snapshot.json").read_text(encoding="utf-8"))
            capture_bytes = (snapshot_root / "capture-manifest.json").read_bytes()
            capture = json.loads(capture_bytes)
        except (OSError, ValueError) as error:
            raise Refusal("off-host candidate release or snapshot declaration is unreadable") from error
        if (release.get("commit") != source_sha or release.get("operationId") != operation_id or
                release.get("staticTreeSha256") != static_digest):
            raise Refusal("off-host static candidate release declaration does not match the admitted bytes")
        proof = snapshot.get("captureProof") if isinstance(snapshot, dict) else None
        snapshot_fingerprint = snapshot.get("fingerprint") if isinstance(snapshot, dict) else None
        if profile == "production-paired" and (not isinstance(snapshot_fingerprint, str) or
                                                 not re.fullmatch(r"sha256:[a-f0-9]{64}", snapshot_fingerprint)):
            raise Refusal("off-host candidate snapshot fingerprint is malformed")
        bundle_digest = hashlib.sha256(capture_bytes).hexdigest()
        reused_capture = release.get("reusedCapture")
        same_capture_operation = (capture.get("operationId") == operation_id
                                  and capture.get("sourceSha") == source_sha)
        if profile in ("initial-prod", "production-static", "production-paired"):
            capture_reference_matches = same_capture_operation and "reusedCapture" not in release
        elif same_capture_operation:
            capture_reference_matches = "reusedCapture" not in release
        else:
            capture_reference_matches = (isinstance(reused_capture, dict)
                and set(reused_capture) == {"operationId", "sourceSha", "bundleDigest"}
                and reused_capture.get("operationId") == capture.get("operationId")
                and reused_capture.get("sourceSha") == capture.get("sourceSha")
                and reused_capture.get("bundleDigest") == bundle_digest)
        if profile in ("initial-prod", "production-static", "production-paired"):
            proof_matches = (isinstance(proof, dict)
                and snapshot.get("sourcePolicy") == ("initial-production" if profile == "initial-prod" else "production-static")
                and snapshot.get("sourceAge") == "source-bound"
                and snapshot.get("origin", {}).get("sourceId") == "initial-prod-server-db"
                and proof.get("targetHost") == INITIAL_PROD_HOST and proof.get("siteUrl") == "https://ikpk.su"
                and proof.get("sourceSha") == source_sha and isinstance(proof.get("runId"), int)
                and isinstance(proof.get("attempt"), int)
                and proof.get("captureId") == (INITIAL_PROD_OPERATION_ID if profile == "initial-prod" else operation_id)
                and capture.get("profile") == ("production-static" if profile == "production-paired" else profile)
                and capture.get("host") == INITIAL_PROD_HOST
                and capture.get("siteUrl") == "https://ikpk.su" and capture.get("sourceSha") == source_sha
                and capture.get("runId") == proof.get("runId") and capture.get("attempt") == proof.get("attempt"))
            if admitted_run is not None:
                proof_matches = proof_matches and proof.get("runId") == admitted_run.get("runId") and proof.get("attempt") == admitted_run.get("attempt")
        else:
            proof_matches = (isinstance(proof, dict) and snapshot.get("sourcePolicy") == "demo-publication-only"
                and snapshot.get("sourceAge") == "untracked"
                and snapshot.get("origin", {}).get("sourceId") == "demo193-cms"
                and proof.get("captureId") == capture.get("operationId") and capture.get("sourceId") == "demo193-cms")
        if (not proof_matches or not capture_reference_matches or snapshot.get("snapshotId") != release.get("snapshotId")
                or snapshot.get("origin", {}).get("kind") != "server-db"
                or proof.get("captureId") != capture.get("operationId")
                or proof.get("schemaDigest") != capture.get("schemaDigest")
                or proof.get("databaseDigest") != capture.get("databaseSha256")
                or proof.get("mediaManifestDigest") != capture.get("mediaManifestSha256")
                or proof.get("bundleDigest") != bundle_digest):
            raise Refusal("off-host candidate snapshot is not the sealed CMS capture for this release")

        if registration_links:
            try:
                registration_proof = json.loads((static_root / ".ikpk-registration-proof.json").read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise Refusal("paired staging194 registration proof is unreadable") from error
            if profile != "staging194" or chat_loader_src or not isinstance(registration_proof, dict):
                raise Refusal("paired staging194 registration proof is missing")
            snapshot_sha = registration_proof.get("snapshotFileSha256")
            build_now = registration_proof.get("buildNow")
            if (not isinstance(build_now, str)
                    or snapshot_sha != hashlib.sha256((snapshot_root / "snapshot.json").read_bytes()).hexdigest()):
                raise Refusal("paired staging194 registration snapshot differs from the candidate")
            checker_web = registration_checker_workspace(source_sha, root / "checker")
            checker_env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR") if key in os.environ}
            installed = subprocess.run(["npm", "ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
                                       cwd=checker_web, env=checker_env, capture_output=True, text=True, check=False)
            checker = checker_web / "node_modules/.bin/tsx"
            if installed.returncode or not checker.is_file():
                raise Refusal("exact-source registration acceptance dependencies are unavailable")
            check = subprocess.run([str(checker), "scripts/check-staging194-registration-links.ts", "check",
                                    str(static_root), str(snapshot_root), snapshot_sha, build_now],
                                   cwd=checker_web, env=checker_env, capture_output=True, text=True, check=False)
            if check.returncode:
                raise Refusal(f"candidate registration CTA check failed: {check.stderr.strip()}")
            if _static_tree_sha256(static_root) != static_digest:
                raise Refusal("candidate tree changed during registration acceptance")

        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, _format, *_args):
                pass

        handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(static_root), **kwargs)
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            production_environment = {"DEPLOY_MODE": "prod", "PAYMENT_ROLE": "prod",
                                      "PAYMENT_ENDPOINT_PROD": "https://ikpk.su/api",
                                      "CHAT_LOADER_SRC": INITIAL_PROD_CHAT_LOADER_SRC}
            if profile == "initial-prod":
                production_environment.update({"INITIAL_PROD_PROFILE": "1",
                                               "PUBLICATION_INITIAL_PRODUCTION_CAPTURE": "1"})
            elif profile in ("production-static", "production-paired"):
                production_environment.update({"PUBLICATION_PRODUCTION_STATIC_CAPTURE": "1"})
            environment = {**os.environ, **(production_environment
                                              if profile in ("initial-prod", "production-static", "production-paired") else {"PUBLICATION_STAGING_CAPTURE": "1",
                                               "DEPLOY_MODE": "stand", "PAYMENT_ROLE": "ci", "DEMO_FORMS": "stub",
                                               "CHAT_LOADER_SRC": chat_loader_src or "none",
                                               "CHAT_OFFLINE_MESSAGE": "absent"}),
                           "CONTENT_SNAPSHOT_DIR": str(snapshot_root), "PUBLICATION_TREE_DIR": str(static_root),
                           "PUBLICATION_BASE_URL": f"http://127.0.0.1:{server.server_address[1]}",
                           "PUBLICATION_COMMIT": source_sha, "PUBLICATION_SNAPSHOT_ID": release["snapshotId"],
                           "PUBLICATION_STATIC_TREE_SHA256": static_digest,
                           "CI": "1"}
            if profile in ("initial-prod", "production-static", "production-paired"):
                environment.pop("CHAT_OFFLINE_MESSAGE", None)
                if (not admitted_run or type(admitted_run.get("runId")) is not int or admitted_run["runId"] <= 0
                        or type(admitted_run.get("attempt")) is not int or admitted_run["attempt"] <= 0):
                    raise Refusal("initial production browser proof requires the exact admitted run and attempt")
                environment.update({"PUBLICATION_RUN_ID": str(admitted_run["runId"]),
                                    "PUBLICATION_ATTEMPT": str(admitted_run["attempt"])})
            environment.pop("PUBLICATION_STAGING194_REGISTRATION_LINKS", None)
            if registration_links:
                environment["PUBLICATION_STAGING194_REGISTRATION_LINKS"] = "1"
            for key in ("SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "IKPK_DEPLOY_KEY"):
                environment.pop(key, None)
            result = subprocess.run([str(executable), "test", "tests/publication-smoke.spec.ts",
                                     "tests/publication-catalog.spec.ts", "tests/publication-content.spec.ts",
                                     "tests/publication-schedule.spec.ts", "tests/publication-widgets.spec.ts",
                                     "--config", "playwright.publication.config.ts",
                                     "--project=desktop", "--project=mobile", "--reporter=line"],
                                    cwd=ROOT / "web", env=environment, check=False)
            if result.returncode:
                raise Refusal(f"candidate publication browser checks failed with exit {result.returncode}")
            return snapshot_fingerprint if isinstance(snapshot_fingerprint, str) else None
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def invoke(args: argparse.Namespace, *, admission: Optional[dict] = None) -> Optional[dict]:
    profile = getattr(args, "profile", "staging194")
    install_host_helper = getattr(args, "install_host_helper", False)
    if install_host_helper and (profile != "staging194" or args.command not in ("static-main", "cms-update")):
        raise Refusal("--install-host-helper is restricted to staging194 static-main or cms-update")
    accept_expired_rollback = getattr(args, "accept_expired_rollback", False)
    if accept_expired_rollback and (profile != "staging194" or args.command != "static-main-recover"
                                    or getattr(args, "rollback_committed", False)):
        raise Refusal("expired rollback acceptance is restricted to staging194 and cannot roll back")
    preflight_kind = getattr(args, "preflight_for", None) if args.command == "space-preflight" else args.command
    target_host = INITIAL_PROD_HOST if profile in ("initial-prod", "production-static", "production-paired") else TARGET_HOST
    if profile == "production-static" and not (args.command in ("static-main", "static-main-recover")
                                                or args.command == "space-preflight" and preflight_kind == "static-main"):
        raise Refusal("production-static permits only static-main publication and recovery")
    if profile == "production-paired" and not (args.command in ("cms-update", "static-publish", "recover")
                                                or args.command == "space-preflight"
                                                and preflight_kind in ("cms-update", "static-main")):
        raise Refusal("production-paired permits only paired CMS update, static publish, and recovery")
    if (args.command in ("static-main", "static-main-recover")
            and profile not in ("staging194", "production-static")):
        raise Refusal("static-main commands are bound to the staging194 profile or authorized production-static profile")
    if (args.command == "space-preflight" and preflight_kind == "static-main"
            and profile not in ("staging194", "production-static", "production-paired")):
        raise Refusal("static-main commands are bound to the staging194 profile or authorized production-static profile")
    if getattr(args, "release_tag", None) is not None and (profile != "production-static" or args.command != "static-main"):
        raise Refusal("--release-tag is restricted to production-static static-main")
    expected_installed_cms_sha = getattr(args, "expected_installed_cms_sha", None)
    if expected_installed_cms_sha is not None:
        if profile != "staging194" or args.command != "static-main":
            raise Refusal("--expected-installed-cms-sha is restricted to staging194 static-main")
        if not isinstance(expected_installed_cms_sha, str) or not SHA.fullmatch(expected_installed_cms_sha):
            raise Refusal("--expected-installed-cms-sha must be a full lowercase commit ID")
    if args.host is not None and args.host != target_host:
        raise Refusal(f"this command is bound to the authorized {profile} host")
    if profile == "initial-prod" and (args.operation_id != INITIAL_PROD_OPERATION_ID or args.command == "recover"):
        raise Refusal("initial-prod permits only its fixed operation ID and has no DB restore command")
    if not OP.fullmatch(args.operation_id):
        raise Refusal("operation ID has invalid characters")
    review_payload = None
    if args.command == "cms-update":
        review_payload = migration_review_payload(getattr(args, "migration_review", None),
            getattr(args, "migration_review_sha256", None), getattr(args, "source_sha", None), args.operation_id)
    automatic_static_capacity = profile == "production-static" and args.command == "static-main"
    helper_install_capacity = install_host_helper and profile == "staging194"
    if args.command == "space-preflight" or automatic_static_capacity or helper_install_capacity:
        if preflight_kind not in ("cms-update", "static-main"):
            raise Refusal("space-preflight requires --for cms-update or --for static-main")
        static_local_export_estimate = (profile == "production-static" and preflight_kind == "static-main")
        if static_local_export_estimate:
            target_space = _check_target_space(profile, args.operation_id, preflight_kind)
            export_estimate = target_space.get("staticExportEstimateBytes")
            if type(export_estimate) is not int or export_estimate < 0:
                raise Refusal("target preflight omitted a valid static export estimate")
            local_space = _check_local_space(getattr(args, "source_sha", None), profile, preflight_kind,
                getattr(args, "backup_dir", None), static_export_estimate_bytes=export_estimate)
        else:
            target_space = _check_target_space(profile, args.operation_id, preflight_kind)
            backup_required = None
            if preflight_kind == "cms-update" and type(target_space.get("backupBytes")) is int:
                backup_required = target_space["backupBytes"] + target_space.get("backupReserveBytes", 0)
            if backup_required is None:
                local_space = _check_local_space(getattr(args, "source_sha", None), profile, preflight_kind,
                                                 getattr(args, "backup_dir", None))
            else:
                local_space = _check_local_space(getattr(args, "source_sha", None), profile, preflight_kind,
                    getattr(args, "backup_dir", None), backup_required_bytes=backup_required)
        if args.command == "space-preflight":
            return {"operationId": args.operation_id, "operationKind": preflight_kind,
                    "localFilesystems": local_space, "target": target_space}
    paired_old_cms = None
    if profile == "production-paired" and args.command == "cms-update":
        preflight = parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id], profile=profile))
        old_pair = preflight.get("oldPair")
        if not isinstance(old_pair, dict) or not isinstance(old_pair.get("cmsPath"), str):
            raise Refusal("read-only production preflight did not identify the old CMS release")
        static_projector = old_pair.get("staticProjector")
        if (not isinstance(static_projector, dict) or not SHA.fullmatch(str(static_projector.get("sourceSha")))
                or not re.fullmatch(r"snap:[a-f0-9]{64}", str(static_projector.get("snapshotId")))
                or not re.fullmatch(r"[a-f0-9]{64}", str(static_projector.get("releaseMetadataSha256")))
                or "historicalRegistryManifest" not in old_pair):
            raise Refusal("production preflight lacks the old static projector source or registry baseline")
        old_projector_sha = static_projector["sourceSha"]
        paired_old_cms = (old_pair["cmsPath"], *production_paired_schema_source(old_pair["cmsPath"]))
        if not (ROOT / "web/node_modules/.bin/tsx").is_file():
            raise Refusal("local content snapshot tooling is unavailable before production fence")
        with tempfile.TemporaryDirectory(prefix="ikpk-historical-projector-preflight-") as local_probe:
            _prepare_historical_projector(old_projector_sha, Path(local_probe) / "projector")
    if args.command == "cms-update":
        provenance = (validate_production_paired_admission(args.source_sha) if profile == "production-paired"
                      else validate_sha_and_ci(args.source_sha, profile))
        ci_admission = dict(provenance)
        seminar_proof = None
        proof_path, proof_digest = getattr(args, "seminar_proof_artifact", None), getattr(args, "seminar_proof_sha256", None)
        if proof_path is not None or proof_digest is not None:
            if profile not in ("staging194", "production-paired"):
                raise Refusal("reviewed migration is supported only for paired staging194 or production admission")
            if not proof_path or not proof_digest:
                raise Refusal("seminar proof requires both archive and independent SHA-256")
            seminar_proof = admit_seminar_proof(proof_path, proof_digest, args.source_sha, provenance)
        if review_payload is not None and seminar_proof is None:
            raise Refusal("reviewed migration requires the admitted seminar proof archive")
        cms_artifact = (fetch_cms_candidate_artifact(provenance, args.source_sha)
                        if profile in ("staging194", "production-paired") else None)
        helper_payload = None
        helper_identity = None
        resume_phase = None
        if install_host_helper:
            # A read-only status check makes an interrupted same-ID continuation
            # reuse the installed helper rather than replacing it on resume.
            try:
                status = parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id], profile=profile))
            except Refusal as error:
                if str(error) not in FRESH_OPERATION_STATUS_ERRORS:
                    raise
                # The previous verified helper reports this exact refusal for a
                # genuinely new ID. The replacement installer rechecks the
                # journal and markers under both host locks before any writes.
                resume_phase = "idle"
            else:
                if status.get("operationId") != args.operation_id:
                    raise Refusal("host status does not match the requested operation ID")
                resume_phase = status.get("phase")
            helper_payload = fetch_host_helper_artifact(provenance, args.source_sha)
            helper_evidence = provenance.get("hostHelperArtifact")
            if not isinstance(helper_evidence, dict):
                raise Refusal("verified host helper artifact omitted its operation evidence")
            if cms_artifact is not None and (helper_evidence.get("runId"), helper_evidence.get("attempt")) != (
                    provenance.get("runId"), provenance.get("attempt")):
                raise Refusal("host helper artifact is not bound to the exact admitted Tests run and attempt")
            helper_identity = _host_helper_runtime_identity(helper_payload)
            provenance["hostHelperRuntimeIdentity"] = helper_identity
            if resume_phase == "idle":
                install_staging194_host_helper(helper_payload, helper_evidence["payloadSha256"], args.operation_id)
            elif resume_phase not in ("acquiring", "fenced", "cms-activated"):
                raise Refusal(f"same-ID CMS continuation is not available from host phase {resume_phase!r}")
        archive, digest = (make_archive(args.source_sha, provenance, cms_artifact=cms_artifact, **({"seminar_proof": seminar_proof} if seminar_proof is not None else {}))
                           if cms_artifact is not None else make_archive(args.source_sha, provenance))
        provenance_b64 = base64.b64encode(json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode()).decode("ascii")
        common = ["cms-update", "--operation-id", args.operation_id, "--source-sha", args.source_sha,
                  "--provenance-b64", provenance_b64]
        if helper_identity is not None:
            common.extend(["--expected-host-helper-identity", helper_identity])
        first = parse_host_json(ssh_remote(common + ["--archive-sha256", hashlib.sha256(archive).hexdigest()], profile=profile,
                                           input_bytes=archive))
        backup_dir = backup_root(args.backup_dir, profile)
        if first.get("offhostBackupRequired"):
            remote_backup = ssh_remote(["export-backup", "--operation-id", args.operation_id], profile=profile)
            old_cms_path = None
            if profile == "production-paired":
                status = parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id], profile=profile))
                fenced_old_pair = status.get("oldPair") or {}
                old_cms_path = fenced_old_pair.get("cmsPath")
                if not paired_old_cms or old_cms_path != paired_old_cms[0]:
                    raise Refusal("journaled old CMS release changed after read-only preflight")
                if (fenced_old_pair.get("staticPath") != old_pair["staticPath"]
                        or fenced_old_pair.get("staticProjector") != static_projector
                        or "historicalRegistryManifest" not in fenced_old_pair
                        or fenced_old_pair["historicalRegistryManifest"] != old_pair["historicalRegistryManifest"]):
                    raise Refusal("journaled old static projector or registry changed after read-only preflight")
            if profile == "production-paired":
                backup_path = persist_offhost_backup(backup_dir, args.operation_id, args.source_sha,
                    remote_backup, first.get("backupSha256", ""), provenance, old_cms_path,
                    old_projector_sha=old_projector_sha)
            else:
                backup_path = persist_offhost_backup(backup_dir, args.operation_id, args.source_sha,
                    remote_backup, first.get("backupSha256", ""))
            digest = hashlib.sha256(backup_path.read_bytes()).hexdigest()
            if profile == "production-paired":
                metadata_record = json.loads(backup_path.with_suffix(".json").read_text(encoding="utf-8"))
                old_registry = fenced_old_pair.get("historicalRegistryManifest")
                if ("historicalRegistryManifest" in fenced_old_pair
                        and metadata_record.get("oldHistoricalRegistrySha256") != (old_registry or {}).get("registrySha256")):
                    raise Refusal("production backup registry differs from the fenced old pair")
                if (metadata_record.get("oldCmsSourceSha") != paired_old_cms[1] or
                        metadata_record.get("oldCmsSchemaSha256") != paired_old_cms[2] or
                        not isinstance(metadata_record.get("snapshotFingerprint"), str)):
                    raise Refusal("verified production backup does not bind the preflight old CMS schema and fingerprint")
            if first.get("phase") == "cms-activated":
                return
            if profile == "production-paired":
                current_admission = validate_production_paired_admission(args.source_sha)
                if current_admission != ci_admission:
                    raise Refusal("production Release/main/CI admission changed before CMS activation; operation remains fenced for same-ID recovery")
            elif profile == "staging194":
                current_admission = validate_sha_and_ci(args.source_sha, profile)
                if current_admission != ci_admission:
                    raise Refusal("staging194 exact-SHA workflow proofs changed before CMS activation; operation remains fenced for same-ID recovery")
            resume_args = common + ["--offhost-sha256", digest]
            if review_payload is not None:
                resume_args += ["--migration-review-sha256", hashlib.sha256(review_payload).hexdigest()]
                completed = parse_host_json(ssh_remote(resume_args, profile=profile, input_bytes=review_payload))
            else:
                completed = parse_host_json(ssh_remote(resume_args, profile=profile))
            if completed.get("migrationPaused") is True:
                print(json.dumps(migration_pause_summary(completed), sort_keys=True))
                return completed
            if completed.get("phase") != "cms-activated":
                raise Refusal(f"CMS command ended in an unexpected state: {completed.get('phase')}")
        elif first.get("phase") != "cms-activated":
            raise Refusal("host did not request backup export or confirm CMS activation")
    elif args.command == "static-publish":
        common = ["static-publish", "--operation-id", args.operation_id, "--source-sha", args.source_sha]
        if profile == "production-paired":
            status = parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id], profile=profile))
            if status.get("sourceSha") != args.source_sha:
                raise Refusal("production operation journal source SHA differs from the requested finalization")
            if status.get("phase") == "committed":
                finalized = parse_host_json(ssh_remote(common, profile=profile))
                if finalized.get("phase") != "committed":
                    raise Refusal("committed production pair could not finish reopening writers")
                return
        admitted_run = (validate_production_paired_admission(args.source_sha) if profile == "production-paired"
                        else validate_sha_and_ci(args.source_sha, profile))
        prepared = parse_host_json(ssh_remote(common, profile=profile))
        if prepared.get("phase") == "committed":
            return
        if prepared.get("phase") != "browser-check-required":
            raise Refusal(f"static candidate is not ready for browser acceptance: {prepared.get('phase')}")
        digest = prepared.get("staticTreeSha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise Refusal("host returned an invalid static candidate digest")
        candidate_bytes = ssh_remote(["export-static", "--operation-id", args.operation_id,
                                      "--source-sha", args.source_sha], profile=profile)
        if profile == "staging194":
            snapshot_fingerprint = browser_check(args.source_sha, args.operation_id, digest, candidate_bytes, profile,
                                                 admitted_run, registration_links=True)
        else:
            snapshot_fingerprint = browser_check(args.source_sha, args.operation_id, digest, candidate_bytes, profile, admitted_run)
        if profile == "production-paired":
            backup_dir = backup_root(args.backup_dir, profile)
            metadata_path = backup_dir / f"{args.operation_id}.json"
            try:
                backup_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise Refusal("production backup provenance sidecar is unavailable before static acceptance") from error
            validate_production_content_acceptance(candidate_bytes, digest, snapshot_fingerprint,
                backup_dir / f"{args.operation_id}.tar", backup_metadata, args.operation_id, args.source_sha, admitted_run)
        current_run = (validate_production_paired_admission(args.source_sha) if profile == "production-paired"
                       else validate_sha_and_ci(args.source_sha, profile))
        if profile == "staging194" and current_run != admitted_run:
            raise Refusal("canonical main source or exact-SHA workflow proofs changed during acceptance")
        if profile != "staging194" and (current_run.get("runId"), current_run.get("attempt")) != (admitted_run.get("runId"), admitted_run.get("attempt")):
            raise Refusal("canonical exact-SHA run/attempt changed during the acceptance window")
        committed = parse_host_json(ssh_remote(common + ["--browser-digest", digest], profile=profile))
        if committed.get("phase") != "committed":
            raise Refusal(f"static publication did not reach durable commit: {committed.get('phase')}")
    elif args.command == "static-main":
        release_tag = getattr(args, "release_tag", None)
        if admission is not None:
            release_evidence = admission.get("release") if isinstance(admission, dict) else None
            if (profile != "production-static" or release_tag is None
                    or not isinstance(release_evidence, dict)
                    or admission.get("sourceSha") != args.source_sha
                    or not admission.get("historicalRelease")
                    or release_evidence.get("tag") != release_tag):
                raise Refusal("in-memory static admission does not match the selected production Release and SHA")
            admitted_run = admission
        else:
            admitted_run = (validate_production_static_release(args.source_sha, release_tag)
                            if release_tag is not None else validate_static_main_ci(args.source_sha))
        journal_provenance = copy.deepcopy(admitted_run)
        helper_payload = None
        helper_evidence = None
        if install_host_helper:
            fetch_provenance = copy.deepcopy(admitted_run)
            helper_payload = fetch_host_helper_artifact(fetch_provenance, args.source_sha)
            helper_evidence = copy.deepcopy(fetch_provenance.get("hostHelperArtifact"))
            if not isinstance(helper_evidence, dict):
                raise Refusal("verified host helper artifact omitted its operation evidence")
            fetch_provenance.pop("hostHelperArtifact", None)
            journal_provenance["hostHelperArtifact"] = helper_evidence
        if helper_payload is not None and helper_evidence is not None:
            install_staging194_host_helper(helper_payload, helper_evidence["payloadSha256"], args.operation_id)
        provenance_b64 = base64.b64encode(json.dumps(journal_provenance, sort_keys=True,
            separators=(",", ":")).encode()).decode("ascii")
        common = ["static-main", "--operation-id", args.operation_id, "--source-sha", args.source_sha,
                  "--provenance-b64", provenance_b64]
        if expected_installed_cms_sha is not None:
            common.extend(["--expected-installed-cms-sha", expected_installed_cms_sha])
        reuse_capture_operation_id = getattr(args, "reuse_capture_operation_id", None)
        if reuse_capture_operation_id is not None:
            common.extend(["--reuse-capture-operation-id", reuse_capture_operation_id])
        archive, archive_sha256 = make_archive(args.source_sha, journal_provenance)
        remote_options = {} if profile == "staging194" else {"profile": profile}
        prepared = parse_host_json(ssh_remote(common + ["--archive-sha256", archive_sha256], **remote_options,
                                              input_bytes=archive))
        if prepared.get("phase") != "browser-check-required":
            raise Refusal(f"static-main candidate is not ready for browser acceptance: {prepared.get('phase')}")
        digest = prepared.get("staticTreeSha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise Refusal("host returned an invalid static-main candidate digest")
        candidate = ssh_remote(["export-static-main", "--operation-id", args.operation_id,
                                "--source-sha", args.source_sha], **remote_options)
        browser_profile = "production-static" if profile == "production-static" else "staging194"
        browser_check(args.source_sha, args.operation_id, digest, candidate, browser_profile, admitted_run,
                      chat_loader_src=INITIAL_PROD_CHAT_LOADER_SRC if profile == "production-static" else STAGING194_CHAT_LOADER_SRC)
        if release_tag is None:
            current_run = validate_static_main_ci(args.source_sha)
            if current_run != admitted_run:
                raise Refusal("canonical main source or exact-SHA workflow proofs changed during acceptance")
        committed = parse_host_json(ssh_remote(common + ["--browser-digest", digest], **remote_options))
        if committed.get("phase") != "committed":
            raise Refusal(f"static-main publication did not reach durable commit: {committed.get('phase')}")
    elif args.command == "static-main-recover":
        command = ["static-main-recover", "--operation-id", args.operation_id]
        expected_phase = "recovered"
        accept_expired_rollback = getattr(args, "accept_expired_rollback", False)
        if accept_expired_rollback:
            if profile != "staging194" or args.rollback_committed:
                raise Refusal("expired rollback acceptance is restricted to staging194 and cannot roll back")
            if (not isinstance(args.operator, str) or not args.operator.strip()
                    or not isinstance(args.reason, str) or not args.reason.strip()):
                raise Refusal("expired rollback acceptance requires --operator and --reason")
            command.extend(["--accept-expired-rollback", "--operator", args.operator, "--reason", args.reason])
            expected_phase = "rollback-target-expired"
        elif args.rollback_committed:
            if (not isinstance(args.operator, str) or not args.operator.strip()
                    or not isinstance(args.reason, str) or not args.reason.strip()):
                raise Refusal("committed static rollback requires --operator and --reason")
            command.extend(["--rollback-committed", "--operator", args.operator, "--reason", args.reason])
            expected_phase = "rolled-back"
        elif args.operator is not None or args.reason is not None:
            raise Refusal("--operator and --reason require --rollback-committed")
        result = parse_host_json(ssh_remote(command, **({} if profile == "staging194" else {"profile": profile})))
        if result.get("phase") == "rollback-target-expired-cleanup-pending":
            raise Refusal("rollback loss was durably recorded; site cleanup remains pending; retry the same recovery")
        allowed_phases = {expected_phase} if args.rollback_committed or accept_expired_rollback else {"recovered", "rolled-back"}
        if result.get("phase") not in allowed_phases:
            raise Refusal(f"static-main recovery did not reach {expected_phase}: {result.get('phase')}")
    else:
        if profile == "production-paired":
            status = parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id], profile=profile))
            if status.get("phase") in ("fenced", "acquiring"):
                try:
                    no_mutation = parse_host_json(ssh_remote(["recover", "--operation-id", args.operation_id],
                                                              profile=profile))
                except Refusal as error:
                    message = str(error)
                    if not any(expected in message for expected in (
                            "explicit recovery requires the actual verified off-host backup bytes",
                            "production backup is imported or restore is prepared")):
                        raise
                else:
                    if no_mutation.get("phase") == "recovered":
                        return
                    raise Refusal("production pre-activation recovery returned an unexpected phase")
        backup_dir = backup_root(args.backup_dir, profile)
        target = backup_dir / f"{args.operation_id}.tar"
        metadata = target.with_suffix(".json")
        if target.exists() or metadata.exists():
            if target.is_symlink() or metadata.is_symlink() or not target.is_file() or not metadata.is_file():
                raise Refusal("off-host recovery backup paths are incomplete or unsafe")
            record = json.loads(metadata.read_text(encoding="utf-8"))
            payload = target.read_bytes()
            if (record.get("operationId") != args.operation_id
                    or hashlib.sha256(payload).hexdigest() != record.get("sha256")):
                raise Refusal("off-host recovery backup bytes no longer match their digest")
            if profile == "production-paired":
                if (not isinstance(record.get("sourceSha"), str) or not SHA.fullmatch(record["sourceSha"]) or
                        type(record.get("runId")) is not int or record["runId"] < 1 or
                        type(record.get("attempt")) is not int or record["attempt"] < 1 or
                        not isinstance(record.get("oldCmsSourceSha"), str) or
                        not SHA.fullmatch(record["oldCmsSourceSha"]) or
                        not isinstance(record.get("oldCmsSchemaSha256"), str) or
                        not re.fullmatch(r"[a-f0-9]{64}", record["oldCmsSchemaSha256"])):
                    raise Refusal("production recovery backup is missing its exact source admission")
                status = parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id], profile=profile))
                recovery_old_pair = status.get("oldPair") or {}
                old_cms_path = recovery_old_pair.get("cmsPath")
                old_match = re.search(r"/releases/([a-f0-9]{40})-[^/]+(?:/|$)", old_cms_path or "")
                if not old_match or old_match.group(1) != record["oldCmsSourceSha"]:
                    raise Refusal("backup old CMS schema source does not match the journaled old CMS release")
                if "historicalRegistryManifest" in recovery_old_pair:
                    old_registry = recovery_old_pair["historicalRegistryManifest"]
                    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
                        source_registry = json.load(archive.extractfile("manifest.json")).get("historicalRegistrySha256")
                    if source_registry != (old_registry or {}).get("registrySha256") or source_registry != record.get("oldHistoricalRegistrySha256"):
                        raise Refusal("backup historical registry cannot be matched to the original production pair")
                projector_sha = record.get("oldProjectorSourceSha", record["sourceSha"])
                original_contract = record.get("oldProjectorContractSha256")
                if original_contract is not None and (
                        "historicalRegistryManifest" not in recovery_old_pair
                        or (recovery_old_pair.get("staticProjector") or {}).get("sourceSha") != projector_sha
                        or original_contract != production_projector_contract(projector_sha, record["oldCmsSourceSha"])
                        or record.get("oldProjectorNodeVersion") != production_projector_node_version()):
                    raise Refusal("production recovery projector or runtime differs from the verified backup")
                fingerprint = production_paired_backup_fingerprint(payload, record["sourceSha"], args.operation_id,
                    record["runId"], record["attempt"], record["oldCmsSourceSha"], record["oldCmsSchemaSha256"],
                    projector_sha=projector_sha)
                if record.get("snapshotFingerprint") != fingerprint:
                    raise Refusal("off-host backup snapshot fingerprint differs from its verified sidecar")
                restored = parse_host_json(ssh_remote(["restore", "--operation-id", args.operation_id,
                    "--backup-sha256", record["sha256"], "--restore-fingerprint", fingerprint],
                    profile=profile, input_bytes=payload))
                if restored.get("phase") == "recovered" and restored.get("dataRestored") is False:
                    return
                if restored.get("phase") != "restore-staged":
                    raise Refusal("production backup restore did not remain fenced for provenance")
                result = parse_host_json(ssh_remote(["finalize-recover", "--operation-id", args.operation_id,
                    "--restore-fingerprint", fingerprint], profile=profile))
                if result.get("phase") != "recovered":
                    raise Refusal("production restore could not finalize after provenance recording")
                return
            result_bytes = ssh_remote(["recover", "--operation-id", args.operation_id,
                                       "--backup-sha256", record["sha256"]], profile=profile, input_bytes=payload)
        else:
            # This is permitted only when acquisition failed before the host made the
            # final post-fence backup and before any DB/code switch.
            result_bytes = ssh_remote(["recover", "--operation-id", args.operation_id], profile=profile)
        result = parse_host_json(result_bytes)
        if result.get("phase") != "recovered":
            raise Refusal(f"explicit recovery did not complete: {result.get('phase')}")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=("staging194", "initial-prod", "production-static", "production-paired"), default="staging194")
    sub = parser.add_subparsers(dest="command", required=True)
    for action in ("cms-update", "static-publish", "static-main", "static-main-recover", "recover", "space-preflight"):
        command = sub.add_parser(action)
        command.add_argument("--host")
        command.add_argument("--operation-id", required=True)
        command.add_argument("--backup-dir")
        if action == "static-main-recover":
            command.add_argument("--rollback-committed", action="store_true")
            command.add_argument("--accept-expired-rollback", action="store_true")
            command.add_argument("--operator")
            command.add_argument("--reason")
        if action not in ("recover", "static-main-recover", "space-preflight"):
            command.add_argument("--source-sha", required=action not in ("cms-update",))
        if action == "static-main":
            command.add_argument("--reuse-capture-operation-id")
            command.add_argument("--release-tag")
            command.add_argument("--expected-installed-cms-sha")
            command.add_argument("--install-host-helper", action="store_true")
        if action == "cms-update":
            command.add_argument("--install-host-helper", action="store_true")
            command.add_argument("--seminar-proof-artifact")
            command.add_argument("--seminar-proof-sha256")
            command.add_argument("--migration-review")
            command.add_argument("--migration-review-sha256")
        if action == "space-preflight":
            command.add_argument("--for", dest="preflight_for", required=True,
                                 choices=("cms-update", "static-main"))
            command.add_argument("--source-sha", required=True)
    export = sub.add_parser("export-migration-pause")
    export.add_argument("--operation-id", required=True)
    export.add_argument("--source-sha", required=True)
    export.add_argument("--output-parent", required=True)
    args = parser.parse_args(argv)
    args.release_tag = getattr(args, "release_tag", None)
    try:
        if args.command == "export-migration-pause":
            if args.profile not in ("staging194", "production-paired"):
                raise Refusal("migration pause export is restricted to paired profiles")
            if not SHA.fullmatch(args.source_sha):
                raise Refusal("source SHA must be a full lowercase commit ID")
            parent = Path(args.output_parent).expanduser().resolve(strict=True)
            if not parent.is_dir():
                raise Refusal("output parent must be a directory")
            data = ssh_remote(["export-migration-pause", "--operation-id", args.operation_id,
                               "--source-sha", args.source_sha], profile=args.profile, binary=True)
            output = Path(tempfile.mkdtemp(prefix="ikpk-migration-pause-", dir=parent))
            os.chmod(output, 0o700)
            target = output / "pause.tar"
            for path, payload in ((target, data), (output / "pause.tar.sha256",
                    (hashlib.sha256(data).hexdigest() + "  pause.tar\n").encode())):
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
            print(json.dumps({"directory": str(output), "sha256": hashlib.sha256(data).hexdigest()}))
            return 0
        if args.command == "cms-update" and args.source_sha is None:
            if args.migration_review is not None or args.migration_review_sha256 is not None:
                raise Refusal("--source-sha is required when submitting a migration review")
            if args.profile != "staging194":
                raise Refusal("--source-sha is required outside the staging194 profile")
            try:
                status = parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id]))
            except Refusal as error:
                if str(error) not in FRESH_OPERATION_STATUS_ERRORS:
                    raise
            else:
                if (status.get("operationId") != args.operation_id
                        or status.get("phase") != "idle"):
                    raise Refusal("--source-sha is required to continue an existing staging194 operation")
            args.source_sha = capture(["gh", "api", f"repos/{CANONICAL_REPOSITORY}/git/ref/heads/main",
                                       "--jq", ".object.sha"])
            if not SHA.fullmatch(args.source_sha):
                raise Refusal("canonical main returned an invalid head SHA")
        result = invoke(args)
        if args.command == "space-preflight" and result is not None:
            print(json.dumps(result, sort_keys=True))
        return 0
    except (Refusal, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"ikpk-rehearsal: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
