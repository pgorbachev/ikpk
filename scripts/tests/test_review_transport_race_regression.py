"""Independent regression: root review transport must pin directory inodes."""
import base64
import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host as host


class ReviewTransportRace(unittest.TestCase):
    def test_reviews_directory_swap_cannot_chown_or_write_the_link_target(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            root = Path(temporary)
            operation = root / 'operation'; operation.mkdir()
            victim = root / 'outside-operation'; victim.mkdir(mode=0o700)
            directory = operation / 'reviews'
            raw = b'{"plan":1}'
            digest = hashlib.sha256(raw).hexdigest()
            control = {'operationId': 'op', 'sourceSha': 'a' * 40,
                'reviewedStep': {'id': 'step', 'fileBase64': base64.b64encode(raw).decode(),
                    'expectedReviewFileSha256': digest, 'expectedPlanDigest': 'b' * 64}}
            user = type('User', (), {'pw_uid': os.getuid(), 'pw_gid': os.getgid()})()
            original_chown = os.chown
            escaped = []
            def race(path, uid, gid, **kwargs):
                if Path(path) == directory:
                    directory.rmdir()
                    directory.symlink_to(victim, target_is_directory=True)
                if Path(path).resolve().is_relative_to(victim):
                    escaped.append(str(Path(path).resolve()))
                return original_chown(path, uid, gid, **kwargs)
            with patch.object(host.pwd, 'getpwnam', return_value=user), patch.object(host.os, 'chown', side_effect=race):
                try:
                    host._migration_review_arguments({'cmsUser': 'cms'}, operation, 'op', 'a' * 40, control)
                except host.HostFailure:
                    pass
            self.assertEqual(escaped, [], 'root chown followed a substituted CMS-owned review directory')
            self.assertEqual(list(victim.iterdir()), [], 'root wrote review bytes outside the operation')

    def test_directory_swap_after_fd_open_is_rejected_without_writing_outside(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            root = Path(temporary).resolve()
            operation = root / 'operation'; operation.mkdir()
            victim = root / 'victim'; victim.mkdir(mode=0o700)
            directory = operation / 'reviews'
            raw = b'{"plan":1}'; digest = hashlib.sha256(raw).hexdigest()
            control = {'operationId': 'op', 'sourceSha': 'a' * 40,
                'reviewedStep': {'id': 'step', 'fileBase64': base64.b64encode(raw).decode(),
                    'expectedReviewFileSha256': digest, 'expectedPlanDigest': 'b' * 64}}
            user = type('User', (), {'pw_uid': os.getuid(), 'pw_gid': os.getgid()})()
            original = os.fchown
            def race(fd, uid, gid):
                if directory.is_dir() and not directory.is_symlink():
                    directory.rename(root / 'detached-reviews')
                    directory.symlink_to(victim, target_is_directory=True)
                return original(fd, uid, gid)
            with patch.object(host.pwd, 'getpwnam', return_value=user), patch.object(host.os, 'fchown', side_effect=race):
                with self.assertRaises(host.HostFailure):
                    host._migration_review_arguments({'cmsUser': 'cms'}, operation, 'op', 'a' * 40, control)
            self.assertEqual(list(victim.iterdir()), [])

    def test_parent_symlink_is_refused(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            root = Path(temporary).resolve()
            victim = root / 'victim'; victim.mkdir()
            alias = root / 'alias'; alias.symlink_to(victim, target_is_directory=True)
            user = type('User', (), {'pw_uid': os.getuid(), 'pw_gid': os.getgid()})()
            with self.assertRaises(host.HostFailure):
                host._store_migration_review(alias, user, 'review.json', b'{}')
            self.assertEqual(list(victim.iterdir()), [])

    def test_snapshot_directory_symlink_is_refused_without_chown(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            root = Path(temporary).resolve()
            operation = root / 'operation'; operation.mkdir()
            victim = root / 'victim'; victim.mkdir()
            (operation / 'stage-snapshots').symlink_to(victim, target_is_directory=True)
            user = type('User', (), {'pw_uid': os.getuid(), 'pw_gid': os.getgid()})()
            with patch.object(host.os, 'chown', side_effect=AssertionError('unsafe root chown')):
                with self.assertRaises(host.HostFailure):
                    host._ensure_cms_private_directory(operation, user, 'stage-snapshots')


if __name__ == '__main__':
    unittest.main()
