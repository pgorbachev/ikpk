#!/usr/bin/env python3
"""Bounded Linux host operations for the staging193 CMS/static rehearsal.

The installed command reads a root-owned JSON policy. It never accepts arbitrary
unit names, executable paths, or filesystem destinations from an SSH caller.
"""

from __future__ import annotations

import argparse
import base64
import secrets
import io
import hashlib
import json
import fcntl
import os
import pwd
import re
import shutil
import shlex
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote, urlsplit

try:
    from .rehearsal_state import RehearsalRefusal, RehearsalState, durable_json
except ImportError:  # Installed wrapper places both files in one private module directory.
    from rehearsal_state import RehearsalRefusal, RehearsalState, durable_json


CONFIG_PATH = Path("/etc/ikpk/rehearsal.json")
INITIAL_PROD_CONFIG_PATH = Path("/etc/ikpk/rehearsal-initial-prod.json")
PRODUCTION_STATIC_CONFIG_PATH = Path("/etc/ikpk/rehearsal-production-static.json")
PRODUCTION_PAIRED_CONFIG_PATH = Path("/etc/ikpk/rehearsal-production-paired.json")
TARGET_HOST = "194.226.99.10"
INITIAL_PROD_HOST = "89.111.184.196"
INITIAL_PROD_PAYMENT_ENDPOINT = "https://ikpk.su/api"
INITIAL_PROD_CHAT_LOADER_SRC = "https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js"
STAGING194_CHAT_LOADER_SRC = INITIAL_PROD_CHAT_LOADER_SRC
INITIAL_PROD_CMS_ENV_FILE = Path("/etc/ikpk-cms/trial.env")
PRODUCTION_PUBLICATION_LOCK = Path("/var/www/ikpk/.publication.lock")
STAGING194_TEMPORARY_ROOT = Path("/var/tmp/ikpk-staging194")
PRODUCTION_PAIRED_WORKSPACE_ROOT = Path("/var/lib/ikpk-site-build/production-paired")
SITE_PUBLICATION_MARKER = "host-publication.json"
SITE_PUBLICATION_MARKER_DIR = Path("/var/lib/ikpk-rehearsal/site-publication")
INITIAL_PROD_OPERATION_ID = "initial-prod-20261019-A-01"
REQUIRED_CONFIG = {
    "stateDir", "maintenanceFlag", "releaseRoot", "currentCms", "currentStatic",
    "staticReleaseRoot", "cmsUnit", "writerUnits", "cmsUser", "cmsDatabase", "mediaRoots",
    "backupRoot", "nginxBinary", "nginxService", "nginxMapFile",
    "nginxServerGateFile", "writerPrefixes", "preservePrefixes",
    "cmsHealthUrl", "siteHealthUrl", "siteBaseUrl", "siteReleaseUrl", "siteProbeUrls", "paymentStatusProbeUrl",
    "writerProbeUrls", "preserveProbeUrl", "allowedSourceRef", "targetHost", "siteRefreshState",
    "sitePublicationMarker", "publicationLock",
}
SHA_RE = re.compile(r"[a-f0-9]{40}\Z")
SHA256_RE = re.compile(r"[a-f0-9]{64}\Z")
CONTENT_FINGERPRINT_RE = re.compile(r"sha256:[a-f0-9]{64}\Z")
PREFIX_RE = re.compile(r"/[A-Za-z0-9_./*?=-]+\Z")
UNIT_RE = re.compile(r"[A-Za-z0-9_.@:-]+\.service\Z")


def _uses_staging194_temp(config: dict[str, Any]) -> bool:
    return config.get("profile") == "staging194" and "temporaryRoot" in config or (
        "profile" not in config and "temporaryRoot" in config)


def _configure_profile_temp(config: dict[str, Any]) -> None:
    if _uses_staging194_temp(config):
        tempfile.tempdir = str(_validate_staging194_temporary_root(config))


class HostFailure(RuntimeError):
    pass


def run(argv: list[str], *, timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=timeout, check=False, env={**os.environ, "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HostFailure(f"command failed to run: {argv[0]}: {error}") from error
    if check and result.returncode:
        raise HostFailure(f"{argv[0]} exited {result.returncode}: {result.stderr.strip()}")
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _maintenance_banner(config: dict[str, Any]) -> str:
    value = config.get("maintenanceBanner", "off")
    if value not in ("on", "off"):
        raise HostFailure("maintenanceBanner must be on or off")
    return value


def _filesystem_bytes(path: Path, *, required: bool = False, strict_tree: bool = False) -> int:
    path = Path(path)
    if path.is_symlink():
        raise HostFailure(f"cannot estimate free-space requirement through symlink: {path}")
    if required and not path.exists():
        raise HostFailure(f"required space-estimate source is unavailable: {path}")
    if path.is_file():
        return path.stat().st_size
    if not path.is_dir():
        if required:
            raise HostFailure(f"required space-estimate source is unavailable: {path}")
        return 0
    total = 0
    for item in path.rglob("*"):
        if item.is_symlink():
            if strict_tree:
                raise HostFailure(f"cannot estimate required free space through symlink: {item}")
            continue
        try:
            if item.is_file():
                total += item.stat().st_size
            elif strict_tree and not item.is_dir():
                raise HostFailure(f"required space-estimate tree contains a non-regular object: {item}")
        except OSError as error:
            raise HostFailure(f"cannot estimate required free space under {path}: {error}") from error
    return total


def _installed_paired_cms_source_sha(config: dict[str, Any]) -> Optional[str]:
    """Trust only the service-bound operation workspace and its existing identity marker."""
    if config.get("profile") != "production-paired":
        return None
    try:
        installed_env = _paired_cms_source_env(config)
        candidate_sha = installed_env.get("IKPK_INSTALLED_COMMIT")
        workspace_text = installed_env.get("IKPK_BUILD_WORKSPACE")
        trusted_root = Path(config.get("siteBuildWorkspaceRoot", ""))
        workspace = Path(workspace_text) if isinstance(workspace_text, str) else Path("/")
        if (not isinstance(candidate_sha, str) or not SHA_RE.fullmatch(candidate_sha)
                or trusted_root != PRODUCTION_PAIRED_WORKSPACE_ROOT
                or trusted_root.is_symlink() or workspace.is_symlink()
                or workspace.parent != trusted_root):
            return None
        match = re.fullmatch(rf"{re.escape(candidate_sha)}-([A-Za-z0-9][A-Za-z0-9._-]{{0,127}})",
                             workspace.name)
        if not match:
            return None
        operation_id = match.group(1)
        if workspace.resolve(strict=True).parent != trusted_root.resolve(strict=True):
            return None
        marker = workspace / ".ikpk-workspace-identity.json"
        info = marker.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            return None
        identity = json.loads(marker.read_text(encoding="utf-8"))
        if identity == {"sourceSha": candidate_sha, "operationId": operation_id}:
            release_root = Path(config["releaseRoot"]).resolve(strict=True)
            source_root = _candidate_root(config, candidate_sha, operation_id)
            if (source_root.is_symlink() or not source_root.is_dir()
                    or source_root.resolve(strict=True) != source_root
                    or source_root.parent != release_root):
                return None
            artifact = _cms_artifact_path(source_root, operation_id)
            current_cms = _current_target(Path(config["currentCms"]))
            artifact_resolved = artifact.resolve(strict=True)
            if (artifact.is_symlink() or not artifact.is_dir()
                    or not artifact_resolved.is_relative_to(source_root)
                    or current_cms != artifact_resolved):
                return None
            return candidate_sha
    except (HostFailure, OSError, ValueError, UnicodeError, KeyError):
        return None
    return None


def _required_static_capture_tree_bytes(root: Path) -> int:
    """Measure an entire capture source or refuse when any tree member is ambiguous."""
    total = 0
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(Path(entry.path))
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                        total += info.st_size
                    else:
                        raise HostFailure(f"required media tree contains an unsafe object: {entry.path}")
        except OSError as error:
            raise HostFailure(f"cannot completely estimate required media tree under {root}: {error}") from error
    return total


def _space_preflight(config: dict[str, Any], operation_id: str, operation_kind: str) -> dict[str, Any]:
    """Estimate each affected filesystem from current releases, backup inputs, and a stated reserve."""
    needed = ("currentCms", "currentStatic", "releaseRoot", "staticReleaseRoot", "stateDir")
    if operation_kind == "cms-update":
        needed += ("cmsDatabase", "mediaRoots", "backupRoot")
    production_static_capture_bytes = 0
    production_static_capture = (operation_kind == "static-main"
                                 and config.get("profile") in ("production-static", "production-paired"))
    if production_static_capture:
        needed += ("cmsDatabase", "mediaRoots")
    if not all(key in config for key in needed):
        raise HostFailure("host configuration is incomplete for read-only space preflight")
    current_cms = _current_target(Path(config["currentCms"]))
    current_static = _current_target(Path(config["currentStatic"]))
    cms_bytes = _filesystem_bytes(current_cms) if operation_kind == "cms-update" else 0
    static_bytes = _filesystem_bytes(current_static)
    backup_bytes = 0
    backup_archive_bytes = 0
    database_bytes = 0
    live_database_bytes = 0
    backup_members = 0
    if operation_kind == "cms-update":
        database = Path(config["cmsDatabase"])
        database_info = database.lstat()
        if not stat.S_ISREG(database_info.st_mode):
            raise HostFailure(f"required live database is not a regular file: {database}")
        database_bytes = _filesystem_bytes(database, required=True)
        live_database_bytes = database_bytes
        backup_archive = Path(config["backupRoot"]) / operation_id / "backup.tar"
        if backup_archive.is_file() and not backup_archive.is_symlink():
            backup_archive_bytes = backup_archive.stat().st_size
            backup_bytes = backup_archive_bytes
        else:
            capture_bytes = database_bytes
            backup_members = 4  # database.sqlite, media directory, and the two manifests
            for sidecar in (Path(str(database) + "-wal"), Path(str(database) + "-shm")):
                sidecar_bytes = _filesystem_bytes(sidecar)
                capture_bytes += sidecar_bytes
                live_database_bytes += sidecar_bytes
                backup_members += int(sidecar_bytes > 0)
            for media in config["mediaRoots"]:
                media_path = Path(media["path"])
                if media_path.is_symlink() or not media_path.is_dir():
                    raise HostFailure(f"required media source is unavailable or unsafe: {media_path}")
                capture_bytes += _filesystem_bytes(media_path, required=True, strict_tree=True)
                backup_members += sum(1 for item in media_path.rglob("*"))
            # _backup keeps the captured database/media and a second tar containing those bytes.
            # Per-member tar headers and padding can add up to 1 KiB per entry.
            tar_overhead = 1024 * (backup_members + 1)
            backup_archive_bytes = capture_bytes + tar_overhead
            backup_bytes = capture_bytes + backup_archive_bytes
    elif production_static_capture:
        # Production static-main keeps the live CMS in place. Preparation writes a
        # read-only SQLite backup snapshot, copies that snapshot into the sealed
        # capture, and copies every configured media tree into the same source root.
        # The first two files coexist throughout the build; the source DB/WAL remain
        # live and are inputs only, not a CMS backup archive.
        database = Path(config["cmsDatabase"])
        database_info = database.lstat()
        if not stat.S_ISREG(database_info.st_mode) or database_info.st_nlink != 1:
            raise HostFailure(f"required live database is not a safe regular file: {database}")
        database_bytes = _filesystem_bytes(database, required=True)
        wal = Path(str(database) + "-wal")
        wal_bytes = 0
        if os.path.lexists(wal):
            wal_info = wal.lstat()
            if not stat.S_ISREG(wal_info.st_mode) or wal_info.st_nlink != 1:
                raise HostFailure(f"required SQLite WAL is not a safe regular file: {wal}")
            wal_bytes = wal_info.st_size
        media_roots = config["mediaRoots"]
        if not isinstance(media_roots, list) or not media_roots:
            raise HostFailure("production-static mediaRoots must be a non-empty list")
        media_bytes = 0
        for item in media_roots:
            if (not isinstance(item, dict) or not isinstance(item.get("path"), str)
                    or not isinstance(item.get("prefix"), str)
                    or not PREFIX_RE.fullmatch(item["prefix"])):
                raise HostFailure("production-static mediaRoots contains an incomplete entry")
            media_path = Path(item["path"])
            if media_path.is_symlink() or not media_path.is_dir():
                raise HostFailure(f"required media source is unavailable or unsafe: {media_path}")
            media_bytes += _required_static_capture_tree_bytes(media_path)
        # SQLite's read-only backup may materialize WAL pages into the snapshot.
        # Bound each of the two simultaneously present DB copies by DB + WAL.
        production_static_capture_bytes = 2 * (database_bytes + wal_bytes) + media_bytes
    configured_reserve = config.get("spaceReserveBytes", 0)
    if type(configured_reserve) is not int or configured_reserve < 0:
        raise HostFailure("spaceReserveBytes must be a non-negative integer")
    base_needed: dict[int, dict[str, Any]] = {}
    temporary_root = (_validate_staging194_temporary_root(config)
                      if _uses_staging194_temp(config)
                      else Path(tempfile.gettempdir()))
    candidates = [("temporary data", temporary_root, cms_bytes + static_bytes)]
    if operation_kind == "cms-update":
        candidates.append(("CMS releases", Path(config["releaseRoot"]), cms_bytes + static_bytes))
    else:
        candidates.append(("static source releases", Path(config["releaseRoot"]),
                           static_bytes + production_static_capture_bytes))
    candidates.extend((
        ("static releases", Path(config["staticReleaseRoot"]), static_bytes),
        ("operation state", Path(config["stateDir"]), 4096),
    ))
    if operation_kind == "cms-update":
        candidates.append(("backups", Path(config["backupRoot"]), backup_bytes))
        candidates.append(("live database replacement", Path(config["cmsDatabase"]).parent,
                           live_database_bytes))
        cms_home = Path(pwd.getpwnam(config["cmsUser"]).pw_dir)
        candidates.append(("CMS npm cache", cms_home / ".npm", 0))
    if operation_kind == "cms-update" and config.get("siteBuildWorkspaceRoot"):
        candidates.append(("site build workspace", Path(config["siteBuildWorkspaceRoot"]), cms_bytes + static_bytes))
    for label, path, required in candidates:
        while not path.exists():
            path = path.parent
        usage = shutil.disk_usage(path)
        device = path.stat().st_dev
        current = base_needed.get(device)
        if current is None:
            base_needed[device] = {"path": str(path), "labels": [label], "freeBytes": usage.free,
                                   "estimatedBytes": required}
        else:
            current["labels"].append(label)
            current["estimatedBytes"] += required
    for item in base_needed.values():
        proportional_reserve = (item["estimatedBytes"] + 3) // 4
        item["reserveBytes"] = max(1_073_741_824, configured_reserve, proportional_reserve)
        item["requiredBytes"] = item["estimatedBytes"] + item["reserveBytes"]
    installed_source_sha = _installed_paired_cms_source_sha(config)
    report: dict[str, Any] = {"filesystems": list(base_needed.values()),
                              "reservePolicy": "max(1 GiB, configured reserve, 25% of estimate)",
                              "configuredReserveBytes": configured_reserve,
                              "backupBytes": backup_archive_bytes,
                              "installedSourceSha": installed_source_sha,
                              "installedSourceShaStatus": "known" if installed_source_sha else "unknown"}
    if production_static_capture:
        report["staticCaptureBytes"] = production_static_capture_bytes
        if config.get("profile") == "production-static":
            # browser_check exports the current static tree and proof JSON, not
            # the source database, WAL, or capture media. This is an estimate;
            # the current tree does not bound the next build's dist size.
            report["staticExportEstimateBytes"] = static_bytes
    if operation_kind == "cms-update":
        backup_device = Path(config["backupRoot"])
        while not backup_device.exists():
            backup_device = backup_device.parent
        device_item = base_needed[backup_device.stat().st_dev]
        report["backupReserveBytes"] = device_item["reserveBytes"]
        if _uses_staging194_temp(config):
            report["spaceNotes"] = [
                "default npm cache location is shown, but cache growth and npmrc/environment overrides are not separately estimated; filesystem reserve is the only growth allowance"
            ]
    return report


def _root_config(path: Path, expected_profile: str = "staging194") -> dict[str, Any]:
    try:
        info = path.lstat()
    except OSError as error:
        raise HostFailure(f"host config unavailable: {path}: {error}") from error
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise HostFailure("host config must be a root-owned regular file not writable by group/other")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("host config is not valid JSON") from error
    _maintenance_banner(data)
    missing = REQUIRED_CONFIG - data.keys()
    if missing:
        raise HostFailure(f"host config missing fields: {', '.join(sorted(missing))}")
    for name in ("cmsUnit", "nginxService"):
        if not UNIT_RE.fullmatch(data[name]):
            raise HostFailure(f"invalid configured service unit: {name}")
    if not isinstance(data["writerUnits"], list) or not data["writerUnits"]:
        raise HostFailure("writerUnits must name every CMS writer systemd unit")
    if any(not isinstance(unit, str) or not UNIT_RE.fullmatch(unit) for unit in data["writerUnits"]):
        raise HostFailure("writerUnits contains an invalid systemd unit")
    if data["cmsUnit"] not in data["writerUnits"]:
        raise HostFailure("writerUnits must include the CMS service whose database will be replaced")
    for name in ("writerPrefixes", "preservePrefixes"):
        values = data[name]
        if not isinstance(values, list) or not values or any(not isinstance(x, str) or not PREFIX_RE.fullmatch(x) for x in values):
            raise HostFailure(f"{name} must be a non-empty list of literal URI prefixes")
    if not isinstance(data["writerProbeUrls"], list) or len(data["writerProbeUrls"]) != len(data["writerPrefixes"]):
        raise HostFailure("writerProbeUrls must provide one live POST probe for each fenced URI prefix")
    if not isinstance(data["siteProbeUrls"], list) or not data["siteProbeUrls"]:
        raise HostFailure("siteProbeUrls must name the required post-cutover routes")
    if any(a == b or a.startswith(b.rstrip("/") + "/")
           for a in data["writerPrefixes"] for b in data["preservePrefixes"]):
        raise HostFailure("preserved URI prefix is broader than a CMS writer prefix")
    if not isinstance(data["mediaRoots"], list) or not data["mediaRoots"]:
        raise HostFailure("mediaRoots must name the configured media trees")
    for item in data["mediaRoots"]:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("prefix"), str):
            raise HostFailure("mediaRoots entries must have path and URL prefix")
        if item["prefix"] not in ("/uploads/", "/media/"):
            raise HostFailure("mediaRoots prefix must be /uploads/ or /media/")
    for key in ("cmsHealthUrl", "siteHealthUrl", "siteBaseUrl", "siteReleaseUrl", "preserveProbeUrl", "paymentStatusProbeUrl"):
        if not isinstance(data[key], str) or not data[key].startswith(("http://", "https://")):
            raise HostFailure(f"{key} must be an absolute HTTP URL")
    profile = data.get("profile", "staging194")
    path_keys = ["stateDir", "releaseRoot", "staticReleaseRoot", "backupRoot", "maintenanceFlag", "currentCms", "currentStatic",
                 "cmsDatabase", "nginxMapFile", "nginxServerGateFile"]
    if profile in ("staging194", "production-static", "production-paired", "initial-prod"):
        path_keys.append("publicationLock")
    if profile == "production-paired":
        path_keys.append("cmsEnvironmentFile")
    path_keys.extend(("siteRefreshState", "sitePublicationMarker"))
    for key in path_keys:
        value = Path(data[key])
        if not value.is_absolute() or value == Path("/"):
            raise HostFailure(f"{key} must be an absolute non-root path")
    if profile != expected_profile:
        raise HostFailure("host config does not match the selected fixed profile")
    if profile == "staging194":
        _validate_staging194_temporary_root(data)
    if profile in ("initial-prod", "production-static", "production-paired"):
        endpoint = data.get("paymentEndpointProd")
        try:
            parsed_endpoint = urlsplit(endpoint)
            valid_endpoint = (parsed_endpoint.scheme == "https" and bool(parsed_endpoint.hostname)
                             and not parsed_endpoint.username and not parsed_endpoint.password)
        except (TypeError, ValueError):
            valid_endpoint = False
        if not valid_endpoint or parsed_endpoint.geturl() != INITIAL_PROD_PAYMENT_ENDPOINT:
            raise HostFailure("production payment endpoint must match the observed production origin")
    _validate_target_binding(data)
    return data


def _validate_staging194_temporary_root(config: dict[str, Any]) -> Path:
    """Return the fixed shared temp directory only when its ownership is safe."""
    if config.get("temporaryRoot") != str(STAGING194_TEMPORARY_ROOT):
        raise HostFailure("staging194 temporaryRoot must use the fixed host path")
    try:
        cms_user = pwd.getpwnam(config["cmsUser"])
        for directory in (Path("/"), Path("/var"), STAGING194_TEMPORARY_ROOT.parent):
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
                raise HostFailure("staging194 temporary path parents must be real root-owned directories")
            if directory == STAGING194_TEMPORARY_ROOT.parent:
                if not info.st_mode & stat.S_ISVTX:
                    raise HostFailure("staging194 temporary parent must be sticky")
            elif info.st_mode & 0o022:
                raise HostFailure("staging194 temporary path parent is writable by group or other")
        info = STAGING194_TEMPORARY_ROOT.lstat()
    except OSError as error:
        raise HostFailure(f"staging194 temporary directory is unavailable or unsafe: {error}") from error
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != cms_user.pw_gid
            or stat.S_IMODE(info.st_mode) != 0o1770):
        raise HostFailure("staging194 temporary directory must be root-owned, CMS-grouped, and mode 1770")
    return STAGING194_TEMPORARY_ROOT


def _validate_target_binding(data: dict[str, Any]) -> None:
    profile = data.get("profile", "staging194")
    if profile == "staging194":
        if data["allowedSourceRef"] not in ("refs/heads/main", "refs/heads/dev") or data["targetHost"] != TARGET_HOST:
            raise HostFailure("host config is not bound to the staging194 target/source policy")
        if (data.get("siteRefreshState") != "/var/lib/ikpk-cms-prototype193/staging/site-refresh194/state/state.json"
                or data.get("publicationLock") != str(PRODUCTION_PUBLICATION_LOCK)
                or data.get("sitePublicationMarker") != "/var/lib/ikpk-rehearsal/site-publication/host-publication.json"):
            raise HostFailure("staging194 site publication coordination paths are not fixed")
        if data["cmsHealthUrl"] != "http://127.0.0.1:1338/_health":
            raise HostFailure("CMS health check must remain bound to the local staging194 service")
        expected_origin = f"https://{TARGET_HOST}"
    elif profile == "initial-prod":
        if (data.get("allowedSourceRef") != "refs/heads/main" or data.get("targetHost") != INITIAL_PROD_HOST
                or data.get("initialOperationId") != INITIAL_PROD_OPERATION_ID):
            raise HostFailure("host config is not bound to the fixed initial-prod operation")
        if data.get("siteBaseUrl") != "https://ikpk.su" or data.get("cmsHealthUrl") != "http://127.0.0.1:1337/_health":
            raise HostFailure("initial-prod origin or local CMS health endpoint is not fixed")
        if (data.get("siteRefreshState") != "/var/www/ikpk/shared/site-refresh/state.json"
                or data.get("publicationLock") != str(PRODUCTION_PUBLICATION_LOCK)
                or data.get("sitePublicationMarker") != "/var/lib/ikpk-rehearsal/site-publication/host-publication.json"):
            raise HostFailure("initial-prod site publication coordination paths are not fixed")
        expected_origin = "https://ikpk.su"
    elif profile == "production-static":
        if data.get("allowedSourceRef") != "refs/heads/main" or data.get("targetHost") != INITIAL_PROD_HOST:
            raise HostFailure("host config is not bound to the production-static main source policy")
        if (data.get("siteBaseUrl") != "https://ikpk.su" or data.get("cmsHealthUrl") != "http://127.0.0.1:1337/_health"
                or data.get("currentCms") != "/opt/ikpk-cms/current"
                or data.get("cmsDatabase") != "/var/lib/ikpk-cms/trial/data/data.db"
                or data.get("currentStatic") != "/var/www/ikpk/current"
                or data.get("siteRefreshState") != "/var/www/ikpk/shared/site-refresh/state.json"
                or data.get("publicationLock") != str(PRODUCTION_PUBLICATION_LOCK)
                or data.get("sitePublicationMarker") != "/var/lib/ikpk-rehearsal/site-publication/host-publication.json"
                or data.get("staticReleaseRoot") != "/var/www/ikpk/releases"
                or data.get("stateDir") != "/var/lib/ikpk-rehearsal/production-static"
                or data.get("backupRoot") != "/var/lib/ikpk-rehearsal/production-static/backups"
                or data.get("releaseRoot") != "/var/lib/ikpk-rehearsal/production-static-sources"
                or data.get("staticMainReleasePolicy") != "ci-only-approved"
                or data.get("mediaRoots") != [
                    {"path": "/opt/ikpk-cms/shared/uploads", "prefix": "/uploads/"},
                    {"path": "/var/www/ikpk/current/media", "prefix": "/media/"}]
                or data.get("cmsUnit") != "ikpk-cms.service"):
            raise HostFailure("production-static config is not bound to current production CMS data")
        expected_origin = "https://ikpk.su"
    elif profile == "production-paired":
        if (data.get("allowedSourceRef") != "refs/heads/main" or data.get("targetHost") != INITIAL_PROD_HOST
                or data.get("siteBaseUrl") != "https://ikpk.su"
                or data.get("cmsHealthUrl") != "http://127.0.0.1:1337/_health"
                or data.get("currentCms") != "/opt/ikpk-cms/current"
                or data.get("cmsDatabase") != "/var/lib/ikpk-cms/trial/data/data.db"
                or data.get("currentStatic") != "/var/www/ikpk/current"
                or data.get("siteRefreshState") != "/var/www/ikpk/shared/site-refresh/state.json"
                or data.get("sitePublicationMarker") != "/var/lib/ikpk-rehearsal/site-publication/host-publication.json"
                or data.get("staticReleaseRoot") != "/var/www/ikpk/releases"
                or data.get("stateDir") != "/var/lib/ikpk-rehearsal/production-paired"
                or data.get("backupRoot") != "/var/lib/ikpk-rehearsal/production-paired/backups"
                or data.get("releaseRoot") != "/opt/ikpk-cms/releases"
                or data.get("maintenanceFlag") != "/var/lib/ikpk-rehearsal/production-paired/fenced"
                or data.get("publicationLock") != str(PRODUCTION_PUBLICATION_LOCK)
                or data.get("siteBuildWorkspaceRoot") != str(PRODUCTION_PAIRED_WORKSPACE_ROOT)
                or data.get("cmsEnvironmentFile") != "/etc/ikpk-cms/trial.env"
                or data.get("siteRefreshState") != "/var/www/ikpk/shared/site-refresh/state.json"
                or data.get("cmsUnit") != "ikpk-cms.service"
                or data.get("mediaRoots") != [
                    {"path": "/opt/ikpk-cms/shared/uploads", "prefix": "/uploads/"},
                    {"path": "/var/www/ikpk/current/media", "prefix": "/media/"}]
                or data.get("paymentEndpointProd") != INITIAL_PROD_PAYMENT_ENDPOINT
                or data.get("chatLoaderSrc") != INITIAL_PROD_CHAT_LOADER_SRC):
            raise HostFailure("production-paired config is not bound to current production CMS data and publication lock")
        expected_origin = "https://ikpk.su"
    else:
        raise HostFailure("unknown rehearsal profile")
    urls = [data[key] for key in ("siteHealthUrl", "siteBaseUrl", "siteReleaseUrl",
                                  "preserveProbeUrl", "paymentStatusProbeUrl")]
    for key in ("siteProbeUrls", "writerProbeUrls"):
        if not isinstance(data[key], list):
            raise HostFailure(f"{key} must be a list of staging194 URLs")
        urls.extend(data[key])
    for value in urls:
        try:
            parsed = urlsplit(value)
            valid = (parsed.scheme == "https" and parsed.hostname == urlsplit(expected_origin).hostname
                     and parsed.port is None and not parsed.username and not parsed.password)
        except (TypeError, ValueError):
            valid = False
        if not valid:
            raise HostFailure("host config probe URLs must use the fixed staging194 HTTPS origin")


