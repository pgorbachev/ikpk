#!/usr/bin/env python3
"""Bounded Linux host operations for the staging193 CMS/static rehearsal.

The installed command reads a root-owned JSON policy. It never accepts arbitrary
unit names, executable paths, or filesystem destinations from an SSH caller.
"""

from __future__ import annotations

import argparse
import base64
import io
import hashlib
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

try:
    from .rehearsal_state import RehearsalRefusal, RehearsalState, durable_json
except ImportError:  # Installed wrapper places both files in one private module directory.
    from rehearsal_state import RehearsalRefusal, RehearsalState, durable_json


CONFIG_PATH = Path("/etc/ikpk/rehearsal.json")
REQUIRED_CONFIG = {
    "stateDir", "maintenanceFlag", "releaseRoot", "currentCms", "currentStatic",
    "staticReleaseRoot", "cmsUnit", "writerUnits", "cmsUser", "cmsDatabase", "mediaRoots",
    "backupRoot", "nginxBinary", "nginxService", "nginxMapFile",
    "nginxServerGateFile", "writerPrefixes", "preservePrefixes",
    "cmsHealthUrl", "siteHealthUrl", "siteBaseUrl", "siteReleaseUrl", "siteProbeUrls", "paymentStatusProbeUrl",
    "writerProbeUrls", "preserveProbeUrl", "allowedSourceRef", "targetHost",
}
SHA_RE = re.compile(r"[a-f0-9]{40}\Z")
SHA256_RE = re.compile(r"[a-f0-9]{64}\Z")
PREFIX_RE = re.compile(r"/[A-Za-z0-9_./*?=-]+\Z")
UNIT_RE = re.compile(r"[A-Za-z0-9_.@:-]+\.service\Z")


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


def _root_config(path: Path) -> dict[str, Any]:
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
    for key in ("stateDir", "releaseRoot", "staticReleaseRoot", "backupRoot", "maintenanceFlag", "currentCms", "currentStatic",
                "cmsDatabase", "nginxMapFile", "nginxServerGateFile"):
        value = Path(data[key])
        if not value.is_absolute() or value == Path("/"):
            raise HostFailure(f"{key} must be an absolute non-root path")
    if data["allowedSourceRef"] != "refs/heads/dev" or data["targetHost"] != "193.124.115.99":
        raise HostFailure("host config is bound to the staging193 dev source policy")
    return data


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


def _write_gate(config: dict[str, Any], enabled: bool) -> None:
    expressions = [re.escape(prefix.rstrip("/")) for prefix in config["writerPrefixes"]]
    exceptions = [re.escape(prefix.rstrip("/")) for prefix in config["preservePrefixes"]]
    lines = ["# managed by ikpk-rehearsal; included from nginx http context",
             'map "$request_method:$request_uri" $ikpk_rehearsal_write_block {', "    default 0;"]
    for prefix in exceptions:
        lines.append(f"    ~*^(POST|PUT|PATCH|DELETE):{prefix}(?:/|\\?|$) 0;")
    if enabled:
        for prefix in expressions:
            lines.append(f"    ~*^(POST|PUT|PATCH|DELETE):{prefix}(?:/|\\?|$) 1;")
    lines.extend(["}", ""])
    map_bytes = "\n".join(lines).encode()
    # This is the existing server-level include in both demo vhosts; no locations are added.
    server_bytes = ("# managed by ikpk-rehearsal; included from both existing demo vhosts\n"
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
            except OSError:
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


def _capture_media(config: dict[str, Any], destination: Path) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    media_dir = destination / "media"
    media_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    seen = set()
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
                digest = sha256_file(item)
                target_name = f"sha256:{digest}"
                copied = media_dir / target_name
                if target_name not in seen:
                    shutil.copy2(item, copied)
                    seen.add(target_name)
                inventory.append({"url": entry["prefix"] + relative, "file": f"media/{target_name}",
                                  "sha256": digest, "size": item.stat().st_size,
                                  "originalName": relative, "mode": stat.S_IMODE(item.stat().st_mode),
                                  "uid": item.stat().st_uid, "gid": item.stat().st_gid})
            elif not item.is_dir():
                raise HostFailure(f"media tree contains a non-regular object: {item}")
    inventory.sort(key=lambda item: item["url"])
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


def _old_pair(config: dict[str, Any]) -> dict[str, Any]:
    cms = _current_target(Path(config["currentCms"]))
    static = _current_target(Path(config["currentStatic"]))
    database = Path(config["cmsDatabase"]).resolve(strict=True)
    media_uploads = next(Path(item["path"]).resolve(strict=True) for item in config["mediaRoots"]
                         if item["prefix"] == "/uploads/")
    return {"cmsPath": str(cms), "staticPath": str(static), "databasePath": str(database),
            "cmsPayloadSha256": _cms_payload_sha256(cms, media_uploads),
            "databaseSha256": sha256_file(database), "staticTreeSha256": _tree_sha256(static),
            "configSha256": _config_sha256(config),
            "cmsDatabaseProof": _database_process_proof(_service_pid(config["cmsUnit"]), database)}


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
                            provenance: dict[str, Any]) -> Path:
    if sha256_file_bytes(payload) != expected_sha256:
        raise HostFailure("source archive digest does not match the admitted manifest")
    if provenance.get("sourceSha") != source_sha or provenance.get("ref") != config["allowedSourceRef"]:
        raise HostFailure("source archive provenance does not match the operation")
    if (provenance.get("workflow") != "Tests" or provenance.get("workflowName") != "Tests"
            or provenance.get("headBranch") != "dev" or provenance.get("event") != "push"):
        raise HostFailure("source archive lacks canonical Tests push provenance")
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


