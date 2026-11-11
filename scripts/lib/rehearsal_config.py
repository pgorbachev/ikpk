#!/usr/bin/env python3
"""Narrow, reversible migration for rehearsal host configuration."""
import json
import os
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

PRODUCTION_PROFILES = {"initial-prod", "production-static", "production-paired"}


def _migration(current: Path, template: Path) -> tuple[dict, bool]:
    if current.is_symlink() or not current.is_file():
        raise ValueError("existing rehearsal config is not a regular file")
    actual = json.loads(current.read_text(encoding="utf-8"))
    expected = json.loads(template.read_text(encoding="utf-8"))
    if actual == expected:
        return actual, False
    normalized = dict(actual)
    changed = False
    if normalized.get("allowedSourceRef") == "refs/heads/dev" and expected.get("allowedSourceRef") == "refs/heads/main":
        normalized["allowedSourceRef"] = "refs/heads/main"
        changed = True
    for key in ("siteRefreshState", "sitePublicationMarker", "publicationLock"):
        if key not in expected:
            continue
        if key not in normalized:
            normalized[key] = expected[key]
            changed = True
        elif (key == "siteRefreshState"
              and normalized[key] == "/var/lib/ikpk-cms-prototype193/staging/site-refresh194/state"
              and expected[key] == "/var/lib/ikpk-cms-prototype193/staging/site-refresh194/state/state.json"):
            normalized[key] = expected[key]
            changed = True
    if "temporaryRoot" in expected and "temporaryRoot" not in normalized:
        normalized["temporaryRoot"] = expected["temporaryRoot"]
        changed = True
    if (expected.get("profile", "staging194") == "staging194"
            and normalized.get("profile", "staging194") == "staging194"
            and "cmsEnvironmentFile" in expected and "cmsEnvironmentFile" not in normalized):
        normalized["cmsEnvironmentFile"] = expected["cmsEnvironmentFile"]
        changed = True
    if normalized != expected and not _preserves_existing_payment_probe(actual, expected, normalized):
        raise ValueError("existing rehearsal config has unrelated differences; refusing migration")
    return normalized, changed


def _preserves_existing_payment_probe(actual: dict, expected: dict, normalized: dict) -> bool:
    """Keep an already installed production probe URL and accept no other drift."""
    profile = expected.get("profile")
    if profile not in PRODUCTION_PROFILES or normalized.get("profile") != profile:
        return False
    if "paymentStatusProbeUrl" not in actual or normalized.get("paymentStatusProbeUrl") != actual["paymentStatusProbeUrl"]:
        return False
    comparable = dict(normalized)
    comparable["paymentStatusProbeUrl"] = expected.get("paymentStatusProbeUrl")
    return comparable == expected


def check(current: str, template: str) -> None:
    path = Path(current)
    if path.exists() or path.is_symlink():
        _migration(path, Path(template))


def migrate(current: str, template: str) -> None:
    path = Path(current)
    actual, needed = _migration(path, Path(template))
    if not needed:
        return
    backup = path.with_name(path.name + ".pre-update-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".bak")
    source = path.read_bytes()
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(source)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        backup.unlink(missing_ok=True)
        raise
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".new-", dir=path.parent)
    try:
        os.fchmod(fd, stat.S_IMODE(path.stat().st_mode))
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(actual, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("check", "migrate"):
        raise SystemExit("usage: rehearsal_config.py check|migrate CONFIG TEMPLATE")
    (check if sys.argv[1] == "check" else migrate)(sys.argv[2], sys.argv[3])
