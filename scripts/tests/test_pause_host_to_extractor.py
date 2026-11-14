import argparse
from contextlib import nullcontext
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from scripts.lib import rehearsal_host as host

EXTRACTOR = Path(__file__).resolve().parents[1] / 'extract-migration-pause.py'
def sha(data):
    return hashlib.sha256(data).hexdigest()
def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()

class HostToExtractor(unittest.TestCase):
    def test_real_export_dispatch_bytes_are_accepted_and_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            work = root/'work'
            work.mkdir(mode=0o700)
            snapshots = work/'stage-snapshots'
            snapshots.mkdir(mode=0o700)
            state_root = root/'state'
            state_root.mkdir(mode=0o700)
            candidate = work/'candidate.db'
            candidate.write_bytes(b'candidate')
            candidate.chmod(0o600)
            source = root/'live.db'
            source.write_bytes(b'live')
            wal = root/'live.db-wal'
            wal.write_bytes(b'wal')
            shm = root/'live.db-shm'
            shm.write_bytes(b'shm')
            stage = snapshots/'op.seminar-occurrence-model-v1.db'
            stage.write_bytes(b'stage')
            stage.chmod(0o400)
            source_fp = sha(compact([{'file':'live.db','sha256':sha(b'live')}, {'file':'live.db-wal','sha256':sha(b'wal')}]))
            receipt = {'operationId':'op','sourceCommitSha':'a'*40,'candidateDbPath':str(candidate),
                       'stageSnapshotDir':str(snapshots),'sourceDbPath':str(source),
                       'source':{'sourceFileFingerprint':source_fp},
                       'stageSnapshots':{'seminar-occurrence-model-v1':{'path':str(stage),
                           'snapshotFingerprint':sha(compact([sha(b'stage'),None]))}}}
            receipt_path=work/'receipt.json'
            receipt_path.write_bytes(compact(receipt));receipt_path.chmod(0o600)
            result_path=state_root/('migration-pause-'+'b'*32+'.json')
            result_path.write_bytes(compact({'migrationPaused':True, 'migration':{'waitingForReview':'seminar-occurrence-model-v1'}})+b'\n')
            result_path.chmod(0o600)
            config={'profile':'staging194','stateDir':str(state_root),'cmsDatabase':str(source),
                    'cmsUser':pwd.getpwuid(os.getuid()).pw_name}
            with patch.object(host,'_assert_no_database_handles'),patch.object(host,'_verify_fence'):
                capture=host._capture_migration_pause(work,'op','a'*40,include_bytes=True,config=config)
            attempt='b'*32
            rows=[{'record':'migration-attempt-started','attempt':attempt},
                  {'record':'migration-pause-sealed','attempt':attempt,'sourceSha':'a'*40,
                   'files':capture['files'],'resultSha256':sha(result_path.read_bytes())}]
            state=MagicMock();state.root=state_root;state.lock.return_value=nullcontext()
            state.read_journal_for_cleanup.return_value=[];state._operation_rows.return_value=rows
            state.phase.return_value={'phase':'fenced'}
            args=argparse.Namespace(action='export-migration-pause',profile='staging194',operation_id='op',source_sha='a'*40)
            real_lstat=Path.lstat
            def lstat_for_root_owned_result(path, *a, **kw):
                value=real_lstat(path,*a,**kw)
                if path != result_path:
                    return value
                return SimpleNamespace(st_mode=value.st_mode,st_uid=0,st_nlink=value.st_nlink,
                                       st_dev=value.st_dev,st_ino=value.st_ino)
            with patch.object(host.os,'geteuid',return_value=0), \
                 patch.object(host,'_root_config',return_value=config), \
                 patch.object(host,'_configure_profile_temp'), \
                 patch.object(host,'_destination_publication_lock',return_value=nullcontext()), \
                 patch.object(host,'_read_site_publication_marker',return_value=None), \
                 patch.object(host,'RehearsalState',return_value=state), \
                 patch.object(host,'_candidate_root',return_value=root), \
                 patch.object(host,'_cms_artifact_path',return_value=work/'cms-artifact'), \
                 patch.object(host,'_assert_no_database_handles'),patch.object(host,'_verify_fence'), \
                 patch.object(Path,'lstat',lstat_for_root_owned_result):
                payload=host.dispatch(args)['_bytes']
                source.write_bytes(b'changed')
                with self.assertRaises(host.HostFailure):
                    host.dispatch(args)
                source.write_bytes(b'live')
            archive=root/'pause.tar';archive.write_bytes(payload)
            parent=root/'extracted';parent.mkdir(mode=0o700)
            command=['python3',str(EXTRACTOR),'--archive',str(archive),'--archive-sha256',sha(payload),
                     '--operation-id','op','--source-sha','a'*40,'--output-parent',str(parent)]
            output=subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(output.returncode,0,output.stderr)
            result=Path(json.loads(output.stdout)['directory'])
            self.assertEqual((result/'source/live.db').read_bytes(),b'live')
            self.assertEqual((result/'source/live.db-wal').read_bytes(),b'wal')
            self.assertEqual((result/'source/live.db-shm').read_bytes(),b'shm')
            self.assertEqual((result/'stage-snapshots'/stage.name).read_bytes(),b'stage')
            self.assertEqual((result/'receipt.json').read_bytes(),receipt_path.read_bytes())
            command[command.index('--archive-sha256')+1]='0'*64
            self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