def sha256_file_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _run_as_cms(config: dict[str, Any], cwd: Path, argv: list[str], timeout: int = 1800,
                environment: Optional[dict[str, str]] = None) -> str:
    user = pwd.getpwnam(config["cmsUser"])
    runtime_max = max(1, timeout - 30)
    command = ["/usr/bin/systemd-run", "--wait", "--collect", "--pipe", f"--uid={user.pw_name}",
               f"--working-directory={cwd}", f"--property=RuntimeMaxSec={runtime_max}s",
               "--property=TimeoutStopSec=15s"]
    for key, value in (environment or {}).items():
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


def _validate_prepared_cms_candidate(config: dict[str, Any], source_root: Path, operation_id: str,
                                     provenance: Optional[dict[str, Any]] = None) -> tuple[Path, Path, Path]:
    marker = source_root / ".ikpk-rehearsal-ci.json"
    try:
        admitted = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostFailure("prepared source candidate lacks admitted CI provenance") from error
    if (admitted.get("sourceSha") is None or admitted.get("ref") != config["allowedSourceRef"]
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
            or installed_package.get("version") != locked_strapi):
        raise HostFailure("CMS source, artifact, and installed Strapi identities do not match")
    _validate_prepared_web_dependencies(source_root)
    return source_root, artifact, dependencies


def _prepare_cms_candidate(config: dict[str, Any], source_root: Path, operation_id: str,
                           provenance: dict[str, Any]) -> tuple[Path, Path, Path]:
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
        str(artifact)], timeout=3600, environment={"NODE_OPTIONS": "--max-old-space-size=1536"})
    if os.path.lexists(artifact / "node_modules"):
        raise HostFailure("CMS artifact unexpectedly contains node_modules before dependency linking")
    (artifact / "node_modules").symlink_to(dependencies, target_is_directory=True)
    return _validate_prepared_cms_candidate(config, source_root, operation_id, provenance)


def _start_acquisition(config: dict[str, Any], state: RehearsalState, operation_id: str,
                       source_sha: str) -> dict[str, Any]:
    prior = next((row for row in state._operation_rows(operation_id) if row.get("record") == "start"), None)
    old_pair = prior.get("oldPair") if prior else _old_pair(config)
    state.begin(operation_id, source_sha, old_pair)
    _set_flag(config, True)
    _write_gate(config, True)
    _stop_writers(config)
    _verify_fence(config)
    state.confirm_fence(operation_id, lambda: all(
        run(["/usr/bin/systemctl", "is-active", unit], check=False).returncode != 0
        for unit in config["writerUnits"]))
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
    payment_status = run(["/usr/bin/curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
                          "--max-time", "10", config["paymentStatusProbeUrl"]], timeout=12)
    if payment_status.stdout.strip() != "404":
        raise HostFailure("disabled payment status route did not retain its expected 404")


