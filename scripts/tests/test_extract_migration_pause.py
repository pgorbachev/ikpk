import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'extract-migration-pause.py'
BUILDER = Path(__file__).resolve().parents[1] / 'seminar-review-builder.mjs'
h = lambda b: hashlib.sha256(b).hexdigest()
def js(x): return json.dumps(x,ensure_ascii=False,separators=(',',':')).encode()
def fp(b): return h(js([h(b),None]))
def archive(files, result, extra=()):
    manifest={'operationId':'op','sourceSha':'a'*40,'attempt':'b'*32,'resultSha256':h(result),'files':{k:h(v) for k,v in files.items()}}
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w') as out:
        for name, data in [('manifest.json',json.dumps(manifest,sort_keys=True).encode()),('result.json',result),*sorted(files.items()),*extra]:
            info=tarfile.TarInfo(name);info.mode=0o600;info.size=len(data);out.addfile(info,io.BytesIO(data))
    return stream.getvalue()

class ExtractionTests(unittest.TestCase):
 def test_export_extract_builder_and_refusals(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t).resolve(); os.chmod(root,0o700)
   op='op'; ids={'schema':'permission','schedule':'schedule','documents':'documents','content':'content'}
   values={k:k.encode() for k in ids}; source=b'source';candidate=b'candidate';sha='a'*64
   stages={v:{'path':f'/remote/stage-snapshots/op.{v}.db','snapshotFingerprint':fp(values[k])} for k,v in ids.items()};stages['content']['candidateFingerprint']=fp(candidate)
   decisions={'acceptedExceptions':[]};schedule={'sourceDigest':'a','decisionDigest':h(js(decisions)),'entries':[],'seminars':[],'exceptions':[]};sp=h(js(schedule));schedule['planDigest']=sp
   dp={'version':1}; dd=h(js(dp));cp={'documentsPlanDigest':dd,'rendererSha256':'5'*64};cd=h(js(cp))
   receipt={'operationId':op,'sourceCommitSha':'a'*40,'candidateDbPath':'/remote/candidate.db','sourceDbPath':'/live/source.db','planSha256':'b'*64,'artifactSha256':'c'*64,'source':{'snapshotSha256':'d'*64,'schemaFingerprint':'e'*64,'sourceFileFingerprint':h(js([{'file':'source.db','sha256':h(source)},{'file':'source.db-wal','absent':True}]))},'stageSnapshots':stages,'steps':[{'id':x,'sha256':sha} for x in ids.values()],'reviewedSteps':{k:{'expectedPlanDigest':v} for k,v in [('schedule',sp),('documents',dd),('content',cd)]}}
   files={'source/source.db':source,'candidate.db':candidate,'receipt.json':js(receipt),**{f'stage-snapshots/op.{id}.db':values[k] for k,id in ids.items()}};result=js({'phase':'fenced','migrationPaused':True})
   payload=archive(files,result);tar=root/'pause.tar';tar.write_bytes(payload);out=root/'output';out.mkdir(mode=0o700)
   cmd=['python3',str(SCRIPT),'--archive',str(tar),'--archive-sha256',h(payload),'--operation-id','op','--source-sha','a'*40,'--output-parent',str(out)]
   ok=subprocess.run(cmd,text=True,capture_output=True);self.assertEqual(ok.returncode,0,ok.stderr);destination=Path(json.loads(ok.stdout)['directory']);self.assertEqual(destination.stat().st_mode & 0o777,0o700);self.assertEqual((destination/'receipt.json').stat().st_mode & 0o777,0o600)
   proof=root/'proof';proof.write_bytes(b'proof');reg=root/'registry.json';reg.write_bytes(b'[]')
   template={'version':1,'ledger':{'lineageId':'f'*64},'steps':{k:{'id':ids['schema' if k=='permissions' else k],'sha256':sha,'result':{}} for k in ['permissions','schedule','documents','content']},'schemaContract':{'version':1},'schemaContractDigest':h(js({'version':1})),'schedule':{'plan':schedule,'decisions':decisions,'expectedPlanDigest':sp},'documents':{'plan':{'payload':dp,'digest':dd},'expectedPlanDigest':dd},'content':{'plan':{'payload':cp,'digest':cd},'expectedPlanDigest':cd},'rendererSha256':'5'*64,'proofArtifact':{'path':'/remote/proof','sha256':h(b'proof')}}
   template_path=root/'template.json';template_path.write_bytes(js(template));paths={'source':str(destination/'source/source.db'),**{k:str(destination/f'stage-snapshots/op.{v}.db') for k,v in ids.items()}}
   config={'receiptPath':str(destination/'receipt.json'),'receiptSha256':h(files['receipt.json']),'templatePath':str(template_path),'templateSha256':h(js(template)),'registryPath':str(reg),'registrySha256':h(b'[]'),'proofPath':str(proof),'remoteProofPath':'/remote/proof','candidatePath':str(destination/'candidate.db'),'remoteReceipt':'/remote/receipt.json','paths':paths}
   config_path=root/'config.json';config_path.write_bytes(js(config));builder_out=root/'build';builder_out.mkdir(mode=0o700)
   built=subprocess.run(['node',str(BUILDER),str(config_path),h(js(config)),str(builder_out)],capture_output=True,text=True);self.assertEqual(built.returncode,0,built.stderr);self.assertTrue((builder_out/'composition.json').is_file())
   with_sidecars=archive({**files,'source/source.db-wal':b'wal','source/source.db-shm':b'shm'},result)
   tar.write_bytes(with_sidecars);sidecmd=cmd.copy();sidecmd[sidecmd.index('--archive-sha256')+1]=h(with_sidecars)
   side=subprocess.run(sidecmd,text=True,capture_output=True);self.assertEqual(side.returncode,0,side.stderr)
   self.assertEqual((Path(json.loads(side.stdout)['directory'])/'source/source.db-wal').read_bytes(),b'wal')
   for bad in [archive(files,result,extra=[('receipt.json',b'evil')]),archive(files,result,extra=[('../escape',b'evil')])]:
    tar.write_bytes(bad);badcmd=cmd.copy();badcmd[badcmd.index('--archive-sha256')+1]=h(bad)
    before=set(out.iterdir());r=subprocess.run(badcmd,text=True,capture_output=True);self.assertNotEqual(r.returncode,0);self.assertEqual(before,set(out.iterdir()))
   # A valid manifest must still reject substituted payload bytes and unsafe member types.
   stream=io.BytesIO()
   with tarfile.open(fileobj=io.BytesIO(payload),mode='r:') as original, tarfile.open(fileobj=stream,mode='w') as changed:
    for member in original:
     data=original.extractfile(member).read()
     if member.name=='candidate.db': data=b'tampered';member.size=len(data)
     changed.addfile(member,io.BytesIO(data))
   variants=[stream.getvalue(),archive({k:v for k,v in files.items() if k!='source/source.db'},result)]
   stream=io.BytesIO()
   with tarfile.open(fileobj=io.BytesIO(payload),mode='r:') as original, tarfile.open(fileobj=stream,mode='w') as changed:
    for member in original:
     data=original.extractfile(member).read()
     if member.name=='candidate.db':
      member.type=tarfile.SYMTYPE;member.linkname='/etc/passwd';member.size=0;changed.addfile(member)
     else: changed.addfile(member,io.BytesIO(data))
   variants.append(stream.getvalue())
   for bad in variants:
    tar.write_bytes(bad);badcmd=cmd.copy();badcmd[badcmd.index('--archive-sha256')+1]=h(bad)
    before=set(out.iterdir());r=subprocess.run(badcmd,capture_output=True);self.assertNotEqual(r.returncode,0);self.assertEqual(before,set(out.iterdir()))
   tar.write_bytes(payload)
   self.assertNotEqual(subprocess.run(cmd+['--max-bytes','10'],capture_output=True).returncode,0)
   tar.write_bytes(payload);badcmd=cmd.copy();badcmd[badcmd.index('--archive-sha256')+1]='0'*64
   self.assertNotEqual(subprocess.run(badcmd,capture_output=True).returncode,0)
