#!/usr/bin/env python3
"""Verify and privately unpack a sealed pause export; this does not approve its contents."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import tempfile

HASH = re.compile(r'[a-f0-9]{64}\Z')
OP = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')
MAX_BYTES = 1024 * 1024 * 1024

def digest(data):
    return hashlib.sha256(data).hexdigest()

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result

def read_json(data):
    return json.loads(data, object_pairs_hook=unique_object)

def extract(archive_path, expected_sha, operation, source_sha, parent, limit=MAX_BYTES):
    if not HASH.fullmatch(expected_sha) or not OP.fullmatch(operation) or not SHA.fullmatch(source_sha):
        raise ValueError('invalid expected archive or operation identity')
    if not isinstance(limit, int) or not 0 < limit <= 2 * MAX_BYTES:
        raise ValueError('invalid size limit')
    parent = Path(parent)
    if not parent.is_absolute() or str(parent) != os.path.realpath(parent):
        raise ValueError('output parent must be canonical')
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('output parent must be private and owned')
    archive_path = Path(archive_path)
    if not archive_path.is_absolute() or str(archive_path) != os.path.realpath(archive_path):
        raise ValueError('archive path must be canonical')
    fd = os.open(archive_path, os.O_RDONLY | getattr(os,'O_NOFOLLOW',0) | getattr(os,'O_NONBLOCK',0))
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError('archive is unsafe or exceeds size limit')
        with os.fdopen(fd,'rb',closefd=False) as source:
            payload = source.read(limit + 1)
        after = os.fstat(fd)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or len(payload)>limit:
            raise ValueError('archive changed during read')
    finally:
        os.close(fd)
    if digest(payload) != expected_sha:
        raise ValueError('independent archive SHA-256 mismatch')
    files = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as tar:
            total = 0
            for member in tar:
                name = member.name
                if (member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or name in files or name.startswith('/') or '\\' in name
                        or any(part in ('','.','..') for part in name.split('/'))):
                    raise ValueError('archive has an unsafe or duplicate member')
                total += member.size
                if member.size < 0 or total > limit or len(files) >= 128:
                    raise ValueError('archive content exceeds size limit')
                stream = tar.extractfile(member)
                if stream is None:
                    raise ValueError('archive member cannot be read')
                data = stream.read(member.size + 1)
                if len(data) != member.size:
                    raise ValueError('archive member truncated')
                files[name] = data
    except tarfile.TarError as error:
        raise ValueError('invalid tar archive') from error
    manifest = read_json(files.get('manifest.json',b''))
    if not isinstance(manifest,dict) or manifest.get('operationId') != operation or manifest.get('sourceSha') != source_sha or not re.fullmatch(r'[a-f0-9]{32}',str(manifest.get('attempt',''))):
        raise ValueError('manifest operation identity mismatch')
    declared = manifest.get('files')
    if not isinstance(declared,dict) or set(files) != set(declared) | {'manifest.json','result.json'} or not HASH.fullmatch(str(manifest.get('resultSha256',''))):
        raise ValueError('archive member set differs from manifest')
    if digest(files['result.json']) != manifest['resultSha256'] or not isinstance(read_json(files['result.json']),dict):
        raise ValueError('pause result digest mismatch')
    for name, expected in declared.items():
        if not isinstance(expected,str) or not HASH.fullmatch(expected) or digest(files[name]) != expected:
            raise ValueError('archive member digest mismatch')
    receipt = read_json(files.get('receipt.json',b''))
    if not isinstance(receipt,dict) or receipt.get('operationId') != operation or receipt.get('sourceCommitSha') != source_sha or not isinstance(receipt.get('stageSnapshots'),dict):
        raise ValueError('receipt identity mismatch')
    source_path = receipt.get('sourceDbPath')
    if not isinstance(source_path,str) or not source_path.startswith('/') or os.path.normpath(source_path)!=source_path:
        raise ValueError('invalid source database path')
    source_name = os.path.basename(source_path)
    if source_name in ('','.','..'):
        raise ValueError('invalid source database name')
    allowed = {'candidate.db','receipt.json','source/'+source_name}
    for suffix in ('-wal','-shm'):
        name = 'source/'+source_name+suffix
        if name in declared:
            allowed.add(name)
    for stage in receipt['stageSnapshots']:
        if not isinstance(stage,str) or not OP.fullmatch(stage):
            raise ValueError('invalid stage identity')
        allowed.add(f'stage-snapshots/{operation}.{stage}.db')
    if set(declared) != allowed:
        raise ValueError('archive contains unexpected or missing files')
    destination = Path(tempfile.mkdtemp(prefix='ikpk-pause-reviewed-',dir=parent))
    try:
        os.chmod(destination,0o700)
        for name, data in files.items():
            target = destination / name
            target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            fd = os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
            with os.fdopen(fd,'wb') as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
        return destination
    except BaseException:
        shutil.rmtree(destination)
        raise

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',required=True)
    parser.add_argument('--archive-sha256',required=True,help='independently recorded archive digest')
    parser.add_argument('--operation-id',required=True)
    parser.add_argument('--source-sha',required=True)
    parser.add_argument('--output-parent',required=True)
    parser.add_argument('--max-bytes',type=int,default=MAX_BYTES)
    args=parser.parse_args()
    try:
        result=extract(args.archive,args.archive_sha256,args.operation_id,args.source_sha,args.output_parent,args.max_bytes)
        print(json.dumps({'directory':str(result),'status':'VERIFIED_BYTES_REQUIRE_INDEPENDENT_REVIEW'}))
    except (ValueError,OSError,KeyError,TypeError,EOFError,OverflowError,tarfile.TarError) as error:
        print(f'extract migration pause: {error}',file=sys.stderr)
        return 2
    return 0

if __name__=='__main__':
    sys.exit(main())
