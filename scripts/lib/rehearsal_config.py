#!/usr/bin/env python3
"""Narrow, reversible migration for the staging194 source-ref policy."""
import json
import os
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def _migration(current: Path, template: Path) -> tuple[dict, bool]:
    if current.is_symlink() or not current.is_file():
        raise ValueError("existing rehearsal config is not a regular file")
    actual = json.loads(current.read_text(encoding="utf-8"))
    expected = json.loads(template.read_text(encoding="utf-8"))
    if actual == expected:
        return actual, False
    if actual.get("allowedSourceRef") != "refs/heads/dev" or expected.get("allowedSourceRef") != "refs/heads/main":
        raise ValueError("existing rehearsal config differs from the reviewed versioned template")
    normalized = dict(actual)
    normalized["allowedSourceRef"] = "refs/heads/main"
    if normalized != expected:
        raise ValueError("existing rehearsal config has unrelated differences; refusing migration")
    return actual, True


def check(current: str, template: str) -> None:
    path = Path(current)
    if path.exists() or path.is_symlink():
        _migration(path, Path(template))


def migrate(current: str, template: str) -> None:
    path = Path(current)
    actual, needed = _migration(path, Path(template))
    if not needed:
        return
    backup = path.with_name(path.name + ".pre-main-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".bak")
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
    actual["allowedSourceRef"] = "refs/heads/main"
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
