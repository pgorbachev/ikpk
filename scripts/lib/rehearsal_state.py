"""Small durable journal and lock shared by the CMS and static commands."""

from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator, Optional


class RehearsalRefusal(RuntimeError):
    pass


OPERATION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
SOURCE_SHA = re.compile(r"[a-f0-9]{40}\Z")


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_json(path: Path, value: dict) -> None:
    """Write JSON by fsync + same-directory atomic replace + directory fsync."""
    path = Path(path)
    if not path.parent.is_dir() or path.parent.is_symlink():
        raise RehearsalRefusal("state directory must be an existing real directory")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            fd = -1
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_dir(path.parent)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class RehearsalState:
    """One append-only operation journal plus durable filesystem fence state."""

    def __init__(self, state_dir: Path):
        self.root = Path(state_dir)
        if not self.root.is_absolute() or self.root == Path("/"):
            raise RehearsalRefusal("state root must be an absolute non-root path")
        if not self.root.is_dir() or self.root.is_symlink():
            raise RehearsalRefusal("state root must be an existing real directory")
        self.lock_path = self.root / ".operation.lock"
        self.marker_path = self.root / "maintenance.json"
        self.journal_path = self.root / "journal.jsonl"
        self._lock_local = threading.local()

    @contextmanager
    def lock(self, timeout: float = 30.0) -> Iterator[None]:
        depth = getattr(self._lock_local, "depth", 0)
        if depth:
            self._lock_local.depth = depth + 1
            try:
                yield
            finally:
                self._lock_local.depth -= 1
            return
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.lock_path, flags, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise RehearsalRefusal("operation lock must be a regular, unlinked file")
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RehearsalRefusal("another host operation holds the lock")
                    time.sleep(0.05)
            self._lock_local.depth = 1
            yield
        finally:
            self._lock_local.depth = 0
            os.close(fd)

    def _read_marker(self) -> Optional[dict]:
        try:
            info = self.marker_path.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RehearsalRefusal("maintenance marker must be a regular, unlinked file")
        try:
            value = json.loads(self.marker_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise RehearsalRefusal("maintenance marker is unreadable") from error
        if value.get("version") != 1:
            raise RehearsalRefusal("unsupported maintenance marker version")
        return value

    @staticmethod
    def _validate_identity(operation_id: str, source_sha: Optional[str] = None) -> None:
        if not OPERATION_ID.fullmatch(operation_id):
            raise RehearsalRefusal("invalid operation ID")
        if source_sha is not None and not SOURCE_SHA.fullmatch(source_sha):
            raise RehearsalRefusal("source SHA must be a full lowercase commit ID")

    def _journal(self) -> list[dict]:
        self._repair_incomplete_tail()
        try:
            raw = self.journal_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        if self.journal_path.is_symlink():
            raise RehearsalRefusal("journal must not be a symlink")
        rows = []
        try:
            for line in raw.splitlines():
                value = json.loads(line)
                if not isinstance(value, dict) or value.get("version") != 1:
                    raise ValueError("invalid journal record")
                rows.append(value)
        except ValueError as error:
            raise RehearsalRefusal("append-only operation journal is malformed") from error
        return rows

    def _repair_incomplete_tail(self) -> None:
        try:
            info = self.journal_path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RehearsalRefusal("journal must be a regular unlinked file")
        fd = os.open(self.journal_path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        try:
            current = os.fstat(fd)
            if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                raise RehearsalRefusal("journal must be a regular unlinked file")
            os.lseek(fd, 0, os.SEEK_SET)
            chunks = []
            while True:
                block = os.read(fd, 65536)
                if not block:
                    break
                chunks.append(block)
            raw = b"".join(chunks)
            if not raw or raw.endswith(b"\n"):
                return
            split = raw.rfind(b"\n")
            complete_end = split + 1
            tail = raw[complete_end:]
            try:
                candidate = json.loads(tail)
                valid_record = isinstance(candidate, dict) and candidate.get("version") == 1
            except (UnicodeDecodeError, ValueError):
                valid_record = False
            if valid_record:
                os.lseek(fd, 0, os.SEEK_END)
                view = memoryview(b"\n")
                while view:
                    written = os.write(fd, view)
                    if written <= 0:
                        raise RehearsalRefusal("journal tail repair made no forward progress")
                    view = view[written:]
            else:
                os.ftruncate(fd, complete_end)
            os.fsync(fd)
            _fsync_dir(self.root)
        finally:
            os.close(fd)

    def _append(self, value: dict) -> None:
        if self.journal_path.is_symlink():
            raise RehearsalRefusal("journal must not be a symlink")
        fd = os.open(self.journal_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise RehearsalRefusal("journal must be a regular unlinked file")
            payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise RehearsalRefusal("journal append made no forward progress")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        _fsync_dir(self.root)

    def _operation_rows(self, operation_id: str) -> list[dict]:
        return [row for row in self._journal() if row.get("operationId") == operation_id]

    @staticmethod
    def _unfinished_operation_ids(history: list[dict]) -> set[str]:
        starts = {row["operationId"] for row in history
                  if row.get("record") == "start" and isinstance(row.get("operationId"), str)}
        terminal = {row["operationId"] for row in history
                    if row.get("record") in ("committed", "recovered")
                    and isinstance(row.get("operationId"), str)}
        static_starts = {row["operationId"] for row in history
                         if row.get("record") == "static-main-start" and row.get("operationKind") == "static-main"
                         and isinstance(row.get("operationId"), str)}
        static_terminal = {row["operationId"] for row in history
                           if row.get("operationKind") == "static-main"
                           and row.get("record") in ("static-main-committed", "static-main-recovered",
                                                     "static-main-rolled-back")
                           and isinstance(row.get("operationId"), str)}
        static_rollback_intents = {row["operationId"] for row in history
                                   if row.get("operationKind") == "static-main"
                                   and row.get("record") == "static-main-rollback-intent"
                                   and isinstance(row.get("operationId"), str)}
        static_rollback_completed = {row["operationId"] for row in history
                                     if row.get("operationKind") == "static-main"
                                     and row.get("record") == "static-main-rollback-completed"
                                     and isinstance(row.get("operationId"), str)}
        return ((starts - terminal) | (static_starts - static_terminal)
                | (static_rollback_intents - static_rollback_completed))

    def assert_new_operation_allowed(self, operation_id: str, source_sha: str) -> None:
        """Refuse prefence preparation when durable state already belongs to an operation."""
        self._validate_identity(operation_id, source_sha)
        with self.lock():
            if self._read_marker() is not None:
                raise RehearsalRefusal("maintenance marker already belongs to an operation")
            history = self._journal()
            if self._unfinished_operation_ids(history):
                raise RehearsalRefusal("append-only journal has an unfinished operation requiring recovery")
            if any(row.get("operationId") == operation_id for row in history):
                raise RehearsalRefusal("operation ID already exists in append-only journal")

    def _is_committed(self, operation_id: str) -> bool:
        # The journal is authoritative if the process dies after journal fsync but
        # before maintenance.json is replaced.
        return any(row.get("record") == "committed" for row in self._operation_rows(operation_id))

    def _is_recovered(self, operation_id: str) -> bool:
        return any(row.get("record") == "recovered" for row in self._operation_rows(operation_id))

    def _is_terminal(self, operation_id: str) -> bool:
        return self._is_committed(operation_id) or self._is_recovered(operation_id)

    def _require_mutable(self, operation_id: str) -> None:
        if self._is_terminal(operation_id):
            raise RehearsalRefusal("terminal operation cannot accept further mutations")

    def assert_terminal_reopen_allowed(self, operation_id: str) -> None:
        with self.lock():
            if not self._is_terminal(operation_id):
                raise RehearsalRefusal("only a terminal operation may reopen writers")
            if self._read_marker() is not None:
                self._owned(operation_id)
                return
            history = self._journal()
            if self._unfinished_operation_ids(history):
                raise RehearsalRefusal("another unfinished operation owns recovery")

    def begin(self, operation_id: str, source_sha: str, old_pair: dict) -> dict:
        self._validate_identity(operation_id, source_sha)
        if not isinstance(old_pair, dict) or not old_pair:
            raise RehearsalRefusal("start record must identify the old CMS/static pair")
        with self.lock():
            current = self._read_marker()
            if current is not None:
                if current.get("operationId") != operation_id:
                    raise RehearsalRefusal("unfinished operation owns the maintenance marker")
                self._require_mutable(operation_id)
                if current.get("sourceSha") != source_sha:
                    raise RehearsalRefusal("operation ID is already bound to another source SHA")
                if not any(row.get("record") == "start" and row.get("sourceSha") == source_sha
                           for row in self._operation_rows(operation_id)):
                    raise RehearsalRefusal("maintenance marker has no matching journal start record")
                return current
            history = self._journal()
            unfinished = self._unfinished_operation_ids(history)
            if operation_id in unfinished:
                start = next(row for row in history if row.get("record") == "start" and row.get("operationId") == operation_id)
                if start.get("sourceSha") != source_sha or start.get("oldPair") != old_pair:
                    raise RehearsalRefusal("interrupted operation identity does not match its journal start")
                current = {
                    "version": 1,
                    "operationId": operation_id,
                    "sourceSha": source_sha,
                    "fence": "acquiring",
                    "newPairAccepted": any(row.get("record") == "new-bundle" for row in self._operation_rows(operation_id)),
                    "committed": False,
                }
                durable_json(self.marker_path, current)
                return current
            if any(row.get("operationId") == operation_id for row in history):
                raise RehearsalRefusal("operation ID already exists in append-only journal")
            if unfinished:
                raise RehearsalRefusal("append-only journal has an unfinished operation requiring recovery")
            current = {
                "version": 1,
                "operationId": operation_id,
                "sourceSha": source_sha,
                "fence": "acquiring",
                "newPairAccepted": False,
                "committed": False,
            }
            self._append({"version": 1, "record": "start", "operationId": operation_id,
                          "sourceSha": source_sha, "oldPair": old_pair})
            durable_json(self.marker_path, current)
            return current

    def _owned(self, operation_id: str, source_sha: Optional[str] = None) -> dict:
        current = self._read_marker()
        if current is None or current.get("operationId") != operation_id:
            raise RehearsalRefusal("operation does not own the maintenance marker")
        if source_sha is not None and current.get("sourceSha") != source_sha:
            raise RehearsalRefusal("operation source SHA changed")
        if not any(row.get("record") == "start" and row.get("sourceSha") == current.get("sourceSha")
                   for row in self._operation_rows(operation_id)):
            raise RehearsalRefusal("maintenance marker has no matching journal start record")
        return current

    def confirm_fence(self, operation_id: str, verify_closed: Callable[[], bool]) -> dict:
        with self.lock():
            current = self._owned(operation_id)
            self._require_mutable(operation_id)
            if current["committed"]:
                raise RehearsalRefusal("committed operation cannot re-enter maintenance")
            if not verify_closed():
                raise RehearsalRefusal("CMS writer fence is not confirmed closed")
            current["fence"] = "closed"
            durable_json(self.marker_path, current)
            return current

    def mark_cms_activated(self, operation_id: str) -> dict:
        with self.lock():
            current = self._owned(operation_id)
            self._require_mutable(operation_id)
            if current["fence"] != "closed":
                raise RehearsalRefusal("CMS activation requires a verified writer fence")
            current["cmsActivated"] = True
            durable_json(self.marker_path, current)
            return current

    def accept_new_pair(self, operation_id: str, new_pair: dict) -> dict:
        with self.lock():
            current = self._owned(operation_id)
            self._require_mutable(operation_id)
            if current["committed"]:
                raise RehearsalRefusal("new pair is closed after global commit")
            if current["fence"] != "closed" or not current.get("cmsActivated"):
                raise RehearsalRefusal("new pair requires accepted CMS and a verified writer fence")
            if not isinstance(new_pair, dict) or not new_pair:
                raise RehearsalRefusal("new pair record must contain CMS and static digests")
            if current.get("newPairAccepted"):
                raise RehearsalRefusal("new pair was already recorded for this operation")
            self._append({"version": 1, "record": "new-bundle", "operationId": operation_id,
                          "sourceSha": current["sourceSha"], "newPair": new_pair})
            current["newPairAccepted"] = True
            durable_json(self.marker_path, current)
            return current

    def phase(self, operation_id: str) -> dict:
        with self.lock():
            if self._read_marker() is None:
                rows = self._operation_rows(operation_id)
                if any(row.get("record") == "committed" for row in rows):
                    return {"operationId": operation_id, "committed": True, "phase": "committed"}
                if any(row.get("record") == "recovered" for row in rows):
                    return {"operationId": operation_id, "committed": False, "phase": "recovered"}
                raise RehearsalRefusal("operation has no maintenance marker or terminal journal record")
            current = self._owned(operation_id)
            if self._is_committed(operation_id):
                return {**current, "phase": "committed"}
            if self._is_recovered(operation_id):
                return {**current, "phase": "recovered"}
            current["phase"] = ("new-pair-accepted" if current.get("newPairAccepted") else
                                "cms-activated" if current.get("cmsActivated") else
                                "fenced" if current.get("fence") == "closed" else "acquiring")
            return current

    def commit(self, operation_id: str) -> dict:
        with self.lock():
            current = self._owned(operation_id)
            self._require_mutable(operation_id)
            if current["fence"] != "closed" or not current["cmsActivated"] or not current["newPairAccepted"]:
                raise RehearsalRefusal("global commit requires accepted CMS and static pair")
            self._append({"version": 1, "record": "committed", "operationId": operation_id,
                          "sourceSha": current["sourceSha"]})
            current["committed"] = True
            durable_json(self.marker_path, current)
            return current

    def require_restore_allowed(self, operation_id: str) -> dict:
        with self.lock():
            if self._is_committed(operation_id) or self._is_recovered(operation_id):
                raise RehearsalRefusal("DB restore is forbidden after a terminal journal record")
            current = self._owned(operation_id)
            if current["fence"] != "closed":
                raise RehearsalRefusal("recovery must close and verify the writer fence first")
            return current

    def finalize(self, operation_id: str, verify_reopened: Callable[[], bool]) -> dict:
        with self.lock():
            if self._read_marker() is None:
                self.assert_terminal_reopen_allowed(operation_id)
                if verify_reopened():
                    return {"operationId": operation_id, "committed": self._is_committed(operation_id),
                            "phase": "committed" if self._is_committed(operation_id) else "recovered"}
                raise RehearsalRefusal("operation cannot be finalized without its maintenance marker")
            current = self._owned(operation_id)
            if not self._is_committed(operation_id):
                raise RehearsalRefusal("writers may reopen only after global commit")
            if not verify_reopened():
                raise RehearsalRefusal("writer reopen is not verified")
            self.marker_path.unlink()
            _fsync_dir(self.root)
            return current

    def recover(self, operation_id: str, verify_restored: Callable[[], bool],
                verify_reopened: Callable[[], bool]) -> dict:
        with self.lock():
            if self._is_committed(operation_id):
                raise RehearsalRefusal("recovery cannot restore the database after global commit")
            if self._is_recovered(operation_id):
                self.assert_terminal_reopen_allowed(operation_id)
                if not verify_reopened():
                    raise RehearsalRefusal("old CMS writer reopen is not verified")
                if self.marker_path.exists():
                    current = self._owned(operation_id)
                    self.marker_path.unlink()
                    _fsync_dir(self.root)
                    return {**current, "phase": "recovered"}
                return {"operationId": operation_id, "committed": False, "phase": "recovered"}
            current = self._owned(operation_id)
            if current["fence"] != "closed":
                raise RehearsalRefusal("recovery must close and verify the writer fence first")
            if not verify_restored():
                raise RehearsalRefusal("old CMS/database/media pair is not verified restored")
            self._append({"version": 1, "record": "recovered", "operationId": operation_id,
                          "sourceSha": current["sourceSha"]})
            # The terminal row is durable before writers reopen. If reopening fails,
            # the next recovery call may only retry reopen/finalize, never restore DB again.
            if not verify_reopened():
                raise RehearsalRefusal("old CMS writer reopen is not verified")
            self.marker_path.unlink()
            _fsync_dir(self.root)
            return current
