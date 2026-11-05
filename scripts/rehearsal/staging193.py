#!/usr/bin/env python3
"""Local authenticated operator for exact-source staging194 rehearsal commands."""

from __future__ import annotations

import argparse
import base64
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
from pathlib import Path
from typing import Optional


ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r"[a-f0-9]{40}\Z")
OP = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
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
    provenance["release"] = {"tag": tag, "publishedAt": published_at}
    provenance["releasePreflight"] = preflight_result
    provenance["historicalRelease"] = historical_release
    return provenance


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
    provenance["release"] = release
    provenance["releasePreflight"] = {"status": result["status"], "commit": result["commit"],
                                      "release": release, "historicalRelease": True}
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


def fetch_cms_candidate_artifact(provenance: dict, sha: str) -> bytes:
    """Fetch and verify the CMS payload bound to this exact Tests run and SHA."""
    run_id = provenance.get("runId")
    attempt = provenance.get("attempt")
    if (type(run_id) is not int or run_id <= 0 or type(attempt) is not int or attempt <= 0
            or provenance.get("sourceSha") != sha):
        raise Refusal("CMS admission omitted the exact workflow run identity")

    artifact_name = f"cms-candidate-{run_id}-{attempt}"
    endpoint = f"repos/{CANONICAL_REPOSITORY}/actions/runs/{run_id}/artifacts"
    raw = capture(["gh", "api", endpoint, "--paginate", "--slurp"])
    try:
        pages = json.loads(raw)
    except ValueError as error:
        raise Refusal("gh returned malformed CMS artifact metadata") from error
    if not isinstance(pages, list):
        raise Refusal("gh returned malformed CMS artifact metadata")
    artifacts = []
    for page in pages:
        if isinstance(page, dict) and isinstance(page.get("artifacts"), list):
            artifacts.extend(page["artifacts"])
    matches = [item for item in artifacts if isinstance(item, dict) and item.get("name") == artifact_name]
    if len(matches) != 1:
        raise Refusal("exact CMS candidate artifact is missing or duplicated")
    artifact = matches[0]
    workflow_run = artifact.get("workflow_run")
    digest = artifact.get("digest")
    if (type(artifact.get("id")) is not int or artifact["id"] <= 0
            or artifact.get("expired") is not False
            or not isinstance(workflow_run, dict)
            or workflow_run.get("id") != run_id or workflow_run.get("head_sha") != sha
            or workflow_run.get("head_branch") != "main"
            or not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)):
        raise Refusal("CMS candidate artifact is expired or not bound to the admitted run and SHA")

    archive = capture_bytes(["gh", "api",
        f"repos/{CANONICAL_REPOSITORY}/actions/artifacts/{artifact['id']}/zip"])
    archive_sha256 = hashlib.sha256(archive).hexdigest()
    if digest.removeprefix("sha256:") != archive_sha256:
        raise Refusal("downloaded CMS candidate ZIP does not match GitHub's artifact digest")
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            entries = bundle.infolist()
            if (len(entries) != 1 or entries[0].filename != "cms-artifact.tar.gz"
                    or entries[0].is_dir() or entries[0].flag_bits & 0x1):
                raise Refusal("CMS candidate ZIP must contain exactly one unencrypted tar payload")
            payload = bundle.read(entries[0])
    except Refusal:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise Refusal("CMS candidate ZIP is unreadable") from error
    provenance["cmsArtifact"] = {"artifactId": artifact["id"], "runId": run_id, "attempt": attempt,
        "archiveSha256": archive_sha256, "payloadSha256": hashlib.sha256(payload).hexdigest()}
    return payload


def make_archive(sha: str, provenance: dict, *, cms_artifact: Optional[bytes] = None) -> tuple[bytes, str]:
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


