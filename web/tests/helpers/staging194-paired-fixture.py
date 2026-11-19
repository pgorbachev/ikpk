"""Feed a controlled static export through the real paired publication operator."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
from argparse import Namespace
from unittest.mock import patch

from scripts.rehearsal import staging193 as operator

tree, snapshot_path = map(Path, sys.argv[1:3])
build_now = sys.argv[3]
operation_id, source_sha = "registration-fixture", "a" * 40
manifest = {"operationId": operation_id, "sourceSha": source_sha, "sourceId": "demo193-cms",
            "schemaDigest": "b" * 64, "databaseSha256": "c" * 64, "mediaManifestSha256": "d" * 64}
manifest_bytes = json.dumps(manifest).encode()
snapshot = json.loads(snapshot_path.read_bytes())
snapshot.update(sourcePolicy="demo-publication-only", sourceAge="untracked",
                origin={"sourceId": "demo193-cms", "kind": "server-db"},
                captureProof={"captureId": operation_id, "schemaDigest": manifest["schemaDigest"],
                              "databaseDigest": manifest["databaseSha256"],
                              "mediaManifestDigest": manifest["mediaManifestSha256"],
                              "bundleDigest": hashlib.sha256(manifest_bytes).hexdigest()})
snapshot_bytes = json.dumps(snapshot).encode()
(tree / '.ikpk-registration-proof.json').write_text(json.dumps({
    'buildNow': build_now, 'snapshotFileSha256': hashlib.sha256(snapshot_bytes).hexdigest(),
}), encoding='utf-8')
digest = operator._static_tree_sha256(tree)
release = {"commit": source_sha, "operationId": operation_id, "snapshotId": snapshot["snapshotId"],
           "staticTreeSha256": digest}
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode="w") as tar:
    for name, content in (("static/release.json", json.dumps(release).encode()),
                          ("snapshot/snapshot.json", snapshot_bytes),
                          ("snapshot/capture-manifest.json", manifest_bytes)):
        member = tarfile.TarInfo(name)
        member.size = len(content)
        tar.addfile(member, io.BytesIO(content))
    for path in tree.rglob("*"):
        if path.is_file():
            tar.add(path, "static/" + path.relative_to(tree).as_posix())

confirmed = []
def respond(arguments, **_kwargs):
    if arguments[0] == "export-static":
        return archive.getvalue()
    if arguments[0] == "static-publish" and "--browser-digest" in arguments:
        confirmed.append(arguments[-1])
        return json.dumps({"phase": "committed"}).encode()
    if arguments[0] == "static-publish":
        return json.dumps({"phase": "browser-check-required", "staticTreeSha256": digest}).encode()
    raise AssertionError(arguments)

run = subprocess.run
def local_checks(argv, **kwargs):
    # This fixture exercises the local registration checker. Browser smoke has its own fixture.
    if Path(argv[0]).name == "playwright":
        return subprocess.CompletedProcess(argv, 0)
    return run(argv, **kwargs)

args = Namespace(profile="staging194", command="static-publish", host=None,
                 operation_id=operation_id, source_sha=source_sha)
with patch.object(operator, "ssh_remote", side_effect=respond), \
     patch.object(operator, "validate_sha_and_ci", return_value={"runId": 1, "attempt": 1}), \
     patch.object(operator.subprocess, "run", side_effect=local_checks):
    reason = None
    try:
        operator.invoke(args)
    except operator.Refusal as failure:
        reason = str(failure)
    print(json.dumps({"confirmed": confirmed, "reason": reason}))
