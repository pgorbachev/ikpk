#!/usr/bin/env python3
"""Verify reviewed proof archive bytes, source revision and renderer fingerprint.

The archive digest and source commit must come from independently reviewed
release/cohort evidence, not from the archive itself. No files are extracted.
"""
import hashlib
import json
import os
import re
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath

HASH = re.compile(r'^[a-f0-9]{64}$')
COMMIT = re.compile(r'^[a-f0-9]{40}$')
FIXED = [
    'astro.config.mjs', 'package-lock.json',
    'scripts/seminar-migration/render-audit.ts', 'scripts/seminar-migration/rehearse.py',
    'tests/seminar-real-migration.migration.test.ts', 'tests/seminar-separate-fields.migration.test.ts',
]


def fail(message):
    raise ValueError('proof artifact: ' + message)


def verify(path, archive_sha, commit_sha, renderer_sha):
    if not HASH.fullmatch(archive_sha or '') or not COMMIT.fullmatch(commit_sha or '') or not HASH.fullmatch(renderer_sha or ''):
        fail('independently reviewed archive, commit and renderer digests are required')
    file = Path(path)
    if not file.is_absolute() or str(file) != os.path.realpath(file):
        fail('archive path must be absolute and not traverse symlinks')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(file, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o022:
            fail('archive must be a regular, non-writable, unlinked file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            digest = hashlib.sha256()
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            if digest.hexdigest() != archive_sha:
                fail('archive SHA-256 mismatch')
            stream.seek(0)
            with tarfile.open(fileobj=stream, mode='r:gz') as archive:
                if archive.pax_headers.get('comment') != commit_sha:
                    fail('git archive commit differs from cohort source SHA')
                files, names, size = {}, set(), 0
                for member in archive:
                    name = member.name.rstrip('/')
                    part = PurePosixPath(name)
                    if not name or part.is_absolute() or '..' in part.parts or str(part) != name or name in names:
                        fail('unsafe or duplicate archive path')
                    names.add(name)
                    # This file is regenerated from the sealed snapshot during build,
                    # and its media inputs are verified by the separate media gate.
                    wanted = (name.startswith('web/src/') and name != 'web/src/lib/media-manifest.json') or name in {'web/' + path for path in FIXED}
                    if not wanted or member.isdir():
                        continue
                    if not member.isfile() or member.size > 20_000_000:
                        fail('renderer input must be a bounded regular file')
                    size += member.size
                    if size > 256_000_000:
                        fail('renderer input exceeds size limit')
                    data = archive.extractfile(member)
                    if data is None:
                        fail('renderer input cannot be read')
                    files[name[4:]] = hashlib.sha256(data.read()).hexdigest()
                if not any(name.startswith('src/') for name in files) or any(name not in files for name in FIXED):
                    fail('renderer source inputs are incomplete')
                digest = hashlib.sha256()
                # JavaScript's `<` compares UTF-16 code units.
                for name in sorted(files, key=lambda s: s.encode('utf-16-be', 'surrogatepass')):
                    digest.update((name + '\0' + files[name] + '\n').encode())
                actual = digest.hexdigest()
                if actual != renderer_sha:
                    fail('renderer fingerprint differs from reviewed plan')
                return {'passed': True, 'sourceCommitSha': commit_sha, 'archiveSha256': archive_sha,
                        'rendererSha256': actual, 'rendererFiles': len(files)}
    finally:
        os.close(fd)


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit('usage: verify-seminar-proof-artifact.py ARCHIVE ARCHIVE_SHA256 COMMIT_SHA RENDERER_SHA256')
    try:
        print(json.dumps(verify(*sys.argv[1:]), sort_keys=True))
    except (OSError, ValueError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