def _create_capture_bundle(config: dict[str, Any], operation_id: str, source_sha: str,
                           source_root: Path, database: Path) -> Path:
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
    _run_as_cms(config, source_root / "web", [node, str(source_root / "scripts/lib/seal-staging193-capture.mjs"),
        str(capture), operation_id, source_sha, str(source_root / "cms/src")], timeout=300)
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
                  capture: Path) -> dict[str, Any]:
    live = Path(config["cmsDatabase"]).resolve(strict=True)
    _assert_no_database_handles(live)
    _copy_atomic(candidate_db, live)
    _switch_pointer(Path(config["currentCms"]), cms_release, Path(config["releaseRoot"]))
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
    probe_url = "http://127.0.0.1:1338" + quote(media_url, safe="/")
    media_probe = run(["/usr/bin/curl", "--fail", "--silent", "--show-error", "--output", "/dev/null",
                       "--max-time", "15", probe_url],
                      timeout=20, check=False)
    if media_probe.returncode:
        raise HostFailure("CMS did not serve the captured original media file after activation")
    return proof


def _build_static(config: dict[str, Any], source_root: Path, capture: Path) -> tuple[Path, str]:
    web = source_root / "web"
    _validate_prepared_web_dependencies(source_root)
    capture_environment = {
        "CONTENT_SNAPSHOT_DIR": str(web / ".snapshot"), "DEMO_PROFILE": "demo193",
        "DEPLOY_MODE": "stand", "PAYMENT_ROLE": "ci", "DEMO_FORMS": "stub",
        "CHAT_LOADER_SRC": "none", "CHAT_OFFLINE_MESSAGE": "absent",
        "DEMO_SITE_URL": config["siteBaseUrl"],
    }
    _run_as_cms(config, web, [str(web / "node_modules/.bin/tsx"),
        str(web / "scripts/capture-content-snapshot.ts"), "--server-capture", str(capture)], timeout=1800,
        environment=capture_environment)
    _run_as_cms(config, web, ["/usr/bin/npm", "run", "build:demo193"], timeout=1800,
                environment=capture_environment)
    dist = web / "dist-demo193"
    if not dist.is_dir() or dist.is_symlink():
        raise HostFailure("static build did not produce a real dist-demo193 directory")
    _preserve_hashed_assets(config, dist)
    snapshot = json.loads((web / ".snapshot/snapshot.json").read_text(encoding="utf-8"))
    source_identity = json.loads((source_root / ".ikpk-rehearsal-ci.json").read_text(encoding="utf-8"))
    release = {"commit": source_identity["sourceSha"], "operationId": capture.parent.name,
               "snapshotId": snapshot.get("snapshotId"),
               "staticTreeSha256": _tree_sha256(dist)}
    if not isinstance(release["snapshotId"], str) or not release["snapshotId"].startswith("snap:"):
        raise HostFailure("static candidate snapshot ID is missing")
    durable_json(dist / "release.json", release)
    digest = _tree_sha256(dist)
    return dist, digest


def _preserve_hashed_assets(config: dict[str, Any], destination: Path) -> set[str]:
    root = Path(config["staticReleaseRoot"]).resolve(strict=True)
    asset_pattern = re.compile(r".+\.[A-Za-z0-9_-]{8,}\.(?:js|css|mjs|woff2?|ttf|svg|png|webp|avif)\Z")
    pagefind_pattern = re.compile(r".+[._-][a-f0-9]{7,}\.pf_(?:fragment|index|meta)\Z")
    copied: set[str] = set()
    for release in sorted(root.iterdir()):
        if not release.is_dir() or release.is_symlink():
            continue
        asset_roots = [(release / "_astro", "_astro", asset_pattern),
                       (release / "public/_astro", "_astro", asset_pattern),
                       (release / "pagefind", "pagefind", pagefind_pattern),
                       (release / "public/pagefind", "pagefind", pagefind_pattern)]
        for asset_root, public_prefix, pattern in asset_roots:
            if not asset_root.is_dir() or asset_root.is_symlink():
                continue
            for asset in sorted(asset_root.rglob("*")):
                info = asset.lstat()
                if stat.S_ISDIR(info.st_mode):
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise HostFailure("retained release hashed asset tree contains an unsafe object")
                if not pattern.fullmatch(asset.name):
                    continue
                relative = asset.relative_to(asset_root)
                target = destination / public_prefix / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    if target.is_symlink() or not target.is_file() or sha256_file(target) != sha256_file(asset):
                        raise HostFailure("same hashed asset URL has different retained bytes")
                else:
                    shutil.copy2(asset, target)
                copied.add("/" + public_prefix + "/" + relative.as_posix())
    return copied