@contextmanager
def _destination_publication_lock(config: dict[str, Any], *, wait: bool = False):
    """Serialize host work with publication-remote on the fixed destination inode."""
    path = Path(config.get("publicationLock", PRODUCTION_PUBLICATION_LOCK))
    if path != PRODUCTION_PUBLICATION_LOCK:
        raise HostFailure("shared publication lock path is not fixed")
    try:
        before = path.lstat()
    except FileNotFoundError as error:
        raise HostFailure("shared publication lock is missing; writers cannot be serialized") from error
    try:
        expected_uid = pwd.getpwnam(config["cmsUser"]).pw_uid
    except (KeyError, OSError) as error:
        raise HostFailure("configured publication lock owner is unknown") from error
    try:
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != expected_uid
                or stat.S_IMODE(before.st_mode) != 0o600):
            raise HostFailure("shared publication lock must be a 0600 regular file owned by the configured CMS user")
        fd = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
    except OSError as error:
        raise HostFailure("shared publication lock is unavailable") from error
    try:
        info = os.fstat(fd)
        if ((info.st_dev, info.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1 or info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o600):
            raise HostFailure("shared publication lock changed or has unsafe owner/permissions")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise HostFailure("another publisher holds the destination lock") from error
        opened = os.fstat(fd)
        try:
            named = path.lstat()
        except OSError as error:
            raise HostFailure("shared publication lock changed while waiting") from error
        if ((opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)
                or not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(named.st_mode)
                or opened.st_nlink != 1 or named.st_nlink != 1
                or opened.st_uid != expected_uid or named.st_uid != expected_uid
                or stat.S_IMODE(opened.st_mode) != 0o600 or stat.S_IMODE(named.st_mode) != 0o600):
            raise HostFailure("shared publication lock changed or has unsafe owner/permissions")
        yield
    finally:
        os.close(fd)


def _site_marker_path(config: dict[str, Any]) -> Path:
    expected = SITE_PUBLICATION_MARKER_DIR / SITE_PUBLICATION_MARKER
    if config.get("sitePublicationMarker") != str(expected):
        raise HostFailure("site-publication marker path is not the fixed protected path")
    return expected


def _config_path_for_profile(profile: str) -> Path:
    paths = {
        "staging194": CONFIG_PATH,
        "initial-prod": INITIAL_PROD_CONFIG_PATH,
        "production-static": PRODUCTION_STATIC_CONFIG_PATH,
        "production-paired": PRODUCTION_PAIRED_CONFIG_PATH,
    }
    try:
        return paths[profile]
    except KeyError as error:
        raise HostFailure("site-publication marker names an unsupported cleanup profile") from error


def _select_cleanup_profile(config: dict[str, Any], profile: str) -> tuple[dict[str, Any], str, Optional[dict[str, Any]]]:
    """Use the marker's fixed profile config so cleanup reads its owning journal."""
    marker = _read_site_publication_marker(config)
    if marker is None:
        return config, profile, None
    marker_profile = marker["profile"]
    config_path = _config_path_for_profile(marker_profile)
    if marker_profile == profile:
        return config, profile, marker
    selected = _root_config(config_path, expected_profile=marker_profile)
    if (selected.get("sitePublicationMarker") != config.get("sitePublicationMarker")
            or selected.get("staticReleaseRoot") != config.get("staticReleaseRoot")
            or selected.get("currentStatic") != config.get("currentStatic")):
        raise HostFailure("site-publication profile does not match the fixed cleanup target")
    return selected, marker_profile, marker


def _read_site_publication_marker(config: dict[str, Any]) -> Optional[dict[str, Any]]:
    path = _site_marker_path(config)
    try:
        parent = path.parent.lstat()
        cms_gid = pwd.getpwnam(config["cmsUser"]).pw_gid
    except (OSError, KeyError) as error:
        raise HostFailure("site-publication marker directory is unavailable; coordination is unknown") from error
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_gid != cms_gid
            or stat.S_IMODE(parent.st_mode) != 0o750):
        raise HostFailure("site-publication marker directory is unsafe; coordination is unknown")
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0
            or info.st_gid != cms_gid or stat.S_IMODE(info.st_mode) != 0o640):
        raise HostFailure("site-publication marker is unsafe; operator recovery is required")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("site-publication marker is unreadable; operator recovery is required") from error
    if (not isinstance(value, dict) or value.get("version") != 1
            or not isinstance(value.get("operationId"), str)
            or not isinstance(value.get("profile"), str)
            or value.get("phase") not in ("active", "cleanup-pending")
            or (value.get("lastError") is not None and not isinstance(value.get("lastError"), str))):
        raise HostFailure("site-publication marker is invalid; operator recovery is required")
    return value


def _write_site_publication_marker(config: dict[str, Any], operation_id: str, phase: str = "active",
                                   last_error: Optional[str] = None) -> None:
    path = _site_marker_path(config)
    parent = path.parent.lstat()
    cms_gid = pwd.getpwnam(config["cmsUser"]).pw_gid
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_gid != cms_gid
            or stat.S_IMODE(parent.st_mode) != 0o750):
        raise HostFailure("site-publication marker directory must be root-owned 0750 and readable by CMS group")
    existing = _read_site_publication_marker(config)
    if existing and existing["operationId"] != operation_id:
        raise HostFailure("another site publication owns the shared marker; recover it first")
    try:
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            try:
                os.fchmod(fd, 0o640)
                os.fchown(fd, 0, cms_gid)
                record = {"version": 1, "operationId": operation_id,
                          "profile": config.get("profile", "staging194"), "phase": phase}
                if last_error:
                    record["lastError"] = str(last_error)[:500]
                payload = json.dumps(record,
                                     sort_keys=True, separators=(",", ":")).encode() + b"\n"
                os.write(fd, payload)
                os.fsync(fd)
                os.replace(temporary, path)
                os.fsync(directory)
            finally:
                os.close(fd)
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
        finally:
            os.close(directory)
    except OSError as error:
        raise HostFailure("could not durably write site-publication marker") from error


def _clear_site_publication_marker(config: dict[str, Any], operation_id: str) -> None:
    marker = _read_site_publication_marker(config)
    if marker is None:
        return
    if marker["operationId"] != operation_id:
        raise HostFailure("site-publication marker belongs to another operation")
    path = _site_marker_path(config)
    path.unlink()
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _assert_site_publication_admission(config: dict[str, Any], profile: str, action: str,
                                      operation_id: Optional[str], unfinished: set[str], *,
                                      allow_cleanup_pending_rollback: bool = False,
                                      allow_cleanup_pending_finalize: bool = False,
                                      allow_marker_recreation: bool = False) -> None:
    if action == "cleanup-site":
        if unfinished:
            raise HostFailure("host publication journal has an unfinished operation; recover it first")
        return
    if unfinished and operation_id not in unfinished:
        raise HostFailure("another host publication is unfinished; recover it first")
    marker = _read_site_publication_marker(config)
    if marker is not None:
        same_operation = marker["profile"] == profile and marker["operationId"] == operation_id
        if same_operation and marker["phase"] == "active":
            return
        if (same_operation and marker["phase"] == "cleanup-pending"
                and action == "static-main-recover" and allow_cleanup_pending_rollback):
            return
        if (same_operation and marker["phase"] == "cleanup-pending"
                and action == "finalize-recover" and allow_cleanup_pending_finalize):
            return
        if not same_operation or marker["phase"] != "active":
            raise HostFailure("another or unresolved host publication owns the shared marker")
    recovery_actions = {"cms-update", "static-main", "static-main-recover", "static-publish",
                        "recover", "restore", "finalize-recover"}
    if operation_id in unfinished and action in recovery_actions and allow_marker_recreation:
        _write_site_publication_marker(config, operation_id)


def _consume_site_cleanup_request(config: dict[str, Any]) -> None:
    request = Path(config["siteRefreshState"]).parent / "cleanup.request"
    try:
        info = request.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise HostFailure("site cleanup request is unsafe; housekeeping refused")
    try:
        value = json.loads(request.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("site cleanup request is unreadable; housekeeping refused") from error
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("releaseId"), str):
        raise HostFailure("site cleanup request is malformed; housekeeping refused")
    before = request.lstat()
    if (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino):
        raise HostFailure("site cleanup request changed while being read")
    request.unlink()
    directory_fd = os.open(request.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _mount_points() -> set[Path]:
    try:
        lines = Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise HostFailure("cannot inspect mount points before release cleanup") from error
    result = set()
    for line in lines:
        fields = line.split()
        if len(fields) < 5:
            raise HostFailure("mount table is malformed; release cleanup refused")
        decoded = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), fields[4])
        result.add(Path(decoded))
    return result


def _remove_release_tree(path: Path, mount_points: set[Path]) -> None:
    if not getattr(shutil.rmtree, "avoids_symlink_attacks", False):
        raise HostFailure("safe symlink-resistant release removal is unavailable")
    before = path.lstat()
    if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
        raise HostFailure("release cleanup encountered a non-directory candidate")
    if any(point == path or path in point.parents for point in mount_points):
        raise HostFailure("release cleanup candidate contains a mount point")
    shutil.rmtree(path)


def _verified_cleanup_backup(directory: Path, operation_id: str, expected_database: str) -> bool:
    """Validate an existing operation backup without extraction or writes."""
    import sqlite3
    try:
        if directory.is_symlink() or not directory.is_dir():
            return False
        manifest_path = directory / "manifest.json"
        database = directory / "database.sqlite"
        media_path = directory / "media-manifest.json"
        archive = directory / "backup.tar"
        for path in (manifest_path, database, media_path, archive):
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                return False
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        media_doc = json.loads(media_path.read_text(encoding="utf-8"))
        if (not isinstance(manifest, dict) or not isinstance(media_doc, dict)
                or manifest.get("operationId") != operation_id
                or manifest.get("database") != expected_database
                or not SHA256_RE.fullmatch(str(manifest.get("databaseSha256", "")))
                or not SHA256_RE.fullmatch(str(manifest.get("mediaManifestSha256", "")))
                or not SHA256_RE.fullmatch(str(manifest.get("archiveSha256", "")))
                or sha256_file(database) != manifest["databaseSha256"]
                or sha256_file(media_path) != manifest["mediaManifestSha256"]
                or sha256_file(archive) != manifest["archiveSha256"]
                or not isinstance(media_doc.get("media"), list)
                or manifest.get("media") != media_doc["media"]):
            return False
        checked = sqlite3.connect(f"file:{quote(str(database))}?mode=ro", uri=True)
        try:
            if checked.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                return False
        finally:
            checked.close()
        expected = {"manifest.json", "database.sqlite", "media-manifest.json"}
        for item in media_doc["media"]:
            if not isinstance(item, dict):
                return False
            relative = item.get("file")
            digest = item.get("sha256")
            size = item.get("size")
            if (not SHA256_RE.fullmatch(str(digest)) or relative != f"media/sha256:{digest}"
                    or type(size) is not int or size < 0):
                return False
            media_file = directory / relative
            media_info = media_file.lstat()
            if (not stat.S_ISREG(media_info.st_mode) or media_info.st_nlink != 1
                    or media_info.st_size != size or sha256_file(media_file) != digest):
                return False
            expected.add(relative)
        with tarfile.open(archive, "r|") as bundle:
            names = set()
            canonical_names = set()
            files = set()
            for member in bundle:
                name = member.name
                relative = name.removeprefix("./")
                if (name.startswith("/") or ".." in Path(name).parts or not relative
                        or Path(relative).as_posix() != relative or relative in canonical_names or name in names
                        or not (member.isfile() or member.isdir())):
                    return False
                names.add(name)
                canonical_names.add(relative)
                if member.isfile():
                    files.add(relative)
                    source = bundle.extractfile(member)
                    if source is None:
                        return False
                    if relative == "manifest.json":
                        embedded = {key: value for key, value in manifest.items() if key != "archiveSha256"}
                        expected_manifest = (json.dumps(embedded, sort_keys=True, separators=(",", ":")) + "\n").encode()
                        if source.read() != expected_manifest:
                            return False
                        continue
                    digest = hashlib.sha256()
                    while True:
                        block = source.read(1024 * 1024)
                        if not block:
                            break
                        digest.update(block)
                    local = directory / relative
                    if not local.is_file() or digest.hexdigest() != sha256_file(local):
                        return False
            if expected != files:
                return False
        return True
    except (OSError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError, sqlite3.Error):
        return False


def _operation_backup_cleanup_candidates(backup_root: Path, history: list[dict], expected_database: str, *, keep: int = 2
                                        ) -> tuple[list[Path], Optional[str]]:
    starts = {row["operationId"]: row for row in history if row.get("record") == "start"
              and row.get("operationKind") is None}
    terminal_order = []
    for row in history:
        operation_id = row.get("operationId")
        if (row.get("record") in ("committed", "recovered") and operation_id in starts
                and operation_id not in terminal_order):
            terminal_order.append(operation_id)
    verified = []
    for operation_id in terminal_order:
        candidate = backup_root / operation_id
        old_pair = starts[operation_id].get("oldPair")
        database_proof = old_pair.get("cmsDatabaseProof") if isinstance(old_pair, dict) else None
        journal_database = database_proof.get("database") if isinstance(database_proof, dict) else None
        if (journal_database == expected_database
                and _verified_cleanup_backup(candidate, operation_id, expected_database)):
            verified.append(candidate)
    if len(verified) < keep:
        return [], f"found {len(verified)} verified terminal operation backups; retaining all"
    preserve = set(verified[-keep:]) if keep else set()
    return [path for path in verified if path not in preserve], None


def _cleanup_operation_backups(config: dict[str, Any], history: list[dict], marker: Optional[dict],
                               operation_id: Optional[str], mounts: set[Path]) -> list[str]:
    print("IKPK housekeeping: CMS source release cleanup skipped; systemd EnvironmentFiles can change the restart workspace without changing the live process environment", file=sys.stderr)
    backup_root = Path(config["backupRoot"])
    root_info = backup_root.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise HostFailure("operation backup root is unsafe; cleanup refused")
    try:
        expected_database = str(Path(config["cmsDatabase"]).resolve(strict=True))
    except (OSError, KeyError, ValueError):
        print("IKPK housekeeping: backup cleanup skipped: configured CMS database path is unavailable", file=sys.stderr)
        return []
    backup_candidates, retention_note = _operation_backup_cleanup_candidates(
        backup_root, history, expected_database, keep=2)
    if retention_note:
        print(f"IKPK housekeeping: backup cleanup skipped: {retention_note}", file=sys.stderr)
    protected_ids = {operation_id} if operation_id else set()
    if marker and isinstance(marker.get("operationId"), str):
        protected_ids.add(marker["operationId"])
    removed_backups = []
    for path in backup_candidates:
        if path.name in protected_ids:
            continue
        _remove_release_tree(path, mounts)
        removed_backups.append(str(path))
    return removed_backups


