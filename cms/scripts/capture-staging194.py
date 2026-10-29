#!/usr/bin/env python3
"""Capture the staging194 SQLite database and uploads under a brief writer barrier."""

import hashlib
import json
import os
import re
import signal
import sqlite3
import stat
import sys
from pathlib import Path
from urllib.parse import quote


CAPTURE_LIMIT_SECONDS = 20 * 60
SAFE_OPERATION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def expire(_signum, _frame):
    raise TimeoutError("staging capture exceeded its time limit")


def source_files(root: Path):
    for parent, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        parent_path = Path(parent)
        for name in dirs:
            path = parent_path / name
            if path.is_symlink():
                raise ValueError("media tree contains a symlink")
        for name in files:
            path = parent_path / name
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("media tree contains a non-regular file")
            yield path, path.relative_to(root)


def copy_media(source: Path, bundle: Path, url_prefix: str, storage_prefix: str):
    rows = []
    for path, relative in source_files(source):
        target = bundle / "media" / storage_prefix / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as src, target.open("xb") as dst:
            while True:
                block = src.read(1024 * 1024)
                if not block:
                    break
                dst.write(block)
                digest.update(block)
                size += len(block)
            dst.flush()
            os.fsync(dst.fileno())
        rows.append({
            "url": url_prefix + relative.as_posix(),
            "file": (Path("media") / storage_prefix / relative).as_posix(),
            "sha256": digest.hexdigest(),
            "size": size,
        })
    return rows


def main():
    os.umask(0o077)
    if len(sys.argv) != 2:
        raise ValueError("capture operation id is required")
    operation = sys.argv[1]
    if not SAFE_OPERATION.fullmatch(operation):
        raise ValueError("invalid capture operation id")
    if (os.environ.get("IKPK_CAPTURE_PROFILE") != "staging194"
            or os.environ.get("IKPK_VERIFY_URL") != "https://194.226.99.10/release.json"):
        raise ValueError("capture is restricted to the configured staging194 target")

    database_arg = Path(os.environ["IKPK_CAPTURE_DATABASE"])
    media_arg = Path(os.environ["IKPK_CAPTURE_MEDIA"])
    static_media_arg = Path(os.environ["IKPK_MEDIA_CACHE"])
    if database_arg.is_symlink() or media_arg.is_symlink() or static_media_arg.is_symlink():
        raise ValueError("configured source paths cannot be symlinks")
    database = database_arg.resolve(strict=True)
    media = media_arg.resolve(strict=True)
    static_media = static_media_arg.resolve(strict=True)
    capture_root = Path(os.environ["IKPK_CAPTURE_ROOT"]).resolve()
    if (not database.is_file() or database.is_symlink() or not media.is_dir() or media.is_symlink()
            or not static_media.is_dir() or static_media.is_symlink()):
        raise ValueError("configured source paths are not regular staging inputs")
    bundle = capture_root / operation
    capture_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    capture_root.chmod(0o700)
    bundle.mkdir(mode=0o700)

    signal.signal(signal.SIGALRM, expire)
    signal.alarm(CAPTURE_LIMIT_SECONDS)
    barrier = None
    source = None
    destination = None
    try:
        barrier = sqlite3.connect(database, timeout=5, isolation_level=None)
        barrier.execute("PRAGMA busy_timeout=5000")
        barrier.execute("BEGIN IMMEDIATE")

        uri = "file:" + quote(str(database), safe="/:.") + "?mode=ro"
        source = sqlite3.connect(uri, uri=True, timeout=5)
        destination = sqlite3.connect(bundle / "database.sqlite", timeout=5)
        source.backup(destination, pages=256, sleep=0.05)
        destination.commit()
        destination.close()
        destination = None
        rows = copy_media(media, bundle, "/uploads/", "uploads")
        rows.extend(copy_media(static_media, bundle, "/media/", "static-media"))
        rows.sort(key=lambda item: item["url"])
    finally:
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()
        if barrier is not None:
            try:
                if barrier.in_transaction:
                    barrier.rollback()
            finally:
                barrier.close()

    # Normalize and validate only the independent copy after releasing the source barrier.
    copied = sqlite3.connect(bundle / "database.sqlite", timeout=5)
    try:
        mode = copied.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
        if str(mode).lower() != "delete":
            raise RuntimeError("captured database could not be normalized")
        if copied.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("captured database integrity check failed")
    finally:
        copied.close()
    for suffix in ("-wal", "-shm"):
        Path(str(bundle / "database.sqlite") + suffix).unlink(missing_ok=True)
    with (bundle / "media-manifest.json").open("x", encoding="utf-8") as output:
        json.dump({"media": rows}, output, ensure_ascii=False, separators=(",", ":"))
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    signal.alarm(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"staging capture failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