def production_paired_schema_from_commit(source_sha: str, schema_root: Path) -> str:
    if not SHA.fullmatch(source_sha):
        raise Refusal("old CMS source SHA must be a full lowercase commit ID")
    capture(["git", "cat-file", "-e", f"{source_sha}^{{commit}}"])
    archive = capture_bytes(["git", "archive", "--format=tar", source_sha, *CMS_CAPTURE_SCHEMA_PATHS])
    schema_root.mkdir(mode=0o700, parents=True, exist_ok=False)
    seen = set()
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as source:
            for member in source.getmembers():
                if member.isdir():
                    continue
                if member.issym() or member.islnk() or not member.isfile() or member.name not in CMS_CAPTURE_SCHEMA_PATHS:
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
    if seen != set(CMS_CAPTURE_SCHEMA_PATHS):
        raise Refusal("old CMS source commit lacks the exact capture schema contract")
    digest = hashlib.sha256()
    for path in sorted(CMS_CAPTURE_SCHEMA_PATHS):
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
                           old_cms_path: Optional[str] = None) -> Path:
    verify_backup_tar(payload, expected_sha256)
    target = directory / f"{operation_id}.tar"
    metadata = target.with_suffix(".json")
    schema_metadata = {}
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
        if hashlib.sha256(target.read_bytes()).hexdigest() != expected_sha256 or any(
                old.get(k) != v for k, v in {"operationId": operation_id, "sourceSha": source_sha,
                                            "sha256": expected_sha256}.items()):
            raise Refusal("existing off-host backup belongs to different bytes or operation")
    else:
        base = {"operationId": operation_id, "sourceSha": source_sha, "sha256": expected_sha256}
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
        if (type(admission.get("runId")) is not int or admission["runId"] <= 0 or
                type(admission.get("attempt")) is not int or admission["attempt"] <= 0):
            raise Refusal("production backup admission is missing its exact run and attempt")
        fingerprint = production_paired_backup_fingerprint(payload, source_sha, operation_id,
            admission["runId"], admission["attempt"], schema_sha, schema_digest)
        schema_metadata = {"oldCmsSourceSha": schema_sha, "oldCmsSchemaSha256": schema_digest,
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


def production_paired_backup_fingerprint(payload: bytes, source_sha: str, operation_id: str,
                                         run_id: int, attempt: int, old_cms_source_sha: str,
                                         expected_schema_digest: str) -> str:
    """Project the verified, pre-migration production SQLite backup with its old CMS schema."""
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
        try:
            (root / "manifest.json").unlink()
        except FileNotFoundError:
            raise Refusal("verified production backup lacks its capture manifest")
        schema_root = Path(temporary) / "old-cms-schema"
        schema_digest = production_paired_schema_from_commit(old_cms_source_sha, schema_root)
        if schema_digest != expected_schema_digest:
            raise Refusal("old CMS schema bytes differ from the digest bound to this verified backup")
        capture(["node", "scripts/lib/seal-staging193-capture.mjs", str(root), operation_id, source_sha,
                 str(schema_root), "production-static", str(run_id), str(attempt)])
        snapshot_dir = Path(temporary) / "snapshot"
        environment = {key: value for key, value in os.environ.items()
                       if key not in ("CMS_URL", "STRAPI_URL", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "IKPK_DEPLOY_KEY")}
        environment.update({"CONTENT_SNAPSHOT_DIR": str(snapshot_dir), "CONTENT_CAPTURE_SCHEMA_ROOT": str(schema_root)})
        result = subprocess.run(["web/node_modules/.bin/tsx", "web/scripts/capture-content-snapshot.ts",
                                 "--server-capture", "--profile", "production-static", str(root)],
                                cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
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


def browser_check(source_sha: str, operation_id: str, static_digest: str, archive: bytes,
                  profile: str = "staging194", admitted_run: Optional[dict] = None,
                  chat_loader_src: Optional[str] = None) -> Optional[str]:
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
                    elif normalized in ("snapshot/snapshot.json", "snapshot/capture-manifest.json"):
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
    automatic_static_capacity = profile == "production-static" and args.command == "static-main"
    if args.command == "space-preflight" or automatic_static_capacity:
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
        paired_old_cms = (old_pair["cmsPath"], *production_paired_schema_source(old_pair["cmsPath"]))
        if not (ROOT / "web/node_modules/.bin/tsx").is_file():
            raise Refusal("local content snapshot tooling is unavailable before production fence")
    if args.command == "cms-update":
        provenance = (validate_production_paired_admission(args.source_sha) if profile == "production-paired"
                      else validate_sha_and_ci(args.source_sha, profile))
        ci_admission = dict(provenance)
        cms_artifact = (fetch_cms_candidate_artifact(provenance, args.source_sha)
                        if profile in ("staging194", "production-paired") else None)
        archive, digest = (make_archive(args.source_sha, provenance, cms_artifact=cms_artifact)
                           if cms_artifact is not None else make_archive(args.source_sha, provenance))
        provenance_b64 = base64.b64encode(json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode()).decode("ascii")
        common = ["cms-update", "--operation-id", args.operation_id, "--source-sha", args.source_sha,
                  "--provenance-b64", provenance_b64]
        first = parse_host_json(ssh_remote(common + ["--archive-sha256", hashlib.sha256(archive).hexdigest()], profile=profile,
                                           input_bytes=archive))
        backup_dir = backup_root(args.backup_dir, profile)
        if first.get("offhostBackupRequired"):
            remote_backup = ssh_remote(["export-backup", "--operation-id", args.operation_id], profile=profile)
            old_cms_path = None
            if profile == "production-paired":
                status = parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id], profile=profile))
                old_cms_path = (status.get("oldPair") or {}).get("cmsPath")
                if not paired_old_cms or old_cms_path != paired_old_cms[0]:
                    raise Refusal("journaled old CMS release changed after read-only preflight")
            if profile == "production-paired":
                backup_path = persist_offhost_backup(backup_dir, args.operation_id, args.source_sha,
                    remote_backup, first.get("backupSha256", ""), provenance, old_cms_path)
            else:
                backup_path = persist_offhost_backup(backup_dir, args.operation_id, args.source_sha,
                    remote_backup, first.get("backupSha256", ""))
            digest = hashlib.sha256(backup_path.read_bytes()).hexdigest()
            if profile == "production-paired":
                metadata_record = json.loads(backup_path.with_suffix(".json").read_text(encoding="utf-8"))
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
            completed = parse_host_json(ssh_remote(common + ["--offhost-sha256", digest], profile=profile))
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
        snapshot_fingerprint = browser_check(args.source_sha, args.operation_id, digest, candidate_bytes, profile, admitted_run)
        if profile == "production-paired":
            backup_dir = backup_root(args.backup_dir, profile)
            metadata_path = backup_dir / f"{args.operation_id}.json"
            try:
                backup_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise Refusal("production backup provenance sidecar is unavailable before static acceptance") from error
            if (backup_metadata.get("sourceSha") != args.source_sha or
                    backup_metadata.get("snapshotFingerprint") != snapshot_fingerprint):
                raise Refusal("built production snapshot differs from the fingerprint captured in the verified backup")
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
        provenance_b64 = base64.b64encode(json.dumps(admitted_run, sort_keys=True,
            separators=(",", ":")).encode()).decode("ascii")
        common = ["static-main", "--operation-id", args.operation_id, "--source-sha", args.source_sha,
                  "--provenance-b64", provenance_b64]
        if expected_installed_cms_sha is not None:
            common.extend(["--expected-installed-cms-sha", expected_installed_cms_sha])
        reuse_capture_operation_id = getattr(args, "reuse_capture_operation_id", None)
        if reuse_capture_operation_id is not None:
            common.extend(["--reuse-capture-operation-id", reuse_capture_operation_id])
        archive, archive_sha256 = make_archive(args.source_sha, admitted_run)
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
                old_cms_path = (status.get("oldPair") or {}).get("cmsPath")
                old_match = re.search(r"/releases/([a-f0-9]{40})-[^/]+(?:/|$)", old_cms_path or "")
                if not old_match or old_match.group(1) != record["oldCmsSourceSha"]:
                    raise Refusal("backup old CMS schema source does not match the journaled old CMS release")
                fingerprint = production_paired_backup_fingerprint(payload, record["sourceSha"], args.operation_id,
                    record["runId"], record["attempt"], record["oldCmsSourceSha"], record["oldCmsSchemaSha256"])
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
        if action == "space-preflight":
            command.add_argument("--for", dest="preflight_for", required=True,
                                 choices=("cms-update", "static-main"))
            command.add_argument("--source-sha", required=True)
    args = parser.parse_args(argv)
    args.release_tag = getattr(args, "release_tag", None)
    try:
        if args.command == "cms-update" and args.source_sha is None:
            if args.profile != "staging194":
                raise Refusal("--source-sha is required outside the staging194 profile")
            try:
                parse_host_json(ssh_remote(["status", "--operation-id", args.operation_id]))
            except Refusal as error:
                if "operation has no maintenance marker or terminal journal record" not in str(error):
                    raise
            else:
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