def _verify_retained_hashed_assets(config: dict[str, Any]) -> None:
    root = Path(config["staticReleaseRoot"]).resolve(strict=True)
    asset_pattern = re.compile(r".+\.[A-Za-z0-9_-]{8,}\.(?:js|css|mjs|woff2?|ttf|svg|png|webp|avif)\Z")
    pagefind_pattern = re.compile(r".+[._-][a-f0-9]{7,}\.pf_(?:fragment|index|meta)\Z")
    urls: set[str] = set()
    for release in sorted(root.iterdir()):
        if not release.is_dir() or release.is_symlink():
            continue
        for asset_root, public_prefix, pattern in ((release / "_astro", "_astro", asset_pattern),
                                                   (release / "public/_astro", "_astro", asset_pattern),
                                                   (release / "pagefind", "pagefind", pagefind_pattern),
                                                   (release / "public/pagefind", "pagefind", pagefind_pattern)):
            if not asset_root.is_dir() or asset_root.is_symlink():
                continue
            for asset in asset_root.rglob("*"):
                info = asset.lstat()
                if stat.S_ISREG(info.st_mode) and pattern.fullmatch(asset.name):
                    urls.add("/" + public_prefix + "/" + asset.relative_to(asset_root).as_posix())
    if not urls:
        raise HostFailure("no retained hashed asset URLs were found for post-switch verification")
    for path in sorted(urls):
        response = run(["/usr/bin/curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}",
                        "--max-time", "15", config["siteBaseUrl"].rstrip("/") + path], timeout=20)
        if response.stdout.strip() not in ("200", "304"):
            raise HostFailure(f"retained hashed asset is unavailable after static switch: {path}")


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
    op, sha = args.operation_id, args.source_sha
    if not SHA_RE.fullmatch(sha):
        raise HostFailure("source SHA must be a full lowercase commit ID")
    try:
        provenance = json.loads(base64.b64decode(args.provenance_b64, validate=True))
    except (ValueError, TypeError) as error:
        raise HostFailure("source CI provenance is not valid base64 JSON") from error
    try:
        phase = state.phase(op)
    except RehearsalRefusal:
        phase = None
    if phase and phase.get("sourceSha") not in (None, sha):
        raise HostFailure("operation ID is already bound to another source SHA")
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
    source_root = _candidate_root(config, sha, op)
    if phase is None:
        if args.offhost_sha256:
            raise HostFailure("off-host confirmation cannot precede initial source preparation and backup")
        state.assert_new_operation_allowed(op, sha)
        if not SHA256_RE.fullmatch(args.archive_sha256 or ""):
            raise HostFailure("source archive SHA-256 is required before acquisition")
        archive_bytes = sys.stdin.buffer.read()
        if not archive_bytes:
            raise HostFailure("admitted source archive is required before acquisition")
        source_root = _extract_source_archive(config, sha, op, archive_bytes, args.archive_sha256, provenance)
        del archive_bytes
        _prepare_cms_candidate(config, source_root, op, provenance)
    else:
        _validate_prepared_cms_candidate(config, source_root, op, provenance)
    phase = _start_acquisition(config, state, op, sha)
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
    proof = _activate_cms(config, cms_release, candidate_db, capture)
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
    built = source_root / "web/dist-demo193"
    if not args.browser_digest:
        if phase["phase"] == "cms-activated" or not built.is_dir():
            capture = source_root / ".staging193-rehearsal" / op / "capture"
            if capture.is_symlink() or not capture.is_dir():
                raise HostFailure("sealed CMS capture is missing before static build")
            built, built_digest = _build_static(config, source_root, capture)
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
    _verify_retained_hashed_assets(config)
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