def _expire_site_restore(config: dict[str, Any], current_name: str, *, cleanup_pending: bool) -> None:
    state_path = Path(config["siteRefreshState"])
    try:
        info = state_path.lstat()
    except FileNotFoundError:
        previous = {}
        cms = pwd.getpwnam(config["cmsUser"])
        owner, group, mode = cms.pw_uid, cms.pw_gid, 0o640
    else:
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise HostFailure("site-refresh state is unsafe; release cleanup refused")
        owner, group, mode = info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)
        try:
            previous = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HostFailure("site-refresh state is unreadable; release cleanup refused") from error
        if (not isinstance(previous, dict) or previous.get("status") not in
                ("idle", "failed", "interrupted", "succeeded", "verification-failed")):
            raise HostFailure("site-refresh state is active or unknown; release cleanup refused")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    record = {"status": "succeeded", "phase": "done",
              "message": ("Сайт обновлён. Удаляются предыдущие релизы после проверки."
                          if cleanup_pending else "Сайт обновлён. Предыдущий релиз удалён после проверки."),
              "releaseId": current_name, "previousReleaseId": None,
              "cleanupPending": cleanup_pending,
              "buildArtifactsCleanupPending": previous.get("buildArtifactsCleanupPending") is True,
              "siteUrl": config.get("siteBaseUrl"),
              "startedAt": previous.get("startedAt") or now,
              "finishedAt": now, "switched": True}
    directory = state_path.parent
    if directory.is_symlink() or not directory.is_dir():
        raise HostFailure("site-refresh state directory is unsafe; release cleanup refused")
    fd, temporary = tempfile.mkstemp(prefix=f".{state_path.name}.", dir=directory)
    try:
        os.fchown(fd, owner, group)
        os.fchmod(fd, mode)
        payload = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if os.write(fd, payload) != len(payload):
            raise HostFailure("site-refresh state write was incomplete")
        os.fsync(fd)
        os.replace(temporary, state_path)
        dir_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _cleanup_site_releases(config: dict[str, Any], state: RehearsalState,
                           operation_id: Optional[str], *, close_marker: bool = True) -> list[str]:
    try:
        # This must precede every journal query: the normal reader repairs a
        # torn tail, which could erase an unfinished rollback intent.
        history = state.read_journal_for_cleanup(validate_history=True)
    except RehearsalRefusal as error:
        raise HostFailure(str(error)) from error

    def operation_rows(target: str) -> list[dict]:
        return [row for row in history if row.get("operationId") == target]

    marker = _read_site_publication_marker(config)
    if operation_id is None and marker is not None and marker["phase"] != "cleanup-pending":
        rows = operation_rows(marker["operationId"])
        terminal = any(row.get("record") in ("committed", "recovered", "static-main-committed",
                                                "static-main-recovered", "static-main-rolled-back",
                                                "static-main-rollback-completed") for row in rows)
        if not terminal:
            raise HostFailure("a host publication is active; CMS cleanup must retry after it finishes")
        _write_site_publication_marker(config, marker["operationId"], "cleanup-pending")
        marker = _read_site_publication_marker(config)
    if operation_id is not None and marker is not None and marker["operationId"] != operation_id:
        raise HostFailure("release cleanup marker belongs to another operation")
    if state._unfinished_operation_ids(history):
        raise HostFailure("another publication is unfinished; release cleanup refused")
    configured_root = Path(config["staticReleaseRoot"])
    root_info = configured_root.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise HostFailure("static release root is unsafe; cleanup refused")
    root = configured_root.resolve(strict=True)
    current = _current_target(Path(config["currentStatic"])).resolve(strict=True)
    if current.parent != root.resolve(strict=True):
        raise HostFailure("current static release is not a direct child of its configured root")
    site_state_path = Path(config["siteRefreshState"])
    try:
        site_state = json.loads(site_state_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        site_state = None
    except (OSError, ValueError) as error:
        raise HostFailure("CMS site-refresh state is unreadable; release cleanup refused") from error
    if site_state is not None and (not isinstance(site_state, dict) or site_state.get("status") not in
                                   ("idle", "failed", "succeeded")):
        raise HostFailure("CMS refresh or Restore is active or unresolved; release cleanup refused")
    if operation_id is None:
        cms_state = site_state
        cms_success = (isinstance(cms_state, dict) and cms_state.get("status") == "succeeded"
                       and cms_state.get("phase") == "done" and cms_state.get("switched") is True
                       and cms_state.get("releaseId") == current.name)
        if marker is None:
            if not cms_success or cms_state.get("cleanupPending") is not True:
                return []
            operation_id = f"cms-{current.name}"
            _write_site_publication_marker(config, operation_id, "cleanup-pending")
            marker = _read_site_publication_marker(config)
        operation_id = marker["operationId"]
        if not cms_success:
            rows = operation_rows(operation_id)
            terminal = any(row.get("record") in ("committed", "recovered", "static-main-committed",
                                                    "static-main-recovered", "static-main-rolled-back",
                                                    "static-main-rollback-completed") for row in rows)
            if not terminal:
                raise HostFailure("pending marker has no durable successful publication record")
    else:
        rows = operation_rows(operation_id)
        terminal = any(row.get("record") in ("committed", "recovered", "static-main-committed",
                                                "static-main-recovered", "static-main-rolled-back",
                                                "static-main-rollback-completed") for row in rows)
        if not terminal:
            raise HostFailure("release cleanup requires a durable terminal publication record")
        _write_site_publication_marker(config, operation_id, "cleanup-pending")
        marker = _read_site_publication_marker(config)
    protected = {current}
    for pointer in root.parent.glob(".current-next-*"):
        before = pointer.lstat()
        if not stat.S_ISLNK(before.st_mode):
            raise HostFailure("temporary current pointer is not a symlink; cleanup refused")
        match = re.fullmatch(r"\.current-next-([A-Za-z0-9][A-Za-z0-9._-]{0,127})", pointer.name)
        if not match:
            raise HostFailure("temporary current pointer name is unknown; cleanup refused")
        try:
            target = pointer.resolve(strict=True)
            link_text = os.readlink(pointer)
        except OSError as error:
            raise HostFailure("temporary current pointer is unreadable; cleanup refused") from error
        if (target.parent != root or target.name != match.group(1)
                or link_text != f"releases/{match.group(1)}"):
            raise HostFailure("temporary current pointer target is not the exact release child")
        after = pointer.lstat()
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise HostFailure("temporary current pointer changed during cleanup")
        pointer.unlink()
        dir_fd = os.open(root.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    for pointer in root.parent.glob(".current.new-*"):
        try:
            if not pointer.is_symlink():
                raise HostFailure("temporary current pointer is not a symlink; cleanup refused")
            target = pointer.resolve(strict=True)
        except OSError as error:
            raise HostFailure("temporary current pointer is unreadable; cleanup refused") from error
        if target.parent != root.resolve(strict=True):
            raise HostFailure("temporary current pointer escapes the release root")
        protected.add(target)
    for key in ("siteBuildWorkspaceRoot", "releaseRoot", "backupRoot"):
        value = config.get(key)
        if not value:
            continue
        workspace = Path(value).resolve(strict=True)
        if workspace.parent == root.resolve(strict=True):
            protected.add(workspace)
        elif root.resolve(strict=True) in workspace.parents:
            protected.add(root.resolve(strict=True) / workspace.relative_to(root.resolve(strict=True)).parts[0])
    _expire_site_restore(config, current.name, cleanup_pending=True)
    mounts = _mount_points()
    removed = []
    for candidate in sorted(root.iterdir()):
        if candidate.name.startswith("."):
            continue
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise HostFailure("unexpected symlink in static release root; cleanup refused")
        if not stat.S_ISDIR(info.st_mode) or candidate in protected:
            continue
        release_file = candidate / "release.json"
        try:
            release_info = release_file.lstat()
            release = json.loads(release_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HostFailure("unidentified directory in static release root; cleanup refused") from error
        if (not stat.S_ISREG(release_info.st_mode) or release_info.st_nlink != 1
                or not isinstance(release, dict)
                or not re.fullmatch(r"[a-f0-9]{40}", str(release.get("commit", "")))
                or not isinstance(release.get("snapshotId"), str)
                or not release["snapshotId"].startswith("snap:")):
            raise HostFailure("unverified directory in static release root; cleanup refused")
        _remove_release_tree(candidate, mounts)
        removed.append(str(candidate))
    if "backupRoot" in config:
        removed.extend(_cleanup_operation_backups(config, history, marker, operation_id, mounts))
    _expire_site_restore(config, current.name, cleanup_pending=False)
    if close_marker and marker is not None and operation_id is not None:
        _clear_site_publication_marker(config, operation_id)
    return removed


def _cleanup_after_commit(config: dict[str, Any], state: RehearsalState, operation_id: str) -> dict[str, Any]:
    try:
        return {"removedReleases": _cleanup_site_releases(config, state, operation_id)}
    except (HostFailure, OSError, ValueError) as error:
        try:
            marker = _read_site_publication_marker(config)
            if marker is not None and marker["operationId"] == operation_id:
                _write_site_publication_marker(config, operation_id, "cleanup-pending", str(error))
        except (HostFailure, OSError, ValueError):
            pass
        return {"cleanupPending": True, "cleanupError": str(error)[:500]}


def _save_bytes(path: Path, payload: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.is_symlink():
        raise HostFailure(f"refusing symlink parent: {path.parent}")
    temporary = path.with_name(f".{path.name}.new-{os.getpid()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _nginx_worker_pids(config: dict[str, Any]) -> set[int]:
    master = run(["/usr/bin/systemctl", "show", config["nginxService"], "-p", "MainPID", "--value"],
                 timeout=15).stdout.strip()
    if not master.isdecimal() or int(master) < 2:
        raise HostFailure("nginx master PID is unavailable; refusing production request drain")
    result: set[int] = set()
    try:
        for entry in Path("/proc").iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                stat_fields = (entry / "stat").read_text(encoding="ascii").rsplit(")", 1)[1].split()
                command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            except (OSError, IndexError):
                continue
            if len(stat_fields) > 1 and stat_fields[1] == master and command.startswith("nginx: worker process"):
                result.add(int(entry.name))
    except OSError as error:
        raise HostFailure("cannot inspect nginx workers before production request drain") from error
    if not result:
        raise HostFailure("nginx has no inspectable workers; refusing production request drain")
    return result


def _wait_nginx_workers_exit(pids: set[int], timeout: int = 3600) -> None:
    deadline = time.monotonic() + timeout
    while any(Path("/proc", str(pid)).exists() for pid in pids):
        if time.monotonic() >= deadline:
            raise HostFailure("old nginx workers did not drain; CMS remains running and gated")
        time.sleep(1)


def _write_gate(config: dict[str, Any], enabled: bool) -> None:
    production_drain = enabled and config.get("profile") == "production-paired"
    old_workers: set[int] = set()
    if production_drain:
        old_workers = _nginx_worker_pids(config)
        current = run([config["nginxBinary"], "-T"], timeout=30)
        active_config = current.stdout + current.stderr
        for line in active_config.splitlines():
            match = re.match(r"^\s*worker_shutdown_timeout\s+(\S+)\s*;", line)
            if match and not re.fullmatch(r"0(?:s|m|h)?", match.group(1)):
                raise HostFailure("nginx worker_shutdown_timeout can terminate accepted requests; refusing production drain")
    expressions = [re.escape(prefix.rstrip("/")) for prefix in config["writerPrefixes"]]
    exceptions = [re.escape(prefix.rstrip("/")) for prefix in config["preservePrefixes"]]
    lines = ["# managed by ikpk-rehearsal; included from nginx http context",
             'map "$request_method:$uri" $ikpk_rehearsal_write_block {', "    default 0;"]
    for prefix in exceptions:
        lines.append(f"    ~*^(POST|PUT|PATCH|DELETE):{prefix}(?:/|$) 0;")
    if enabled:
        for prefix in expressions:
            lines.append(f"    ~*^(POST|PUT|PATCH|DELETE):{prefix}(?:/|$) 1;")
    lines.extend(["}", ""])
    map_bytes = "\n".join(lines).encode()
    # The fixed setup binds this server-level include to every CMS-proxy vhost; no locations are added.
    server_bytes = ("# managed by ikpk-rehearsal; included from each configured CMS-proxy vhost\n"
                    "if ($ikpk_rehearsal_write_block) { return 503; }\n").encode()
    map_path = Path(config["nginxMapFile"])
    server_path = Path(config["nginxServerGateFile"])
    old_map = map_path.read_bytes() if map_path.exists() else None
    old_server = server_path.read_bytes() if server_path.exists() else None
    try:
        _save_bytes(map_path, map_bytes, 0o644)
        _save_bytes(server_path, server_bytes, 0o644)
        probe = run([config["nginxBinary"], "-T"], timeout=30)
        active = probe.stdout + probe.stderr
        for required in (str(map_path), str(server_path), "ikpk_rehearsal_write_block"):
            if required not in active:
                raise HostFailure(f"nginx effective config does not include expected gate: {required}")
        run([config["nginxBinary"], "-t"], timeout=30)
        run(["/usr/bin/systemctl", "reload", config["nginxService"]], timeout=30)
        if production_drain:
            _wait_nginx_workers_exit(old_workers)
    except Exception:
        if old_map is None:
            map_path.unlink(missing_ok=True)
        else:
            _save_bytes(map_path, old_map, 0o644)
        if old_server is None:
            server_path.unlink(missing_ok=True)
        else:
            _save_bytes(server_path, old_server, 0o644)
        # Keep the durable maintenance flag on failures. Restore the previous Nginx files,
        # check the restored configuration, and leave the writer gate closed at systemd level.
        run([config["nginxBinary"], "-t"], timeout=30, check=False)
        raise


def _set_flag(config: dict[str, Any], enabled: bool) -> None:
    flag = Path(config["maintenanceFlag"])
    if enabled:
        _save_bytes(flag, b"fenced\n", 0o600)
    else:
        flag.unlink(missing_ok=True)
        fd = os.open(flag.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _stop_writers(config: dict[str, Any]) -> None:
    # Stop every named writer and verify inactive after each unit transition.
    for unit in config["writerUnits"]:
        run(["/usr/bin/systemctl", "stop", unit], timeout=60)
    active = [unit for unit in config["writerUnits"] if run(["/usr/bin/systemctl", "is-active", unit], check=False).returncode == 0]
    if active:
        raise HostFailure(f"writer units remain active: {', '.join(active)}")


def _assert_no_database_handles(database: Path) -> None:
    expected = set()
    for path in (database, Path(str(database) + "-wal"), Path(str(database) + "-shm")):
        try:
            info = path.resolve(strict=True).stat()
        except FileNotFoundError:
            continue
        expected.add((info.st_dev, info.st_ino))
    matches = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        fd_root = proc / "fd"
        try:
            descriptors = tuple(fd_root.iterdir())
        except OSError:
            continue
        for descriptor in descriptors:
            try:
                info = descriptor.stat()
            except (OSError, RuntimeError):
                continue
            if (info.st_dev, info.st_ino) in expected:
                matches.append(proc.name)
                break
    if matches:
        raise HostFailure(f"SQLite database still has open process handles: {', '.join(matches)}")


def _service_pid(unit: str) -> int:
    result = run(["/usr/bin/systemctl", "show", "--property=MainPID", "--value", unit])
    try:
        pid = int(result.stdout.strip())
    except ValueError as error:
        raise HostFailure("systemd returned an invalid CMS MainPID") from error
    if pid <= 1:
        raise HostFailure("CMS service has no live MainPID")
    return pid


def _initial_prod_baseline_db_reference(config: dict[str, Any], database: Path) -> dict[str, Any]:
    """Describe the verified inactive baseline without inventing a process/FD proof."""
    unit = config["cmsUnit"]
    active = run(["/usr/bin/systemctl", "show", "--property=ActiveState", "--value", unit]).stdout.strip()
    pid_raw = run(["/usr/bin/systemctl", "show", "--property=MainPID", "--value", unit]).stdout.strip()
    if active != "inactive" or pid_raw != "0":
        raise HostFailure("initial-prod baseline must remain inactive with MainPID=0 before acquisition")
    resolved = database.resolve(strict=True)
    env_files = run(["/usr/bin/systemctl", "show", "--property=EnvironmentFiles", "--value", unit]).stdout
    env_file_pattern = r"(?<!\S)(-?/[^\s]+) \(ignore_errors=(?:yes|no)\)"
    named = {path.removeprefix("-") for path in re.findall(env_file_pattern, env_files)}
    unparsed = re.sub(env_file_pattern, "", env_files).strip()
    if unparsed or named != {str(INITIAL_PROD_CMS_ENV_FILE)}:
        raise HostFailure("initial-prod inactive baseline has an unreviewed CMS environment-file set")
    try:
        lines = INITIAL_PROD_CMS_ENV_FILE.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise HostFailure("cannot read the inventoried initial-prod CMS environment file") from error
    effective = {}
    unit_environment = run(["/usr/bin/systemctl", "show", "--property=Environment", "--value", unit]).stdout
    for assignment in shlex.split(unit_environment):
        key, separator, value = assignment.partition("=")
        if separator and key in ("DATABASE_CLIENT", "DATABASE_FILENAME"):
            effective[key] = value
    values: dict[str, str] = {}
    for line in lines:
        try:
            assignments = shlex.split(line, comments=True)
        except ValueError as error:
            raise HostFailure("initial-prod CMS environment file cannot be parsed safely") from error
        for assignment in assignments:
            key, separator, value = assignment.partition("=")
            if separator and key in ("DATABASE_CLIENT", "DATABASE_FILENAME"):
                if key in values:
                    raise HostFailure("initial-prod CMS environment repeats a database setting")
                values[key] = value
    effective.update(values)
    selected = effective.get("DATABASE_FILENAME")
    try:
        effective_database = Path(selected).resolve(strict=True) if selected else None
    except OSError as error:
        raise HostFailure("initial-prod inactive CMS environment names an unavailable database") from error
    if effective.get("DATABASE_CLIENT") != "sqlite" or effective_database != resolved:
        raise HostFailure("initial-prod inactive CMS environment does not identify the configured SQLite database")
    return {"kind": "inactive-configured-db", "activeState": active, "mainPid": 0,
            "database": str(resolved), "configSha256": _config_sha256(config),
            "environmentFile": str(INITIAL_PROD_CMS_ENV_FILE), "databaseClient": "sqlite"}


def _database_process_proof(pid: int, database: Path) -> dict[str, Any]:
    expected = database.resolve(strict=True)
    try:
        environ = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        env = dict(item.split(b"=", 1) for item in environ if b"=" in item)
        configured = env.get(b"DATABASE_FILENAME") or env.get(b"DATABASE_PATH")
        if configured is None or Path(os.fsdecode(configured)).resolve(strict=True) != expected:
            raise HostFailure("CMS process environment does not name the configured SQLite database")
        wanted = expected.stat()
        found = False
        for fd_path in Path(f"/proc/{pid}/fd").iterdir():
            try:
                fd_stat = fd_path.stat()
            except OSError:
                continue
            if (fd_stat.st_dev, fd_stat.st_ino) == (wanted.st_dev, wanted.st_ino):
                found = True
                break
        if not found:
            raise HostFailure("CMS process has no open fd for the configured SQLite database")
    except OSError as error:
        raise HostFailure(f"cannot verify CMS process database through /proc: {error}") from error
    return {"pid": pid, "database": str(expected), "device": wanted.st_dev, "inode": wanted.st_ino}


def _wait_health(url: str, seconds: int = 1200) -> None:
    deadline = time.monotonic() + seconds
    last = "no response"
    while time.monotonic() < deadline:
        result = run(["/usr/bin/curl", "--fail", "--silent", "--show-error", "--max-time", "10", url], timeout=12, check=False)
        if result.returncode == 0:
            return
        last = result.stderr.strip() or f"curl exit {result.returncode}"
        time.sleep(5)
    raise HostFailure(f"health did not recover within {seconds}s: {last}")


def _media_inventory(config: dict[str, Any]) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for entry in config["mediaRoots"]:
        declared_root = Path(entry["path"])
        if declared_root.is_symlink():
            declared_root = declared_root.resolve(strict=True)
        root = declared_root.resolve(strict=True)
        if not root.is_dir():
            raise HostFailure(f"media root is not a directory: {root}")
        for item in sorted(root.rglob("*")):
            if item.is_symlink():
                raise HostFailure(f"media tree contains an unsupported symlink: {item}")
            elif item.is_file():
                relative = item.relative_to(root).as_posix()
                if not relative or any(part in (".", "..") for part in Path(relative).parts):
                    raise HostFailure(f"media path is unsupported: {relative}")
                info = item.stat()
                inventory.append({"url": entry["prefix"] + relative, "sha256": sha256_file(item),
                                  "size": info.st_size,
                                  "originalName": relative, "mode": stat.S_IMODE(item.stat().st_mode),
                                  "uid": info.st_uid, "gid": info.st_gid})
            elif not item.is_dir():
                raise HostFailure(f"media tree contains a non-regular object: {item}")
    inventory.sort(key=lambda item: item["url"])
    return inventory


def _media_state_sha256(inventory: list[dict[str, Any]]) -> str:
    state = [{key: item[key] for key in ("url", "sha256", "size", "mode", "uid", "gid")}
             for item in sorted(inventory, key=lambda value: value.get("url", ""))]
    return hashlib.sha256(json.dumps(state, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _capture_media(config: dict[str, Any], destination: Path) -> list[dict[str, Any]]:
    inventory = _media_inventory(config)
    media_dir = destination / "media"
    media_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    copied: set[str] = set()
    for item in inventory:
        source = next(Path(root["path"]).resolve(strict=True) for root in config["mediaRoots"]
                      if item["url"].startswith(root["prefix"])) / item["originalName"]
        target_name = f"sha256:{item['sha256']}"
        target = media_dir / target_name
        if target_name not in copied:
            shutil.copy2(source, target)
            copied.add(target_name)
        item["file"] = f"media/{target_name}"
    return inventory


def _backup(config: dict[str, Any], operation_id: str) -> dict[str, Any]:
    import sqlite3
    live = Path(config["cmsDatabase"]).resolve(strict=True)
    backup_root = Path(config["backupRoot"])
    backup_dir = backup_root / operation_id
    if backup_dir.exists():
        raise HostFailure("backup already exists; inspect the operation before retrying capture")
    for abandoned in backup_root.glob(f".{operation_id}.capture-*"):
        if abandoned.is_symlink() or not abandoned.is_dir():
            raise HostFailure("abandoned backup staging path is not a regular directory")
        shutil.rmtree(abandoned)
    temporary = backup_root / f".{operation_id}.capture-{os.getpid()}"
    temporary.mkdir(mode=0o700, parents=False, exist_ok=False)
    backup_dir = temporary
    database_copy = backup_dir / "database.sqlite"
    _assert_no_database_handles(live)
    # The service is stopped and no process owns the file, so checkpoint through a
    # writable SQLite handle before making the immutable final backup.
    source = sqlite3.connect(str(live), timeout=10)
    try:
        checkpoint = source.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if checkpoint is None or checkpoint[0] != 0 or (checkpoint[1] >= 0 and checkpoint[1] != checkpoint[2]):
            raise HostFailure("WAL checkpoint is busy or incomplete")
        post_checkpoint_live_sha = sha256_file(live)
        target = sqlite3.connect(database_copy)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    checked = sqlite3.connect(f"file:{database_copy}?mode=ro", uri=True)
    try:
        integrity = checked.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise HostFailure(f"SQLite backup integrity failed: {integrity}")
    finally:
        checked.close()
    media = _capture_media(config, backup_dir)
    durable_json(backup_dir / "media-manifest.json", {"media": media})
    manifest = {"version": 1, "operationId": operation_id, "database": str(live),
                "postCheckpointLiveSha256": post_checkpoint_live_sha,
                "databaseSha256": sha256_file(database_copy), "mediaManifestSha256": sha256_file(backup_dir / "media-manifest.json"),
                "media": media}
    durable_json(backup_dir / "manifest.json", manifest)
    archive = backup_dir / "backup.tar"
    with tarfile.open(archive, "w") as output:
        for path in sorted(backup_dir.rglob("*")):
            if path == archive:
                continue
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise HostFailure(f"backup contains an unsupported object: {path}")
            output.add(path, arcname=str(path.relative_to(backup_dir)), recursive=False)
    manifest["archiveSha256"] = sha256_file(archive)
    durable_json(backup_dir / "manifest.json", manifest)
    os.replace(temporary, backup_root / operation_id)
    fd = os.open(backup_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return manifest


def _current_target(link: Path) -> Path:
    try:
        info = link.lstat()
        target = link.resolve(strict=True)
    except OSError as error:
        raise HostFailure(f"release pointer is not installed: {link}: {error}") from error
    if not stat.S_ISLNK(info.st_mode) or not target.is_dir():
        raise HostFailure(f"release pointer must be a symlink to a real directory: {link}")
    return target


def _tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        if path.relative_to(root).as_posix() == "release.json":
            continue
        if stat.S_ISLNK(info.st_mode):
            raise HostFailure(f"release tree contains a symlink: {path}")
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise HostFailure(f"release tree contains a non-regular object: {path}")
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()


PAIRED_CMS_ENV_KEYS = ("IKPK_BUILD_WORKSPACE", "IKPK_INSTALLED_COMMIT", "INITIAL_PROD_PROFILE",
                       "DEPLOY_MODE", "PAYMENT_ROLE", "PAYMENT_ENDPOINT_PROD", "DEMO_FORMS",
                       "CHAT_LOADER_SRC", "CHAT_OFFLINE_MESSAGE")


def _paired_cms_source_env(config: dict[str, Any]) -> dict[str, Optional[str]]:
    path = Path(config["cmsEnvironmentFile"])
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0:
        raise HostFailure("paired CMS environment file is not a regular unlinked file")
    text = path.read_text(encoding="utf-8")
    values: dict[str, Optional[str]] = {key: None for key in PAIRED_CMS_ENV_KEYS}
    for key in PAIRED_CMS_ENV_KEYS:
        matches = re.findall(rf"^(?:export\s+)?{re.escape(key)}=(.*)$", text, re.MULTILINE)
        if len(matches) > 1:
            raise HostFailure(f"paired CMS environment repeats {key}")
        if matches:
            values[key] = matches[0].strip().strip('"').strip("'")
    return values


def _write_paired_cms_source_env(config: dict[str, Any], values: dict[str, Optional[str]]) -> None:
    if set(values) != set(PAIRED_CMS_ENV_KEYS):
        raise HostFailure("paired CMS environment update may change only the two source-version keys")
    path = Path(config["cmsEnvironmentFile"])
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise HostFailure("paired CMS environment file is not a regular unlinked file")
    text = path.read_text(encoding="utf-8")
    for key, value in values.items():
        if value is not None and ("\n" in value or "\r" in value or not value):
            raise HostFailure(f"invalid paired CMS environment value for {key}")
    output = []
    seen = set()
    for line in text.splitlines(keepends=True):
        matched = next((key for key in PAIRED_CMS_ENV_KEYS
                        if re.match(rf"^(?:export\s+)?{re.escape(key)}=", line)), None)
        if matched is None:
            output.append(line)
            continue
        if matched in seen:
            raise HostFailure(f"paired CMS environment repeats {matched}")
        seen.add(matched)
        if values[matched] is not None:
            ending = "\n" if line.endswith("\n") else ""
            output.append(f"{matched}={values[matched]}{ending}")
    for key, value in values.items():
        if value is not None and key not in seen:
            if output and not output[-1].endswith("\n"):
                output[-1] += "\n"
            output.append(f"{key}={value}\n")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        os.fchmod(fd, stat.S_IMODE(info.st_mode))
        os.fchown(fd, info.st_uid, info.st_gid)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as target:
            target.write("".join(output))
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _site_refresh_worker_pids(proc_root: Path = Path("/proc")) -> set[int]:
    """Find legacy refresh workers whose terminal state predates workerPid records."""
    try:
        entries = list(proc_root.iterdir())
    except OSError as error:
        raise HostFailure("cannot inspect processes for legacy site-refresh workers") from error
    result = set()
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        if b"site-refresh-worker.js" in command or (b"executeRefresh()" in command and b"site-refresh" in command):
            result.add(int(entry.name))
    return result


def _verify_site_refresh_idle(config: dict[str, Any], *, recovery: bool = False) -> None:
    path = Path(config["siteRefreshState"])
    lock_path = Path(str(path) + ".lock")
    deadline = time.monotonic() + 3600
    ambiguous_attempts = 0

    def retry_ambiguous(message: str) -> None:
        # A lock can be created empty or rewritten during handoff, and a
        # worker can exit between a read and its PID probe. Never regard an
        # ambiguous observation as idle; re-read the entire state and lock.
        nonlocal ambiguous_attempts
        ambiguous_attempts += 1
        if ambiguous_attempts >= 3 or time.monotonic() >= deadline:
            raise HostFailure(message)
        time.sleep(1)

    while True:
        waiting = False
        try:
            info = path.lstat()
        except FileNotFoundError:
            record = None
        else:
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise HostFailure("site-refresh state is not a regular unlinked file")
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise HostFailure("site-refresh state is unreadable; refusing to stop CMS") from error
            allowed_statuses = {"idle", "running", "succeeded", "failed", "verification-failed"}
            if recovery:
                allowed_statuses.add("interrupted")
            if not isinstance(record, dict) or record.get("status") not in allowed_statuses:
                raise HostFailure("site-refresh or Restore has unknown state; refusing to stop CMS")
            if record.get("status") == "running":
                pid = record.get("pid")
                if isinstance(pid, bool) or not isinstance(pid, int) or pid < 2:
                    raise HostFailure("active site-refresh/Restore has no trustworthy PID; refusing to stop CMS")
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    retry_ambiguous("site-refresh/Restore state is stale; inspect it instead of stopping CMS")
                    continue
                except PermissionError:
                    pass
                waiting = True
            elif record.get("status") == "interrupted":
                recorded_pids = [record.get(key) for key in ("pid", "workerPid") if record.get(key) is not None]
                for pid in recorded_pids:
                    if isinstance(pid, bool) or not isinstance(pid, int) or pid < 2:
                        raise HostFailure("interrupted site-refresh state has an invalid worker PID")
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        waiting = True
                    else:
                        waiting = True
                if not recorded_pids or record.get("phase"):
                    waiting = waiting or bool(_site_refresh_worker_pids())
            else:
                worker_pid = record.get("workerPid")
                if record.get("phase") and worker_pid is None:
                    waiting = bool(_site_refresh_worker_pids())
                if worker_pid is not None:
                    if isinstance(worker_pid, bool) or not isinstance(worker_pid, int) or worker_pid < 2:
                        raise HostFailure("terminal refresh state has an invalid worker PID")
                    try:
                        os.kill(worker_pid, 0)
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        waiting = True
                    else:
                        waiting = True
        try:
            lock_info = lock_path.lstat()
        except FileNotFoundError:
            lock_info = None
        if lock_info is not None:
            if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1:
                raise HostFailure("site-refresh lock is unsafe; refusing to stop CMS")
            try:
                lock_text = lock_path.read_text(encoding="ascii")
            except FileNotFoundError:
                retry_ambiguous("site-refresh lock changed while reading; refusing to stop CMS")
                continue
            except (OSError, UnicodeError) as error:
                raise HostFailure("site-refresh lock is unreadable; refusing to stop CMS") from error
            # Legacy writers use a PID-only file; newer workers append a
            # 32-character lowercase token. Do not treat a partial handoff as idle.
            legacy_lock = re.fullmatch(r"([0-9]+)\n?", lock_text)
            token_lock = re.fullmatch(r"([0-9]+)\n[a-f0-9]{32}\n", lock_text)
            lock_pid_text = legacy_lock.group(1) if legacy_lock else (
                token_lock.group(1) if token_lock else "")
            if not lock_pid_text or len(lock_pid_text) > 10 or not 2 <= int(lock_pid_text) <= 2147483647:
                retry_ambiguous("site-refresh lock PID is unknown; refusing to stop CMS")
                continue
            try:
                os.kill(int(lock_pid_text), 0)
            except ProcessLookupError:
                retry_ambiguous("site-refresh lock is stale; inspect it instead of stopping CMS")
                continue
            except PermissionError:
                pass
            waiting = True
        ambiguous_attempts = 0
        if not waiting:
            return
        if time.monotonic() >= deadline:
            raise HostFailure("site-refresh/Restore did not drain within 60 minutes; CMS remains running")
        time.sleep(1)


def _assert_site_refresh_idle(config: dict[str, Any], *, allow_interrupted: bool = False) -> None:
    """Read-only preflight: active, malformed, or interrupted operations refuse before fencing."""
    path = Path(config["siteRefreshState"])
    try:
        info = path.lstat()
    except FileNotFoundError:
        record = None
    else:
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise HostFailure("site-refresh state is not a regular unlinked file")
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HostFailure("site-refresh state is unreadable; refusing before fencing") from error
        allowed_statuses = {"idle", "succeeded", "failed"}
        if allow_interrupted:
            allowed_statuses.add("interrupted")
        if not isinstance(record, dict) or record.get("status") not in allowed_statuses:
            raise HostFailure("site-refresh is active or unknown; resolve it before starting paired maintenance")
    lock_path = Path(str(path) + ".lock")
    if lock_path.exists() or lock_path.is_symlink():
        raise HostFailure("site-refresh/Restore lock exists; resolve it before starting paired maintenance")
    if record and record.get("phase") and record.get("workerPid") is None and _site_refresh_worker_pids():
        raise HostFailure("legacy terminal site-refresh worker is still active; resolve it before maintenance")
    if record and record.get("workerPid") is not None:
        worker_pid = record["workerPid"]
        if isinstance(worker_pid, bool) or not isinstance(worker_pid, int) or worker_pid < 2:
            raise HostFailure("terminal refresh state has an invalid worker PID")
        try:
            os.kill(worker_pid, 0)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise HostFailure("terminal refresh worker is still active; resolve it before maintenance")
        else:
            raise HostFailure("terminal refresh worker is still active; resolve it before maintenance")
    if record and record.get("status") == "interrupted":
        owner_pid = record.get("pid")
        if isinstance(owner_pid, bool) or not isinstance(owner_pid, int) or owner_pid < 2:
            raise HostFailure("interrupted refresh state has an invalid owner PID")
        try:
            os.kill(owner_pid, 0)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise HostFailure("interrupted refresh owner is still active; recovery refused")
        else:
            raise HostFailure("interrupted refresh owner is still active; recovery refused")
    site_root = Path(config["staticReleaseRoot"]).parent
    for name in (".publication-pending.json", ".publication-preparation.json"):
        evidence = site_root / name
        if evidence.exists() or evidence.is_symlink():
            raise HostFailure("SSH publication is unfinished; recover it before host publication")


def _old_pair(config: dict[str, Any]) -> dict[str, Any]:
    cms = _current_target(Path(config["currentCms"]))
    static = _current_target(Path(config["currentStatic"]))
    database = Path(config["cmsDatabase"]).resolve(strict=True)
    media_uploads = next(Path(item["path"]).resolve(strict=True) for item in config["mediaRoots"]
                         if item["prefix"] == "/uploads/")
    db_proof = (_initial_prod_baseline_db_reference(config, database)
                if config.get("profile") == "initial-prod"
                else _database_process_proof(_service_pid(config["cmsUnit"]), database))
    result = {"cmsPath": str(cms), "staticPath": str(static), "databasePath": str(database),
            "cmsPayloadSha256": _cms_payload_sha256(cms, media_uploads),
            "databaseSha256": sha256_file(database), "staticTreeSha256": _tree_sha256(static),
            "configSha256": _config_sha256(config),
            "cmsDatabaseProof": db_proof}
    if config.get("profile") == "production-paired":
        result["cmsSourceEnvironment"] = _paired_cms_source_env(config)
        result["mediaStateSha256"] = _media_state_sha256(_media_inventory(config))
    return result


def _effective_old_pair(state: RehearsalState, operation_id: str) -> dict[str, Any]:
    rows = state._operation_rows(operation_id)
    baseline = next((row["oldPair"] for row in reversed(rows)
                     if row.get("record") == "fenced-baseline" and isinstance(row.get("oldPair"), dict)), None)
    start = next((row for row in rows if row.get("record") == "start"), None)
    if baseline:
        return baseline
    if start and isinstance(start.get("oldPair"), dict):
        return start["oldPair"]
    raise HostFailure("operation has no journaled old CMS/site pair")


def _record_fenced_baseline(config: dict[str, Any], state: RehearsalState,
                            operation_id: str, source_sha: str, observed: dict[str, Any]) -> None:
    if config.get("profile") != "production-paired":
        return
    rows = state._operation_rows(operation_id)
    if any(row.get("record") == "fenced-baseline" for row in rows):
        return
    backup = Path(config["backupRoot"]) / operation_id / "manifest.json"
    if backup.exists():
        return
    cms = _current_target(Path(config["currentCms"]))
    static = _current_target(Path(config["currentStatic"]))
    if str(cms) != observed.get("cmsPath"):
        raise HostFailure("CMS code changed before backup; refusing to replace the journaled old pair")
    database = Path(config["cmsDatabase"]).resolve(strict=True)
    uploads = next(Path(item["path"]).resolve(strict=True) for item in config["mediaRoots"]
                   if item["prefix"] == "/uploads/")
    baseline = dict(observed)
    baseline.update({"cmsPath": str(cms), "staticPath": str(static), "databasePath": str(database),
                     "cmsPayloadSha256": _cms_payload_sha256(cms, uploads),
                     "databaseSha256": sha256_file(database), "staticTreeSha256": _tree_sha256(static)})
    baseline["mediaStateSha256"] = _media_state_sha256(_media_inventory(config))
    state._append({"version": 1, "record": "fenced-baseline", "operationId": operation_id,
                   "sourceSha": source_sha, "oldPair": baseline})


def _switch_pointer(pointer: Path, target: Path, allowed_root: Path) -> None:
    target = target.resolve(strict=True)
    allowed_root = allowed_root.resolve(strict=True)
    if target == allowed_root or allowed_root not in target.parents:
        raise HostFailure(f"release target escapes configured root: {target}")
    temporary = pointer.with_name(f".{pointer.name}.new-{os.getpid()}")
    try:
        temporary.symlink_to(target, target_is_directory=True)
        os.replace(temporary, pointer)
        fd = os.open(pointer.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _copy_atomic(source: Path, destination: Path) -> None:
    if destination.is_symlink():
        raise HostFailure("database destination must not be a symlink")
    if source.is_symlink() or not source.is_file():
        raise HostFailure("database source must be a regular file")
    info = destination.stat()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(destination) + suffix)
        if sidecar.is_symlink():
            raise HostFailure(f"database sidecar must not be a symlink: {sidecar}")
        if sidecar.exists():
            sidecar.unlink()
    temporary = destination.with_name(f".{destination.name}.new-{os.getpid()}")
    with source.open("rb") as input_file, temporary.open("xb") as output_file:
        shutil.copyfileobj(input_file, output_file, 1024 * 1024)
        output_file.flush()
        os.fsync(output_file.fileno())
    os.chmod(temporary, stat.S_IMODE(info.st_mode))
    os.chown(temporary, info.st_uid, info.st_gid)
    os.replace(temporary, destination)
    fd = os.open(destination.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _candidate_root(config: dict[str, Any], source_sha: str, operation_id: str) -> Path:
    RehearsalState._validate_identity(operation_id, source_sha)
    root = Path(config["releaseRoot"]).resolve(strict=True)
    return root / f"{source_sha}-{operation_id}"


def _extract_source_archive(config: dict[str, Any], source_sha: str, operation_id: str,
                            payload: bytes, expected_sha256: str,
                            provenance: dict[str, Any], expected_ref: Optional[str] = None) -> Path:
    if sha256_file_bytes(payload) != expected_sha256:
        raise HostFailure("source archive digest does not match the admitted manifest")
    admitted_ref = expected_ref or config["allowedSourceRef"]
    if provenance.get("sourceSha") != source_sha or provenance.get("ref") != admitted_ref:
        raise HostFailure("source archive provenance does not match the operation")
    expected_branch = admitted_ref.removeprefix("refs/heads/")
    if (provenance.get("workflow") != "Tests" or provenance.get("workflowName") != "Tests"
            or provenance.get("headBranch") != expected_branch or provenance.get("event") != "push"):
        raise HostFailure("source archive lacks canonical Tests push provenance for the selected fixed profile")
    if (not isinstance(provenance.get("runId"), int) or not isinstance(provenance.get("attempt"), int)
            or provenance.get("repository") != "pgorbachev/ikpk"
            or not provenance.get("runUrl", "").startswith("https://github.com/")):
        raise HostFailure("source archive provenance lacks exact CI run identity")
    root = Path(config["releaseRoot"]).resolve(strict=True)
    destination = _candidate_root(config, source_sha, operation_id)
    if destination.exists():
        marker = destination / ".ikpk-rehearsal-ci.json"
        try:
            existing = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HostFailure("existing candidate is not bound to admitted CI metadata") from error
        if existing != provenance:
            raise HostFailure("existing candidate provenance differs from this operation")
        return destination
    temporary = root / f".{source_sha}-{operation_id}.new-{os.getpid()}"
    temporary.mkdir(mode=0o700)
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
            seen = set()
            for member in archive.getmembers():
                relative = Path(member.name)
                if relative.is_absolute() or not member.name or any(part in (".", "..") for part in relative.parts):
                    raise HostFailure("source archive contains an unsafe path")
                target = temporary / relative
                if target == temporary or temporary not in target.parents:
                    raise HostFailure("source archive member escapes candidate root")
                normalized = relative.as_posix()
                if normalized in seen:
                    raise HostFailure("source archive contains duplicate members")
                seen.add(normalized)
                if normalized == ".ikpk-rehearsal-ci.json":
                    source = archive.extractfile(member)
                    if source is None or json.loads(source.read().decode("utf-8")) != provenance:
                        raise HostFailure("embedded source CI provenance differs from operator admission")
                    durable_json(target, provenance)
                    continue
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o755)
                elif member.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                    source = archive.extractfile(member)
                    if source is None:
                        raise HostFailure(f"cannot read source archive member: {member.name}")
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                                 0o755 if member.mode & 0o111 else 0o644)
                    with os.fdopen(fd, "wb") as output:
                        shutil.copyfileobj(source, output)
                        output.flush()
                        os.fsync(output.fileno())
                else:
                    raise HostFailure(f"source archive contains unsupported member: {member.name}")
        if ".ikpk-rehearsal-ci.json" not in seen:
            raise HostFailure("source archive lacks embedded CI provenance")
        user = pwd.getpwnam(config["cmsUser"])
        for path in [temporary, *temporary.rglob("*")]:
            os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
        os.replace(temporary, destination)
        fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return destination
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def _prepare_paired_site_workspace(config: dict[str, Any], source_root: Path,
                                  source_sha: str, operation_id: str) -> Path:
    """Copy the admitted build tree beneath the existing CMS-writable workspace root."""
    workspace_root = Path(config.get("siteBuildWorkspaceRoot", ""))
    if workspace_root != PRODUCTION_PAIRED_WORKSPACE_ROOT:
        raise HostFailure("production paired site workspace root is not fixed")
    source_root = source_root.resolve(strict=True)
    web_dependencies = source_root / "web/node_modules"
    cms_dependencies = source_root / "cms/node_modules"
    if (not web_dependencies.is_dir() or web_dependencies.is_symlink()
            or not cms_dependencies.is_symlink() or not cms_dependencies.resolve(strict=True).is_dir()):
        raise HostFailure("paired source dependencies are not prepared for the CMS site-refresh workspace")
    workspace_root.mkdir(mode=0o750, parents=True, exist_ok=True)
    root_info = workspace_root.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise HostFailure("paired site workspace root is not a real directory")
    user = pwd.getpwnam(config["cmsUser"])
    os.chown(workspace_root, user.pw_uid, user.pw_gid)
    os.chmod(workspace_root, 0o750)
    destination = workspace_root / f"{source_sha}-{operation_id}"
    if destination.exists():
        if destination.is_symlink():
            raise HostFailure("paired site workspace destination is a symlink")
        marker = destination / ".ikpk-workspace-identity.json"
        try:
            identity = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HostFailure("existing paired site workspace has no valid operation identity") from error
        if identity != {"sourceSha": source_sha, "operationId": operation_id}:
            raise HostFailure("existing paired site workspace identity differs from this operation")
        return destination
    temporary = workspace_root / f".{source_sha}-{operation_id}.new-{os.getpid()}"
    if os.path.lexists(temporary):
        raise HostFailure("paired site workspace staging path is occupied")
    ignored = shutil.ignore_patterns("node_modules", ".staging193-rehearsal")
    try:
        shutil.copytree(source_root, temporary, ignore=ignored, symlinks=False)
        (temporary / "web/node_modules").symlink_to(web_dependencies, target_is_directory=True)
        (temporary / "cms/node_modules").symlink_to(cms_dependencies.resolve(strict=True), target_is_directory=True)
        durable_json(temporary / ".ikpk-workspace-identity.json",
                     {"sourceSha": source_sha, "operationId": operation_id})
        for path in [temporary, *temporary.rglob("*")]:
            os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
        os.replace(temporary, destination)
        fd = os.open(workspace_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return destination
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def sha256_file_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _run_as_cms(config: dict[str, Any], cwd: Path, argv: list[str], timeout: int = 1800,
                environment: Optional[dict[str, str]] = None,
                read_only_path: Optional[Path | list[Path]] = None) -> str:
    user = pwd.getpwnam(config["cmsUser"])
    runtime_max = max(1, timeout - 30)
    command = ["/usr/bin/systemd-run", "--wait", "--collect", "--pipe", f"--uid={user.pw_name}",
               f"--working-directory={cwd}", f"--property=RuntimeMaxSec={runtime_max}s",
               "--property=TimeoutStopSec=15s"]
    if read_only_path is not None:
        read_only_paths = read_only_path if isinstance(read_only_path, list) else [read_only_path]
        resolved_paths = []
        for read_only in map(Path, read_only_paths):
            if not read_only.is_absolute() or read_only.is_symlink() or not (read_only.is_dir() or read_only.is_file()):
                raise HostFailure("transient read-only path must be a real absolute file or directory")
            resolved = read_only.resolve(strict=True)
            if resolved != read_only:
                raise HostFailure("transient read-only path must be canonical")
            resolved_paths.append(str(resolved))
        command.append(f"--property=ReadOnlyPaths={' '.join(resolved_paths)}")
    child_environment = dict(environment or {})
    if _uses_staging194_temp(config):
        child_environment.setdefault("TMPDIR", str(_validate_staging194_temporary_root(config)))
    for key, value in child_environment.items():
        if not re.fullmatch(r"[A-Z0-9_]+", key) or "\x00" in value:
            raise HostFailure("invalid unprivileged command environment")
        command.extend(["--setenv", f"{key}={value}"])
    result = run(command + argv, timeout=timeout)
    return result.stdout


def _cms_build_generation(config: dict[str, Any], source_root: Path) -> tuple[Path, dict[str, str]]:
    source_cms = source_root / "cms"
    lockfile = source_cms / "package-lock.json"
    if lockfile.is_symlink() or not lockfile.is_file():
        raise HostFailure("CMS source package-lock is unavailable for dependency admission")
    lock_hash = sha256_file(lockfile)
    node = config.get("nodeBinary", "/usr/bin/node")
    node_version = run([node, "--version"]).stdout.strip()
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", node_version):
        raise HostFailure("host Node version is unavailable for CMS dependency admission")
    runtime = json.loads(run([node, "-p", "JSON.stringify({abi:process.versions.modules,platform:process.platform,arch:process.arch})"]).stdout)
    profile = "full-build"
    key = f"{lock_hash}-{profile}-node{node_version[1:]}-{runtime['platform']}-{runtime['arch']}-abi{runtime['abi']}"
    root = Path(config["releaseRoot"]).resolve(strict=True).parent / "deps"
    if root.is_symlink():
        raise HostFailure("shared CMS dependency root must not be a symlink")
    root.mkdir(mode=0o755, exist_ok=True)
    generation = root / key
    metadata = {"version": 1, "lockSha256": lock_hash, "profile": profile,
                "nodeVersion": node_version, "nodeAbi": runtime["abi"],
                "platform": runtime["platform"], "architecture": runtime["arch"]}
    return generation, metadata


def _validate_cms_build_generation(config: dict[str, Any], generation: Path,
                                   expected: dict[str, str]) -> Path:
    if generation.is_symlink() or not generation.is_dir():
        raise HostFailure("CMS build dependency generation is missing or unsafe")
    complete = generation / ".complete"
    if complete.is_symlink() or not complete.is_file():
        raise HostFailure("CMS build dependency generation is incomplete")
    try:
        metadata = json.loads(complete.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("CMS build dependency generation metadata is unreadable") from error
    if metadata != expected:
        raise HostFailure("CMS build dependency generation does not match its lock hash and profile")
    generation_lock = generation / "package-lock.json"
    if generation_lock.is_symlink() or not generation_lock.is_file() or sha256_file(generation_lock) != expected["lockSha256"]:
        raise HostFailure("CMS build dependency generation lockfile differs from its identity")
    dependencies = generation / "node_modules"
    if dependencies.is_symlink() or not dependencies.is_dir():
        raise HostFailure("CMS build dependency generation has no real node_modules directory")
    user = pwd.getpwnam(config["cmsUser"])
    for directory in (generation, dependencies):
        info = directory.stat()
        if info.st_uid != user.pw_uid or info.st_mode & 0o022:
            raise HostFailure("CMS build dependency generation is not a private service-user tree")
    try:
        lock_data = json.loads(generation_lock.read_text(encoding="utf-8"))
        installed = json.loads((dependencies / "@strapi/strapi/package.json").read_text(encoding="utf-8"))
        expected_strapi = lock_data.get("packages", {}).get("node_modules/@strapi/strapi", {}).get("version")
    except (OSError, ValueError, AttributeError) as error:
        raise HostFailure("CMS build dependency generation Strapi identity is unreadable") from error
    if not isinstance(expected_strapi, str) or installed.get("version") != expected_strapi:
        raise HostFailure("CMS build dependency generation Strapi version differs from its lockfile")
    return dependencies.resolve(strict=True)


def _prepare_cms_build_dependencies(config: dict[str, Any], source_root: Path) -> Path:
    source_cms = source_root / "cms"
    generation, expected = _cms_build_generation(config, source_root)
    if os.path.lexists(generation):
        dependencies = _validate_cms_build_generation(config, generation, expected)
    else:
        generation.parent.mkdir(mode=0o755, exist_ok=True)
        user = pwd.getpwnam(config["cmsUser"])
        temporary = Path(tempfile.mkdtemp(prefix=f".{generation.name}.partial-", dir=generation.parent))
        try:
            for name in ("package.json", "package-lock.json"):
                shutil.copy2(source_cms / name, temporary / name)
                os.chown(temporary / name, user.pw_uid, user.pw_gid)
            os.chown(temporary, user.pw_uid, user.pw_gid)
            _run_as_cms(config, temporary, ["/usr/bin/npm", "ci", "--no-audit", "--no-fund"], timeout=1800)
            dependencies = temporary / "node_modules"
            if dependencies.is_symlink() or not dependencies.is_dir():
                raise HostFailure("CMS npm ci did not create a real build dependency tree")
            try:
                package = json.loads((dependencies / "@strapi/strapi/package.json").read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise HostFailure("CMS build dependency tree has no readable Strapi package") from error
            source_package = json.loads((source_cms / "package.json").read_text(encoding="utf-8"))
            expected_strapi = source_package.get("dependencies", {}).get("@strapi/strapi")
            if package.get("version") != expected_strapi:
                raise HostFailure("CMS build dependency Strapi version differs from source package")
            durable_json(temporary / ".complete", expected)
            os.chown(temporary / ".complete", user.pw_uid, user.pw_gid)
            if os.path.lexists(generation):
                raise HostFailure("CMS build dependency generation appeared during preparation")
            os.rename(temporary, generation)
            dependencies = _validate_cms_build_generation(config, generation, expected)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
    return dependencies


def _cms_artifact_path(source_root: Path, operation_id: str) -> Path:
    RehearsalState._validate_identity(operation_id)
    return source_root / ".staging193-rehearsal" / operation_id / "migration" / "cms-artifact"


def _trusted_cms_artifact(provenance: dict[str, Any]) -> dict[str, Any]:
    evidence = provenance.get("cmsArtifact")
    if (not isinstance(evidence, dict)
            or set(evidence) != {"artifactId", "runId", "attempt", "archiveSha256", "payloadSha256"}
            or type(evidence.get("artifactId")) is not int or evidence["artifactId"] <= 0
            or type(evidence.get("runId")) is not int or evidence["runId"] != provenance.get("runId")
            or type(evidence.get("attempt")) is not int or evidence["attempt"] != provenance.get("attempt")
            or not SHA256_RE.fullmatch(str(evidence.get("archiveSha256", "")))
            or not SHA256_RE.fullmatch(str(evidence.get("payloadSha256", "")))):
        raise HostFailure("trusted CI provenance lacks a valid CMS artifact identity")
    return {key: evidence[key] for key in
            ("artifactId", "runId", "attempt", "archiveSha256", "payloadSha256")}


def _cms_tar_members(payload: bytes) -> tuple[tarfile.TarFile, list[tarfile.TarInfo]]:
    try:
        archive = tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz")
        members = archive.getmembers()
    except (OSError, tarfile.TarError) as error:
        raise HostFailure("CI CMS artifact payload is not a readable gzip tar") from error
    seen: set[str] = set()
    for member in members:
        name = member.name
        relative = Path(name)
        if (not name or "\\" in name or relative.is_absolute()
                or any(part == "" for part in name.rstrip("/").split("/"))
                or any(part in ("", ".", "..") for part in relative.parts)
                or any(part.lower() in ("node_modules", "uploads") for part in relative.parts)):
            archive.close()
            raise HostFailure("CI CMS artifact contains an unsafe or forbidden path")
        normalized = relative.as_posix().rstrip("/")
        if normalized in seen:
            archive.close()
            raise HostFailure("CI CMS artifact contains duplicate paths")
        seen.add(normalized)
        if not (member.isdir() or member.isfile()):
            archive.close()
            raise HostFailure("CI CMS artifact contains a link or unsupported archive member")
    return archive, members


def _verify_cms_artifact_bytes(source_root: Path, artifact: Path, expected: dict[str, Any]) -> bytes:
    archive_path = source_root / ".ikpk-cms-artifact.tar.gz"
    try:
        if source_root.is_symlink() or source_root.resolve(strict=True) != source_root:
            raise HostFailure("CI CMS source candidate path is unsafe")
        try:
            relative_artifact = artifact.relative_to(source_root)
        except ValueError as error:
            raise HostFailure("CI CMS artifact path is outside its operation candidate") from error
        if (len(relative_artifact.parts) != 4
                or relative_artifact.parts[0] != ".staging193-rehearsal"
                or relative_artifact.parts[2:] != ("migration", "cms-artifact")):
            raise HostFailure("CI CMS artifact path is outside its operation candidate")
        RehearsalState._validate_identity(relative_artifact.parts[1])
        for parent in (artifact.parent.parent.parent, artifact.parent.parent, artifact.parent):
            if parent.is_symlink() or parent.resolve(strict=True) != parent:
                raise HostFailure("CI CMS artifact path contains a symlink")
        info = archive_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise HostFailure("CI CMS artifact archive is missing or unsafe")
        payload = archive_path.read_bytes()
    except OSError as error:
        raise HostFailure("CI CMS artifact archive is missing or unreadable") from error
    if sha256_file_bytes(payload) != expected["payloadSha256"]:
        raise HostFailure("CI CMS artifact payload digest differs from trusted provenance")
    tar, members = _cms_tar_members(payload)
    try:
        if artifact.is_symlink() or not artifact.is_dir():
            raise HostFailure("prepared CI CMS artifact directory is missing or unsafe")
        expected_paths: set[str] = set()
        for member in members:
            relative = Path(member.name)
            name = relative.as_posix().rstrip("/")
            expected_paths.add(name)
            expected_paths.update(parent.as_posix() for parent in relative.parents if str(parent) != ".")
            target = artifact / relative
            if member.isdir():
                if target.is_symlink() or not target.is_dir():
                    raise HostFailure("prepared CI CMS artifact differs from its admitted payload")
                continue
            source = tar.extractfile(member)
            if source is None or target.is_symlink() or not target.is_file():
                raise HostFailure("prepared CI CMS artifact differs from its admitted payload")
            target_info = target.lstat()
            if not stat.S_ISREG(target_info.st_mode) or target_info.st_nlink != 1:
                raise HostFailure("prepared CI CMS artifact contains an unsafe file")
            with target.open("rb") as actual:
                while True:
                    expected_block = source.read(1024 * 1024)
                    if not expected_block:
                        break
                    actual_block = actual.read(len(expected_block))
                    if actual_block != expected_block:
                        raise HostFailure("prepared CI CMS artifact bytes differ from its admitted payload")
                if actual.read(1):
                    raise HostFailure("prepared CI CMS artifact bytes differ from its admitted payload")
        for path in artifact.rglob("*"):
            relative = path.relative_to(artifact).as_posix()
            if relative == "node_modules" or relative.startswith("node_modules/"):
                continue
            if relative == "public/uploads":
                continue
            if relative not in expected_paths:
                raise HostFailure("prepared CI CMS artifact has files outside its admitted payload")
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise HostFailure("prepared CI CMS artifact contains an unexpected symlink")
        required = ("package.json", "package-lock.json", "tsconfig.json", "dist/config/database.js",
                    "database/.migrations-expected", "scripts/run-data-migrations.mjs")
        if any(not (artifact / name).is_file() or (artifact / name).is_symlink() for name in required):
            raise HostFailure("CI CMS artifact is structurally incomplete")
        return payload
    finally:
        tar.close()


def _extract_ci_cms_artifact(config: dict[str, Any], source_root: Path, operation_id: str,
                             expected: dict[str, Any]) -> Path:
    artifact = _cms_artifact_path(source_root, operation_id)
    operation_root = artifact.parent
    if any(path.is_symlink() for path in (source_root, artifact.parent, artifact.parent.parent,
                                          artifact.parent.parent.parent)):
        raise HostFailure("CI CMS artifact preparation path contains a symlink")
    operation_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.path.lexists(artifact):
        _verify_cms_artifact_bytes(source_root, artifact, expected)
        return artifact
    archive_path = source_root / ".ikpk-cms-artifact.tar.gz"
    try:
        payload = archive_path.read_bytes()
    except OSError as error:
        raise HostFailure("CI CMS artifact archive is missing or unreadable") from error
    if sha256_file_bytes(payload) != expected["payloadSha256"]:
        raise HostFailure("CI CMS artifact payload digest differs from trusted provenance")
    tar, members = _cms_tar_members(payload)
    temporary = artifact.with_name(f".cms-artifact.new-{os.getpid()}")
    if os.path.lexists(temporary):
        tar.close()
        raise HostFailure("CI CMS artifact temporary extraction path already exists")
    temporary.mkdir(mode=0o700)
    try:
        for member in members:
            target = temporary / Path(member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            source = tar.extractfile(member)
            if source is None:
                raise HostFailure("cannot read CI CMS artifact member")
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                         0o755 if member.mode & 0o111 else 0o644)
            with os.fdopen(fd, "wb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
        for directory in sorted((item for item in temporary.rglob("*") if item.is_dir()),
                                key=lambda item: len(item.parts), reverse=True):
            os.chmod(directory, 0o755)
        os.chmod(temporary, 0o755)
        user = pwd.getpwnam(config["cmsUser"])
        for path in [temporary, *temporary.rglob("*")]:
            os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
        os.replace(temporary, artifact)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    finally:
        tar.close()
    _verify_cms_artifact_bytes(source_root, artifact, expected)
    return artifact


def _validate_prepared_web_dependencies(source_root: Path) -> Path:
    web_dependencies = source_root / "web/node_modules"
    if web_dependencies.is_symlink() or not web_dependencies.is_dir():
        raise HostFailure("prepared web dependencies are missing or unsafe")
    for package in ("astro", "tsx"):
        metadata_path = web_dependencies / package / "package.json"
        if metadata_path.is_symlink() or not metadata_path.is_file():
            raise HostFailure(f"prepared web dependencies lack {package}")
    resolved = web_dependencies.resolve(strict=True)
    for executable in (web_dependencies / ".bin/astro", web_dependencies / ".bin/tsx"):
        if not executable.is_symlink() or not executable.resolve(strict=True).is_relative_to(resolved):
            raise HostFailure("prepared web executable link escapes its source dependencies")
    return resolved


def _has_main_release_admission(provenance: dict[str, Any], source_sha: str) -> bool:
    release = provenance.get("release")
    preflight = provenance.get("releasePreflight")
    return bool(
        provenance.get("ref") == "refs/heads/main" and provenance.get("sourceSha") == source_sha
        and provenance.get("event") == "push" and provenance.get("headBranch") == "main"
        and provenance.get("workflow") == "Tests" and provenance.get("workflowName") == "Tests"
        and provenance.get("repository") == "pgorbachev/ikpk"
        and type(provenance.get("runId")) is int and provenance["runId"] > 0
        and type(provenance.get("attempt")) is int and provenance["attempt"] > 0
        and isinstance(release, dict) and isinstance(release.get("tag"), str)
        and re.fullmatch(r"v[0-9][A-Za-z0-9._-]{0,127}", release["tag"])
        and isinstance(release.get("publishedAt"), str) and bool(release["publishedAt"])
        and isinstance(preflight, dict)
        and preflight.get("status", preflight.get("result")) in ("admitted", "passed")
        and preflight.get("commit") == source_sha
    )


def _validate_prepared_cms_candidate(config: dict[str, Any], source_root: Path, operation_id: str,
                                     provenance: Optional[dict[str, Any]] = None) -> tuple[Path, Path, Path]:
    marker = source_root / ".ikpk-rehearsal-ci.json"
    try:
        admitted = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("prepared source candidate lacks admitted CI provenance") from error
    admitted_ref = ("refs/heads/main" if _has_main_release_admission(
        admitted, str(admitted.get("sourceSha"))) else config["allowedSourceRef"])
    if (admitted.get("sourceSha") is None or admitted.get("ref") != admitted_ref
            or (provenance is not None and admitted != provenance)):
        raise HostFailure("prepared candidate provenance differs from the admitted source")
    if (not re.fullmatch(r"[a-f0-9]{40}", str(admitted.get("sourceSha")))
            or source_root.name != f"{admitted['sourceSha']}-{operation_id}"):
        raise HostFailure("prepared candidate path differs from its admitted source and operation")
    source_cms = source_root / "cms"
    generation, expected_generation = _cms_build_generation(config, source_root)
    dependencies_link = source_cms / "node_modules"
    if not dependencies_link.is_symlink():
        raise HostFailure("operation CMS dependencies are not linked to the shared private generation")
    dependencies = _validate_cms_build_generation(config, generation, expected_generation)
    if dependencies_link.resolve(strict=True) != dependencies:
        raise HostFailure("operation CMS dependency link does not target its canonical lock generation")
    artifact = _cms_artifact_path(source_root, operation_id)
    if artifact.is_symlink() or not artifact.is_dir():
        raise HostFailure("prepared CMS artifact is missing or unsafe")
    if config.get("profile") in ("staging194", "production-paired"):
        evidence = _trusted_cms_artifact(admitted)
        _verify_cms_artifact_bytes(source_root, artifact, evidence)
    if sha256_file(source_cms / "package-lock.json") != sha256_file(artifact / "package-lock.json"):
        raise HostFailure("CMS artifact package-lock differs from the operation source lock")
    required = (artifact / "package.json", artifact / "tsconfig.json", artifact / "dist/config/database.js",
                artifact / "database/.migrations-expected",
                artifact / "scripts/run-data-migrations.mjs")
    if any(item.is_symlink() or not item.is_file() for item in required):
        raise HostFailure("prepared CMS artifact is structurally incomplete")
    artifact_dependencies = artifact / "node_modules"
    if not artifact_dependencies.is_symlink() or artifact_dependencies.resolve(strict=True) != dependencies:
        raise HostFailure("CMS artifact node_modules link does not target the final shared dependency tree")
    try:
        source_package = json.loads((source_cms / "package.json").read_text(encoding="utf-8"))
        artifact_package = json.loads((artifact / "package.json").read_text(encoding="utf-8"))
        installed_package = json.loads((dependencies / "@strapi/strapi/package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("CMS source, artifact, or installed Strapi metadata is unreadable") from error
    expected_strapi = source_package.get("dependencies", {}).get("@strapi/strapi")
    artifact_strapi = artifact_package.get("dependencies", {}).get("@strapi/strapi")
    try:
        lock_data = json.loads((source_cms / "package-lock.json").read_text(encoding="utf-8"))
        locked_strapi = lock_data.get("packages", {}).get("node_modules/@strapi/strapi", {}).get("version")
    except (OSError, ValueError, AttributeError) as error:
        raise HostFailure("CMS source lockfile Strapi identity is unreadable") from error
    if (not isinstance(expected_strapi, str) or artifact_strapi != expected_strapi
            or locked_strapi != expected_strapi or installed_package.get("version") != expected_strapi):
        raise HostFailure("CMS source, artifact, and installed Strapi identities do not match")
    _validate_prepared_web_dependencies(source_root)
    return source_root, artifact, dependencies


def _prepare_cms_candidate(config: dict[str, Any], source_root: Path, operation_id: str,
                           provenance: dict[str, Any]) -> tuple[Path, Path, Path]:
    if config.get("profile") in ("staging194", "production-paired"):
        evidence = _trusted_cms_artifact(provenance)
        artifact = _extract_ci_cms_artifact(config, source_root, operation_id, evidence)
        source_cms = source_root / "cms"
        if sha256_file(source_cms / "package-lock.json") != sha256_file(artifact / "package-lock.json"):
            raise HostFailure("CI CMS artifact package-lock differs from the operation source lock")
        dependencies = _prepare_cms_build_dependencies(config, source_root)
        source_dependencies = source_cms / "node_modules"
        if os.path.lexists(source_dependencies):
            if not source_dependencies.is_symlink() or source_dependencies.resolve(strict=True) != dependencies:
                raise HostFailure("operation CMS dependencies are not the canonical lock generation")
        else:
            source_dependencies.symlink_to(dependencies, target_is_directory=True)
        if os.path.lexists(artifact / "node_modules"):
            artifact_dependencies = artifact / "node_modules"
            try:
                canonical_artifact_dependencies = (artifact_dependencies.is_symlink()
                                                   and artifact_dependencies.resolve(strict=True) == dependencies)
            except OSError:
                canonical_artifact_dependencies = False
            if not canonical_artifact_dependencies:
                raise HostFailure("CI CMS artifact node_modules is not the canonical lock generation")
        else:
            artifact.joinpath("node_modules").symlink_to(dependencies, target_is_directory=True)
        _run_as_cms(config, artifact, [config.get("nodeBinary", "/usr/bin/node"), "-e",
            "const Database = require('better-sqlite3'); "
            "const db = new Database(':memory:'); db.close(); require('sharp');"], timeout=120)
        web_dependencies = source_root / "web/node_modules"
        if web_dependencies.is_symlink():
            raise HostFailure("operation web dependencies must be a private source install")
        _run_as_cms(config, source_root / "web", ["/usr/bin/npm", "ci", "--no-audit", "--no-fund"], timeout=1800)
        user = pwd.getpwnam(config["cmsUser"])
        operation_root = artifact.parent
        private_root = operation_root.parent
        rehearsal_root = private_root.parent
        for directory in (rehearsal_root, private_root, operation_root):
            os.chown(directory, user.pw_uid, user.pw_gid)
            os.chmod(directory, 0o700)
        return _validate_prepared_cms_candidate(config, source_root, operation_id, provenance)
    artifact = _cms_artifact_path(source_root, operation_id)
    if os.path.lexists(artifact):
        return _validate_prepared_cms_candidate(config, source_root, operation_id, provenance)
    dependencies = _prepare_cms_build_dependencies(config, source_root)
    source_cms = source_root / "cms"
    source_dependencies = source_cms / "node_modules"
    if os.path.lexists(source_dependencies):
        if not source_dependencies.is_symlink() or source_dependencies.resolve(strict=True) != dependencies:
            raise HostFailure("operation CMS dependency path is occupied by a noncanonical tree")
    else:
        source_dependencies.symlink_to(dependencies, target_is_directory=True)
    web = source_root / "web"
    web_dependencies = web / "node_modules"
    if web_dependencies.is_symlink():
        raise HostFailure("operation web dependencies must be a private source install")
    _run_as_cms(config, web, ["/usr/bin/npm", "ci", "--no-audit", "--no-fund"], timeout=1800)
    operation_root = artifact.parent
    private_root = operation_root.parent
    rehearsal_root = private_root.parent
    if (operation_root.is_symlink() or private_root.is_symlink() or rehearsal_root.is_symlink()
            or artifact.is_symlink()):
        raise HostFailure("CMS artifact preparation path contains a symlink")
    operation_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    user = pwd.getpwnam(config["cmsUser"])
    for directory in (rehearsal_root, private_root, operation_root):
        os.chown(directory, user.pw_uid, user.pw_gid)
        os.chmod(directory, 0o700)
    if os.path.lexists(artifact):
        raise HostFailure("CMS artifact path already exists without a complete prepared candidate")
    _run_as_cms(config, source_cms, ["/usr/bin/bash", str(source_root / "scripts/build-cms-artifact.sh"),
        str(artifact)], timeout=3600, environment={"NODE_OPTIONS": "--max-old-space-size=1536"},
        read_only_path=dependencies)
    if os.path.lexists(artifact / "node_modules"):
        raise HostFailure("CMS artifact unexpectedly contains node_modules before dependency linking")
    (artifact / "node_modules").symlink_to(dependencies, target_is_directory=True)
    return _validate_prepared_cms_candidate(config, source_root, operation_id, provenance)


def _start_acquisition(config: dict[str, Any], state: RehearsalState, operation_id: str,
                       source_sha: str, *, recovery: bool = False,
                       cms_artifact: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    if not recovery:
        _assert_site_refresh_idle(config)
    prior = next((row for row in state._operation_rows(operation_id) if row.get("record") == "start"), None)
    old_pair = prior.get("oldPair") if prior else _old_pair(config)
    _write_site_publication_marker(config, operation_id)
    if cms_artifact is None:
        state.begin(operation_id, source_sha, old_pair)
    else:
        state.begin(operation_id, source_sha, old_pair, cms_artifact=cms_artifact)
    _set_flag(config, True)
    _write_gate(config, True)
    _verify_site_refresh_idle(config, recovery=recovery)
    _stop_writers(config)
    _verify_site_refresh_idle(config, recovery=recovery)
    _verify_fence(config)
    state.confirm_fence(operation_id, lambda: all(
        run(["/usr/bin/systemctl", "is-active", unit], check=False).returncode != 0
        for unit in config["writerUnits"]))
    _record_fenced_baseline(config, state, operation_id, source_sha, old_pair)
    return state.phase(operation_id)


def _verify_fence(config: dict[str, Any]) -> None:
    for url in config.get("writerProbeUrls", []):
        result = run(["/usr/bin/curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
                      "--max-time", "10", "--request", "POST", url], timeout=12)
        if result.stdout.strip() != "503":
            raise HostFailure(f"writer fence probe did not return 503: {url}")
    if config.get("preserveProbeUrl"):
        result = run(["/usr/bin/curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
                      "--max-time", "10", config["preserveProbeUrl"]], timeout=12)
        if result.stdout.strip() not in ("200", "204", "206", "304"):
            raise HostFailure("public media/status preservation probe failed")
    payment_status = run(["/usr/bin/curl", "--silent", "--show-error", "--write-out", "\n%{http_code}",
                          "--max-time", "10", config["paymentStatusProbeUrl"]], timeout=12)
    response, separator, status = payment_status.stdout.rpartition("\n")
    if not separator:
        raise HostFailure("payment status probe did not return an HTTP status")
    if config.get("profile") == "production-paired":
        try:
            body = json.loads(response)
        except json.JSONDecodeError as error:
            raise HostFailure("production payment status probe returned an invalid request response") from error
        errors = body.get("errors") if isinstance(body, dict) else None
        if (status.strip() != "400" or not isinstance(errors, list) or body.get("status") != "rejected"
                or {"field": "requestId", "message": "must be UUID v4"} not in errors):
            raise HostFailure("production payment status route did not reject the invalid probe requestId")
    elif status.strip() != "404":
        raise HostFailure("disabled payment status route did not retain its expected 404")


def _create_capture_bundle(config: dict[str, Any], operation_id: str, source_sha: str,
                           source_root: Path, database: Path,
                           read_only_paths: Optional[list[Path]] = None) -> Path:
    operation_root = source_root / ".staging193-rehearsal" / operation_id
    operation_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if operation_root.is_symlink() or operation_root.parent.is_symlink():
        raise HostFailure("rehearsal work directory contains a symlink")
    capture = operation_root / "capture"
    capture.mkdir(mode=0o700)
    shutil.copy2(database, capture / "database.sqlite")
    media = _capture_media(config, capture)
    durable_json(capture / "media-manifest.json", {"media": media})
    user = pwd.getpwnam(config["cmsUser"])
    if operation_root.stat().st_uid != user.pw_uid or stat.S_IMODE(operation_root.stat().st_mode) & 0o077:
        raise HostFailure("rehearsal work directory must be private and owned by the CMS service user")
    for path in [capture, *capture.rglob("*")]:
        os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
    node = config.get("nodeBinary", "/usr/bin/node")
    capture_profile = "production-static" if config.get("profile") == "production-paired" else config.get("profile", "staging194")
    seal_args = [node, str(source_root / "scripts/lib/seal-staging193-capture.mjs"),
        str(capture), operation_id, source_sha, str(source_root / "cms/src"), capture_profile]
    if config.get("profile") in ("initial-prod", "production-static", "production-paired"):
        provenance = json.loads((source_root / ".ikpk-rehearsal-ci.json").read_text(encoding="utf-8"))
        seal_args.append(str(provenance["runId"]))
        seal_args.append(str(provenance["attempt"]))
    _run_as_cms(config, source_root / "web", seal_args, timeout=300, read_only_path=read_only_paths)
    return capture


def _configure_candidate_uploads(config: dict[str, Any], artifact_root: Path) -> Path:
    user = pwd.getpwnam(config["cmsUser"])
    uploads = artifact_root / "public/uploads"
    if uploads.is_symlink():
        raise HostFailure("packaged CMS uploads path must not be a symlink before configuration")
    if uploads.exists():
        if not uploads.is_dir():
            raise HostFailure("packaged CMS uploads path must be a directory")
        entries = list(uploads.iterdir())
        if any(item.name != ".gitkeep" or item.is_symlink() or not item.is_file() for item in entries):
            raise HostFailure("packaged CMS uploads directory contains unexpected files")
        for item in entries:
            item.unlink()
        uploads.rmdir()
    configured = next((Path(item["path"]) for item in config["mediaRoots"]
                       if item["prefix"] == "/uploads/"), None)
    if configured is None or configured.is_symlink() or not configured.is_dir():
        raise HostFailure("configured external CMS uploads root is unavailable")
    media_root = configured.resolve(strict=True)
    root_info = media_root.stat()
    if root_info.st_uid != user.pw_uid or not os.access(media_root, os.W_OK | os.X_OK):
        raise HostFailure("external CMS uploads root is not writable by the CMS service user")
    uploads.symlink_to(media_root, target_is_directory=True)
    return media_root


def _cms_payload_sha256(root: Path, uploads: Path, expected_dependencies: Path | None = None) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix().encode()
        info = path.lstat()
        if relative.startswith(b"node_modules/"):
            # npm's private dependency tree is sealed by package-lock plus the
            # migration runner fingerprint; hashing every installed byte here
            # would make every old-pair read traverse hundreds of megabytes.
            if stat.S_ISLNK(info.st_mode):
                node_root = (root / "node_modules").resolve(strict=True)
                if not path.resolve(strict=True).is_relative_to(node_root):
                    raise HostFailure(f"CMS dependency symlink escapes node_modules: {path}")
            continue
        if stat.S_ISLNK(info.st_mode):
            if relative == b"public/uploads" and path.resolve(strict=True) == uploads.resolve(strict=True):
                payload = b"symlink:" + str(path.readlink()).encode()
            elif relative == b"node_modules":
                target = path.resolve(strict=True)
                target_info = target.stat()
                expected = expected_dependencies.resolve(strict=True) if expected_dependencies is not None else None
                if (target.name != "node_modules" or not target.is_dir() or
                        target_info.st_mode & 0o022 or
                        (expected is not None and target != expected)):
                    raise HostFailure("CMS node_modules link is not a private installed dependency tree")
                payload = b"symlink:" + str(path.readlink()).encode()
            else:
                raise HostFailure(f"CMS payload contains an unexpected symlink: {path}")
        elif stat.S_ISDIR(info.st_mode):
            continue
        elif stat.S_ISREG(info.st_mode):
            payload = bytes.fromhex(sha256_file(path))
        else:
            raise HostFailure(f"CMS payload contains a non-regular object: {path}")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(payload)
    return digest.hexdigest()


def _config_sha256(config: dict[str, Any]) -> str:
    payload = json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256_file_bytes(payload)


def _install_migrated_database(config: dict[str, Any], source_root: Path, operation_id: str,
                               old_cms_root: Path) -> tuple[Path, Path, str]:
    live = Path(config["cmsDatabase"]).resolve(strict=True)
    _source, artifact_dir, dependencies = _validate_prepared_cms_candidate(config, source_root, operation_id)
    operation_root = artifact_dir.parent
    if operation_root.is_symlink() or not operation_root.is_dir():
        raise HostFailure("prepared CMS migration directory is missing or unsafe")
    user = pwd.getpwnam(config["cmsUser"])
    if operation_root.parent.is_symlink() or operation_root.parent.parent.is_symlink():
        raise HostFailure("migration work directory contains a symlink")
    candidate = operation_root / "candidate.db"
    receipt = operation_root / "receipt.json"
    if any(os.path.lexists(path) for path in (candidate, receipt)):
        raise HostFailure("CMS migration candidate already exists; inspect the operation before retrying")
    runner = artifact_dir / "scripts/run-data-migrations.mjs"
    common = ["--operation-id", operation_id, "--source-db", str(live), "--source-cms-root", str(old_cms_root),
              "--candidate-db", str(candidate), "--artifact-dir", str(artifact_dir), "--receipt", str(receipt)]
    _run_as_cms(config, artifact_dir, [config.get("nodeBinary", "/usr/bin/node"), str(runner), "prepare", *common], timeout=3600)
    status = _run_as_cms(config, artifact_dir, [config.get("nodeBinary", "/usr/bin/node"), str(runner), "status",
        "--operation-id", operation_id, "--candidate-db", str(candidate), "--receipt", str(receipt)], timeout=300)
    try:
        report = json.loads(status)
    except ValueError as error:
        raise HostFailure("migration runner returned malformed status JSON") from error
    if report.get("phase") != "prepared" or report.get("passed") is False:
        raise HostFailure("CMS migration prepare/audit did not pass")
    uploads_root = _configure_candidate_uploads(config, artifact_dir)
    import sqlite3
    _assert_no_database_handles(candidate)
    database = sqlite3.connect(str(candidate), timeout=10)
    try:
        checkpoint = database.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if checkpoint is None or checkpoint[0] != 0 or (checkpoint[1] >= 0 and checkpoint[1] != checkpoint[2]):
            raise HostFailure("migrated candidate WAL checkpoint is busy or incomplete")
    finally:
        database.close()
    _assert_no_database_handles(candidate)
    return candidate, artifact_dir, _cms_payload_sha256(artifact_dir, uploads_root, dependencies)


def _activate_cms(config: dict[str, Any], cms_release: Path, candidate_db: Path,
                  capture: Path, source_root: Optional[Path] = None,
                  source_sha: Optional[str] = None,
                  site_workspace: Optional[Path] = None,
                  cms_artifact: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    if config.get("profile") in ("staging194", "production-paired"):
        if source_root is None or cms_artifact is None:
            raise HostFailure("paired CMS activation lacks its journal-bound CI artifact identity")
        try:
            admitted = json.loads((source_root / ".ikpk-rehearsal-ci.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HostFailure("paired CMS activation lacks admitted source provenance") from error
        if _trusted_cms_artifact(admitted) != cms_artifact:
            raise HostFailure("paired CMS activation artifact identity differs from the operation journal")
        _verify_cms_artifact_bytes(source_root, cms_release, cms_artifact)
    live = Path(config["cmsDatabase"]).resolve(strict=True)
    _assert_no_database_handles(live)
    _copy_atomic(candidate_db, live)
    _switch_pointer(Path(config["currentCms"]), cms_release, Path(config["releaseRoot"]))
    if config.get("profile") == "production-paired":
        if source_root is None or source_sha is None or not SHA_RE.fullmatch(source_sha):
            raise HostFailure("paired CMS activation lacks its admitted source workspace")
        workspace = site_workspace.resolve(strict=True) if site_workspace else None
        if workspace is None or not workspace.is_relative_to(PRODUCTION_PAIRED_WORKSPACE_ROOT):
            raise HostFailure("paired CMS activation lacks its service-writable site workspace")
        if any(not (workspace / part).is_file() for part in ("cms/package.json", "web/package.json")):
            raise HostFailure("paired CMS source workspace is incomplete")
        payment_endpoint = config.get("paymentEndpointProd")
        chat_loader = config.get("chatLoaderSrc")
        if payment_endpoint != INITIAL_PROD_PAYMENT_ENDPOINT or not isinstance(chat_loader, str) or not chat_loader.startswith("https://"):
            raise HostFailure("paired CMS activation lacks the validated production site build settings")
        _write_paired_cms_source_env(config, {
            "IKPK_BUILD_WORKSPACE": str(workspace), "IKPK_INSTALLED_COMMIT": source_sha,
            "INITIAL_PROD_PROFILE": "1", "DEPLOY_MODE": "prod", "PAYMENT_ROLE": "prod",
            "PAYMENT_ENDPOINT_PROD": payment_endpoint, "DEMO_FORMS": None,
            "CHAT_LOADER_SRC": chat_loader, "CHAT_OFFLINE_MESSAGE": None})
    run(["/usr/bin/systemctl", "start", config["cmsUnit"]], timeout=120)
    _wait_health(config["cmsHealthUrl"])
    proof = _database_process_proof(_service_pid(config["cmsUnit"]), live)
    inventory = json.loads((capture / "media-manifest.json").read_text(encoding="utf-8")).get("media")
    if not isinstance(inventory, list) or not inventory:
        raise HostFailure("sealed CMS capture has no media entries for a runtime media probe")
    upload = next((item for item in inventory if isinstance(item, dict)
                   and isinstance(item.get("url"), str) and item["url"].startswith("/uploads/")), None)
    if upload is None:
        raise HostFailure("sealed CMS media inventory has no /uploads/ entry for a runtime media probe")
    media_url = upload["url"]
    media_path = upload.get("originalName")
    if not isinstance(media_path, str) or not media_path:
        raise HostFailure("sealed CMS media inventory has an invalid /uploads/ entry for a runtime media probe")
    relative = Path(media_path)
    if (media_url != "/uploads/" + media_path or relative.is_absolute()
            or relative.as_posix() != media_path or any(part in ("", ".", "..") for part in relative.parts)):
        raise HostFailure("sealed CMS media inventory has an invalid /uploads/ entry for a runtime media probe")
    from urllib.parse import quote
    health_suffix = "/_health"
    if not config["cmsHealthUrl"].endswith(health_suffix):
        raise HostFailure("configured CMS health URL cannot bind the runtime media probe")
    probe_url = config["cmsHealthUrl"][:-len(health_suffix)] + quote(media_url, safe="/")
    media_probe = run(["/usr/bin/curl", "--fail", "--silent", "--show-error", "--output", "/dev/null",
                       "--max-time", "15", probe_url],
                      timeout=20, check=False)
    if media_probe.returncode:
        raise HostFailure("CMS did not serve the captured original media file after activation")
    return proof


def _build_static(config: dict[str, Any], source_root: Path, capture: Path,
                  read_only_paths: Optional[list[Path]] = None,
                  chat_loader_src: Optional[str] = None,
                  operation_id: Optional[str] = None,
                  reused_capture: Optional[dict[str, str]] = None,
                  reuse_snapshot: bool = False) -> tuple[Path, str]:
    if chat_loader_src is not None and (config.get("profile", "staging194") not in ("staging194", "production-static")
                                        or chat_loader_src != STAGING194_CHAT_LOADER_SRC):
        raise HostFailure("only staging194 static-main may use the owner-approved chat loader; production-static uses the production profile")
    maintenance_banner = _maintenance_banner(config)
    web = source_root / "web"
    _validate_prepared_web_dependencies(source_root)
    initial_prod = config.get("profile") == "initial-prod"
    production_static = config.get("profile") in ("production-static", "production-paired")
    capture_environment = {"CONTENT_SNAPSHOT_DIR": str(web / ".snapshot")}
    if initial_prod:
        capture_environment.update({"INITIAL_PROD_PROFILE": "1", "DEPLOY_MODE": "prod", "PAYMENT_ROLE": "prod",
                                   "PAYMENT_ENDPOINT_PROD": INITIAL_PROD_PAYMENT_ENDPOINT,
                                   "CHAT_LOADER_SRC": INITIAL_PROD_CHAT_LOADER_SRC})
        capture_args = ["--server-capture", "--profile", "initial-prod", str(capture)]
        build_script = "build"
        dist_name = "dist"
    elif production_static:
        capture_environment.update({"INITIAL_PROD_PROFILE": "1", "DEPLOY_MODE": "prod", "PAYMENT_ROLE": "prod",
                                   "PAYMENT_ENDPOINT_PROD": INITIAL_PROD_PAYMENT_ENDPOINT,
                                   "CHAT_LOADER_SRC": INITIAL_PROD_CHAT_LOADER_SRC})
        capture_args = ["--server-capture", "--profile", "production-static", str(capture)]
        build_script = "build"
        dist_name = "dist"
    else:
        capture_environment.update({"DEMO_PROFILE": "demo193", "DEPLOY_MODE": "stand", "PAYMENT_ROLE": "ci",
                                   "DEMO_FORMS": "stub", "CHAT_LOADER_SRC": chat_loader_src or "none",
                                   "CHAT_OFFLINE_MESSAGE": "absent", "DEMO_SITE_URL": config["siteBaseUrl"]})
        capture_args = ["--server-capture", str(capture)]
        build_script = "build:demo193"
        dist_name = "dist-demo193"
    if not reuse_snapshot:
        _run_as_cms(config, web, [str(web / "node_modules/.bin/tsx"),
            str(web / "scripts/capture-content-snapshot.ts"), *capture_args], timeout=1800,
            environment=capture_environment, read_only_path=read_only_paths)
    build_environment = dict(capture_environment, MAINTENANCE_BANNER=maintenance_banner)
    if chat_loader_src is not None and config.get("profile", "staging194") == "staging194":
        build_environment["CHAT_LOADER_PROFILE"] = "staging194-static-main"
    _run_as_cms(config, web, ["/usr/bin/npm", "run", build_script], timeout=1800,
                environment=build_environment, read_only_path=read_only_paths)
    dist = web / dist_name
    if not dist.is_dir() or dist.is_symlink():
        raise HostFailure(f"static build did not produce a real {dist_name} directory")
    snapshot = json.loads((web / ".snapshot/snapshot.json").read_text(encoding="utf-8"))
    source_identity = json.loads((source_root / ".ikpk-rehearsal-ci.json").read_text(encoding="utf-8"))
    if initial_prod or production_static:
        proof = snapshot.get("captureProof", {})
        expected_policy = "initial-production" if initial_prod else "production-static"
        expected_capture_id = INITIAL_PROD_OPERATION_ID if initial_prod else operation_id
        if (snapshot.get("sourcePolicy") != expected_policy or snapshot.get("sourceAge") != "source-bound"
                or snapshot.get("origin", {}).get("sourceId") != "initial-prod-server-db"
                or proof.get("captureId") != expected_capture_id
                or proof.get("sourceSha") != source_identity.get("sourceSha")
                or proof.get("runId") != source_identity.get("runId")
                or proof.get("attempt") != source_identity.get("attempt")
                or proof.get("targetHost") != INITIAL_PROD_HOST or proof.get("siteUrl") != "https://ikpk.su"):
            raise HostFailure("initial-prod capture proof differs from exact source/run/target admission")
    release = {"commit": source_identity["sourceSha"], "operationId": operation_id or capture.parent.name,
               "snapshotId": snapshot.get("snapshotId"),
               "staticTreeSha256": _tree_sha256(dist)}
    if reused_capture is not None:
        release["reusedCapture"] = reused_capture
    if not isinstance(release["snapshotId"], str) or not release["snapshotId"].startswith("snap:"):
        raise HostFailure("static candidate snapshot ID is missing")
    durable_json(dist / "release.json", release)
    os.chmod(dist / "release.json", 0o644)
    digest = _tree_sha256(dist)
    return dist, digest


def _served_release_matches(config: dict[str, Any], source_sha: str, operation_id: str,
                            digest: str) -> dict[str, Any]:
    result = run(["/usr/bin/curl", "--fail", "--silent", "--show-error", "--max-time", "15",
                 config["siteReleaseUrl"]], timeout=20)
    try:
        release = json.loads(result.stdout)
    except ValueError as error:
        raise HostFailure("served /release.json is malformed") from error
    if (release.get("commit") != source_sha or release.get("operationId") != operation_id or
            release.get("staticTreeSha256") != digest):
        raise HostFailure("served /release.json does not identify the admitted static candidate")
    return release


def _reopen(config: dict[str, Any], state: RehearsalState, operation_id: str) -> None:
    state.assert_terminal_reopen_allowed(operation_id)
    if state._read_marker() is None:
        if not all(run(["/usr/bin/systemctl", "is-active", unit], check=False).returncode == 0
                   for unit in config["writerUnits"]):
            raise HostFailure("committed writers are not active; retry static-publish to finalize")
        return
    _set_flag(config, False)
    _write_gate(config, False)
    run(["/usr/bin/systemctl", "start", *config["writerUnits"]], timeout=120)
    state.finalize(operation_id, lambda: all(
        run(["/usr/bin/systemctl", "is-active", unit], check=False).returncode == 0
        for unit in config["writerUnits"]))


def _backup_manifest(config: dict[str, Any], operation_id: str, directory: Optional[Path] = None) -> dict[str, Any]:
    server_directory = Path(config["backupRoot"]) / operation_id
    is_offhost_copy = directory is not None
    directory = directory or server_directory
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        archive = directory / "backup.tar"
    except (OSError, ValueError) as error:
        raise HostFailure("operation has no complete immutable backup") from error
    if is_offhost_copy:
        try:
            host_manifest = json.loads((server_directory / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HostFailure("server backup manifest is unavailable for off-host verification") from error
        expected_archive_sha = host_manifest.get("archiveSha256")
    else:
        expected_archive_sha = manifest.get("archiveSha256")
    if manifest.get("operationId") != operation_id or not SHA256_RE.fullmatch(expected_archive_sha or ""):
        raise HostFailure("backup manifest is not bound to the operation")
    if sha256_file(archive) != expected_archive_sha:
        raise HostFailure("server backup archive changed after capture")
    return {**manifest, "archiveSha256": expected_archive_sha}


def _import_offhost_backup(config: dict[str, Any], operation_id: str, payload: bytes,
                           expected_sha256: str) -> Path:
    try:
        server_manifest = json.loads((Path(config["backupRoot"]) / operation_id / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("durable server backup manifest is unavailable for recovery import") from error
    if server_manifest.get("operationId") != operation_id or not SHA256_RE.fullmatch(server_manifest.get("archiveSha256", "")):
        raise HostFailure("durable server backup manifest is not bound to this recovery operation")
    if expected_sha256 != server_manifest["archiveSha256"]:
        raise HostFailure("off-host recovery archive is not the exact server-captured backup")
    if not SHA256_RE.fullmatch(expected_sha256) or sha256_file_bytes(payload) != expected_sha256:
        raise HostFailure("off-host recovery archive bytes do not match their supplied digest")
    operation_dir = Path(config["backupRoot"]) / operation_id
    if operation_dir.is_symlink() or not operation_dir.is_dir():
        raise HostFailure("operation backup directory is unavailable for verified recovery import")
    destination = operation_dir / "offhost-backup"
    if destination.exists():
        archive = destination / "backup.tar"
        if destination.is_symlink() or not archive.is_file() or sha256_file(archive) != expected_sha256:
            raise HostFailure("existing off-host recovery import belongs to different bytes")
        return destination
    temporary = operation_dir / f".offhost-backup.new-{os.getpid()}"
    temporary.mkdir(mode=0o700)
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as source:
            seen = set()
            for member in source.getmembers():
                relative = Path(member.name)
                if relative.is_absolute() or not member.name or any(part in (".", "..") for part in relative.parts):
                    raise HostFailure("off-host backup contains an unsafe path")
                name = relative.as_posix()
                if name in seen or not (member.isdir() or member.isfile()):
                    raise HostFailure("off-host backup has duplicate or unsupported members")
                seen.add(name)
                target = temporary / relative
                if target == temporary or temporary not in target.parents:
                    raise HostFailure("off-host backup member escapes its operation directory")
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    stream = source.extractfile(member)
                    if stream is None:
                        raise HostFailure("off-host backup contains an unreadable member")
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                    with os.fdopen(fd, "wb") as output:
                        shutil.copyfileobj(stream, output)
                        output.flush()
                        os.fsync(output.fileno())
        manifest = json.loads((temporary / "manifest.json").read_text(encoding="utf-8"))
        media_bytes = (temporary / "media-manifest.json").read_bytes()
        database = temporary / "database.sqlite"
        if manifest.get("operationId") != operation_id or sha256_file(database) != manifest.get("databaseSha256"):
            raise HostFailure("off-host database bytes do not match the operation backup manifest")
        if sha256_file(temporary / "media-manifest.json") != manifest.get("mediaManifestSha256"):
            raise HostFailure("off-host media manifest bytes do not match the operation backup manifest")
        media_doc = json.loads(media_bytes)
        media = media_doc.get("media") if isinstance(media_doc, dict) else media_doc
        if not isinstance(media, list):
            raise HostFailure("off-host media manifest is malformed")
        for item in media:
            relative = Path(item.get("file", ""))
            if not item.get("file") or relative.is_absolute() or any(part in (".", "..") for part in relative.parts):
                raise HostFailure("off-host media inventory contains an unsafe path")
            copied = temporary / relative
            if copied.is_symlink() or not copied.is_file() or sha256_file(copied) != item.get("sha256") or copied.stat().st_size != item.get("size"):
                raise HostFailure("off-host media bytes do not match the captured inventory")
        import sqlite3
        checked = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            if checked.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise HostFailure("off-host database failed SQLite integrity verification")
        finally:
            checked.close()
        archive_fd = os.open(temporary / "backup.tar", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(archive_fd, "wb") as archive_file:
            archive_file.write(payload)
            archive_file.flush()
            os.fsync(archive_file.fileno())
        manifest["archiveSha256"] = expected_sha256
        durable_json(temporary / "manifest.json", manifest)
        os.replace(temporary, destination)
        fd = os.open(operation_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return destination
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def _cms_update(config: dict[str, Any], state: RehearsalState, args: argparse.Namespace) -> dict[str, Any]:
    if _uses_staging194_temp(config):
        tempfile.tempdir = str(_validate_staging194_temporary_root(config))
    op, sha = args.operation_id, args.source_sha
    if not SHA_RE.fullmatch(sha):
        raise HostFailure("source SHA must be a full lowercase commit ID")
    try:
        provenance = json.loads(base64.b64decode(args.provenance_b64, validate=True))
    except (ValueError, TypeError) as error:
        raise HostFailure("source CI provenance is not valid base64 JSON") from error
    if config.get("profile", "staging194") == "initial-prod":
        if op != INITIAL_PROD_OPERATION_ID:
            raise HostFailure("initial-prod accepts only its fixed single-use operation ID")
        if (provenance.get("ref") != "refs/heads/main" or provenance.get("sourceSha") != sha
                or provenance.get("event") != "push" or provenance.get("headBranch") != "main"
                or provenance.get("repository") != "pgorbachev/ikpk"
                or not isinstance(provenance.get("runId"), int) or provenance["runId"] <= 0
                or not isinstance(provenance.get("attempt"), int) or provenance["attempt"] <= 0):
            raise HostFailure("initial-prod source admission must bind exact canonical main push run")
    profile = config.get("profile", "staging194")
    main_release_admission = _has_main_release_admission(provenance, sha)
    cms_artifact = None
    if profile in ("staging194", "production-paired"):
        _validate_paired_ci_workflows(sha, provenance)
        if profile == "production-paired" and not main_release_admission:
            raise HostFailure("production-paired source archive lacks stable Release and exact-main admission evidence")
        cms_artifact = _trusted_cms_artifact(provenance)
    try:
        phase = state.phase(op)
    except RehearsalRefusal:
        phase = None
    if phase and phase.get("sourceSha") not in (None, sha):
        raise HostFailure("operation ID is already bound to another source SHA")
    source_root = _candidate_root(config, sha, op)
    if phase:
        start_record = next((row for row in state._operation_rows(op) if row.get("record") == "start"), None)
        if profile in ("staging194", "production-paired"):
            if not start_record or start_record.get("cmsArtifact") != cms_artifact:
                raise HostFailure("operation journal CMS artifact identity differs from trusted provenance")
            _validate_prepared_cms_candidate(config, source_root, op, provenance)
    if phase and phase.get("phase") == "cms-activated":
        manifest = _backup_manifest(config, op)
        _verify_fence(config)
        _wait_health(config["cmsHealthUrl"], 1200)
        proof = _database_process_proof(_service_pid(config["cmsUnit"]), Path(config["cmsDatabase"]))
        if not args.offhost_sha256:
            return {"operationId": op, "sourceSha": sha, "phase": "cms-activated",
                    "offhostBackupRequired": True, "backupSha256": manifest["archiveSha256"]}
        if args.offhost_sha256 != manifest["archiveSha256"]:
            raise HostFailure("operator-confirmed off-host backup digest differs from actual captured bytes")
        return {"operationId": op, "sourceSha": sha, "phase": "cms-activated",
                "backupSha256": manifest["archiveSha256"], "cmsDatabaseProof": proof}
    if phase is None:
        if args.offhost_sha256:
            raise HostFailure("off-host confirmation cannot precede initial source preparation and backup")
        state.assert_new_operation_allowed(op, sha)
        if not SHA256_RE.fullmatch(args.archive_sha256 or ""):
            raise HostFailure("source archive SHA-256 is required before acquisition")
        archive_bytes = sys.stdin.buffer.read()
        if not archive_bytes:
            raise HostFailure("admitted source archive is required before acquisition")
        if profile == "production-paired":
            source_root = _extract_source_archive(config, sha, op, archive_bytes, args.archive_sha256,
                                                 provenance, expected_ref="refs/heads/main")
        else:
            source_root = _extract_source_archive(config, sha, op, archive_bytes,
                                                 args.archive_sha256, provenance)
        del archive_bytes
        _prepare_cms_candidate(config, source_root, op, provenance)
    else:
        _validate_prepared_cms_candidate(config, source_root, op, provenance)
    site_workspace = (_prepare_paired_site_workspace(config, source_root, sha, op)
                      if config.get("profile") == "production-paired" else None)
    if profile in ("staging194", "production-paired"):
        _validate_prepared_cms_candidate(config, source_root, op, provenance)
    phase = (_start_acquisition(config, state, op, sha) if cms_artifact is None else
             _start_acquisition(config, state, op, sha, cms_artifact=cms_artifact))
    backup_manifest_path = Path(config["backupRoot"]) / op / "manifest.json"
    if not backup_manifest_path.exists():
        _verify_fence(config)
        manifest = _backup(config, op)
    else:
        manifest = _backup_manifest(config, op)
    if not args.offhost_sha256:
        return {"operationId": op, "sourceSha": sha, "phase": phase["phase"],
                "offhostBackupRequired": True, "backupSha256": manifest["archiveSha256"]}
    if args.offhost_sha256 != manifest["archiveSha256"]:
        raise HostFailure("operator-confirmed off-host backup digest differs from actual captured bytes")
    start = next((row for row in state._operation_rows(op) if row.get("record") == "start"), None)
    if not start or not isinstance(start.get("oldPair", {}).get("cmsPath"), str):
        raise HostFailure("operation journal has no recorded old CMS release for migration provenance")
    old_cms_root = Path(start["oldPair"]["cmsPath"])
    candidate_db, cms_release, cms_payload_sha = _install_migrated_database(config, source_root, op, old_cms_root)
    capture = _create_capture_bundle(config, op, sha, source_root, candidate_db)
    if profile in ("staging194", "production-paired"):
        _validate_prepared_cms_candidate(config, source_root, op, provenance)
    proof = _activate_cms(config, cms_release, candidate_db, capture, source_root, sha, site_workspace,
                          cms_artifact=cms_artifact)
    _wait_health(config["cmsHealthUrl"], 1200)
    _verify_fence(config)
    state.mark_cms_activated(op)
    return {"operationId": op, "sourceSha": sha, "phase": "cms-activated",
            "backupSha256": manifest["archiveSha256"], "captureDirectory": str(capture),
            "cmsDatabaseProof": proof, "cmsPayloadSha256": cms_payload_sha}


def _store_static(config: dict[str, Any], source_sha: str, operation_id: str, built: Path, digest: str) -> Path:
    root = Path(config["staticReleaseRoot"]).resolve(strict=True)
    destination = root / f"{source_sha}-{operation_id}"
    if destination.exists():
        if destination.is_symlink() or _tree_sha256(destination) != digest:
            raise HostFailure("retained static release differs from this candidate")
        return destination
    temporary = root / f".{source_sha}.new-{os.getpid()}"
    if temporary.exists():
        shutil.rmtree(temporary)
    shutil.copytree(built, temporary, symlinks=False)
    if _tree_sha256(temporary) != digest:
        shutil.rmtree(temporary, ignore_errors=True)
        raise HostFailure("static release bytes changed while being retained")
    os.replace(temporary, destination)
    fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return destination



STATIC_MAIN_REQUIRED_JOBS = {
    "Capture content snapshot", "Unit and build tests", "Dependency update invariants",
    "Scripts unit tests", "Playwright smoke (desktop + mobile)",
}
STATIC_MAIN_ADDITIONAL_WORKFLOWS = ("Lint and Typecheck", "Security", "Lighthouse CI")


def _validate_paired_ci_workflows(source_sha: str, provenance: dict[str, Any],
                                  subject: str = "paired") -> None:
    if (not SHA_RE.fullmatch(source_sha) or provenance.get("repository") != "pgorbachev/ikpk"
            or provenance.get("ref") != "refs/heads/main" or provenance.get("sourceSha") != source_sha
            or provenance.get("workflow") != "Tests" or provenance.get("workflowName") != "Tests"
            or provenance.get("event") != "push" or provenance.get("headBranch") != "main"
            or provenance.get("status") != "completed" or provenance.get("conclusion") != "success"
            or type(provenance.get("runId")) is not int or provenance["runId"] <= 0
            or type(provenance.get("attempt")) is not int or provenance["attempt"] <= 0
            or provenance.get("requiredJobs") != sorted(STATIC_MAIN_REQUIRED_JOBS)):
        raise HostFailure(f"{subject} source provenance must bind exact-SHA successful main push CI")
    expected_url = f"https://github.com/pgorbachev/ikpk/actions/runs/{provenance['runId']}"
    if provenance.get("runUrl") != expected_url:
        raise HostFailure(f"{subject} Tests run URL does not match its exact run ID")
    additional = provenance.get("additionalWorkflows")
    if not isinstance(additional, list) or len(additional) != len(STATIC_MAIN_ADDITIONAL_WORKFLOWS):
        raise HostFailure(f"{subject} provenance must include Lint and Typecheck, Security, and Lighthouse CI")
    by_name = {proof.get("workflow"): proof for proof in additional if isinstance(proof, dict)}
    if set(by_name) != set(STATIC_MAIN_ADDITIONAL_WORKFLOWS):
        raise HostFailure(f"{subject} provenance is missing an exact main CI workflow proof")
    for workflow in STATIC_MAIN_ADDITIONAL_WORKFLOWS:
        proof = by_name[workflow]
        jobs = proof.get("requiredJobs")
        if (proof.get("headSha") != source_sha or proof.get("event") != "push"
                or proof.get("headBranch") != "main" or proof.get("status") != "completed"
                or proof.get("conclusion") != "success" or type(proof.get("runId")) is not int
                or proof["runId"] <= 0 or type(proof.get("attempt")) is not int or proof["attempt"] <= 0
                or not isinstance(jobs, list) or not jobs
                or any(not isinstance(job, str) or not job for job in jobs)
                or jobs != sorted(set(jobs))
                or proof.get("runUrl") != f"https://github.com/pgorbachev/ikpk/actions/runs/{proof['runId']}"):
            raise HostFailure(f"{subject} {workflow} proof does not bind successful exact-main jobs")


def _static_main_release_policy(config: dict[str, Any]) -> str:
    policy = config.get("staticMainReleasePolicy")
    if policy != "ci-only-approved":
        raise HostFailure("static-main requires the owner's explicit ci-only-approved policy")
    return policy


def _validate_static_main_admission(config: dict[str, Any], source_sha: str,
                                    provenance: dict[str, Any]) -> None:
    if config.get("profile", "staging194") not in ("staging194", "production-static"):
        raise HostFailure("static-main is bound to the staging194 or production-static host profile")
    policy = _static_main_release_policy(config)
    _validate_paired_ci_workflows(source_sha, provenance, subject="static-main")


def _static_main_cms_fingerprint(config: dict[str, Any]) -> dict[str, Any]:
    cms = _current_target(Path(config["currentCms"]))
    database = Path(config["cmsDatabase"]).resolve(strict=True)
    pid = _service_pid(config["cmsUnit"])
    process = _database_process_proof(pid, database)
    uploads = next(Path(item["path"]).resolve(strict=True) for item in config["mediaRoots"]
                   if item["prefix"] == "/uploads/")
    service = run(["/usr/bin/systemctl", "show", "--property=ActiveState", "--property=SubState",
                   "--property=MainPID", "--property=Environment", "--property=EnvironmentFiles",
                   "--property=FragmentPath", config["cmsUnit"]]).stdout
    env_paths = set(re.findall(r"(?:^|[=\s])(-?/[^\s]+) \(ignore_errors=(?:yes|no)\)", service))
    env_files = []
    for env_path in sorted(env_paths):
        path = Path(env_path.removeprefix("-"))
        try:
            env_files.append({"path": str(path.resolve(strict=True)), "sha256": sha256_file(path)})
        except OSError as error:
            raise HostFailure("CMS environment file disappeared during static-main fingerprinting") from error
    database_files = {}
    for suffix in ("", "-wal"):
        path = Path(str(database) + suffix)
        database_files[suffix or "database"] = sha256_file(path) if path.is_file() else None
    return {
        "cmsPath": str(cms),
        "cmsPayloadSha256": _cms_payload_sha256(cms, uploads),
        "cmsUnit": config["cmsUnit"],
        "cmsMainPid": pid,
        "cmsEnvironmentSha256": hashlib.sha256(service.encode()).hexdigest(),
        "cmsEnvironmentFiles": env_files,
        "databasePath": str(database),
        "databaseProcess": process,
        "databaseFiles": database_files,
        "uploadsRoot": str(uploads),
        "uploadsTreeSha256": _tree_sha256(uploads),
    }


def _static_main_protected_paths(config: dict[str, Any]) -> list[Path]:
    """Protect live CMS inputs from every unprivileged process in static-main."""
    current_cms = _current_target(Path(config["currentCms"]))
    database = Path(config["cmsDatabase"]).resolve(strict=True)
    uploads = next(Path(item["path"]).resolve(strict=True) for item in config["mediaRoots"]
                   if item["prefix"] == "/uploads/")
    service = run(["/usr/bin/systemctl", "show", "--property=EnvironmentFiles", "--property=FragmentPath",
                   "--property=DropInPaths", config["cmsUnit"]]).stdout
    paths = {current_cms, database.parent, uploads}
    if config.get("currentStatic"):
        paths.add(_current_target(Path(config["currentStatic"])))
    paths.update(Path(item.removeprefix("-")).resolve(strict=True)
                 for item in re.findall(r"(?:^|[=\s])(-?/[^\s]+) \(ignore_errors=(?:yes|no)\)", service))
    values = {}
    for line in service.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    fragment = values.get("FragmentPath", "")
    if fragment.startswith("/"):
        paths.add(Path(fragment).resolve(strict=True))
    for item in values.get("DropInPaths", "").split():
        if item.startswith("/"):
            paths.add(Path(item).resolve(strict=True))
    protected = []
    for path in sorted(paths, key=str):
        if not path.is_absolute() or any(char.isspace() for char in str(path)):
            raise HostFailure("static-main protected path is not a safe absolute path")
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise HostFailure("static-main protected path is unavailable or unsafe")
        resolved = path.resolve(strict=True)
        if resolved != path:
            raise HostFailure("static-main protected path is not canonical")
        protected.append(path)
    return protected


def _readonly_database_snapshot(config: dict[str, Any], operation_root: Path) -> Path:
    import sqlite3
    live = Path(config["cmsDatabase"]).resolve(strict=True)
    target = operation_root / "static-main-source.sqlite"
    if target.exists() or target.is_symlink():
        raise HostFailure("static-main read-only database snapshot already exists")
    source = sqlite3.connect(f"file:{live}?mode=ro", uri=True, timeout=10)
    destination = sqlite3.connect(str(target), timeout=10)
    try:
        before = source.execute("PRAGMA data_version").fetchone()[0]
        source.backup(destination)
        destination.commit()
        mode = destination.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
        if str(mode).lower() != "delete":
            raise HostFailure("static-main private SQLite snapshot could not leave WAL mode")
        after = source.execute("PRAGMA data_version").fetchone()[0]
    finally:
        destination.close()
        source.close()
    if before != after:
        target.unlink(missing_ok=True)
        raise HostFailure("CMS database changed during the read-only SQLite snapshot")
    checked = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
    try:
        if checked.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise HostFailure("static-main SQLite snapshot failed integrity_check")
    finally:
        checked.close()
    os.chmod(target, 0o440)
    return target


def _prepare_static_web_dependencies(config: dict[str, Any], source_root: Path,
                                     protected_paths: list[Path]) -> Path:
    web = source_root / "web"
    lockfile = web / "package-lock.json"
    if lockfile.is_symlink() or not lockfile.is_file():
        raise HostFailure("static-main web package lock is missing or unsafe")
    lock_sha = sha256_file(lockfile)
    dependencies = web / "node_modules"
    if os.path.lexists(dependencies):
        raise HostFailure("static-main web dependency path is already occupied")
    _run_as_cms(config, web, ["/usr/bin/npm", "ci", "--no-audit", "--no-fund"], timeout=1800,
                read_only_path=protected_paths)
    if sha256_file(lockfile) != lock_sha:
        raise HostFailure("static-main npm ci changed the admitted web lockfile")
    return _validate_prepared_web_dependencies(source_root)


def _static_main_rows(state: RehearsalState, operation_id: str) -> list[dict[str, Any]]:
    return [row for row in state._operation_rows(operation_id)
            if row.get("operationKind") == "static-main"]


def _static_main_start(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return next((row for row in rows if row.get("record") == "static-main-start"), {})


def _static_main_prepared(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return next((row for row in rows if row.get("record") == "static-main-prepared"), {})


def _static_main_capture_root(config: dict[str, Any], rows: list[dict[str, Any]],
                              source_sha: str, operation_id: str) -> Path:
    start = _static_main_start(rows)
    prepared = _static_main_prepared(rows)
    if (not start or not prepared or start.get("sourceSha") != source_sha
            or prepared.get("sourceSha") != source_sha):
        raise HostFailure("static-main capture has no matching prepared operation")
    reference = start.get("reusedCapture")
    if reference is None:
        return _candidate_root(config, source_sha, operation_id) / ".staging193-rehearsal" / operation_id / "capture"
    if (not isinstance(reference, dict) or set(reference) != {"operationId", "sourceSha", "bundleDigest"}
            or prepared.get("reusedCapture") != reference
            or not isinstance(reference.get("operationId"), str)
            or not isinstance(reference.get("sourceSha"), str)
            or not isinstance(reference.get("bundleDigest"), str)):
        raise HostFailure("static-main reused capture reference differs from its durable preparation")
    try:
        RehearsalState._validate_identity(reference["operationId"], reference["sourceSha"])
    except RehearsalRefusal as error:
        raise HostFailure("static-main reused capture reference has an invalid identity") from error
    if not SHA256_RE.fullmatch(reference["bundleDigest"]):
        raise HostFailure("static-main reused capture reference has an invalid bundle digest")
    capture = (_candidate_root(config, reference["sourceSha"], reference["operationId"])
               / ".staging193-rehearsal" / reference["operationId"] / "capture")
    old_source_root = capture.parents[2]
    if (old_source_root.parent != Path(config["releaseRoot"]).resolve(strict=True)
            or old_source_root.is_symlink() or old_source_root.resolve(strict=True) != old_source_root):
        raise HostFailure("static-main reused capture escaped the configured operation store")
    for parent in (capture.parents[1], capture.parents[0], capture):
        if parent.is_symlink() or parent.resolve(strict=True) != parent:
            raise HostFailure("static-main reused capture path contains a symlink")
    manifest_path = capture / "manifest.json"
    if capture.is_symlink() or not capture.is_dir() or manifest_path.is_symlink() or not manifest_path.is_file():
        raise HostFailure("static-main selected sealed capture is unavailable")
    if sha256_file(manifest_path) != reference["bundleDigest"]:
        raise HostFailure("static-main selected sealed capture manifest changed after preparation")
    user = pwd.getpwnam(config["cmsUser"])
    _assert_owned_tree(capture, user.pw_uid, user.pw_gid, sealed=True)
    return capture


def _static_main_snapshot_inputs(snapshot_root: Path) -> list[Path]:
    snapshot = snapshot_root / "snapshot.json"
    if snapshot.is_symlink() or not snapshot.is_file():
        raise HostFailure("reused snapshot is missing its snapshot.json input")
    paths = [snapshot]
    for name in ("collapsible_panels.json", "url_map.csv"):
        path = snapshot_root / name
        if path.is_symlink():
            raise HostFailure("reused snapshot metadata contains a symlink")
        if path.exists():
            if not path.is_file():
                raise HostFailure("reused snapshot metadata is not a regular file")
            paths.append(path)
    media = snapshot_root / "media"
    if media.is_symlink() or not media.is_dir():
        raise HostFailure("reused snapshot is missing its immutable media store")
    paths.append(media)
    return paths


def _static_main_snapshot_inputs_sha256(snapshot_root: Path) -> str:
    digest = hashlib.sha256()
    for root in _static_main_snapshot_inputs(snapshot_root):
        paths = [root, *sorted(root.rglob("*"), key=lambda item: item.relative_to(snapshot_root).as_posix())] \
            if root.is_dir() else [root]
        for path in paths:
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise HostFailure("reused snapshot input contains an unsafe filesystem object")
            if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                raise HostFailure("reused snapshot input contains a multiply linked file")
            name = path.relative_to(snapshot_root).as_posix().encode()
            digest.update(name + b"\0")
            if stat.S_ISREG(info.st_mode):
                digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()


def _static_main_capture_projection_sha256(source_root: Path, uid: int, gid: int) -> str:
    digest = hashlib.sha256()
    for relative in (Path("web/scripts/lib/content-field-map.ts"),
                     Path("web/scripts/capture-content-snapshot.ts")):
        path = source_root / relative
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != uid or info.st_gid != gid):
            raise HostFailure("selected capture projection source is missing or unsafe")
        digest.update(relative.as_posix().encode() + b"\0")
        digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()


def _assert_owned_tree(root: Path, uid: int, gid: int, *, sealed: bool) -> None:
    if root.is_symlink() or not root.is_dir() or root.resolve(strict=True) != root:
        raise HostFailure("reused capture or snapshot root is missing, non-canonical, or unsafe")
    for path in (root, *root.rglob("*")):
        info = path.lstat()
        if info.st_uid != uid or info.st_gid != gid:
            raise HostFailure("reused capture or snapshot is not owned by the configured CMS user")
        if stat.S_ISLNK(info.st_mode):
            raise HostFailure("reused capture or snapshot contains a symlink")
        if stat.S_ISDIR(info.st_mode):
            if sealed and info.st_mode & 0o222:
                raise HostFailure("reused capture bundle contains a writable directory")
        elif stat.S_ISREG(info.st_mode):
            if info.st_nlink != 1 or (sealed and info.st_mode & 0o222):
                raise HostFailure("reused capture contains a writable or multiply linked file")
        else:
            raise HostFailure("reused capture or snapshot contains an unsupported filesystem object")


def _verify_reusable_static_capture(config: dict[str, Any], state: RehearsalState,
                                    capture_operation_id: str, source_root: Path,
                                    cms_fingerprint: dict[str, Any],
                                    protected_paths: list[Path]) -> dict[str, Any]:
    rows = _static_main_rows(state, capture_operation_id)
    start = _static_main_start(rows)
    prepared = _static_main_prepared(rows)
    terminal = next((row for row in reversed(rows) if row.get("record") in
                     ("static-main-committed", "static-main-recovered", "static-main-rolled-back",
                      "static-main-rollback-intent", "static-main-rollback-completed")), None)
    if (not start or not prepared or not terminal
            or terminal.get("record") not in ("static-main-committed", "static-main-recovered")
            or start.get("operationId") != capture_operation_id
            or prepared.get("operationId") != capture_operation_id
            or terminal.get("operationId") != capture_operation_id
            or start.get("sourceSha") != prepared.get("sourceSha")
            or start.get("sourceSha") != terminal.get("sourceSha")
            or not SHA_RE.fullmatch(start.get("sourceSha", ""))):
        raise HostFailure("selected capture is not a prepared terminal staging194 static-main operation")
    if prepared.get("cmsFingerprint") != start.get("cmsFingerprint"):
        raise HostFailure("selected capture operation has inconsistent CMS fingerprint evidence")
    if start.get("cmsFingerprint") != cms_fingerprint:
        raise HostFailure("current CMS fingerprint differs from the selected terminal capture")

    release_root = Path(config["releaseRoot"]).resolve(strict=True)
    old_source_root = _candidate_root(config, start["sourceSha"], capture_operation_id)
    if (old_source_root.parent != release_root or old_source_root.is_symlink()
            or not old_source_root.is_dir() or old_source_root.resolve(strict=True) != old_source_root):
        raise HostFailure("selected capture candidate is outside the configured operation store")
    old_operation_root = old_source_root / ".staging193-rehearsal" / capture_operation_id
    capture = old_operation_root / "capture"
    original_snapshot = old_source_root / "web/.snapshot"
    old_rehearsal_root = old_source_root / ".staging193-rehearsal"
    for path in (old_rehearsal_root, old_operation_root, capture,
                 old_source_root / "web", original_snapshot):
        if path.is_symlink() or not path.is_dir() or path.resolve(strict=True) != path:
            raise HostFailure("selected capture path is missing, non-canonical, or unsafe")

    user = pwd.getpwnam(config["cmsUser"])
    old_operation_info = old_operation_root.lstat()
    if (old_operation_info.st_uid != user.pw_uid or old_operation_info.st_gid != user.pw_gid
            or old_operation_info.st_mode & 0o077):
        raise HostFailure("selected capture operation directory has unsafe ownership or permissions")
    _assert_owned_tree(capture, user.pw_uid, user.pw_gid, sealed=True)
    _assert_owned_tree(original_snapshot, user.pw_uid, user.pw_gid, sealed=False)
    mapping_digest = _static_main_capture_projection_sha256(source_root, user.pw_uid, user.pw_gid)
    if _static_main_capture_projection_sha256(old_source_root, user.pw_uid, user.pw_gid) != mapping_digest:
        raise HostFailure("current CMS capture projection differs from the selected capture source")

    script = r'''import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [verifierPath, captureRoot, schemaRoot] = process.argv.slice(1);
const { verifyStaging193Bundle } = await import(pathToFileURL(verifierPath));
const verified = verifyStaging193Bundle(captureRoot, schemaRoot);
const captureBytes = readFileSync(join(captureRoot, 'manifest.json'));
process.stdout.write(JSON.stringify({ manifest: verified.manifest, proof: verified.proof,
  bundleDigest: createHash('sha256').update(captureBytes).digest('hex') }));
'''
    verifier_path = source_root / "scripts/lib/staging193-capture-bundle.mjs"
    node = config.get("nodeBinary", "/usr/bin/node")
    try:
        result = _run_as_cms(config, source_root,
            [node, "--input-type=module", "-e", script, str(verifier_path), str(capture),
             str(source_root / "cms/src")], timeout=300,
            read_only_path=[*protected_paths, capture, original_snapshot])
        verified = json.loads(result)
        manifest = verified["manifest"]
    except HostFailure as error:
        raise HostFailure(f"selected sealed capture or snapshot failed verification: {error}") from error
    except (OSError, ValueError, KeyError) as error:
        raise HostFailure("selected sealed capture or snapshot could not be verified") from error
    snapshot = json.loads((original_snapshot / "snapshot.json").read_text(encoding="utf-8"))
    if (manifest.get("operationId") != capture_operation_id
            or manifest.get("sourceSha") != start["sourceSha"]
            or manifest.get("host") != TARGET_HOST
            or manifest.get("siteUrl") != "https://194.226.99.10"
            or manifest.get("sourceId") != "demo193-cms"
            or snapshot.get("snapshotId") != prepared.get("snapshotId")):
        raise HostFailure("selected capture manifest does not match its terminal staging194 operation")
    reference = {"operationId": capture_operation_id, "sourceSha": start["sourceSha"],
                 "bundleDigest": verified["bundleDigest"]}
    return {"capture": capture, "sourceRoot": old_source_root, "snapshotRoot": original_snapshot,
            "snapshotId": snapshot["snapshotId"], "referenceDate": snapshot["referenceDate"],
            "reusedCapture": reference, "mappingDigest": mapping_digest,
            "snapshotInputsSha256": _static_main_snapshot_inputs_sha256(original_snapshot),
            "manifest": manifest}


def _static_main_prepare(config: dict[str, Any], state: RehearsalState, operation_id: str,
                         source_sha: str, provenance: dict[str, Any],
                         reuse_capture_operation_id: Optional[str] = None) -> dict[str, Any]:
    _validate_static_main_admission(config, source_sha, provenance)
    if state._read_marker() is not None:
        raise HostFailure("static-main refuses to run while a CMS maintenance marker exists")
    if config.get("profile") == "production-static":
        production_marker = Path("/var/lib/ikpk-rehearsal/initial-prod/maintenance.json")
        if production_marker.exists() or Path(config["maintenanceFlag"]).exists():
            raise HostFailure("production-static refuses to run while the production CMS maintenance marker exists")
    rows = _static_main_rows(state, operation_id)
    if rows:
        if _static_main_prepared(rows):
            prepared = _static_main_prepared(rows)
            start = _static_main_start(rows)
            selected_capture = (start.get("reusedCapture") or {}).get("operationId")
            if selected_capture != reuse_capture_operation_id:
                raise HostFailure("static-main retry changed its selected capture operation")
            return {"operationId": operation_id, "sourceSha": source_sha, "phase": "browser-check-required",
                    "staticTreeSha256": prepared["staticTreeSha256"], "snapshotId": prepared["snapshotId"]}
        raise HostFailure("static-main operation has incomplete durable state; use static-main-recover")
    state.assert_new_operation_allowed(operation_id, source_sha)
    source_root = _candidate_root(config, source_sha, operation_id)
    if source_root.is_symlink() or not source_root.is_dir():
        raise HostFailure("static-main source candidate is missing")
    marker = source_root / ".ikpk-rehearsal-ci.json"
    try:
        embedded = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("static-main source candidate lacks admitted provenance") from error
    if embedded != provenance:
        raise HostFailure("static-main source archive provenance differs from current admission")
    old_static = _current_target(Path(config["currentStatic"]))
    old_tree = _tree_sha256(old_static)
    cms_fingerprint = _static_main_cms_fingerprint(config)
    protected_paths = _static_main_protected_paths(config)
    reusable = None
    if reuse_capture_operation_id is not None:
        try:
            RehearsalState._validate_identity(reuse_capture_operation_id)
        except RehearsalRefusal as error:
            raise HostFailure("selected capture operation ID has invalid characters") from error
        reusable = _verify_reusable_static_capture(config, state, reuse_capture_operation_id,
            source_root, cms_fingerprint, protected_paths)
    start = {"version": 1, "record": "static-main-start", "operationKind": "static-main",
             "operationId": operation_id, "sourceSha": source_sha, "provenance": provenance,
             "oldStaticPath": str(old_static), "oldStaticTreeSha256": old_tree,
             "cmsFingerprint": cms_fingerprint, "configSha256": _config_sha256(config)}
    if reusable is not None:
        start.update({"reusedCapture": reusable["reusedCapture"],
                      "captureMappingSha256": reusable["mappingDigest"],
                      "snapshotId": reusable["snapshotId"],
                      "referenceDate": reusable["referenceDate"],
                      "snapshotInputsSha256": reusable["snapshotInputsSha256"]})
    state._append(start)
    operation_root = source_root / ".staging193-rehearsal" / operation_id
    operation_root.mkdir(mode=0o700, parents=True, exist_ok=False)
    user = pwd.getpwnam(config["cmsUser"])
    os.chown(operation_root, user.pw_uid, user.pw_gid)
    os.chmod(operation_root, 0o700)
    if reusable is None:
        database_snapshot = _readonly_database_snapshot(config, operation_root)
        os.chown(database_snapshot, user.pw_uid, user.pw_gid)
        capture = _create_capture_bundle(config, operation_id, source_sha, source_root, database_snapshot,
                                         read_only_paths=protected_paths)
        manifest = json.loads((capture / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("sourceSha") != source_sha or manifest.get("operationId") != operation_id:
            raise HostFailure("static-main sealed CMS capture is not bound to this main source")
    else:
        capture = reusable["capture"]
        snapshot_target = source_root / "web/.snapshot"
        if snapshot_target.exists() or snapshot_target.is_symlink():
            raise HostFailure("new static-main source already contains snapshot input")
        snapshot_target.mkdir(mode=0o750)
        for source_input in _static_main_snapshot_inputs(reusable["snapshotRoot"]):
            destination = snapshot_target / source_input.relative_to(reusable["snapshotRoot"])
            if source_input.is_dir():
                shutil.copytree(source_input, destination, copy_function=shutil.copy2)
            else:
                shutil.copy2(source_input, destination)
        for path in [snapshot_target, *snapshot_target.rglob("*")]:
            if path.is_symlink():
                raise HostFailure("materialized reused snapshot contains a symlink")
            os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
            if path.is_dir():
                os.chmod(path, 0o750 if path == snapshot_target else 0o550)
            elif path.is_file():
                os.chmod(path, 0o440)
            else:
                raise HostFailure("materialized reused snapshot contains an unsupported object")
        snapshot_input_paths = _static_main_snapshot_inputs(snapshot_target)
        if _static_main_snapshot_inputs_sha256(snapshot_target) != reusable["snapshotInputsSha256"]:
            raise HostFailure("materialized reused snapshot differs from the original bytes")
        _assert_owned_tree(snapshot_target, user.pw_uid, user.pw_gid, sealed=False)
        protected_paths.extend([capture, reusable["snapshotRoot"], *snapshot_input_paths])
    _prepare_static_web_dependencies(config, source_root, protected_paths)
    if reusable is not None:
        verifier = source_root / "scripts/lib/verify-reused-staging193-snapshot.ts"
        tsx = source_root / "web/node_modules/.bin/tsx"
        verified_snapshot = _run_as_cms(config, source_root,
            [str(tsx), str(verifier), str(capture), str(snapshot_target),
             str(source_root / "cms/src"), reuse_capture_operation_id,
             reusable["reusedCapture"]["sourceSha"], reusable["snapshotId"]], timeout=300,
            read_only_path=protected_paths)
        try:
            snapshot_proof = json.loads(verified_snapshot)
        except ValueError as error:
            raise HostFailure("reused snapshot verifier returned invalid evidence") from error
        if (snapshot_proof.get("snapshotId") != reusable["snapshotId"]
                or snapshot_proof.get("referenceDate") != reusable["referenceDate"]
                or snapshot_proof.get("bundleDigest") != reusable["reusedCapture"]["bundleDigest"]):
            raise HostFailure("reused snapshot verifier disagrees with durable capture evidence")
    chat_loader = INITIAL_PROD_CHAT_LOADER_SRC if config.get("profile") == "production-static" else STAGING194_CHAT_LOADER_SRC
    built, digest = _build_static(config, source_root, capture, read_only_paths=protected_paths,
                                  chat_loader_src=chat_loader, operation_id=operation_id,
                                  reused_capture=reusable["reusedCapture"] if reusable else None,
                                  reuse_snapshot=reusable is not None)
    if (reusable is not None
            and _static_main_snapshot_inputs_sha256(source_root / "web/.snapshot")
            != reusable["snapshotInputsSha256"]):
        raise HostFailure("static-main build changed reused snapshot identity bytes")
    if (_current_target(Path(config["currentStatic"])) != old_static
            or _tree_sha256(old_static) != old_tree):
        raise HostFailure("static-main old static release changed during candidate preparation")
    release = _store_static(config, source_sha, operation_id, built, digest)
    release_info = json.loads((release / "release.json").read_text(encoding="utf-8"))
    if (release_info.get("commit") != source_sha or release_info.get("operationId") != operation_id
            or release_info.get("reusedCapture") != (reusable["reusedCapture"] if reusable else None)):
        raise HostFailure("static-main release declaration differs from the admitted main source")
    prepared_record = {"version": 1, "record": "static-main-prepared", "operationKind": "static-main",
                       "operationId": operation_id, "sourceSha": source_sha, "staticTreeSha256": digest,
                       "snapshotId": release_info.get("snapshotId"), "cmsFingerprint": cms_fingerprint}
    if reusable is not None:
        if release_info.get("snapshotId") != reusable["snapshotId"]:
            raise HostFailure("static-main reused snapshot ID changed during build")
        prepared_record.update({"reusedCapture": reusable["reusedCapture"],
                                "captureMappingSha256": reusable["mappingDigest"],
                                "referenceDate": reusable["referenceDate"],
                                "snapshotInputsSha256": reusable["snapshotInputsSha256"]})
    state._append(prepared_record)
    return {"operationId": operation_id, "sourceSha": source_sha, "phase": "browser-check-required",
            "staticTreeSha256": digest, "snapshotId": release_info.get("snapshotId")}


def _static_main_rollback(config: dict[str, Any], state: RehearsalState, start: dict[str, Any],
                          candidate: Path, *, terminal_record: str = "static-main-rolled-back",
                          details: Optional[dict[str, Any]] = None) -> None:
    pointer = Path(config["currentStatic"])
    if _current_target(pointer) != candidate.resolve(strict=True):
        raise HostFailure("static-main rollback refused because currentStatic no longer points to this candidate")
    try:
        old = Path(start["oldStaticPath"]).resolve(strict=True)
    except OSError as error:
        raise HostFailure("static-main rollback target expired/unavailable; no switch was attempted") from error
    if _tree_sha256(old) != start.get("oldStaticTreeSha256"):
        raise HostFailure("static-main rollback target differs from the exact old static tree")
    _switch_pointer(pointer, old, Path(config["staticReleaseRoot"]))
    if _current_target(pointer) != old:
        raise HostFailure("static-main rollback did not restore the old static tree")
    record = {"version": 1, "record": terminal_record, "operationKind": "static-main",
              "operationId": start["operationId"], "sourceSha": start["sourceSha"],
              "restoredStaticPath": str(old)}
    if details:
        record.update(details)
    state._append(record)


def _static_main_rollback_committed(config: dict[str, Any], state: RehearsalState, operation_id: str,
                                   operator_name: Optional[str], reason: Optional[str],
                                   before_intent: Optional[Callable[[], None]] = None) -> dict[str, Any]:
    if (not isinstance(operator_name, str) or not operator_name.strip() or len(operator_name) > 120
            or any(ord(char) < 32 or ord(char) == 127 for char in operator_name)):
        raise HostFailure("committed static rollback requires a valid operator name")
    if (not isinstance(reason, str) or not reason.strip() or len(reason) > 1000
            or any(ord(char) < 32 or ord(char) == 127 for char in reason)):
        raise HostFailure("committed static rollback requires a valid reason")
    rows = _static_main_rows(state, operation_id)
    start = _static_main_start(rows)
    committed = next((row for row in rows if row.get("record") == "static-main-committed"), None)
    if not start or not committed or committed.get("sourceSha") != start.get("sourceSha"):
        raise HostFailure("committed static rollback requires a matching durable release record")
    source_sha = start["sourceSha"]
    candidate = Path(config["staticReleaseRoot"]) / f"{source_sha}-{operation_id}"
    try:
        old = Path(start["oldStaticPath"]).resolve(strict=True)
    except OSError as error:
        raise HostFailure("static-main rollback target expired/unavailable; no rollback intent was written") from error
    if candidate.is_symlink() or not candidate.is_dir():
        raise HostFailure("committed static rollback candidate is missing or unsafe")
    candidate_digest = _tree_sha256(candidate)
    committed_digest = committed.get("staticTreeSha256")
    prepared = _static_main_prepared(rows)
    if (not isinstance(committed_digest, str) or candidate_digest != committed_digest
            or prepared.get("staticTreeSha256") != committed_digest):
        raise HostFailure("committed static rollback candidate differs from its release evidence")
    old_digest = _tree_sha256(old)
    if old_digest != start.get("oldStaticTreeSha256"):
        raise HostFailure("committed static rollback target differs from the exact old static tree")
    details = {"operator": operator_name.strip(), "reason": reason.strip(),
               "candidateStaticPath": str(candidate.resolve(strict=True)),
               "candidateStaticTreeSha256": candidate_digest,
               "committedStaticTreeSha256": committed_digest,
               "oldStaticPath": str(old), "oldStaticTreeSha256": old_digest,
               "snapshotId": committed.get("snapshotId")}
    completed = next((row for row in rows if row.get("record") == "static-main-rollback-completed"), None)
    if completed:
        if any(completed.get(key) != value for key, value in details.items()):
            raise HostFailure("committed static rollback was already completed with different evidence")
        return {"operationId": operation_id, "phase": "rolled-back", "restoredStaticPath": str(old)}
    intent = next((row for row in rows if row.get("record") == "static-main-rollback-intent"), None)
    if intent and any(intent.get(key) != value for key, value in details.items()):
        raise HostFailure("committed static rollback intent has different operator or release evidence")
    pointer = Path(config["currentStatic"])
    current = _current_target(pointer)
    if not intent:
        if current != candidate.resolve(strict=True):
            raise HostFailure("static-main rollback refused because currentStatic no longer points to this candidate")
        if before_intent is not None:
            before_intent()
        state._append({"version": 1, "record": "static-main-rollback-intent", "operationKind": "static-main",
                       "operationId": operation_id, "sourceSha": source_sha, **details})
    if current == candidate.resolve(strict=True):
        _static_main_rollback(config, state, start, candidate,
                              terminal_record="static-main-rollback-completed", details=details)
    elif current == old:
        # A prior invocation may have switched the pointer and crashed before recording completion.
        if _current_target(pointer) != old or _tree_sha256(old) != old_digest:
            raise HostFailure("committed static rollback target changed before durable completion")
        state._append({"version": 1, "record": "static-main-rollback-completed", "operationKind": "static-main",
                       "operationId": operation_id, "sourceSha": source_sha,
                       "restoredStaticPath": str(old), **details})
    else:
        raise HostFailure("static-main recovery refused to replace a newer foreign static pointer")
    return {"operationId": operation_id, "phase": "rolled-back", "restoredStaticPath": str(old)}


def _static_main_commit(config: dict[str, Any], state: RehearsalState, operation_id: str,
                        source_sha: str, provenance: dict[str, Any], browser_digest: str) -> dict[str, Any]:
    _validate_static_main_admission(config, source_sha, provenance)
    rows = _static_main_rows(state, operation_id)
    start = _static_main_start(rows)
    prepared = _static_main_prepared(rows)
    if not start or not prepared or start.get("sourceSha") != source_sha or start.get("provenance") != provenance:
        raise HostFailure("static-main browser acceptance has no matching durable prepared operation")
    if any(row.get("record") in ("static-main-rollback-intent", "static-main-rollback-completed")
           for row in rows):
        raise HostFailure("static-main operation cannot be committed after rollback has started")
    if any(row.get("record") == "static-main-committed" for row in rows):
        return {"operationId": operation_id, "sourceSha": source_sha, "phase": "committed"}
    if any(row.get("record") in ("static-main-recovered", "static-main-rolled-back") for row in rows):
        raise HostFailure("static-main operation is terminal after recovery or rollback")
    candidate = Path(config["staticReleaseRoot"]) / f"{source_sha}-{operation_id}"
    if candidate.is_symlink() or not candidate.is_dir():
        raise HostFailure("static-main retained candidate is missing")
    digest = _tree_sha256(candidate)
    if browser_digest != digest or prepared.get("staticTreeSha256") != digest:
        raise HostFailure("static-main browser digest differs from the durable candidate")
    if _config_sha256(config) != start.get("configSha256"):
        raise HostFailure("staging configuration changed during static-main acceptance")
    if _static_main_cms_fingerprint(config) != start.get("cmsFingerprint"):
        raise HostFailure("CMS fingerprint changed during static-main acceptance")
    pointer = Path(config["currentStatic"])
    old_static = Path(start["oldStaticPath"]).resolve(strict=True)
    if (_current_target(pointer) != old_static
            or _tree_sha256(old_static) != start.get("oldStaticTreeSha256")):
        raise HostFailure("static-main old-pointer compare-and-swap failed")
    state._append({"version": 1, "record": "static-main-switch-intent", "operationKind": "static-main",
                   "operationId": operation_id, "sourceSha": source_sha,
                   "oldStaticPath": start["oldStaticPath"], "candidateStaticPath": str(candidate),
                   "staticTreeSha256": digest})
    _switch_pointer(pointer, candidate, Path(config["staticReleaseRoot"]))
    if _current_target(pointer) != candidate.resolve(strict=True):
        raise HostFailure("static-main candidate did not become currentStatic")
    state._append({"version": 1, "record": "static-main-switched", "operationKind": "static-main",
                   "operationId": operation_id, "sourceSha": source_sha, "staticTreeSha256": digest})
    try:
        _wait_health(config["siteHealthUrl"], 120)
        served = _served_release_matches(config, source_sha, operation_id, digest)
        if served.get("snapshotId") != prepared.get("snapshotId"):
            raise HostFailure("served static-main snapshot ID differs from the accepted candidate")
        for url in config.get("siteProbeUrls", []):
            response = run(["/usr/bin/curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
                            "--max-time", "15", url], timeout=20)
            if response.stdout.strip() != "200":
                raise HostFailure(f"static-main served route probe failed: {url}")
        capture_root = _static_main_capture_root(config, rows, source_sha, operation_id)
        media_doc = json.loads((capture_root / "media-manifest.json").read_text(encoding="utf-8"))
        media_inventory = media_doc.get("media") if isinstance(media_doc, dict) else None
        if not isinstance(media_inventory, list) or not media_inventory:
            raise HostFailure("static-main sealed capture has no media inventory for serving probes")
        for item in media_inventory:
            media_url = item.get("url") if isinstance(item, dict) else None
            if not isinstance(media_url, str) or not media_url.startswith(("/uploads/", "/media/")):
                raise HostFailure("static-main sealed media inventory has an invalid public URL")
            response = run(["/usr/bin/curl", "--fail", "--silent", "--show-error", "--output", "/dev/null",
                            "--max-time", "15", config["siteBaseUrl"].rstrip("/") + quote(media_url, safe="/%")], timeout=20)
            if response.returncode:
                raise HostFailure(f"static-main captured media is not served after activation: {media_url}")
        if _static_main_cms_fingerprint(config) != start.get("cmsFingerprint"):
            raise HostFailure("CMS fingerprint changed during static-main activation")
        if _current_target(pointer) != candidate.resolve(strict=True):
            raise HostFailure("static-main currentStatic changed during served-release probes")
    except Exception as error:
        _static_main_rollback(config, state, start, candidate)
        raise HostFailure(f"static-main activation failed and the old static tree was restored: {error}") from error
    state._append({"version": 1, "record": "static-main-committed", "operationKind": "static-main",
                   "operationId": operation_id, "sourceSha": source_sha, "staticTreeSha256": digest,
                   "snapshotId": prepared.get("snapshotId")})
    return {"operationId": operation_id, "sourceSha": source_sha, "phase": "committed",
            "staticTreeSha256": digest, "snapshotId": prepared.get("snapshotId")}


def _static_main_export(config: dict[str, Any], state: RehearsalState, operation_id: str,
                        source_sha: str) -> bytes:
    rows = _static_main_rows(state, operation_id)
    prepared = _static_main_prepared(rows)
    if not prepared or prepared.get("sourceSha") != source_sha:
        raise HostFailure("static-main export requires its exact prepared candidate")
    release = Path(config["staticReleaseRoot"]) / f"{source_sha}-{operation_id}"
    candidate = _candidate_root(config, source_sha, operation_id)
    snapshot = candidate / "web/.snapshot/snapshot.json"
    capture_root = _static_main_capture_root(config, rows, source_sha, operation_id)
    capture_manifest = capture_root / "manifest.json"
    for required in (snapshot, capture_manifest):
        if required.is_symlink() or not required.is_file():
            raise HostFailure("static-main sealed snapshot proof is unavailable")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:") as archive:
        for path in sorted(release.rglob("*")):
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise HostFailure("static-main release contains a non-regular object")
            archive.add(path, arcname="static/" + path.relative_to(release).as_posix(), recursive=False)
        archive.add(snapshot, arcname="snapshot/snapshot.json", recursive=False)
        archive.add(capture_manifest, arcname="snapshot/capture-manifest.json", recursive=False)
    return buffer.getvalue()


def _static_main_recover(config: dict[str, Any], state: RehearsalState, operation_id: str, *,
                         rollback_committed: bool = False, operator_name: Optional[str] = None,
                         reason: Optional[str] = None,
                         before_rollback_intent: Optional[Callable[[], None]] = None) -> dict[str, Any]:
    rows = _static_main_rows(state, operation_id)
    start = _static_main_start(rows)
    if not start:
        raise HostFailure("static-main recovery has no matching durable operation")
    if any(row.get("record") == "static-main-committed" for row in rows):
        if rollback_committed:
            return _static_main_rollback_committed(config, state, operation_id, operator_name, reason,
                                                   before_rollback_intent)
        if any(row.get("record") == "static-main-rollback-completed" for row in rows):
            return {"operationId": operation_id, "phase": "rolled-back"}
        return {"operationId": operation_id, "phase": "committed"}
    if rollback_committed:
        raise HostFailure("committed static rollback requires a matching durable release record")
    if any(row.get("record") in ("static-main-recovered", "static-main-rolled-back") for row in rows):
        return {"operationId": operation_id, "phase": "recovered"}
    intent = next((row for row in rows if row.get("record") == "static-main-switch-intent"), None)
    pointer = Path(config["currentStatic"])
    current = _current_target(pointer)
    try:
        old = Path(start["oldStaticPath"]).resolve(strict=True)
    except OSError as error:
        raise HostFailure("static-main rollback target expired/unavailable; recovery cannot switch") from error
    if intent:
        candidate = Path(intent["candidateStaticPath"]).resolve(strict=True)
        if current == candidate:
            _static_main_rollback(config, state, start, candidate)
        elif current != old:
            raise HostFailure("static-main recovery refused to replace a newer foreign static pointer")
    elif current != old:
        raise HostFailure("static-main recovery found an unjournaled currentStatic change")
    state._append({"version": 1, "record": "static-main-recovered", "operationKind": "static-main",
                   "operationId": operation_id, "sourceSha": start["sourceSha"],
                   "restoredStaticPath": str(old)})
    return {"operationId": operation_id, "phase": "recovered"}


def _static_publish(config: dict[str, Any], state: RehearsalState, args: argparse.Namespace) -> dict[str, Any]:
    op, sha = args.operation_id, args.source_sha
    phase = state.phase(op)
    if phase.get("sourceSha") != sha:
        raise HostFailure("static publication source SHA differs from the operation journal")
    if phase["phase"] == "committed":
        _reopen(config, state, op)
        return {"operationId": op, "sourceSha": sha, "phase": "committed"}
    if phase["phase"] != "cms-activated" and phase["phase"] != "new-pair-accepted":
        raise HostFailure("static publication requires an accepted CMS update under the same operation ID")
    source_root = _candidate_root(config, sha, op)
    if source_root.is_symlink() or not source_root.is_dir():
        raise HostFailure("admitted source candidate is missing")
    _verify_fence(config)
    built = source_root / ("web/dist" if config.get("profile") in ("initial-prod", "production-paired")
                          else "web/dist-demo193")
    if not args.browser_digest:
        retained = Path(config["staticReleaseRoot"]) / f"{sha}-{op}"
        if os.path.lexists(retained):
            if retained.is_symlink() or not retained.is_dir():
                raise HostFailure("retained static candidate is not a real directory")
            try:
                retained_info = json.loads((retained / "release.json").read_text(encoding="utf-8"))
                snapshot = json.loads((source_root / "web/.snapshot/snapshot.json").read_text(encoding="utf-8"))
                capture = json.loads((source_root / ".staging193-rehearsal" / op / "capture/manifest.json")
                                     .read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise HostFailure("retained static candidate lacks its operation-bound snapshot proof") from error
            digest = _tree_sha256(retained)
            snapshot_id = snapshot.get("snapshotId")
            expected_capture_profile = ("production-static" if config.get("profile") == "production-paired"
                                         else config.get("profile", "staging194"))
            if (retained_info.get("commit") != sha or retained_info.get("operationId") != op
                    or retained_info.get("staticTreeSha256") != digest
                    or not isinstance(snapshot_id, str) or not snapshot_id.startswith("snap:")
                    or retained_info.get("snapshotId") != snapshot_id
                    or snapshot.get("captureProof", {}).get("captureId") != op
                    or capture.get("operationId") != op or capture.get("sourceSha") != sha
                    or capture.get("profile") != expected_capture_profile):
                raise HostFailure("retained static candidate differs from its sealed operation capture")
            return {"operationId": op, "sourceSha": sha, "phase": "browser-check-required",
                    "staticTreeSha256": digest, "snapshotId": snapshot_id}
        if phase["phase"] == "cms-activated" or not built.is_dir():
            capture = source_root / ".staging193-rehearsal" / op / "capture"
            if capture.is_symlink() or not capture.is_dir():
                raise HostFailure("sealed CMS capture is missing before static build")
            built, built_digest = _build_static(config, source_root, capture, operation_id=op)
        else:
            built_digest = _tree_sha256(built)
        digest = built_digest
        release = _store_static(config, sha, op, built, digest)
        return {"operationId": op, "sourceSha": sha, "phase": "browser-check-required",
                "staticTreeSha256": digest, "snapshotId": json.loads((release / "release.json").read_text(encoding="utf-8")).get("snapshotId")}
    release = Path(config["staticReleaseRoot"]) / f"{sha}-{op}"
    if release.is_symlink() or not release.is_dir():
        raise HostFailure("retained static release is missing before browser acceptance")
    digest = _tree_sha256(release)
    if args.browser_digest != digest:
        raise HostFailure("browser acceptance digest differs from the served static candidate")
    start = next((row for row in state._operation_rows(op) if row.get("record") == "start"), None)
    if not start:
        raise HostFailure("operation journal has no source admission record")
    if start.get("oldPair", {}).get("configSha256") != _config_sha256(config):
        raise HostFailure("staging configuration changed after the operation began")
    provenance = json.loads((_candidate_root(config, sha, op) / ".ikpk-rehearsal-ci.json").read_text(encoding="utf-8"))
    if provenance.get("sourceSha") != sha or provenance.get("repository") != "pgorbachev/ikpk":
        raise HostFailure("static candidate provenance no longer matches the pinned source identity")
    _switch_pointer(Path(config["currentStatic"]), release, Path(config["staticReleaseRoot"]))
    _wait_health(config["cmsHealthUrl"], 1200)
    cms_proof = _database_process_proof(_service_pid(config["cmsUnit"]), Path(config["cmsDatabase"]))
    _wait_health(config["siteHealthUrl"], 1200)
    served = _served_release_matches(config, sha, op, digest)
    candidate_release = json.loads((release / "release.json").read_text(encoding="utf-8"))
    if served.get("snapshotId") != candidate_release.get("snapshotId"):
        raise HostFailure("served release snapshot ID differs from the accepted candidate")
    for url in config.get("siteProbeUrls", []):
        response = run(["/usr/bin/curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
                        "--max-time", "15", url], timeout=20)
        if response.stdout.strip() != "200":
            raise HostFailure(f"served route probe failed: {url}")
    capture_root = source_root / ".staging193-rehearsal" / op / "capture"
    media_inventory = json.loads((capture_root / "media-manifest.json").read_text(encoding="utf-8")).get("media")
    if not isinstance(media_inventory, list) or not media_inventory:
        raise HostFailure("sealed CMS media inventory is unavailable for post-switch serving checks")
    from urllib.parse import quote
    for item in media_inventory:
        media_url = item.get("url") if isinstance(item, dict) else None
        if not isinstance(media_url, str) or not media_url.startswith(("/uploads/", "/media/")):
            raise HostFailure("sealed CMS media inventory has an invalid public URL")
        response = run(["/usr/bin/curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
                        "--max-time", "15", config["siteBaseUrl"].rstrip("/") + quote(media_url, safe="/%")], timeout=20)
        if response.stdout.strip() not in ("200", "304"):
            raise HostFailure(f"captured media is not served after static switch: {media_url}")
    marker = state._read_marker() or {}
    if not marker.get("newPairAccepted"):
        cms_root = _current_target(Path(config["currentCms"]))
        media_uploads = next(Path(item["path"]).resolve(strict=True) for item in config["mediaRoots"]
                             if item["prefix"] == "/uploads/")
        capture_manifest = json.loads((capture_root / "manifest.json").read_text(encoding="utf-8"))
        backup_manifest = json.loads((Path(config["backupRoot"]) / op / "manifest.json").read_text(encoding="utf-8"))
        state.accept_new_pair(op, {"sourceSha": sha, "cmsSha": sha,
                                   "cmsPayloadSha256": _cms_payload_sha256(cms_root, media_uploads),
                                   "staticSha": sha, "staticTreeSha256": digest,
                                   "cmsDatabaseSha256": capture_manifest["databaseSha256"],
                                   "cmsMediaManifestSha256": capture_manifest["mediaManifestSha256"],
                                   "cmsCaptureBundleSha256": _tree_sha256(capture_root),
                                   "oldDatabaseSha256": backup_manifest["databaseSha256"],
                                   "oldMediaManifestSha256": backup_manifest["mediaManifestSha256"],
                                   "configSha256": _config_sha256(config),
                                   "snapshotId": served.get("snapshotId"), "cmsDatabaseProof": cms_proof})
    state.commit(op)
    _reopen(config, state, op)
    return {"operationId": op, "sourceSha": sha, "phase": "committed", "staticTreeSha256": digest,
            "cmsDatabaseProof": cms_proof}


def _export_static(config: dict[str, Any], state: RehearsalState, operation_id: str,
                   source_sha: str) -> bytes:
    phase = state.phase(operation_id)
    if phase.get("sourceSha") != source_sha or phase.get("phase") not in ("cms-activated", "new-pair-accepted"):
        raise HostFailure("static export requires the matching fenced CMS operation")
    release = Path(config["staticReleaseRoot"]) / f"{source_sha}-{operation_id}"
    if release.is_symlink() or not release.is_dir():
        raise HostFailure("retained static candidate is unavailable for off-host acceptance")
    candidate = _candidate_root(config, source_sha, operation_id)
    snapshot = candidate / "web/.snapshot/snapshot.json"
    capture_manifest = candidate / ".staging193-rehearsal" / operation_id / "capture/manifest.json"
    for required in (snapshot, capture_manifest):
        if required.is_symlink() or not required.is_file():
            raise HostFailure("sealed source snapshot proof is unavailable for off-host acceptance")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:") as archive:
        for path in sorted(release.rglob("*")):
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise HostFailure("retained static candidate contains a non-regular object")
            archive.add(path, arcname="static/" + path.relative_to(release).as_posix(), recursive=False)
        archive.add(snapshot, arcname="snapshot/snapshot.json", recursive=False)
        archive.add(capture_manifest, arcname="snapshot/capture-manifest.json", recursive=False)
    return buffer.getvalue()


def _restore_media(config: dict[str, Any], backup_dir: Path, manifest: dict[str, Any]) -> None:
    entries = manifest.get("media")
    if not isinstance(entries, list):
        raise HostFailure("backup media manifest is malformed")
    roots = {entry["prefix"]: Path(entry["path"]) for entry in config["mediaRoots"]}
    uploads = roots.get("/uploads/")
    if uploads is None:
        raise HostFailure("configured /uploads/ restore root is unavailable")
    uploads = uploads.resolve(strict=True)
    if uploads.is_symlink() or not uploads.is_dir():
        raise HostFailure("configured uploads restore root must be a real directory")
    validated: list[tuple[str, Path, Path, dict[str, Any]]] = []
    for item in entries:
        prefix = next((value for value in roots if item.get("url", "").startswith(value)), None)
        if not prefix or item.get("originalName") != item["url"][len(prefix):]:
            raise HostFailure("backup media path does not match configured URL roots")
        relative = Path(item["originalName"])
        if relative.is_absolute() or any(part in (".", "..") for part in relative.parts):
            raise HostFailure("backup media path is unsafe")
        source = backup_dir / item["file"]
        if not source.is_file() or source.is_symlink() or sha256_file(source) != item["sha256"]:
            raise HostFailure("backup media bytes failed digest verification")
        validated.append((prefix, relative, source, item))
    for path in sorted(uploads.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise HostFailure("current uploads tree contains an unsafe object")
        path.unlink() if path.is_file() else path.rmdir()
    for prefix, relative, source, item in validated:
        # /media/ is served from the selected immutable static release. Recovery
        # restores its old bytes by switching the static pointer, never by writing
        # through current/media (which could resolve to the candidate release).
        if prefix == "/media/":
            continue
        destination = uploads / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        os.chmod(destination, int(item["mode"]))
        os.chown(destination, int(item["uid"]), int(item["gid"]))


def _recover(config: dict[str, Any], state: RehearsalState, operation_id: str,
             *, stage_only: bool = False, expected_fingerprint: str | None = None,
             finalize_restore_fingerprint: str | None = None) -> dict[str, Any]:
    if any(row.get("operationKind") == "static-main" for row in state._operation_rows(operation_id)):
        raise HostFailure("static-main operation cannot enter CMS/database recovery")
    if state._is_committed(operation_id):
        raise HostFailure("recovery is closed after global commit; retry static-publish to finalize")
    start = next((row for row in state._operation_rows(operation_id) if row.get("record") == "start"), None)
    if not start:
        raise HostFailure("operation has no journaled old pair")
    old_pair = _effective_old_pair(state, operation_id)
    live = Path(config["cmsDatabase"]).resolve(strict=True)
    already_recovered = state._is_recovered(operation_id)
    paired_uploads = None
    if config.get("profile") == "production-paired":
        paired_uploads = next((Path(item["path"]).resolve(strict=True) for item in config.get("mediaRoots", [])
                               if item.get("prefix") == "/uploads/"), None)

    def old_pair_content_matches() -> bool:
        if config.get("profile") != "production-paired":
            return True
        expected_payload = old_pair.get("cmsPayloadSha256")
        expected_media = old_pair.get("mediaStateSha256")
        return (paired_uploads is not None and isinstance(expected_payload, str) and isinstance(expected_media, str)
                and _cms_payload_sha256(_current_target(Path(config["currentCms"])), paired_uploads) == expected_payload
                and _media_state_sha256(_media_inventory(config)) == expected_media)

    def reopen_old_pair() -> bool:
        if config.get("profile") == "production-paired":
            previous_environment = old_pair.get("cmsSourceEnvironment")
            if not isinstance(previous_environment, dict) or set(previous_environment) != set(PAIRED_CMS_ENV_KEYS):
                raise HostFailure("operation journal lacks the prior CMS source environment")
            _write_paired_cms_source_env(config, previous_environment)
        run(["/usr/bin/systemctl", "start", config["cmsUnit"]], timeout=120)
        _wait_health(config["cmsHealthUrl"], 1200)
        _database_process_proof(_service_pid(config["cmsUnit"]), live)
        if str(_current_target(Path(config["currentCms"]))) != old_pair["cmsPath"]:
            raise HostFailure("old CMS release is not selected during recovery reopen")
        if not old_pair_content_matches():
            raise HostFailure("restored CMS and media payload differs from the journaled old pair")
        if _tree_sha256(_current_target(Path(config["currentStatic"]))) != old_pair["staticTreeSha256"]:
            raise HostFailure("restored static pointer does not identify the recorded old bytes")
        _wait_health(config["siteHealthUrl"], 1200)
        _set_flag(config, False)
        _write_gate(config, False)
        run(["/usr/bin/systemctl", "start", *config["writerUnits"]], timeout=120)
        return all(run(["/usr/bin/systemctl", "is-active", unit], check=False).returncode == 0
                   for unit in [config["cmsUnit"], *config["writerUnits"]])

    prepared = next((row for row in state._operation_rows(operation_id)
                     if row.get("record") == "restore-prepared"), None)
    if finalize_restore_fingerprint is not None:
        if config.get("profile") != "production-paired" or not prepared:
            raise HostFailure("restore finalize requires a staged production-paired restore")
        fingerprint = finalize_restore_fingerprint
        if (not CONTENT_FINGERPRINT_RE.fullmatch(str(fingerprint)) or prepared.get("fingerprint") != fingerprint or
                prepared.get("databaseSha256") != sha256_file(live) or
                prepared.get("operationId") != operation_id):
            raise HostFailure("restore finalize identity or restored database changed")
        offhost_dir = Path(config["backupRoot"]) / operation_id / "offhost-backup"
        manifest = _backup_manifest(config, operation_id, offhost_dir)
        expected_media_sha = _media_state_sha256(manifest.get("media", []))
        if (manifest.get("mediaManifestSha256") != prepared.get("mediaManifestSha256") or
                expected_media_sha != prepared.get("mediaStateSha256") or
                _media_state_sha256(_media_inventory(config)) != expected_media_sha):
            raise HostFailure("restored CMS media bytes or permissions differ from the staged operation backup")
        state.recover(operation_id, lambda: sha256_file(live) == prepared["databaseSha256"]
                      and _tree_sha256(_current_target(Path(config["currentStatic"]))) == old_pair["staticTreeSha256"]
                      and old_pair_content_matches(),
                      reopen_old_pair)
        return {"operationId": operation_id, "phase": "recovered", "restoredPair": old_pair,
                "restoreFingerprint": fingerprint}

    if stage_only and prepared:
        if (prepared.get("databaseSha256") != sha256_file(live) or
                prepared.get("fingerprint") != expected_fingerprint):
            raise HostFailure("staged restore database bytes changed; refusing retry")
        return {"operationId": operation_id, "phase": "restore-staged", "restoredPair": old_pair,
                "databaseSha256": prepared["databaseSha256"]}
    if already_recovered:
        # The durable recovered row is the restore boundary. A retry may only reopen and
        # finalize, even if the prior process died after some writers had already restarted.
        state.recover(operation_id, lambda: False, reopen_old_pair)
        return {"operationId": operation_id, "phase": "recovered", "restoredPair": old_pair}

    if config.get("profile") == "production-paired" and not stage_only:
        imported_backup = Path(config["backupRoot"]) / operation_id / "offhost-backup"
        if prepared or imported_backup.exists():
            raise HostFailure("production backup is imported or restore is prepared; resume staged restore and provenance finalize")

    _start_acquisition(config, state, operation_id, start["sourceSha"], recovery=True)
    _write_gate(config, True)
    _verify_fence(config)
    _stop_writers(config)
    state.confirm_fence(operation_id, lambda: all(
        run(["/usr/bin/systemctl", "is-active", unit], check=False).returncode != 0
        for unit in config["writerUnits"]))
    state.require_restore_allowed(operation_id)
    backup_dir = Path(config["backupRoot"]) / operation_id
    server_manifest = backup_dir / "manifest.json"
    offhost_dir = backup_dir / "offhost-backup"
    live = Path(config["cmsDatabase"]).resolve(strict=True)
    if config.get("profile") == "production-paired" and server_manifest.exists() and not stage_only:
        phase = state.phase(operation_id).get("phase")
        if phase in ("fenced", "acquiring"):
            # Provenance admission can fail after backup but before CMS activation. If
            # exact old bytes and pointers are still live, reopen without a false restore
            # event or rewriting a database that was never changed.
            baseline = next((row.get("oldPair") for row in state._operation_rows(operation_id)
                             if row.get("record") == "fenced-baseline"), None)
            unchanged = False
            try:
                checkpoint_manifest = json.loads(server_manifest.read_text(encoding="utf-8"))
                checkpoint_database = backup_dir / "database.sqlite"
                import sqlite3
                _assert_no_database_handles(live)
                checked = sqlite3.connect(str(checkpoint_database))
                try:
                    backup_integrity = checked.execute("PRAGMA integrity_check").fetchone()[0]
                finally:
                    checked.close()
                unchanged = (isinstance(baseline, dict) and
                    isinstance(checkpoint_manifest.get("databaseSha256"), str) and
                    sha256_file(checkpoint_database) == checkpoint_manifest.get("databaseSha256") and
                    backup_integrity == "ok" and
                    sha256_file(live) == checkpoint_manifest.get("postCheckpointLiveSha256") and
                    str(_current_target(Path(config["currentCms"]))) == baseline.get("cmsPath") and
                    str(_current_target(Path(config["currentStatic"]))) == baseline.get("staticPath") and
                    _tree_sha256(_current_target(Path(config["currentStatic"]))) == baseline.get("staticTreeSha256") and
                    _media_state_sha256(_media_inventory(config)) == baseline.get("mediaStateSha256") and
                    _cms_payload_sha256(_current_target(Path(config["currentCms"])),
                        next(Path(item["path"]).resolve(strict=True) for item in config["mediaRoots"]
                             if item["prefix"] == "/uploads/")) == baseline.get("cmsPayloadSha256"))
            except (OSError, ValueError, sqlite3.Error, StopIteration):
                unchanged = False
            if unchanged:
                state.recover(operation_id, lambda: True, reopen_old_pair)
                return {"operationId": operation_id, "phase": "recovered", "restoredPair": old_pair,
                        "dataRestored": False}
    if server_manifest.exists():
        if not offhost_dir.is_dir() or offhost_dir.is_symlink():
            raise HostFailure("explicit recovery requires the actual verified off-host backup bytes")
        manifest = _backup_manifest(config, operation_id, offhost_dir)
        backup_dir = offhost_dir
        database = backup_dir / "database.sqlite"
        if sha256_file(database) != manifest["databaseSha256"]:
            raise HostFailure("old database backup bytes fail their captured digest")
        import sqlite3
        checked = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            if checked.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise HostFailure("old database backup failed SQLite integrity verification")
        finally:
            checked.close()
        _assert_no_database_handles(live)
        _copy_atomic(database, live)
        _restore_media(config, backup_dir, manifest)
        _switch_pointer(Path(config["currentCms"]), Path(old_pair["cmsPath"]), Path(config["releaseRoot"]))
        _switch_pointer(Path(config["currentStatic"]), Path(old_pair["staticPath"]), Path(config["staticReleaseRoot"]))
        expected_database_sha = manifest["databaseSha256"]
    else:
        # No destructive work starts before the final backup. If acquisition was interrupted
        # before it completed, preserve any editor writes that landed before the fence closed.
        import sqlite3
        _assert_no_database_handles(live)
        checked = sqlite3.connect(f"file:{live}?mode=ro", uri=True)
        try:
            if checked.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise HostFailure("live database is not intact after interrupted acquisition")
        finally:
            checked.close()
        if str(_current_target(Path(config["currentCms"]))) != old_pair["cmsPath"]:
            raise HostFailure("CMS code changed before backup; restore requires an intact old release")
        if str(_current_target(Path(config["currentStatic"]))) != old_pair["staticPath"]:
            raise HostFailure("static code changed before backup; restore requires the old release")
        expected_database_sha = sha256_file(live)
    if stage_only:
        if (config.get("profile") != "production-paired" or not server_manifest.exists() or
                not isinstance(expected_fingerprint, str) or not CONTENT_FINGERPRINT_RE.fullmatch(expected_fingerprint)):
            raise HostFailure("staged restore requires the verified production backup")
        state._append({"version": 1, "record": "restore-prepared", "operationId": operation_id,
                       "sourceSha": start["sourceSha"], "databaseSha256": expected_database_sha,
                       "staticTreeSha256": old_pair["staticTreeSha256"], "fingerprint": expected_fingerprint,
                       "mediaManifestSha256": manifest["mediaManifestSha256"],
                       "mediaStateSha256": _media_state_sha256(manifest.get("media", []))})
        return {"operationId": operation_id, "phase": "restore-staged", "restoredPair": old_pair,
                "databaseSha256": expected_database_sha}
    state.recover(operation_id, lambda: sha256_file(live) == expected_database_sha
                  and _tree_sha256(_current_target(Path(config["currentStatic"]))) == old_pair["staticTreeSha256"],
                  reopen_old_pair)
    return {"operationId": operation_id, "phase": "recovered", "restoredPair": old_pair}


def dispatch(args: argparse.Namespace) -> dict[str, Any]:
    if os.geteuid() != 0:
        raise HostFailure("host command must run through the installed root-owned entrypoint")
    if args.action != "cleanup-site":
        RehearsalState._validate_identity(args.operation_id, getattr(args, "source_sha", None))
    profile = getattr(args, "profile", "staging194")
    config_path = (INITIAL_PROD_CONFIG_PATH if profile == "initial-prod" else
                   PRODUCTION_STATIC_CONFIG_PATH if profile == "production-static" else
                   PRODUCTION_PAIRED_CONFIG_PATH if profile == "production-paired" else CONFIG_PATH)
    config = _root_config(config_path, expected_profile=profile)
    cleanup_marker_snapshot = None
    if args.action == "cleanup-site":
        config, profile, cleanup_marker_snapshot = _select_cleanup_profile(config, profile)
    _configure_profile_temp(config)
    if profile == "production-static" and args.action not in (
            "static-main", "static-main-recover", "export-static-main", "status", "cleanup-site"):
        raise HostFailure("production-static permits only static-main publication and recovery")
    if profile == "production-paired" and args.action not in (
            "cms-update", "static-publish", "export-backup", "export-static", "recover", "restore",
            "finalize-recover", "status", "cleanup-site"):
        raise HostFailure("production-paired permits only paired CMS update, static publish, and recovery")
    if profile == "initial-prod" and args.action == "recover":
        raise HostFailure("initial-prod recovery is disabled; keep the production fence closed for owner direction")
    if (profile == "initial-prod" and args.action not in ("validate-config", "cleanup-site")
            and args.operation_id != INITIAL_PROD_OPERATION_ID):
        raise HostFailure("initial-prod accepts only its fixed single-use operation ID")
    if getattr(args, "space_preflight", False):
        operation_kind = getattr(args, "space_preflight_for", None)
        if args.action != "status" or operation_kind not in ("cms-update", "static-main"):
            raise HostFailure("space preflight is available only through status")
        return _space_preflight(config, args.operation_id, operation_kind)
    state = RehearsalState(Path(config["stateDir"]))
    destination_lock = (nullcontext() if args.action == "status"
                        else _destination_publication_lock(config, wait=args.action == "cleanup-site"))
    with destination_lock, state.lock():
        try:
            # The ordinary journal reader repairs torn tails. Validate before
            # any dispatch path (including status/export) can call it.
            history = state.read_journal_for_cleanup()
        except RehearsalRefusal as error:
            raise HostFailure(str(error)) from error
        unfinished = RehearsalState._unfinished_operation_ids(history)
        marker = _read_site_publication_marker(config)
        recovery_actions = ("recover", "restore", "finalize-recover", "static-main-recover")
        matching_rows = [row for row in history if row.get("operationId") == getattr(args, "operation_id", None)]
        if (args.action in recovery_actions and marker is not None
                and marker.get("phase") == "active" and marker.get("profile") == profile
                and marker.get("operationId") == getattr(args, "operation_id", None)
                and not matching_rows and not unfinished):
            if args.action == "recover":
                if getattr(args, "backup_sha256", None) is not None or getattr(args, "restore_fingerprint", None) is not None:
                    raise HostFailure("marker-only recovery cannot import or finalize a restore")
            elif args.action == "static-main-recover":
                if (getattr(args, "rollback_committed", False)
                        or getattr(args, "operator", None) is not None
                        or getattr(args, "reason", None) is not None):
                    raise HostFailure("marker-only recovery has no committed rollback evidence")
            else:
                raise HostFailure("marker-only recovery is supported only for recover actions")
            _assert_site_refresh_idle(config)
            _clear_site_publication_marker(config, args.operation_id)
            return {"operationId": args.operation_id, "phase": "recovered"}
        state_writers = ("cms-update", "static-publish", "recover", "restore", "finalize-recover",
                         "static-main", "static-main-recover", "cleanup-site")
        if args.action in state_writers:
            _assert_site_refresh_idle(config, allow_interrupted=(
                args.action == "recover" and args.operation_id in unfinished))
            committed_main = any(row.get("operationId") == getattr(args, "operation_id", None)
                                 and row.get("record") == "static-main-committed"
                                 and row.get("operationKind") == "static-main" for row in history)
            prepared_restore = any(row.get("operationId") == getattr(args, "operation_id", None)
                                   and row.get("record") == "restore-prepared" for row in history)
            has_paired_start = any(row.get("operationId") == getattr(args, "operation_id", None)
                                   and row.get("record") == "start"
                                   and row.get("operationKind") != "static-main" for row in history)
            has_static_main_start = any(row.get("operationId") == getattr(args, "operation_id", None)
                                        and row.get("record") == "static-main-start"
                                        and row.get("operationKind") == "static-main" for row in history)
            marker_continuation = (
                (args.action in ("cms-update", "static-publish", "recover", "restore") and has_paired_start)
                or (args.action in ("static-main", "static-main-recover") and has_static_main_start)
                or (args.action == "finalize-recover" and profile == "production-paired" and prepared_restore))
            _assert_site_publication_admission(
                config, profile, args.action, getattr(args, "operation_id", None),
                unfinished,
                allow_cleanup_pending_rollback=(args.action == "static-main-recover"
                    and getattr(args, "rollback_committed", False) is True and committed_main),
                allow_cleanup_pending_finalize=(args.action == "finalize-recover"
                    and profile == "production-paired" and prepared_restore
                    and isinstance(getattr(args, "restore_fingerprint", None), str)
                    and CONTENT_FINGERPRINT_RE.fullmatch(args.restore_fingerprint)),
                allow_marker_recreation=marker_continuation)
        if args.action == "cleanup-site":
            if _read_site_publication_marker(config) != cleanup_marker_snapshot:
                raise HostFailure("site-publication marker changed while housekeeping was acquiring locks; retry required")
            _consume_site_cleanup_request(config)
            return {"status": "succeeded", "removedReleases": _cleanup_site_releases(config, state, None)}
        rows = state._operation_rows(args.operation_id)
        static_main_owned = any(row.get("operationKind") == "static-main" for row in rows)
        if static_main_owned and args.action in ("cms-update", "static-publish", "recover", "restore", "finalize-recover"):
            raise HostFailure("static-main operations require static-main-recover; CMS recovery is forbidden")
        if args.action == "static-main":
            try:
                provenance = json.loads(base64.b64decode(args.provenance_b64, validate=True))
            except (ValueError, TypeError) as error:
                raise HostFailure("static-main source provenance is not valid base64 JSON") from error
            _validate_static_main_admission(config, args.source_sha, provenance)
            if args.browser_digest:
                result = _static_main_commit(config, state, args.operation_id, args.source_sha,
                                             provenance, args.browser_digest)
                if result.get("phase") == "committed":
                    result.update(_cleanup_after_commit(config, state, args.operation_id))
                return result
            if rows:
                return _static_main_prepare(config, state, args.operation_id, args.source_sha, provenance,
                                            args.reuse_capture_operation_id)
            if not SHA256_RE.fullmatch(args.archive_sha256 or ""):
                raise HostFailure("static-main source archive SHA-256 is required before preparation")
            archive_bytes = sys.stdin.buffer.read()
            if not archive_bytes:
                raise HostFailure("static-main source archive is required before preparation")
            if hashlib.sha256(archive_bytes).hexdigest() != args.archive_sha256:
                raise HostFailure("static-main source archive SHA-256 does not match")
            _write_site_publication_marker(config, args.operation_id)
            source_root = _extract_source_archive(config, args.source_sha, args.operation_id, archive_bytes,
                                                  args.archive_sha256, provenance, "refs/heads/main")
            del archive_bytes
            return _static_main_prepare(config, state, args.operation_id, args.source_sha, provenance,
                                        args.reuse_capture_operation_id)
        if args.action == "export-static-main":
            return {"_bytes": _static_main_export(config, state, args.operation_id, args.source_sha)}
        if args.action == "static-main-recover":
            if args.rollback_committed:
                if not args.operator or not args.reason:
                    raise HostFailure("committed static rollback requires --operator and --reason")
                def prepare_rollback_marker() -> None:
                    marker_now = _read_site_publication_marker(config)
                    if marker_now is None:
                        _write_site_publication_marker(config, args.operation_id)
                    elif (marker_now.get("profile") != profile
                          or marker_now.get("operationId") != args.operation_id):
                        raise HostFailure("another site publication owns the shared marker")
                result = _static_main_recover(config, state, args.operation_id, rollback_committed=True,
                                              operator_name=args.operator, reason=args.reason,
                                              before_rollback_intent=prepare_rollback_marker)
                if result.get("phase") == "rolled-back":
                    _clear_site_publication_marker(config, args.operation_id)
                return result
            if args.operator is not None or args.reason is not None:
                raise HostFailure("--operator and --reason require --rollback-committed")
            result = _static_main_recover(config, state, args.operation_id)
            if result.get("phase") == "recovered":
                _clear_site_publication_marker(config, args.operation_id)
            elif result.get("phase") == "committed":
                result.update(_cleanup_after_commit(config, state, args.operation_id))
            return result
        if args.action == "export-backup":
            manifest = _backup_manifest(config, args.operation_id)
            return {"_stream": str(Path(config["backupRoot"]) / args.operation_id / "backup.tar"),
                    "sha256": manifest["archiveSha256"]}
        if args.action == "export-static":
            return {"_bytes": _export_static(config, state, args.operation_id, args.source_sha)}
        if args.action in ("recover", "restore"):
            backup_sha = getattr(args, "backup_sha256", None)
            if profile == "production-paired" and args.action == "recover" and backup_sha:
                raise HostFailure("production-paired backup recovery must use the local provenance operator")
            if backup_sha:
                payload = sys.stdin.buffer.read()
                _import_offhost_backup(config, args.operation_id, payload, backup_sha)
                del payload
            if profile == "production-paired" and args.action == "restore":
                result = _recover(config, state, args.operation_id, stage_only=True,
                                  expected_fingerprint=args.restore_fingerprint)
            else:
                result = _recover(config, state, args.operation_id)
            if result.get("phase") == "recovered":
                marker = _read_site_publication_marker(config)
                if marker and marker["operationId"] == args.operation_id:
                    _clear_site_publication_marker(config, args.operation_id)
            return result
        if args.action == "finalize-recover":
            result = _recover(config, state, args.operation_id,
                              finalize_restore_fingerprint=args.restore_fingerprint)
            if result.get("phase") == "recovered":
                marker = _read_site_publication_marker(config)
                if marker and marker["operationId"] == args.operation_id:
                    _clear_site_publication_marker(config, args.operation_id)
            return result
        if args.action == "cms-update":
            return _cms_update(config, state, args)
        if args.action == "static-publish":
            result = _static_publish(config, state, args)
            if result.get("phase") == "committed":
                result.update(_cleanup_after_commit(config, state, args.operation_id))
            return result
        if args.action == "status":
            if profile == "production-paired":
                try:
                    phase = state.phase(args.operation_id)
                except RehearsalRefusal:
                    if state._read_marker() is not None or state._operation_rows(args.operation_id):
                        raise
                    return {"operationId": args.operation_id, "phase": "idle", "oldPair": _old_pair(config)}
                start = next((row for row in state._operation_rows(args.operation_id) if row.get("record") == "start"), None)
                if start and isinstance(start.get("oldPair"), dict):
                    phase["oldPair"] = start["oldPair"]
            else:
                phase = state.phase(args.operation_id)
            return phase
    raise HostFailure("unsupported bounded host action")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=("staging194", "initial-prod", "production-static", "production-paired"), default="staging194")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("validate-config")
    sub.add_parser("cleanup-site")
    for name in ("cms-update", "static-publish", "static-main"):
        command = sub.add_parser(name)
        command.add_argument("--operation-id", required=True)
        command.add_argument("--source-sha", required=True)
        if name in ("cms-update", "static-main"):
            command.add_argument("--archive-sha256")
            command.add_argument("--provenance-b64", required=True)
            if name == "cms-update":
                command.add_argument("--offhost-sha256")
            else:
                command.add_argument("--browser-digest")
            if name == "static-main":
                command.add_argument("--reuse-capture-operation-id")
        else:
            command.add_argument("--browser-digest")
    for name in ("export-backup", "export-static", "export-static-main", "recover", "restore",
                 "finalize-recover", "static-main-recover", "status"):
        command = sub.add_parser(name)
        command.add_argument("--operation-id", required=True)
        if name in ("export-static", "export-static-main"):
            command.add_argument("--source-sha", required=True)
        if name in ("recover", "restore"):
            command.add_argument("--backup-sha256")
        if name == "restore":
            command.add_argument("--restore-fingerprint", required=True)
        if name == "finalize-recover":
            command.add_argument("--restore-fingerprint", required=True)
        if name == "static-main-recover":
            command.add_argument("--rollback-committed", action="store_true")
            command.add_argument("--operator")
            command.add_argument("--reason")
        if name == "status":
            command.add_argument("--space-preflight", action="store_true")
            command.add_argument("--space-preflight-for", choices=("cms-update", "static-main"))
    args = parser.parse_args(argv)
    try:
        if args.action == "validate-config":
            if os.geteuid() != 0:
                raise HostFailure("host config validation must run through the installed root-owned entrypoint")
            config_path = (INITIAL_PROD_CONFIG_PATH if args.profile == "initial-prod" else
                           PRODUCTION_STATIC_CONFIG_PATH if args.profile == "production-static" else
                           PRODUCTION_PAIRED_CONFIG_PATH if args.profile == "production-paired" else CONFIG_PATH)
            config = _root_config(config_path, expected_profile=args.profile)
            if args.profile == "staging194":
                tempfile.tempdir = str(_validate_staging194_temporary_root(config))
            for key in ("stateDir", "releaseRoot", "staticReleaseRoot", "backupRoot"):
                path = Path(config[key])
                if not path.is_dir() or path.is_symlink():
                    raise HostFailure(f"configured directory is unavailable or unsafe: {key}")
            database_path = Path(config["cmsDatabase"])
            database_info = database_path.lstat()
            if not stat.S_ISREG(database_info.st_mode):
                raise HostFailure("configured SQLite database is not a regular file")
            database = database_path.resolve(strict=True)
            for item in config["mediaRoots"]:
                path = Path(item["path"])
                if path.is_symlink() or not path.is_dir():
                    raise HostFailure("configured external media directory is unavailable")
            _current_target(Path(config["currentCms"]))
            _current_target(Path(config["currentStatic"]))
            if args.profile in ("staging194", "production-static", "production-paired"):
                _database_process_proof(_service_pid(config["cmsUnit"]), database)
            print(json.dumps({"configuration": str(config_path), "profile": args.profile, "valid": True}, sort_keys=True))
            return 0
        result = dispatch(args)
        if "_bytes" in result:
            sys.stdout.buffer.write(result["_bytes"])
            return 0
        if "_stream" in result:
            with open(result["_stream"], "rb") as source:
                shutil.copyfileobj(source, sys.stdout.buffer)
            return 0
        print(json.dumps(result, sort_keys=True))
        return 0
    except (HostFailure, RehearsalRefusal) as error:
        print(f"ikpk-rehearsal: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
