"""One SSH session owns the host lock and the complete publication transaction.

Stdin: a JSON header line, followed (for stage) by exact-length raw file bodies.
Stdout: JSON replies only. No retained release code is imported or executed.
"""
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import uuid


class Refusal(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def reply(value=None, error=None):
    payload = {"ok": error is None}
    payload["value" if error is None else "error"] = value if error is None else error
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def regular_directory(path):
    require(stat.S_ISDIR(os.lstat(path).st_mode), "symlink or invalid release directory")


def valid_id(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value), "invalid release ID")
    return value


def valid_digest(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value), "invalid tree digest")
    return value


def member_path(root, name):
    require(isinstance(name, str) and name and not name.startswith("/") and "\\" not in name and "\0" not in name,
            "invalid relative release path")
    parts = name.split("/")
    require(all(part not in ("", ".", "..") for part in parts), "release path escapes tree")
    return os.path.join(root, *parts)


def tree_digest(root):
    regular_directory(root)
    files = []

    def walk(directory):
        with os.scandir(directory) as entries:
            for entry in entries:
                require(not entry.is_symlink(), "symlink in retained tree")
                if entry.is_dir(follow_symlinks=False):
                    walk(entry.path)
                else:
                    require(entry.is_file(follow_symlinks=False), "invalid retained tree member")
                    files.append(os.path.relpath(entry.path, root))
    walk(root)
    require(files, "empty release tree")
    digest = hashlib.sha256()
    # JS Array.sort uses UTF-16 code units, including for non-BMP filenames.
    for name in sorted(files, key=lambda item: item.encode("utf-16-be")):
        fd = os.open(member_path(root, name), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            encoded = name.encode("utf-8")
            digest.update(str(len(encoded)).encode() + b":" + encoded + str(size).encode() + b":")
            while True:
                block = source.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
    return digest.hexdigest()


class PublicationSession:
    def __init__(self, root, destination):
        require(os.path.isabs(root) and root != "/", "invalid destination root")
        regular_directory(root)
        self.root = os.path.realpath(root)
        self.destination = destination
        self.releases = os.path.join(self.root, "releases")
        if not os.path.exists(self.releases):
            os.mkdir(self.releases, 0o755)
        regular_directory(self.releases)
        self.pending = os.path.join(self.root, ".publication-pending.json")
        self.current = os.path.join(self.root, "current")
        self.staged = {}
        self.prepared = None
        self.previous_current = None

    def release(self, name):
        return os.path.join(self.releases, valid_id(name))

    def no_pending(self):
        require(not os.path.lexists(self.pending), "unfinished publication: pending operation must be recovered")

    def operation(self, operation, release_id=None):
        require(isinstance(operation, dict), "invalid publication operation")
        for field in ("publicationId", "destinationId", "commit", "snapshotId", "releaseId"):
            require(isinstance(operation.get(field), str) and operation[field].strip(), "missing publication " + field)
        require(operation["destinationId"] == self.destination, "publication destination mismatch")
        valid_id(operation["releaseId"])
        valid_digest(operation.get("treeDigest"))
        require(re.fullmatch(r"[a-f0-9]{40}", operation["commit"]), "invalid publication commit")
        require(release_id is None or operation["releaseId"] == release_id, "operation release mismatch")
        return operation

    def read_pending(self):
        require(os.path.lexists(self.pending), "missing pending operation")
        fd = os.open(self.pending, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "r", encoding="utf-8") as source:
            return self.operation(json.load(source))

    def verify_release(self, operation):
        release = self.release(operation["releaseId"])
        require(os.path.lexists(release), "retained release missing")
        require(tree_digest(release) == operation["treeDigest"], "remote tree digest mismatch")
        return release

    def active_is(self, operation):
        require(os.path.islink(self.current), "current release missing or invalid")
        require(os.path.realpath(self.current) == self.release(operation["releaseId"]), "current release mismatch")

    def stage(self, command):
        self.no_pending()
        target = self.release(command.get("releaseId"))
        require(not os.path.lexists(target), "release collision: retained release already exists")
        expected = valid_digest(command.get("expectedDigest"))
        files = command.get("files")
        require(isinstance(files, list) and files, "empty upload tree")
        names = set()
        for file in files:
            require(isinstance(file, dict), "invalid file metadata")
            member_path(target, file.get("path"))
            require(file["path"] not in names, "duplicate upload path")
            names.add(file["path"])
            require(type(file.get("size")) is int and file["size"] >= 0, "invalid file size")
        temporary = tempfile.mkdtemp(prefix=".stage-", dir=self.releases)
        try:
            directories = {temporary}
            for file in files:
                path = member_path(temporary, file["path"])
                os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
                parent = os.path.dirname(path)
                while parent != self.releases:
                    directories.add(parent)
                    parent = os.path.dirname(parent)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                os.fchmod(fd, 0o644)
                with os.fdopen(fd, "wb") as output:
                    remaining = file["size"]
                    while remaining:
                        block = sys.stdin.buffer.read(min(remaining, 1024 * 1024))
                        require(block, "upload stream ended before declared length")
                        output.write(block)
                        remaining -= len(block)
                    output.flush()
                    os.fsync(output.fileno())
            require(tree_digest(temporary) == expected, "remote upload digest mismatch")
            for directory in sorted(directories, key=len, reverse=True):
                # Completed static files must be traversable by the web server.
                os.chmod(directory, 0o755)
                sync_dir(directory)
            require(not os.path.lexists(target), "release collision")
            os.rename(temporary, target)
            sync_dir(self.releases)
            self.staged[command["releaseId"]] = expected
        finally:
            if os.path.lexists(temporary):
                shutil.rmtree(temporary)

    def prepare(self, command):
        self.no_pending()
        operation = self.operation(command.get("operation"), command.get("releaseId"))
        expected = command.get("expectedDigest") if command.get("rollback") else self.staged.get(operation["releaseId"])
        require(expected == operation["treeDigest"], "release not staged or operation digest mismatch")
        self.verify_release(operation)
        self.previous_current = os.path.realpath(self.current) if os.path.lexists(self.current) else None
        temporary = os.path.join(self.root, ".pending-" + uuid.uuid4().hex)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(operation, output)
                output.flush()
                os.fsync(output.fileno())
            os.rename(temporary, self.pending)
            sync_dir(self.root)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)
        self.prepared = operation

    def activate(self, command):
        require(self.prepared and command.get("publicationId") == self.prepared["publicationId"], "publication was not prepared")
        temporary = os.path.join(self.root, ".current-" + uuid.uuid4().hex)
        try:
            os.symlink("releases/" + self.prepared["releaseId"], temporary)
            os.replace(temporary, self.current)
            sync_dir(self.root)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)
        self.prepared = None

    def cancel(self, command):
        require(self.prepared and command.get("publicationId") == self.prepared["publicationId"], "publication was not prepared")
        require(self.read_pending() == self.prepared, "pending operation changed")
        current = os.path.realpath(self.current) if os.path.lexists(self.current) else None
        require(current == self.previous_current, "current changed during preparation")
        os.unlink(self.pending)
        sync_dir(self.root)
        self.prepared = None

    def recover(self):
        if not os.path.lexists(self.pending):
            return None
        operation = self.read_pending()
        self.active_is(operation)
        self.verify_release(operation)
        return operation

    def finish(self, command):
        operation = self.read_pending()
        require(operation["publicationId"] == command.get("publicationId"), "pending publication identity mismatch")
        self.active_is(operation)
        os.unlink(self.pending)
        sync_dir(self.root)

    def run(self):
        reply({"locked": True})
        while True:
            line = sys.stdin.buffer.readline(8 * 1024 * 1024 + 1)
            if not line:
                return
            require(len(line) <= 8 * 1024 * 1024 and line.endswith(b"\n"), "invalid protocol header")
            command = json.loads(line)
            require(isinstance(command, dict), "invalid protocol command")
            name = command.get("command")
            if name == "close":
                reply()
                return
            if name == "recover":
                reply(self.recover())
            else:
                require(name in ("stage", "prepare", "activate", "cancel", "finish"), "unknown publication command")
                getattr(self, name)(command)
                reply()


def main():
    root, destination = sys.argv[1:]
    # The descriptor remains open for the whole SSH session, including index callbacks.
    regular_directory(root)
    fd = os.open(os.path.join(root, ".publication.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        PublicationSession(root, destination).run()


try:
    main()
except (Refusal, OSError, ValueError, TypeError, KeyError):
    error = sys.exc_info()[1]
    reply(error=str(error) if isinstance(error, Refusal) else "remote publication filesystem or protocol failure")
    sys.exit(1)