def _recover(config: dict[str, Any], state: RehearsalState, operation_id: str) -> dict[str, Any]:
    if state._is_committed(operation_id):
        raise HostFailure("recovery is closed after global commit; retry static-publish to finalize")
    start = next((row for row in state._operation_rows(operation_id) if row.get("record") == "start"), None)
    if not start:
        raise HostFailure("operation has no journaled old pair")
    old_pair = start["oldPair"]
    live = Path(config["cmsDatabase"]).resolve(strict=True)
    already_recovered = state._is_recovered(operation_id)

    def reopen_old_pair() -> bool:
        run(["/usr/bin/systemctl", "start", config["cmsUnit"]], timeout=120)
        _wait_health(config["cmsHealthUrl"], 1200)
        _database_process_proof(_service_pid(config["cmsUnit"]), live)
        if str(_current_target(Path(config["currentCms"]))) != old_pair["cmsPath"]:
            raise HostFailure("old CMS release is not selected during recovery reopen")
        if _tree_sha256(_current_target(Path(config["currentStatic"]))) != old_pair["staticTreeSha256"]:
            raise HostFailure("restored static pointer does not identify the recorded old bytes")
        _wait_health(config["siteHealthUrl"], 1200)
        _set_flag(config, False)
        _write_gate(config, False)
        run(["/usr/bin/systemctl", "start", *config["writerUnits"]], timeout=120)
        return all(run(["/usr/bin/systemctl", "is-active", unit], check=False).returncode == 0
                   for unit in [config["cmsUnit"], *config["writerUnits"]])

    if already_recovered:
        # The durable recovered row is the restore boundary. A retry may only reopen and
        # finalize, even if the prior process died after some writers had already restarted.
        state.recover(operation_id, lambda: False, reopen_old_pair)
        return {"operationId": operation_id, "phase": "recovered", "restoredPair": old_pair}

    _start_acquisition(config, state, operation_id, start["sourceSha"])
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
    state.recover(operation_id, lambda: sha256_file(live) == expected_database_sha
                  and _tree_sha256(_current_target(Path(config["currentStatic"]))) == old_pair["staticTreeSha256"],
                  reopen_old_pair)
    return {"operationId": operation_id, "phase": "recovered", "restoredPair": old_pair}


def dispatch(args: argparse.Namespace) -> dict[str, Any]:
    if os.geteuid() != 0:
        raise HostFailure("host command must run through the installed root-owned entrypoint")
    RehearsalState._validate_identity(args.operation_id, getattr(args, "source_sha", None))
    config = _root_config(CONFIG_PATH)
    state = RehearsalState(Path(config["stateDir"]))
    with state.lock():
        if args.action == "export-backup":
            manifest = _backup_manifest(config, args.operation_id)
            return {"_stream": str(Path(config["backupRoot"]) / args.operation_id / "backup.tar"),
                    "sha256": manifest["archiveSha256"]}
        if args.action == "export-static":
            return {"_bytes": _export_static(config, state, args.operation_id, args.source_sha)}
        if args.action == "recover":
            backup_sha = getattr(args, "backup_sha256", None)
            if backup_sha:
                payload = sys.stdin.buffer.read()
                _import_offhost_backup(config, args.operation_id, payload, backup_sha)
                del payload
            return _recover(config, state, args.operation_id)
        if args.action == "cms-update":
            return _cms_update(config, state, args)
        if args.action == "static-publish":
            return _static_publish(config, state, args)
        if args.action == "status":
            return state.phase(args.operation_id)
    raise HostFailure("unsupported bounded host action")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("validate-config")
    for name in ("cms-update", "static-publish"):
        command = sub.add_parser(name)
        command.add_argument("--operation-id", required=True)
        command.add_argument("--source-sha", required=True)
        if name == "cms-update":
            command.add_argument("--archive-sha256")
            command.add_argument("--provenance-b64", required=True)
            command.add_argument("--offhost-sha256")
        else:
            command.add_argument("--browser-digest")
    for name in ("export-backup", "export-static", "recover", "status"):
        command = sub.add_parser(name)
        command.add_argument("--operation-id", required=True)
        if name == "export-static":
            command.add_argument("--source-sha", required=True)
        if name == "recover":
            command.add_argument("--backup-sha256")
    args = parser.parse_args(argv)
    try:
        if args.action == "validate-config":
            if os.geteuid() != 0:
                raise HostFailure("host config validation must run through the installed root-owned entrypoint")
            config = _root_config(CONFIG_PATH)
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
            _database_process_proof(_service_pid(config["cmsUnit"]), database)
            print(json.dumps({"configuration": str(CONFIG_PATH), "valid": True}, sort_keys=True))
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
