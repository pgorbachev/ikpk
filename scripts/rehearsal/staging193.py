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
import socketserver
import subprocess
import sys
import tarfile
import tempfile
import threading
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
CANONICAL_REF = "refs/heads/dev"
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


def validate_sha_and_ci(sha: str, profile: str = "staging194") -> dict:
    if profile not in ("staging194", "staging194-dev", "staging194-main", "initial-prod"):
        raise Refusal("unknown fixed rehearsal profile")
    if not SHA.fullmatch(sha):
        raise Refusal("source SHA must be a full lowercase commit ID")
    capture(["git", "cat-file", "-e", f"{sha}^{{commit}}"])
    if profile == "staging194":
        main_provenance = validate_sha_and_ci(sha, "staging194-main")
        return validate_stable_release(main_provenance, sha)
    repo = capture(["gh", "repo", "view", CANONICAL_REPOSITORY,
                    "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    if repo != CANONICAL_REPOSITORY:
        raise Refusal("GitHub CLI resolved a repository other than the pinned IKPK repository")
    branch = "main" if profile in ("staging194", "staging194-main", "initial-prod") else "dev"
    canonical_ref = f"refs/heads/{branch}"
    canonical_head = capture(["gh", "api", f"repos/{repo}/git/ref/heads/{branch}", "--jq", ".object.sha"])
    if canonical_head != sha:
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


def validate_static_main_ci(sha: str) -> dict:
    provenance = validate_sha_and_ci(sha, "staging194-main")
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
    if canonical_head != sha:
        raise Refusal("canonical main head moved during CI admission")
    provenance["additionalWorkflows"] = workflow_proofs
    return provenance


def validate_stable_release(provenance: dict, sha: str) -> dict:
    """Bind an exact-main CI proof to its stable Release tag and release preflight."""
    raw = capture(["gh", "release", "view", "--repo", CANONICAL_REPOSITORY,
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
            or not isinstance(published_at, str) or not published_at):
        raise Refusal("production paired admission requires a published stable GitHub Release")
    tag_object = capture(["gh", "api", f"repos/{CANONICAL_REPOSITORY}/git/ref/tags/{tag}",
                          "--jq", ".object.sha"])
    if tag_object != sha:
        peeled = capture(["gh", "api", f"repos/{CANONICAL_REPOSITORY}/git/tags/{tag_object}",
                          "--jq", ".object.sha"])
        if peeled != sha:
            raise Refusal("stable Release tag does not resolve to the exact current main SHA")
    preflight = capture(["node", "web/scripts/release-preflight.ts", "--release-tag", tag,
                         "--commit", sha])
    try:
        preflight_result = json.loads(preflight)
    except ValueError as error:
        raise Refusal("release-preflight returned malformed admission evidence") from error
    if (preflight_result.get("status", preflight_result.get("result")) not in ("admitted", "passed")
            or preflight_result.get("commit") != sha):
        raise Refusal("release-preflight did not admit the exact current main SHA")
    provenance["release"] = {"tag": tag, "publishedAt": published_at}
    provenance["releasePreflight"] = preflight_result
    return provenance


def validate_production_paired_admission(sha: str) -> dict:
    """Require the current main release admission before every new paired phase."""
    return validate_stable_release(validate_static_main_ci(sha), sha)


def make_archive(sha: str, provenance: dict) -> tuple[bytes, str]:
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


def persist_offhost_backup(directory: Path, operation_id: str, source_sha: str, payload: bytes,
                           expected_sha256: str) -> Path:
    verify_backup_tar(payload, expected_sha256)
    target = directory / f"{operation_id}.tar"
    metadata = target.with_suffix(".json")
    if target.exists() or metadata.exists():
        if target.is_symlink() or metadata.is_symlink() or not target.is_file() or not metadata.is_file():
            raise Refusal("existing off-host backup path is not a regular file")
        try:
            old = json.loads(metadata.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise Refusal("existing off-host backup metadata is unreadable") from error
        if hashlib.sha256(target.read_bytes()).hexdigest() != expected_sha256 or old != {
            "operationId": operation_id, "sourceSha": source_sha, "sha256": expected_sha256,
        }:
            raise Refusal("existing off-host backup belongs to different bytes or operation")
        return target
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(target, flags, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    metadata_payload = json.dumps({"operationId": operation_id, "sourceSha": source_sha,
                                   "sha256": expected_sha256}, sort_keys=True).encode() + b"\n"
    fd = os.open(metadata, flags, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(metadata_payload)
        output.flush()
        os.fsync(output.fileno())
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    return target


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
                  chat_loader_src: Optional[str] = None) -> None:
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
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def invoke(args: argparse.Namespace) -> None:
    profile = getattr(args, "profile", "staging194")
    target_host = INITIAL_PROD_HOST if profile in ("initial-prod", "production-static", "production-paired") else TARGET_HOST
    if profile == "production-static" and args.command not in ("static-main", "static-main-recover"):
        raise Refusal("production-static permits only static-main publication and recovery")
    if profile == "production-paired" and args.command not in ("cms-update", "static-publish", "recover"):
        raise Refusal("production-paired permits only paired CMS update, static publish, and recovery")
    if args.command in ("static-main", "static-main-recover") and profile not in ("staging194", "production-static"):
        raise Refusal("static-main commands are bound to the staging194 profile or authorized production-static profile")
    if args.host is not None and args.host != target_host:
        raise Refusal(f"this command is bound to the authorized {profile} host")
    if profile == "initial-prod" and (args.operation_id != INITIAL_PROD_OPERATION_ID or args.command == "recover"):
        raise Refusal("initial-prod permits only its fixed operation ID and has no DB restore command")
    if not OP.fullmatch(args.operation_id):
        raise Refusal("operation ID has invalid characters")
    if args.command == "cms-update":
        provenance = (validate_production_paired_admission(args.source_sha) if profile == "production-paired"
                      else validate_sha_and_ci(args.source_sha, profile))
        archive, digest = make_archive(args.source_sha, provenance)
        provenance_b64 = base64.b64encode(json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode()).decode("ascii")
        common = ["cms-update", "--operation-id", args.operation_id, "--source-sha", args.source_sha,
                  "--provenance-b64", provenance_b64]
        first = parse_host_json(ssh_remote(common + ["--archive-sha256", hashlib.sha256(archive).hexdigest()], profile=profile,
                                           input_bytes=archive))
        backup_dir = backup_root(args.backup_dir, profile)
        if first.get("offhostBackupRequired"):
            remote_backup = ssh_remote(["export-backup", "--operation-id", args.operation_id], profile=profile)
            backup_path = persist_offhost_backup(backup_dir, args.operation_id, args.source_sha,
                                                 remote_backup, first.get("backupSha256", ""))
            digest = hashlib.sha256(backup_path.read_bytes()).hexdigest()
            if first.get("phase") == "cms-activated":
                return
            if profile == "production-paired":
                current_admission = validate_production_paired_admission(args.source_sha)
                if current_admission != provenance:
                    raise Refusal("production Release/main/CI admission changed before CMS activation; operation remains fenced for same-ID recovery")
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
        browser_check(args.source_sha, args.operation_id, digest, candidate_bytes, profile, admitted_run)
        current_run = (validate_production_paired_admission(args.source_sha) if profile == "production-paired"
                       else validate_sha_and_ci(args.source_sha, profile))
        if (current_run.get("runId"), current_run.get("attempt")) != (admitted_run.get("runId"), admitted_run.get("attempt")):
            raise Refusal("canonical exact-SHA run/attempt changed during the acceptance window")
        committed = parse_host_json(ssh_remote(common + ["--browser-digest", digest], profile=profile))
        if committed.get("phase") != "committed":
            raise Refusal(f"static publication did not reach durable commit: {committed.get('phase')}")
    elif args.command == "static-main":
        admitted_run = validate_static_main_ci(args.source_sha)
        provenance_b64 = base64.b64encode(json.dumps(admitted_run, sort_keys=True,
            separators=(",", ":")).encode()).decode("ascii")
        common = ["static-main", "--operation-id", args.operation_id, "--source-sha", args.source_sha,
                  "--provenance-b64", provenance_b64]
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
        browser_profile = "production-static" if profile in ("production-static", "production-paired") else "staging194"
        browser_check(args.source_sha, args.operation_id, digest, candidate, browser_profile, admitted_run,
                      chat_loader_src=INITIAL_PROD_CHAT_LOADER_SRC if profile in ("production-static", "production-paired") else STAGING194_CHAT_LOADER_SRC)
        current_run = validate_static_main_ci(args.source_sha)
        if current_run != admitted_run:
            raise Refusal("canonical main source, Tests run, or Release proof changed during acceptance")
        committed = parse_host_json(ssh_remote(common + ["--browser-digest", digest], **remote_options))
        if committed.get("phase") != "committed":
            raise Refusal(f"static-main publication did not reach durable commit: {committed.get('phase')}")
    elif args.command == "static-main-recover":
        command = ["static-main-recover", "--operation-id", args.operation_id]
        expected_phase = "recovered"
        if args.rollback_committed:
            if (not isinstance(args.operator, str) or not args.operator.strip()
                    or not isinstance(args.reason, str) or not args.reason.strip()):
                raise Refusal("committed static rollback requires --operator and --reason")
            command.extend(["--rollback-committed", "--operator", args.operator, "--reason", args.reason])
            expected_phase = "rolled-back"
        elif args.operator is not None or args.reason is not None:
            raise Refusal("--operator and --reason require --rollback-committed")
        result = parse_host_json(ssh_remote(command, **({} if profile == "staging194" else {"profile": profile})))
        allowed_phases = {expected_phase} if args.rollback_committed else {"recovered", "rolled-back"}
        if result.get("phase") not in allowed_phases:
            raise Refusal(f"static-main recovery did not reach {expected_phase}: {result.get('phase')}")
    else:
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
    for action in ("cms-update", "static-publish", "static-main", "static-main-recover", "recover"):
        command = sub.add_parser(action)
        command.add_argument("--host")
        command.add_argument("--operation-id", required=True)
        command.add_argument("--backup-dir")
        if action == "static-main-recover":
            command.add_argument("--rollback-committed", action="store_true")
            command.add_argument("--operator")
            command.add_argument("--reason")
        if action not in ("recover", "static-main-recover"):
            command.add_argument("--source-sha", required=True)
        if action == "static-main":
            command.add_argument("--reuse-capture-operation-id")
    args = parser.parse_args(argv)
    try:
        invoke(args)
        return 0
    except (Refusal, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"ikpk-rehearsal: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
