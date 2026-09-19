"""One SSH session owns the host lock and the complete publication transaction.

Stdin: a JSON header line, followed (for stage) by exact-length raw file bodies.
Stdout: JSON replies only. No retained release code is imported or executed.
"""
import base64
import fcntl
import fnmatch
import hashlib
import json
import os
import re
import resource
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid

MAX_RETAINED_FILES = 100000
MAX_RETAINED_BYTES = 16 * 1024 ** 3
RETAINED_CHUNK_BYTES = 1024 ** 2
MAX_MANIFEST_BYTES = 8 * 1024 ** 2 - 128
MAX_NGINX_BYTES = 2 * 1024 ** 2
MAX_REDIRECT_BYTES = 1024 ** 2
MAX_READINESS_BYTES = 64 * 1024
PROBE_TIMEOUT = 10


class Refusal(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def reply(value=None, error=None, active_operation=None):
    payload = {"ok": error is None}
    payload["value" if error is None else "error"] = value if error is None else error
    if active_operation is not None:
        payload["activeOperation"] = active_operation
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    temporary = path + "." + uuid.uuid4().hex
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_dir(os.path.dirname(path))
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as source:
        return json.load(source)


def regular_directory(path):
    require(stat.S_ISDIR(os.lstat(path).st_mode), "symlink or invalid release directory")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def limit_nginx_output():
    # The dump goes to an anonymous file: neither memory nor disk grows without bound.
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_NGINX_BYTES + 1, MAX_NGINX_BYTES + 1))


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
        if os.path.lexists(self.releases):
            regular_directory(self.releases)
        self.pending = os.path.join(self.root, ".publication-pending.json")
        self.preparation = os.path.join(self.root, ".publication-preparation.json")
        self.current = os.path.join(self.root, "current")
        self.staged = {}
        self.prepared = None
        self.previous_current = None
        self.retained = {}
        self.active_operation = None

    def shared_directory(self):
        return os.open(os.path.join(self.root, "shared"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def read_redirects(self, directory_fd):
        fd = os.open("nginx-redirects.conf", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            require(stat.S_ISREG(info.st_mode), "redirect fragment is not a regular file")
            require(info.st_size <= MAX_REDIRECT_BYTES, "redirect fragment exceeds limit")
            data = source.read(MAX_REDIRECT_BYTES + 1)
            require(len(data) <= MAX_REDIRECT_BYTES, "redirect fragment exceeds limit")
            return data

    def inspect_serving(self):
        shared_fd = self.shared_directory()
        try:
            redirects = self.read_redirects(shared_fd)
        finally:
            os.close(shared_fd)
        with tempfile.TemporaryFile() as output:
            try:
                result = subprocess.run(["/usr/bin/sudo", "-n", "/usr/sbin/nginx", "-T"],
                                        stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                                        shell=False, timeout=PROBE_TIMEOUT, preexec_fn=limit_nginx_output)
            except (OSError, subprocess.SubprocessError):
                raise Refusal("nginx inspection unavailable")
            require(result.returncode == 0, "nginx inspection failed")
            output.seek(0)
            nginx_dump = output.read(MAX_NGINX_BYTES + 1)
        require(nginx_dump and len(nginx_dump) <= MAX_NGINX_BYTES, "empty or oversized nginx inspection")
        return {"nginxDump": nginx_dump.decode("utf-8"), "redirects": redirects.decode("utf-8")}

    def verify_redirect_binding(self, dump):
        # nginx -T emits the loaded files. Parse directives with comments/quotes and
        # block scope: a matching basename or an include in another vhost is not proof.
        lexer = shlex.shlex(dump, posix=True, punctuation_chars="{};")
        lexer.whitespace_split = True
        stack = [{"header": [], "directives": []}]
        blocks = []
        directive = []
        for token in lexer:
            tokens = list(token) if token and all(char in "{};" for char in token) else [token]
            for part in tokens:
                if part == "{":
                    require(directive, "invalid nginx block")
                    block = {"header": directive, "directives": []}
                    stack.append(block)
                    blocks.append(block)
                    directive = []
                elif part == "}":
                    require(len(stack) > 1 and not directive, "invalid nginx block boundary")
                    stack.pop()
                elif part == ";":
                    require(directive, "invalid nginx directive")
                    stack[-1]["directives"].append(directive)
                    directive = []
                else:
                    directive.append(part)
        require(len(stack) == 1 and not directive, "incomplete nginx configuration")
        target_root = ["root", self.current]
        target_include = ["include", os.path.join(self.root, "shared", "nginx-redirects.conf")]
        servers = [block for block in blocks if block["header"] == ["server"]]
        matching = [block for block in servers if target_root in block["directives"]]
        require(matching, "nginx destination root/current binding missing")
        require(all(block["directives"].count(target_include) == 1 for block in matching),
                "nginx redirect include binding missing for destination")
        # Dumped snippets are separate top-level text, not expanded into callers.
        # Count every potential consumer, including wrapper and wildcard includes.
        files = re.findall(r"^# configuration file (.+):$", dump, re.MULTILINE)
        prefix = os.path.dirname(files[0]) if files else "/etc/nginx"
        fragment = target_include[1]
        aliases = {fragment, os.path.realpath(fragment)}
        aliases.update(path for path in files if os.path.realpath(path) == os.path.realpath(fragment))
        consumers = []
        for block in [stack[0], *blocks]:
            for item in block["directives"]:
                if len(item) != 2 or item[0] != "include":
                    continue
                pattern = os.path.normpath(item[1] if os.path.isabs(item[1]) else os.path.join(prefix, item[1]))
                if any(fnmatch.fnmatchcase(path, candidate) for path in aliases
                       for candidate in (pattern, os.path.realpath(pattern))):
                    consumers.append((block, item))
        require(len(consumers) == len(matching) and
                all(block in matching and item == target_include for block, item in consumers),
                "nginx redirect include shared or ambiguous across destinations")

    def nginx_command(self, reload=False):
        argv = (["/usr/bin/sudo", "-n", "/bin/systemctl", "reload", "nginx"] if reload else
                ["/usr/bin/sudo", "-n", "/usr/sbin/nginx", "-t"])
        label = "nginx reload" if reload else "nginx configuration validation"
        try:
            result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, shell=False, timeout=PROBE_TIMEOUT)
        except (OSError, subprocess.SubprocessError):
            raise Refusal(label + " unavailable")
        require(result.returncode == 0, label + " failed")

    def redirect_evidence(self, release):
        shared_fd = self.shared_directory()
        try:
            old = self.read_redirects(shared_fd)
        finally:
            os.close(shared_fd)
        deploy_fd = os.open(os.path.join(release, "deploy"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            new = self.read_redirects(deploy_fd)
        finally:
            os.close(deploy_fd)
        observation = self.inspect_serving()
        self.verify_redirect_binding(observation["nginxDump"])
        require(observation["redirects"].encode("utf-8") == old, "redirect config changed during inspection")
        return {name: {"bytes": base64.b64encode(data).decode("ascii"),
                       "digest": hashlib.sha256(data).hexdigest()} for name, data in (("old", old), ("new", new))}

    def replace_redirects(self, preparation, desired):
        evidence = preparation.get("redirects")
        if evidence is None:
            return
        require(isinstance(evidence, dict) and set(evidence) == {"old", "new"}, "invalid redirect evidence")
        values = {}
        for name, item in evidence.items():
            require(isinstance(item, dict) and isinstance(item.get("bytes"), str)
                    and len(item["bytes"]) <= 4 * ((MAX_REDIRECT_BYTES + 2) // 3), "invalid redirect evidence")
            data = base64.b64decode(item["bytes"], validate=True)
            require(len(data) <= MAX_REDIRECT_BYTES and hashlib.sha256(data).hexdigest() == item.get("digest"),
                    "redirect evidence digest mismatch")
            values[name] = data
        directory_fd = self.shared_directory()
        temporary = ".redirects-" + uuid.uuid4().hex
        try:
            current = self.read_redirects(directory_fd)
            require(current in values.values(), "unexpected redirect configuration drift")
            if current == values[desired]:
                return
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory_fd)
            with os.fdopen(fd, "wb") as output:
                os.fchmod(output.fileno(), 0o644)
                output.write(values[desired])
                output.flush()
                os.fsync(output.fileno())
            require(self.read_redirects(directory_fd) == current, "redirect configuration changed before replacement")
            os.replace(temporary, "nginx-redirects.conf", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            os.fsync(directory_fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
            os.close(directory_fd)

    def payment_readiness(self):
        # Ignore proxy environment and refuse redirects: this is evidence from this VPS.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request("http://127.0.0.1:8787/readyz", method="GET")
        try:
            response = opener.open(request, timeout=PROBE_TIMEOUT)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, urllib.error.URLError):
            raise Refusal("payment readiness unavailable")
        with response:
            body = response.read(MAX_READINESS_BYTES + 1)
            require(len(body) <= MAX_READINESS_BYTES, "payment readiness exceeds limit")
            return {"status": response.status, "contentType": response.headers.get("Content-Type", ""),
                    "body": json.loads(body.decode("utf-8"))}

    def open_retained(self, release_id):
        valid_id(release_id)
        releases_fd = os.open(self.releases, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                info = os.stat(release_id, dir_fd=releases_fd, follow_symlinks=False)
            except FileNotFoundError:
                raise Refusal("retained release missing: target not retained")
            require(stat.S_ISDIR(info.st_mode), "symlink or invalid retained release directory")
            return os.open(release_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=releases_fd)
        finally:
            os.close(releases_fd)

    def read_retained(self, command):
        self.no_pending()
        release_id = valid_id(command.get("releaseId"))
        root_fd = self.open_retained(release_id)
        files = []
        total = 0
        manifest_bytes = 0

        def walk(directory_fd, prefix=""):
            nonlocal total, manifest_bytes
            with os.scandir(directory_fd) as entries:
                for entry in entries:
                    name = prefix + entry.name
                    member_path("", name)
                    require(len(name.split("/")) <= 128 and len(name.encode("utf-8")) <= 4096,
                            "retained path exceeds limit")
                    info = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                    require(not stat.S_ISLNK(info.st_mode), "symlink in retained tree")
                    if stat.S_ISDIR(info.st_mode):
                        child_fd = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                        try:
                            walk(child_fd, name + "/")
                        finally:
                            os.close(child_fd)
                    else:
                        require(stat.S_ISREG(info.st_mode), "retained tree member is not a regular file")
                        file = {"path": name, "size": info.st_size}
                        files.append(file)
                        total += info.st_size
                        manifest_bytes += len(json.dumps(file)) + 2
                        require(len(files) <= MAX_RETAINED_FILES and total <= MAX_RETAINED_BYTES
                                and manifest_bytes <= MAX_MANIFEST_BYTES, "retained tree exceeds transfer limit")
        try:
            walk(root_fd)
        finally:
            os.close(root_fd)
        require(files, "empty retained release tree")
        current = self.current_identity()
        current_id = None
        if current is not None:
            current_path = os.path.realpath(self.current)
            current_id = valid_id(os.path.basename(current_path))
            require(current_path == self.release(current_id), "invalid current release path")
            regular_directory(current_path)
        manifest = {"releaseId": release_id, "destinationId": self.destination,
                    "currentReleaseId": current_id, "files": files}
        require(len(json.dumps(manifest)) <= MAX_MANIFEST_BYTES, "retained manifest exceeds limit")
        self.retained[release_id] = {file["path"]: file["size"] for file in files}
        return manifest

    def read_retained_file(self, command):
        self.no_pending()
        release_id = valid_id(command.get("releaseId"))
        name = command.get("path")
        member_path("", name)
        require(release_id in self.retained and name in self.retained[release_id], "retained file not in manifest")
        size = self.retained[release_id][name]
        offset = command.get("offset")
        require(type(offset) is int and 0 <= offset <= size, "invalid retained file offset")
        directory_fd = self.open_retained(release_id)
        try:
            parts = name.split("/")
            for part in parts[:-1]:
                child_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                os.close(directory_fd)
                directory_fd = child_fd
            # NONBLOCK ensures a concurrently substituted FIFO cannot hang the lock.
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                require(stat.S_ISREG(info.st_mode), "retained tree member is not a regular file")
                require(info.st_size == size, "retained file changed during transfer")
                source.seek(offset)
                data = source.read(min(RETAINED_CHUNK_BYTES, size - offset))
                require(len(data) == min(RETAINED_CHUNK_BYTES, size - offset), "retained file changed during transfer")
            return {"data": base64.b64encode(data).decode("ascii"), "done": offset + len(data) == size}
        finally:
            os.close(directory_fd)

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
        return self.operation(read_json(self.pending))

    def current_identity(self):
        if not os.path.lexists(self.current):
            return None
        info = os.lstat(self.current)
        require(stat.S_ISLNK(info.st_mode), "current release missing or invalid")
        return {"target": os.readlink(self.current), "device": info.st_dev,
                "inode": info.st_ino, "ctimeNs": info.st_ctime_ns}

    def read_preparation(self, operation):
        if not os.path.lexists(self.preparation):
            return None
        preparation = read_json(self.preparation)
        require(isinstance(preparation, dict) and preparation.get("operation") == operation,
                "preparation operation mismatch")
        require(preparation.get("phase") in ("prepared", "committing") and "previousCurrent" in preparation,
                "invalid preparation evidence")
        return preparation

    def prepared_operation(self, publication_id):
        operation = self.read_pending()
        require(operation["publicationId"] == publication_id, "pending publication identity mismatch")
        preparation = self.read_preparation(operation)
        require(preparation and preparation["phase"] == "prepared", "publication may already have switched")
        require(self.current_identity() == preparation["previousCurrent"], "current changed during preparation")
        self.verify_release(operation)
        return operation

    def clear_pending(self):
        # Removing metadata first is safe: remaining pending can still recover an active release.
        if os.path.lexists(self.preparation):
            os.unlink(self.preparation)
            sync_dir(self.root)
        os.unlink(self.pending)
        sync_dir(self.root)

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
        if not os.path.lexists(self.releases):
            os.mkdir(self.releases, 0o755)
        regular_directory(self.releases)
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
        release = self.verify_release(operation)
        redirects = None
        if "redirectsPath" in command:
            require(command["redirectsPath"] == "deploy/nginx-redirects.conf", "invalid redirect artifact path")
            redirects = self.redirect_evidence(release)
        self.previous_current = self.current_identity()
        # Until both writes are durable, a crash with old current remains fail-closed.
        write_json(self.pending, operation)
        preparation = {"operation": operation, "previousCurrent": self.previous_current, "phase": "prepared"}
        if redirects is not None:
            preparation["redirects"] = redirects
        write_json(self.preparation, preparation)
        self.prepared = operation
        if redirects is not None:
            try:
                self.replace_redirects(preparation, "new")
                self.nginx_command()
            except (Refusal, OSError, ValueError):
                # Do not discard either journal if restoration itself refuses/fails.
                self.replace_redirects(preparation, "old")
                self.clear_pending()
                self.prepared = None
                raise

    def activate(self, command):
        require(self.prepared and command.get("operation") == self.prepared, "publication operation was not prepared")
        require(self.read_pending() == self.prepared, "pending operation changed")
        preparation = self.read_preparation(self.prepared)
        require(preparation and preparation["phase"] == "prepared", "missing preparation evidence")
        require(self.current_identity() == preparation["previousCurrent"], "current changed during preparation")
        if preparation.get("redirects") is not None:
            directory_fd = self.shared_directory()
            try:
                require(self.read_redirects(directory_fd) == base64.b64decode(preparation["redirects"]["new"]["bytes"], validate=True),
                        "redirect configuration changed after validation")
            finally:
                os.close(directory_fd)
        preparation["phase"] = "committing"
        # This durable intent makes an old current ambiguous after activation starts.
        write_json(self.preparation, preparation)
        temporary = os.path.join(self.root, ".current-" + uuid.uuid4().hex)
        try:
            os.symlink("releases/" + self.prepared["releaseId"], temporary)
            os.replace(temporary, self.current)
            self.active_operation = self.prepared
            sync_dir(self.root)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)
        self.prepared = None
        if preparation.get("redirects") is not None:
            self.nginx_command(reload=True)

    def cancel(self, command):
        require(self.prepared and command.get("operation") == self.prepared, "publication operation was not prepared")
        require(self.prepared_operation(self.prepared["publicationId"]) == self.prepared, "pending operation changed")
        self.replace_redirects(self.read_preparation(self.prepared), "old")
        self.clear_pending()
        self.prepared = None

    def recover(self):
        if not os.path.lexists(self.pending):
            return None
        operation = self.read_pending()
        preparation = self.read_preparation(operation)
        if preparation and preparation["phase"] == "prepared":
            self.prepared_operation(operation["publicationId"])
            return {"operation": operation, "prepared": True}
        self.active_is(operation)
        self.verify_release(operation)
        return {"operation": operation, "prepared": False}

    def cancel_recovery(self, command):
        operation = self.operation(command.get("operation"))
        require(self.prepared_operation(operation["publicationId"]) == operation, "pending operation changed")
        self.replace_redirects(self.read_preparation(operation), "old")
        self.clear_pending()

    def complete_recovery(self, command):
        operation = self.read_pending()
        require(operation == command.get("operation"), "pending publication operation mismatch")
        preparation = self.read_preparation(operation)
        require(not preparation or preparation["phase"] == "committing", "publication was not committed")
        self.active_is(operation)
        self.active_operation = operation
        self.verify_release(operation)
        if preparation and preparation.get("redirects") is not None:
            self.verify_redirect_binding(self.inspect_serving()["nginxDump"])
            self.replace_redirects(preparation, "new")
            self.nginx_command()
            self.nginx_command(reload=True)

    def finish(self, command):
        operation = self.read_pending()
        require(operation == command.get("operation"), "pending publication operation mismatch")
        self.read_preparation(operation)
        self.active_is(operation)
        self.clear_pending()

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
            elif name in ("inspect-serving", "payment-readiness"):
                require(set(command) == {"command"}, "unexpected probe parameters")
                reply(getattr(self, name.replace("-", "_"))())
            elif name in ("read-retained", "read-retained-file"):
                reply(getattr(self, name.replace("-", "_"))(command))
            else:
                require(name in ("stage", "prepare", "activate", "cancel", "cancel-recovery", "complete-recovery", "finish"), "unknown publication command")
                getattr(self, name.replace("-", "_"))(command)
                reply()


def main():
    root, destination = sys.argv[1:]
    # The descriptor remains open for the whole SSH session, including index callbacks.
    regular_directory(root)
    fd = os.open(os.path.join(root, ".publication.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        session = PublicationSession(root, destination)
        try:
            session.run()
        except (Refusal, OSError, ValueError, TypeError, KeyError):
            error = sys.exc_info()[1]
            reply(error=str(error) if isinstance(error, Refusal) else "remote publication filesystem or protocol failure",
                  active_operation=session.active_operation)
            sys.exit(1)


try:
    main()
except (Refusal, OSError, ValueError, TypeError, KeyError):
    error = sys.exc_info()[1]
    reply(error=str(error) if isinstance(error, Refusal) else "remote publication filesystem or protocol failure")
    sys.exit(1)
