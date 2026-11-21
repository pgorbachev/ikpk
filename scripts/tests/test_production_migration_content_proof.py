"""Contract checks for the production-paired operator, using a local host double."""

import base64
import copy
import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from argparse import Namespace
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from scripts.lib import rehearsal_host
from scripts.rehearsal import staging193 as operator
from scripts.tests.test_rehearsal_host import backup_archive


SOURCE = "b974b71df79c6bdb1c2a7c692c27723e0b73e854"
OLD_CMS = "43b0cfa0a6bfb88462f4a0a0e10ab9fe0b6a1e1b"
OLD_PROJECTOR = "9fad640520a90518a89d2751701acd2faa10ab21"
OPERATION = "production-content-proof-test"
ADMISSION = {"sourceSha": SOURCE, "runId": 7, "attempt": 2}


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def snapshot_fingerprint(row):
    # Stub of the browser result. Include the entire row so unrelated edits
    # change the result and cannot be hidden by comparing price alone.
    public_row = dict(row)
    for field in ("startAt", "endAt"):
        instant = datetime.fromisoformat(row[field].replace("Z", "+00:00"))
        public_row[field + "MoscowDate"] = instant.astimezone(ZoneInfo("Europe/Moscow")).date().isoformat()
    return "sha256:" + sha(json.dumps(public_row, sort_keys=True).encode())


class ProductionPublicationProofTests(unittest.TestCase):
    """Exercise operator and host together, replacing only their external effects.

    The local cohort receipt follows the persisted runner format. Its SQLite
    files and digest chain are real. This fixture does not run Strapi, prove
    Playwright, or purport to be a deployable production receipt.
    """

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.backups = self.root / "backups"
        self.capture_backup = self.backups / OPERATION
        self.backups.mkdir(mode=0o700)
        self.capture_backup.mkdir(mode=0o700)
        self.db = self.capture_backup / "database.sqlite"
        self.original = {
            "documentId": "schedule-test", "title": "Approved public title", "price": 0,
            "startAt": "2026-11-19T21:00:00Z", "endAt": "2026-11-22T21:00:00Z",
        }
        self.transformed = {**self.original, "price": None}
        with sqlite3.connect(self.db) as db:
            db.execute("CREATE TABLE schedule_entries (documentId TEXT PRIMARY KEY, title TEXT,"
                       " price INTEGER, startAt TEXT, endAt TEXT)")
            db.execute("INSERT INTO schedule_entries VALUES (?, ?, ?, ?, ?)", tuple(self.original.values()))
            db.execute("CREATE TABLE admin_users (id INTEGER PRIMARY KEY, blocked INTEGER)")
            db.execute("INSERT INTO admin_users VALUES (4, 0)")
        self.source_digest = sha(self.db.read_bytes())
        self.backup = self.backups / f"{OPERATION}.tar"
        with tarfile.open(fileobj=io.BytesIO(backup_archive(OPERATION))) as original, \
             tarfile.open(self.backup, "w") as archive:
            for member in original:
                raw = original.extractfile(member).read()
                if member.name == "database.sqlite":
                    raw = self.db.read_bytes()
                if member.name == "manifest.json":
                    manifest = json.loads(raw)
                    manifest.update(databaseSha256=self.source_digest, postCheckpointLiveSha256=self.source_digest)
                    raw = json.dumps(manifest).encode()
                member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))
                if member.name != "database.sqlite":
                    local = self.capture_backup / member.name
                    local.parent.mkdir(parents=True, exist_ok=True)
                    local.write_bytes(raw)
        self.backup_digest = sha(self.backup.read_bytes())
        operator.verify_backup_tar(self.backup.read_bytes(), self.backup_digest)
        shutil.copyfile(self.backup, self.capture_backup / "backup.tar")
        host_manifest = self.capture_backup / "manifest.json"
        self.write_json(host_manifest, {**json.loads(host_manifest.read_bytes()),
                                        "archiveSha256": self.backup_digest})
        self.sidecar = {
            "operationId": OPERATION, "sourceSha": SOURCE, "sha256": self.backup_digest,
            "runId": ADMISSION["runId"], "attempt": ADMISSION["attempt"],
            "oldCmsSourceSha": OLD_CMS, "oldCmsSchemaSha256": "a" * 64,
            "snapshotFingerprint": snapshot_fingerprint(self.original),
            "oldProjectorContractSha256": "8" * 64,
            "oldProjectorSourceSha": OLD_PROJECTOR, "oldProjectorNodeVersion": "v22-test",
        }
        self.config = {
            "profile": "production-paired", "releaseRoot": str(self.root / "releases"),
            "staticReleaseRoot": str(self.root / "static"), "currentStatic": str(self.root / "current"),
            "backupRoot": str(self.backups), "cmsDatabase": str(self.db),
        }
        self.source_root = self.root / "releases" / f"{SOURCE}-{OPERATION}"
        self.capture = self.source_root / ".staging193-rehearsal" / OPERATION / "capture"
        self.capture.mkdir(parents=True)
        shutil.copyfile(self.capture_backup / "media-manifest.json", self.capture / "media-manifest.json")
        self.release = self.root / "static" / f"{SOURCE}-{OPERATION}"
        self.release.mkdir(parents=True)
        self.snapshot = self.source_root / "web/.snapshot/snapshot.json"
        self.snapshot.parent.mkdir(parents=True)
        (self.root / "state").mkdir()
        self.state = rehearsal_host.RehearsalState(self.root / "state")
        self.old_pair = {
            "cmsPath": f"/releases/{OLD_CMS}-old/cms-artifact", "historicalRegistryManifest": None,
            "configSha256": rehearsal_host._config_sha256(self.config),
        }
        self.state.begin(OPERATION, SOURCE, self.old_pair)
        self.state.confirm_fence(OPERATION, lambda: True)
        self.record("fenced-baseline", oldPair=self.old_pair)
        self.write_json(self.source_root / ".ikpk-rehearsal-ci.json", {
            **ADMISSION, "repository": "pgorbachev/ikpk",
        })
        self.migration = rehearsal_host._cms_artifact_path(self.source_root, OPERATION).parent
        self.migration.mkdir()
        self.receipt = self.migration / "receipt.json"
        self.final_db = self.capture / "database.sqlite"
        shutil.copyfile(self.db, self.final_db)
        self.switches = []

    def record(self, kind, **fields):
        self.state._append({"version": 1, "operationId": OPERATION, "sourceSha": SOURCE,
                            "record": kind, **fields})

    def write_json(self, path, value):
        path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        return sha(path.read_bytes())

    def prepare_cohort(self, *, inherited=False, unrelated_sql=None, defer_intent=False):
        # Approval is authored first. No candidate diff is used to set what
        # the test permits, and a modified candidate keeps the same approval.
        steps_dir = self.migration / "stage-snapshots"
        steps_dir.mkdir(mode=0o700)
        plan = json.loads((operator.ROOT / "cms/database/migrations/plan.json").read_bytes())
        roles = {"permissions": "seminar-content-admin-permissions-v1",
                 "schedule": "seminar-occurrence-model-v2",
                 "documents": "seminar-documents-structure-v1",
                 "content": "seminar-content-structure-v1"}
        schedule = roles["schedule"]
        selected = {step["id"]: step for step in plan["steps"] if step["id"] in roles.values()}
        artifact = self.migration / "cms-artifact/database/migrations"
        artifact.mkdir(parents=True)
        shutil.copyfile(operator.ROOT / "cms/database/migrations/plan.json", artifact / "plan.json")
        plan_digest = sha((artifact / "plan.json").read_bytes())
        reviews = self.migration / "reviews"
        reviews.mkdir(mode=0o700)
        proof = self.source_root / ".ikpk-seminar-proof.tar.gz"
        proof.write_bytes(b"admitted test proof payload")
        proof_digest = sha(proof.read_bytes())
        step_path = reviews / "schedule.json"
        step_digest = self.write_json(step_path, {
            "decisions": {"paid": ["schedule-test"]},
            "entries": [{"documentId": "schedule-test", "changes": {"price": None}}],
        })
        step_bound = reviews / f"reviewedStep-{step_digest}.json"
        step_path.rename(step_bound)
        composition_path = reviews / "composition.json"
        composition_digest = self.write_json(composition_path, {
            "proofArtifact": {"path": str(proof), "sha256": proof_digest},
            "sourceCommitSha": SOURCE,
            "ledger": {"operationId": OPERATION, "sourceSnapshotSha256": self.source_digest},
            "steps": {role: {"id": step, "sha256": selected[step]["sha256"]}
                      for role, step in roles.items()},
            "schedule": {"expectedPlanDigest": step_digest},
        })
        self.plan = reviews / f"compositionReview-{composition_digest}.json"
        composition_path.rename(self.plan)
        stages = {}
        previous = self.db
        for step in ("schema", *roles.values()):
            path = steps_dir / f"{OPERATION}.{step}.db"
            shutil.copyfile(previous, path)
            if step == schedule and not inherited:
                with sqlite3.connect(path) as db:
                    db.execute("UPDATE schedule_entries SET price=NULL WHERE documentId='schedule-test'")
                    if unrelated_sql:
                        db.execute(unrelated_sql)
            digest = sha(json.dumps([sha(path.read_bytes()), None], separators=(",", ":")).encode())
            stages[step] = {"path": str(path), "candidateFingerprint": digest, "snapshotFingerprint": digest}
            previous = path
        candidate = self.migration / "candidate.db"
        shutil.copyfile(previous, candidate)
        shutil.copyfile(candidate, self.final_db)
        self.final_stage = previous
        registry = reviews / f"registry-{sha(b'[]')}.json"
        registry_digest = self.write_json(registry, [])
        binding = {
            "version": 1, "operationId": OPERATION, "sourceCommit": SOURCE,
            "migrationPlanDigest": plan_digest, "sourceDatabaseSha256": self.source_digest,
            "candidateDatabaseSha256": sha(self.final_db.read_bytes()),
            "registrySha256": registry_digest, "registryPath": str(registry),
            "cmsArtifactSha256": "b" * 64, "proofArtifactSha256": proof_digest,
        }
        audit = {"passed": True, "partial": False}
        if inherited:
            audit.update(mode="inherited-cohort", priorReceiptSha256="9" * 64)
        registry_review = reviews / "registry-review.json"
        registry_review_digest = self.write_json(registry_review, binding)
        registry_bound = reviews / f"registryReview-{registry_review_digest}.json"
        registry_review.rename(registry_bound)
        inherited_receipt = {"expectedReceiptSha256": "9" * 64} if inherited else None
        reviewed_step = {"reviewFilePath": str(step_bound), "expectedReviewFileSha256": step_digest,
                         "expectedPlanDigest": step_digest}
        composition = {"reviewFilePath": str(self.plan), "expectedFileSha256": composition_digest,
                       "expectedContractDigest": composition_digest}
        receipt_digest = self.write_json(self.receipt, {
            "operationId": OPERATION, "phase": "prepared", "sourceCommitSha": SOURCE,
            "artifactSha256": binding["cmsArtifactSha256"], "planSha256": plan_digest,
            "sourceDbPath": str(self.db), "candidateDbPath": str(candidate),
            "source": {"snapshotSha256": self.source_digest, "sourceFileFingerprint": sha(
                json.dumps([{"file": self.db.name, "sha256": self.source_digest},
                            {"file": self.db.name + "-wal", "absent": True}],
                           separators=(",", ":")).encode())},
            "stageSnapshotDir": str(steps_dir), "stageSnapshots": stages,
            "reviewedSteps": {} if inherited else {schedule: reviewed_step},
            "compositionReview": None if inherited else composition,
            "registryReview": None if inherited else {"reviewFilePath": str(registry_bound),
                                                       "expectedFileSha256": registry_review_digest},
            "registryBinding": binding, "compositionAudit": audit, "inheritedCohort": inherited_receipt,
        })
        control = {
            "operationId": OPERATION, "sourceSha": SOURCE,
            "reviewedStep": {"id": schedule, "fileBase64": base64.b64encode(step_bound.read_bytes()).decode(),
                             "expectedReviewFileSha256": step_digest, "expectedPlanDigest": step_digest},
            "compositionReview": {"fileBase64": base64.b64encode(self.plan.read_bytes()).decode(),
                                  "expectedFileSha256": composition_digest,
                                  "expectedContractDigest": composition_digest},
            "registryReview": {"fileBase64": base64.b64encode(registry_bound.read_bytes()).decode(),
                               "registryBase64": "W10=", "expectedFileSha256": registry_review_digest},
        }
        if not inherited:
            self.record("migration-review-submitted", control=control)
        rehearsal_host._verify_migration_receipt_admission(
            self.receipt, [] if inherited else [control],
            {"sourceSha": SOURCE, "payloadSha256": proof_digest}, inherited_receipt,
        )
        admission = {"binding": binding, "receiptPath": str(self.receipt),
                     "receiptSha256": receipt_digest, "registryPath": str(registry)}
        if not defer_intent:
            cms_release = str(self.source_root)
            self.record("historical-cohort-intent", binding=binding, receiptSha256=receipt_digest,
                        cmsRelease=cms_release, previousManifest=None, sourceLiveSha256=self.source_digest,
                        cmsArtifact={"payloadSha256": "b" * 64})
            self.select_cohort(admission, cms_release)
        return candidate, admission

    def select_cohort(self, admission, cms_release):
        self.record("historical-cohort-selected", manifest={
            **admission["binding"], "version": 2, "receiptSha256": admission["receiptSha256"],
            "cmsRelease": cms_release,
        })

    def capture_manifest(self, database_sha):
        return {
            "operationId": OPERATION, "sourceSha": SOURCE, "profile": "production-static",
            "databaseSha256": database_sha, "schemaDigest": "b" * 64,
            "mediaManifestSha256": json.loads((self.capture_backup / "manifest.json").read_bytes())["mediaManifestSha256"],
            **ADMISSION,
        }

    def public_content(self, row, *, historical=False):
        occurrence = {"id": 1, **row}
        if historical:
            occurrence.pop("documentId")
        return {"types": {"teachers": [], "seminars": [], "schedule_entries": [occurrence]}, "media": []}

    def publish(self, row=None):
        self.state.mark_cms_activated(OPERATION)
        if row is None:
            with sqlite3.connect(self.final_db) as db:
                db.row_factory = sqlite3.Row
                row = dict(db.execute("SELECT * FROM schedule_entries").fetchone())
        self.write_json(self.backup.with_suffix(".json"), self.sidecar)
        manifest = self.capture_manifest(sha(self.final_db.read_bytes()))
        capture_sha = self.write_json(self.capture / "manifest.json", manifest)
        self.write_json(self.snapshot, {
            "contractVersion": 2, "snapshotId": "snap:test", "fingerprint": snapshot_fingerprint(row),
            "content": self.public_content(row),
            "captureProof": {
                "captureId": OPERATION, "schemaDigest": manifest["schemaDigest"],
                "databaseDigest": manifest["databaseSha256"], "bundleDigest": capture_sha,
                "mediaManifestDigest": manifest["mediaManifestSha256"],
            },
        })
        (self.release / "index.html").write_text(json.dumps(row), encoding="utf-8")
        static_digest = rehearsal_host._tree_sha256(self.release)
        self.write_json(self.release / "release.json", {
            "commit": SOURCE, "operationId": OPERATION, "snapshotId": "snap:test",
            "staticTreeSha256": static_digest,
        })

        def ssh(arguments, *, profile, **kwargs):
            self.assertEqual(profile, "production-paired")
            self.assertIn(OPERATION, arguments)
            action = arguments[0]
            if action == "status":
                result = {**self.state.phase(OPERATION), "oldPair": self.old_pair}
            elif action == "static-publish":
                browser = arguments[arguments.index("--browser-digest") + 1] if "--browser-digest" in arguments else None
                try:
                    result = rehearsal_host._static_publish(self.config, self.state, Namespace(
                        operation_id=OPERATION, source_sha=SOURCE, browser_digest=browser,
                    ))
                except WouldSwitch:
                    result = {"phase": "committed"}
                except rehearsal_host.HostFailure as error:
                    raise operator.Refusal(str(error)) from error
            elif action == "export-static":
                try:
                    return rehearsal_host._export_static(self.config, self.state, OPERATION, SOURCE)
                except rehearsal_host.HostFailure as error:
                    raise operator.Refusal(str(error)) from error
            else:
                self.fail(f"unexpected host request {action}")
            return json.dumps(result).encode()

        def browser_check(_source, _operation, digest, archive, *_args):
            self.assertEqual(digest, static_digest)
            with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
                return json.load(bundle.extractfile("snapshot/snapshot.json"))["fingerprint"]

        def old_projection(*_args, projection_output, **_kwargs):
            # The production path independently executes and authenticates the exact prior projector.
            # This reduced fixture has no Strapi schema, so keep that boundary tied to its source rows.
            self.write_json(projection_output, {"content": self.public_content(self.original, historical=True)})
            return snapshot_fingerprint(self.original)

        def switch(*_args):
            self.switches.append(static_digest)
            raise WouldSwitch

        args = Namespace(profile="production-paired", command="static-publish", host=None,
                         operation_id=OPERATION, source_sha=SOURCE, backup_dir=str(self.backups))
        with patch.object(operator, "ssh_remote", side_effect=ssh), \
             patch.object(operator, "validate_production_paired_admission", return_value=ADMISSION), \
             patch.object(operator, "browser_check", side_effect=browser_check), \
             patch.object(operator, "production_projector_contract", return_value="8" * 64), \
             patch.object(operator, "production_projector_node_version", return_value="v22-test"), \
             patch.object(operator, "production_paired_backup_fingerprint", side_effect=old_projection), \
             patch.object(rehearsal_host, "_verify_fence"), \
             patch.object(rehearsal_host, "_switch_static_pointer", side_effect=switch):
            operator.invoke(args)

    def assert_refused(self):
        with self.assertRaises(operator.Refusal):
            self.publish()
        self.assertEqual(self.switches, [])
        self.assertEqual(self.state.phase(OPERATION)["fence"], "closed")

    def test_ordinary_release_accepts_the_original_fingerprint(self):
        self.publish()
        self.assertEqual(len(self.switches), 1)

    def test_ordinary_release_refuses_unreviewed_projector_change_even_with_matching_fingerprint(self):
        self.sidecar["oldProjectorContractSha256"] = "7" * 64
        self.assert_refused()

    def test_ordinary_release_refuses_missing_original_projector_schema_binding(self):
        self.sidecar.pop("oldCmsSourceSha")
        self.sidecar.pop("oldProjectorContractSha256")
        self.assert_refused()

    def ordinary_candidate_archive(self, *, content=None, schema_digest="a" * 64):
        target_sha = "7b4548d234710e0f0daacc2c8a46787b1e822e2f"
        manifest = {
            "operationId": OPERATION, "sourceSha": target_sha,
            "profile": "production-static", "databaseSha256": sha(self.final_db.read_bytes()),
            "schemaDigest": schema_digest,
            "mediaManifestSha256": json.loads((self.capture_backup / "manifest.json").read_bytes())["mediaManifestSha256"],
            "runId": ADMISSION["runId"], "attempt": ADMISSION["attempt"],
        }
        manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        snapshot = {
            "contractVersion": 2, "fingerprint": snapshot_fingerprint(self.original),
            "referenceDate": "2026-11-21", "snapshotId": "snap:test",
            "sourcePolicy": "production-static", "sourceAge": "source-bound",
            "origin": {"kind": "server-db", "sourceId": "initial-prod-server-db", "capturedAt": "2026-11-21T10:00:00Z"},
            "skippedUploads": [], "content": content or self.public_content(self.original),
            "captureProof": {
                "version": 1, "method": "quiesced-sqlite-backup", "targetHost": "89.111.184.196",
                "siteUrl": "https://ikpk.su", "sourceSha": target_sha, "runId": ADMISSION["runId"],
                "attempt": ADMISSION["attempt"], "captureId": OPERATION,
                "schemaDigest": schema_digest, "databaseDigest": manifest["databaseSha256"],
                "mediaManifestDigest": manifest["mediaManifestSha256"],
                "bundleDigest": sha(manifest_bytes),
            },
        }
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:") as archive:
            for name, value in (("snapshot/capture-manifest.json", manifest),
                                ("snapshot/snapshot.json", snapshot)):
                payload = manifest_bytes if name == "snapshot/capture-manifest.json" else json.dumps(
                    value, sort_keys=True, separators=(",", ":")).encode()
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
        return output.getvalue()

    def validate_ordinary_candidate(self, *, content=None, schema_digest="a" * 64):
        old_sha = "62744c31283e2c9b31e84512d3b8cfc793e8d5f7"
        target_sha = "7b4548d234710e0f0daacc2c8a46787b1e822e2f"
        old_contract = "3928819713b00cfbf982186d67ed2e29f47b913c9a9ba019ee0106b7255904b9"
        target_contract = "cf536b99bc5815a8b5a76f8315f07c60200c0d1d5728960e9a9593b1c113bcf0"
        backup = {
            **self.sidecar, "sourceSha": target_sha, "oldCmsSourceSha": old_sha,
            "oldCmsSchemaSha256": "a" * 64, "oldProjectorSourceSha": old_sha,
            "oldProjectorContractSha256": old_contract, "oldProjectorNodeVersion": "v22-test",
        }

        def contract(projector_sha, schema_sha):
            if (projector_sha, schema_sha) == (old_sha, old_sha):
                return old_contract
            if (projector_sha, schema_sha) == (target_sha, target_sha):
                return target_contract
            raise AssertionError(f"unexpected projector contract request: {projector_sha} {schema_sha}")

        def old_projection(*_args, projection_output, **_kwargs):
            snapshot = {
                "contractVersion": 2, "fingerprint": snapshot_fingerprint(self.original),
                "referenceDate": "2026-11-21", "snapshotId": "snap:test",
                "sourcePolicy": "production-static", "sourceAge": "source-bound",
                "origin": {"kind": "server-db", "sourceId": "initial-prod-server-db", "capturedAt": "2026-11-21T09:00:00Z"},
                "skippedUploads": [], "content": self.public_content(self.original),
                "captureProof": {
                    "version": 1, "method": "quiesced-sqlite-backup", "targetHost": "89.111.184.196",
                    "siteUrl": "https://ikpk.su", "sourceSha": target_sha, "runId": ADMISSION["runId"],
                    "attempt": ADMISSION["attempt"], "captureId": OPERATION, "schemaDigest": "a" * 64,
                    "databaseDigest": self.source_digest, "mediaManifestDigest": "e" * 64,
                    "bundleDigest": "f" * 64,
                },
            }
            self.write_json(projection_output, snapshot)
            return snapshot["fingerprint"]

        with patch.object(operator, "production_projector_contract", side_effect=contract), \
             patch.object(operator, "production_paired_schema_from_commit", return_value="a" * 64), \
             patch.object(operator, "production_projector_node_version", return_value="v22-test"), \
             patch.object(operator, "production_paired_backup_fingerprint", side_effect=old_projection):
            operator.validate_production_content_acceptance(
                self.ordinary_candidate_archive(content=content, schema_digest=schema_digest), "d" * 64,
                snapshot_fingerprint(self.original), self.backup, backup, OPERATION, target_sha, ADMISSION,
            )

    def test_ordinary_release_accepts_reviewed_changed_projector_with_identical_projection(self):
        self.validate_ordinary_candidate()

    def test_ordinary_release_refuses_changed_content_with_reviewed_projector_pair(self):
        candidate_content = self.public_content(self.original)
        candidate_content["types"]["schedule_entries"][0]["newUnknownField"] = "changed"
        with self.assertRaises(operator.Refusal):
            self.validate_ordinary_candidate(content=candidate_content)

    def test_ordinary_release_refuses_changed_schema_with_identical_projection(self):
        with self.assertRaises(operator.Refusal):
            self.validate_ordinary_candidate(schema_digest="c" * 64)

    def test_ordinary_release_refuses_backup_bytes_that_do_not_match_sidecar(self):
        old_sha = "62744c31283e2c9b31e84512d3b8cfc793e8d5f7"
        backup = {
            **self.sidecar, "sourceSha": "7b4548d234710e0f0daacc2c8a46787b1e822e2f",
            "oldCmsSourceSha": old_sha, "oldCmsSchemaSha256": "a" * 64,
            "oldProjectorSourceSha": old_sha,
            "oldProjectorContractSha256": "0" * 64,
            "sha256": "f" * 64,
        }
        def contract(projector_sha, _schema_sha):
            return "0" * 64 if projector_sha == old_sha else "1" * 64

        with patch.object(operator, "production_projector_contract", side_effect=contract), \
             patch.object(operator, "production_projector_node_version", return_value="v22-test"), \
             self.assertRaisesRegex(operator.Refusal, "backup bytes do not match"):
            operator.validate_production_content_acceptance(
                self.ordinary_candidate_archive(), "d" * 64, snapshot_fingerprint(self.original),
                self.backup, backup, OPERATION, backup["sourceSha"], ADMISSION,
            )

    def test_lossless_sqlite_digest_keeps_nul_suffix_and_hidden_rowid(self):
        baseline = self.root / "text.sqlite"
        altered = self.root / "altered.sqlite"
        with sqlite3.connect(baseline) as source:
            source.execute("CREATE TABLE evidence(value TEXT)")
            source.execute("INSERT INTO evidence (rowid,value) VALUES (?,?)", (1, "X\0one"))
        shutil.copyfile(baseline, altered)
        expected = rehearsal_host._sqlite_logical_digest(baseline)
        with sqlite3.connect(altered) as other:
            other.execute("UPDATE evidence SET value=?", ("X\0two",))
        self.assertNotEqual(rehearsal_host._sqlite_logical_digest(altered), expected)
        with sqlite3.connect(altered) as other:
            other.execute("UPDATE evidence SET rowid=2,value=?", ("X\0one",))
        self.assertNotEqual(rehearsal_host._sqlite_logical_digest(altered), expected)

    def test_logical_database_binding_rejects_unaudited_nonpublic_changes(self):
        copied = self.root / "candidate.copy"
        with sqlite3.connect(self.db) as source, sqlite3.connect(copied) as other:
            source.backup(other)
        sealed = rehearsal_host._sqlite_logical_digest(self.db)
        self.assertEqual(rehearsal_host._sqlite_logical_digest(copied), sealed)
        with sqlite3.connect(copied) as other:
            other.execute("UPDATE admin_users SET blocked=1")
        self.assertNotEqual(rehearsal_host._sqlite_logical_digest(copied), sealed)

    def test_ordinary_release_refuses_changed_fingerprint(self):
        with self.assertRaises(operator.Refusal):
            self.publish(self.transformed)
        self.assertEqual(self.switches, [])

    def test_ordinary_release_refuses_sidecar_from_another_operation(self):
        self.sidecar["operationId"] = "different-operation"
        self.assert_refused()

    def test_inherited_cohort_accepts_the_original_fingerprint(self):
        self.prepare_cohort(inherited=True)
        self.publish()
        self.assertEqual(len(self.switches), 1)

    def test_inherited_cohort_refuses_changed_fingerprint(self):
        self.prepare_cohort(inherited=True)
        with self.assertRaises(operator.Refusal):
            self.publish(self.transformed)
        self.assertEqual(self.switches, [])

    def test_fresh_price_normalization_passes_only_after_independent_audit(self):
        candidate, admission = self.prepare_cohort(defer_intent=True)
        # The actual registry guard checks every ancestor, including Linux /tmp.
        registry = tempfile.TemporaryDirectory(prefix=".ikpk-registry-test-", dir=Path.home())
        self.addCleanup(registry.cleanup)
        registry_directory = Path(registry.name).resolve()

        def audit(config, state, operation_id, source_sha, candidate_db, cohort_admission):
            self.assertEqual((config, state, operation_id, source_sha),
                             (self.config, self.state, OPERATION, SOURCE))
            self.assertEqual((candidate_db, cohort_admission), (candidate, admission))
            receipt = json.loads(self.receipt.read_bytes())
            fingerprints = {}
            for step, snapshot in receipt["stageSnapshots"].items():
                db_path = Path(snapshot["path"])
                check = sha(json.dumps([sha(db_path.read_bytes()), None], separators=(",", ":")).encode())
                self.assertEqual(check, snapshot["snapshotFingerprint"])
                with sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True) as db:
                    db.row_factory = sqlite3.Row
                    before_price_step = step in ("schema", "seminar-content-admin-permissions-v1")
                    expected = self.original if before_price_step else self.transformed
                    tables = db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
                    self.assertEqual([row[0] for row in tables], ["admin_users", "schedule_entries"])
                    self.assertEqual([dict(row) for row in db.execute("SELECT * FROM schedule_entries")],
                                     [expected])
                    self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM admin_users")],
                                     [(4, 0)])
                if step != "schema":
                    fingerprints[step] = check
            self.assertEqual(candidate_db.read_bytes(), self.final_stage.read_bytes())
            return {"compositionContractDigest": receipt["compositionReview"]["expectedContractDigest"],
                    "stageSnapshots": fingerprints,
                    "publicProjection": {
                        "version": 1, "documentIds": {"teachers": {}, "seminars": {},
                            "schedule_entries": {"1": self.original["documentId"]}},
                        "schedule": {"1": {"price": None}}, "seminars": {},
                    }}

        with patch.object(rehearsal_host, "_verify_fence"), \
             patch.object(rehearsal_host, "_assert_no_database_handles"), \
             patch.object(rehearsal_host, "HISTORICAL_REGISTRY_DIRECTORY", registry_directory), \
             patch.object(rehearsal_host, "_audit_fresh_production_composition",
                          side_effect=audit, create=True) as independent:
            manifest = self.capture_manifest(sha(candidate.read_bytes()))
            capture_sha = sha(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
            intent = rehearsal_host._prepare_historical_cohort(
                self.config, self.state, OPERATION, SOURCE, self.source_root,
                candidate, {"payloadSha256": "b" * 64}, admission, trusted_uid=os.getuid(),
                target_projection={
                    "fingerprint": snapshot_fingerprint(self.transformed), "captureSha256": capture_sha,
                    "contentSha256": sha(json.dumps(self.public_content(self.transformed),
                        sort_keys=True, separators=(",", ":")).encode()),
                    "databaseSha256": manifest["databaseSha256"], "schemaDigest": manifest["schemaDigest"],
                    "mediaManifestSha256": manifest["mediaManifestSha256"],
                    "uploadsDigest": rehearsal_host._production_uploads_digest(json.loads(
                        (self.capture_backup / "manifest.json").read_bytes())["media"]),
                },
            )
            independent.assert_called_once()
        self.select_cohort(admission, intent["cmsRelease"])
        self.publish()
        self.assertEqual(len(self.switches), 1)

    def test_matching_digest_and_passed_receipt_do_not_substitute_for_complete_audit(self):
        self.prepare_cohort()
        receipt = json.loads(self.receipt.read_bytes())
        self.assertTrue(receipt["compositionAudit"]["passed"])
        # Deliberately incomplete: the two-table fixture supplies no independent
        # closed-world audit of the artifact's full reviewed composition.
        with self.assertRaises(operator.Refusal):
            self.publish(self.original)
        self.assertEqual(self.switches, [])

    def test_fresh_migration_refuses_missing_plan_even_if_public_fingerprint_matches(self):
        self.prepare_cohort()
        self.plan.unlink()
        with self.assertRaises(operator.Refusal):
            self.publish(self.original)
        self.assertEqual(self.switches, [])

    def test_fresh_migration_refuses_altered_stage_even_if_public_fingerprint_matches(self):
        self.prepare_cohort()
        with sqlite3.connect(self.final_stage) as db:
            db.execute("UPDATE schedule_entries SET startAt='2026-11-19T20:59:59Z'")
        with self.assertRaises(operator.Refusal):
            self.publish(self.original)
        self.assertEqual(self.switches, [])

    def test_fresh_migration_refuses_unapproved_nonpublic_change_with_matching_stage_bytes(self):
        self.prepare_cohort(unrelated_sql="UPDATE admin_users SET blocked=1 WHERE id=4")
        self.assert_refused()

    def test_fresh_migration_refuses_a_receipt_from_another_operation(self):
        self.prepare_cohort()
        receipt = json.loads(self.receipt.read_bytes())
        self.write_json(self.receipt, {**receipt, "operationId": "staging194-other-operation"})
        with self.assertRaises(operator.Refusal):
            self.publish(self.original)
        self.assertEqual(self.switches, [])

    def test_fresh_migration_refuses_unreviewed_moscow_calendar_change(self):
        self.prepare_cohort(unrelated_sql="UPDATE schedule_entries SET startAt='2026-11-19T20:59:59Z'")
        self.assert_refused()


class WouldSwitch(Exception):
    """Stop immediately before any actual publication or service checks."""


class ProductionStaticProjectorTests(unittest.TestCase):
    def test_initial_production_requires_exact_terminal_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            operation = rehearsal_host.INITIAL_PROD_OPERATION_ID
            release = root / f"{OLD_PROJECTOR}-{operation}"
            release.mkdir()
            digest = "a" * 64
            snapshot = "snap:" + "b" * 64
            info = {"commit": OLD_PROJECTOR, "operationId": operation,
                    "snapshotId": snapshot, "staticTreeSha256": digest}
            (release / "release.json").write_text(json.dumps(info))
            (root / "initial-prod").mkdir()
            (root / "production-paired").mkdir()
            config = {"stateDir": str(root / "production-paired")}
            state = rehearsal_host.RehearsalState(root / "initial-prod")
            state.begin(operation, OLD_PROJECTOR, {"cmsSha": SOURCE, "staticSha": SOURCE})
            state.confirm_fence(operation, lambda: True)
            state.mark_cms_activated(operation)
            state.accept_new_pair(operation, {"sourceSha": OLD_PROJECTOR, "cmsSha": OLD_PROJECTOR,
                "staticSha": OLD_PROJECTOR, "snapshotId": snapshot, "staticTreeSha256": digest})
            state.commit(operation)
            state.finalize(operation, lambda: True)
            self.assertEqual(rehearsal_host._production_static_projector(config, release, digest, {})["sourceSha"], OLD_PROJECTOR)
            (release / "release.json").write_text(json.dumps({**info, "snapshotId": "snap:" + "c" * 64}))
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "terminal operation"):
                rehearsal_host._production_static_projector(config, release, digest, {})

    def test_cms_refresh_uses_terminal_state_and_active_cms_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            release = root / "content-1780000000000"
            release.mkdir()
            info = {"commit": OLD_PROJECTOR, "snapshotId": "snap:" + "a" * 64}
            state = {"status": "succeeded", "phase": "done", "switched": True, "releaseId": release.name}
            release_file = release / "release.json"
            state_file = root / "refresh-state.json"
            config = {"siteRefreshState": str(state_file)}
            release_file.write_text(json.dumps(info))
            state_file.write_text(json.dumps(state))
            environment = {"IKPK_INSTALLED_COMMIT": OLD_PROJECTOR}
            self.assertEqual(rehearsal_host._production_static_projector(config, release, "unused", environment),
                {"sourceSha": OLD_PROJECTOR, "snapshotId": info["snapshotId"],
                 "releaseMetadataSha256": sha(release_file.read_bytes())})
            state_file.write_text(json.dumps({**state, "commit": SOURCE}))
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "disagrees"):
                rehearsal_host._production_static_projector(config, release, "unused", environment)
            release_file.write_text(json.dumps({**info, "commit": SOURCE}))
            state_file.write_text(json.dumps({**state, "commit": SOURCE}))
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "disagrees"):
                rehearsal_host._production_static_projector(config, release, "unused", environment)


class CrossVersionPublicProjectionTests(unittest.TestCase):
    def test_expected_v2_result_preserves_untouched_public_content_and_relation_identity(self):
        teacher_a = {"id": 1, "legacy_id": "99", "name": "Teacher A", "order": 1}
        teacher_b = {"id": 2, "legacy_id": "100", "name": "Teacher B", "order": 2}
        seminar = {"id": 3, "name": "Seminar", "description_html": "<p>Legacy public text</p>",
                   "description_text": "Legacy public text",
                   "teachers": [{"legacy_id": "99", "name": "Teacher A", "order": 1}]}
        occurrence = {"id": 4, "price": 0, "city": "Онлайн", "startAt": "2027-02-10T21:00:00.000Z",
                      "registrationFormLink": "https://forms.invalid/approve",
                      "teachers": [{"id": "99", "fullName": "Teacher A"}],
                      "seminar": {"id": 3, "name": "Seminar", "slug": "seminar"}}
        article = {"id": 5, "body_html": "<p>Untouched article</p>"}
        original = {"content": {"media": [{"ref": "/uploads/photo.webp", "contentId": "abc"}],
                               "types": {"teachers": [teacher_a, teacher_b], "seminars": [seminar],
                                         "schedule_entries": [occurrence], "articles": [article]}}}
        target = copy.deepcopy(original)
        target["contractVersion"] = 2
        actual = target["content"]["types"]
        for row, document in zip((actual["teachers"][0], actual["teachers"][1], actual["seminars"][0],
                                  actual["schedule_entries"][0], actual["articles"][0]),
                                 ("teacher-a", "teacher-b", "seminar", "entry", "article")):
            row["documentId"] = document
        actual["seminars"][0].update({"documents": [{"id": 21, "registry": [{"id": 51}]}],
                                      "content_section_anchors": {"documents": "documents"}})
        actual["seminars"][0]["teachers"][0]["documentId"] = "teacher-a"
        actual["schedule_entries"][0].update({"isOnline": True, "price": None, "city": None})
        actual["schedule_entries"][0]["teachers"][0]["documentId"] = "teacher-a"
        actual["schedule_entries"][0]["seminar"]["documentId"] = "seminar"
        reviewed = {
            "version": 1,
            "documentIds": {"teachers": {"1": "teacher-a", "2": "teacher-b"}, "seminars": {"3": "seminar"},
                            "schedule_entries": {"4": "entry"}, "articles": {"5": "article"}},
            "schedule": {"4": {"price": None, "city": None, "isOnline": True}},
            "seminars": {"3": {"documents": [{"id": 21, "registry": [{"id": 51}]}],
                               "content_section_anchors": {"documents": "documents"}}},
        }
        operator.validate_migrated_public_projection(original, target, reviewed)
        mutations = [
            ("teachers", lambda doc: doc["content"]["types"]["schedule_entries"][0]["teachers"][0]
                .update(documentId="teacher-b")),
            ("anchor", lambda doc: doc["content"]["types"]["seminars"][0]["content_section_anchors"].clear()),
            ("registry", lambda doc: doc["content"]["types"]["seminars"][0]["documents"][0]["registry"].clear()),
            ("unrelated article", lambda doc: doc["content"]["types"]["articles"][0].pop("body_html")),
            ("another calendar", lambda doc: doc["content"]["types"]["schedule_entries"][0]
                .update(startAt="2027-02-11T00:00:00.000Z")),
            ("registration address", lambda doc: doc["content"]["types"]["schedule_entries"][0]
                .update(registrationFormLink="https://forms.invalid/unreviewed")),
            ("media", lambda doc: doc["content"]["media"].clear()),
        ]
        for description, mutate in mutations:
            with self.subTest(description=description):
                changed = copy.deepcopy(target)
                mutate(changed)
                with self.assertRaises(operator.Refusal):
                    operator.validate_migrated_public_projection(original, changed, reviewed)


@unittest.skipUnless(os.environ.get("IKPK_TEST_HISTORICAL_BACKUP"),
                     "set IKPK_TEST_HISTORICAL_BACKUP to the private verified 43b0/9fad tar")
class HistoricalProductionRecoveryTests(unittest.TestCase):
    def setUp(self):
        source = Path(os.environ["IKPK_TEST_HISTORICAL_BACKUP"])
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.record = json.loads(source.with_suffix(".json").read_text(encoding="utf-8"))
        self.assertEqual(self.record["oldCmsSourceSha"], OLD_CMS)
        self.assertEqual(self.record["sourceSha"], OLD_PROJECTOR)
        self.operation = self.record["operationId"]
        self.backup = self.root / f"{self.operation}.tar"
        shutil.copyfile(source, self.backup)
        operator.verify_backup_tar(self.backup.read_bytes(), self.record["sha256"])
        self.restored = self.root / "restored.sqlite"
        self.actions = []

    def recover(self):
        self.backup.with_suffix(".json").write_text(json.dumps(self.record), encoding="utf-8")
        args = Namespace(profile="production-paired", command="recover", host=None,
                         operation_id=self.operation, backup_dir=str(self.root),
                         rollback_committed=False, operator=None, reason=None)

        def ssh(arguments, *, profile, input_bytes=None):
            self.assertEqual(profile, "production-paired")
            self.assertIn(self.operation, arguments)
            action = arguments[0]
            self.actions.append(action)
            if action == "status":
                result = {"operationId": self.operation, "phase": "cms-activated", "fence": "closed",
                          "oldPair": {"cmsPath": f"/releases/{OLD_CMS}-old/cms-artifact"}}
            elif action == "restore":
                fingerprint = arguments[arguments.index("--restore-fingerprint") + 1]
                self.assertEqual(fingerprint, self.record["snapshotFingerprint"])
                self.assertEqual(sha(input_bytes), self.record["sha256"])
                archive_digest = arguments[arguments.index("--backup-sha256") + 1]
                capture = self.root / "host-offhost" / self.operation
                capture.mkdir(parents=True)
                (capture / "manifest.json").write_text(json.dumps({
                    "operationId": self.operation, "archiveSha256": self.record["sha256"],
                }), encoding="utf-8")
                imported = rehearsal_host._import_offhost_backup(
                    {"backupRoot": str(capture.parent)}, self.operation, input_bytes, archive_digest,
                )
                self.restored.write_bytes(b"old local target for atomic replacement")
                rehearsal_host._copy_atomic(imported / "database.sqlite", self.restored)
                result = {"phase": "restore-staged"}
            elif action == "finalize-recover":
                self.assertEqual(arguments[arguments.index("--restore-fingerprint") + 1],
                                 self.record["snapshotFingerprint"])
                result = {"phase": "recovered"}
            else:
                self.fail(f"unexpected recovery request {action}")
            return json.dumps(result).encode()

        with patch.object(operator, "ssh_remote", side_effect=ssh):
            operator.invoke(args)

    def test_resumed_recovery_uses_historical_projection_and_restores_original_bytes(self):
        self.recover()
        self.assertEqual(self.actions, ["status", "status", "restore", "finalize-recover"])
        with tarfile.open(self.backup) as archive:
            original = archive.extractfile("database.sqlite").read()
        self.assertEqual(sha(self.restored.read_bytes()), sha(original))
        with sqlite3.connect(f"file:{self.restored}?mode=ro", uri=True) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_recovery_refuses_candidate_fingerprint_as_restore_proof(self):
        original = self.record["snapshotFingerprint"]
        self.record["snapshotFingerprint"] = "sha256:" + sha(b"migrated candidate fingerprint")
        with patch.object(operator, "production_paired_backup_fingerprint", return_value=original), \
             self.assertRaisesRegex(operator.Refusal, "snapshot fingerprint differs"):
            self.recover()
        self.assertEqual(self.actions, ["status", "status"])
        self.assertFalse(self.restored.exists())

    def test_recovery_refuses_tampered_archive_before_restore(self):
        with self.backup.open("ab") as archive:
            archive.write(b"changed after verification")
        with self.assertRaisesRegex(operator.Refusal, "backup bytes no longer match"):
            self.recover()
        self.assertEqual(self.actions, ["status"])
        self.assertFalse(self.restored.exists())


class OrdinaryProjectorEquivalenceTests(unittest.TestCase):
    """Fail-closed compatibility check for the one reviewed diagnostics-only pair."""

    OLD_PROJECTOR_SHA = "62744c31283e2c9b31e84512d3b8cfc793e8d5f7"
    CANDIDATE_PROJECTOR_SHA = "7b4548d234710e0f0daacc2c8a46787b1e822e2f"
    OLD_CONTRACT_SHA256 = "3928819713b00cfbf982186d67ed2e29f47b913c9a9ba019ee0106b7255904b9"
    CANDIDATE_CONTRACT_SHA256 = "cf536b99bc5815a8b5a76f8315f07c60200c0d1d5728960e9a9593b1c113bcf0"
    SCHEMA_SHA256 = "b" * 64

    def test_reviewed_contract_digests_match_the_exact_git_trees(self):
        self.assertEqual(operator.production_projector_contract(self.OLD_PROJECTOR_SHA, self.OLD_PROJECTOR_SHA),
                         self.OLD_CONTRACT_SHA256)
        self.assertEqual(operator.production_projector_contract(
            self.CANDIDATE_PROJECTOR_SHA, self.CANDIDATE_PROJECTOR_SHA), self.CANDIDATE_CONTRACT_SHA256)

    def test_historical_projector_offline_install_timeout_is_a_clear_refusal(self):
        original_run = subprocess.run

        def timeout_npm_ci(command, *args, **kwargs):
            if command[:2] == ["npm", "ci"]:
                raise subprocess.TimeoutExpired(command, timeout=300)
            return original_run(command, *args, **kwargs)

        with tempfile.TemporaryDirectory(prefix="ikpk-projector-install-timeout-") as directory, \
             patch.object(subprocess, "run", side_effect=timeout_npm_ci):
            with self.assertRaisesRegex(operator.Refusal, "dependency installation timed out"):
                operator._prepare_historical_projector(
                    self.CANDIDATE_PROJECTOR_SHA, Path(directory) / "historical-projector")

    def snapshots(self):
        content = {
            "types": {
                "schedule_entries": [{
                    "id": 17, "seminar": {"id": 3, "slug": "seminar"},
                    "unknownPublicField": {"nested": [True, 1, None]},
                }],
                "seminars": [{"id": 3, "title": "Seminar"}],
            },
            "media": [{"ref": "/uploads/a.png", "contentId": "sha256:abc"}],
            "historicalExceptions": [],
        }
        proof = {"version": 1, "method": "quiesced-sqlite-backup", "sourceSha": self.CANDIDATE_PROJECTOR_SHA,
                 "runId": 7, "attempt": 2, "captureId": "operation", "schemaDigest": self.SCHEMA_SHA256,
                 "databaseDigest": "c" * 64, "mediaManifestDigest": "d" * 64, "bundleDigest": "e" * 64}
        snapshot = {"contractVersion": 2, "fingerprint": "sha256:" + sha(b"equal"),
                    "referenceDate": "2026-11-21", "snapshotId": "snap:equal",
                    "sourcePolicy": "production-static", "sourceAge": "source-bound",
                    "origin": {"kind": "server-db", "sourceId": "initial-prod-server-db",
                               "capturedAt": "2026-11-21T10:00:00Z"},
                    "skippedUploads": [], "content": content, "captureProof": proof}
        return copy.deepcopy(snapshot), copy.deepcopy(snapshot)

    def compare(self, old, candidate, *, old_projector_sha=None, candidate_projector_sha=None,
                candidate_projector_contract_sha256=None, old_schema_sha256=None,
                candidate_schema_sha256=None):
        return operator.validate_ordinary_projector_equivalence(
            old, candidate,
            old_projector_sha=old_projector_sha or self.OLD_PROJECTOR_SHA,
            candidate_projector_sha=candidate_projector_sha or self.CANDIDATE_PROJECTOR_SHA,
            old_projector_contract_sha256=self.OLD_CONTRACT_SHA256,
            candidate_projector_contract_sha256=(candidate_projector_contract_sha256
                                                 or self.CANDIDATE_CONTRACT_SHA256),
            old_schema_sha256=old_schema_sha256 or self.SCHEMA_SHA256,
            candidate_schema_sha256=candidate_schema_sha256 or self.SCHEMA_SHA256,
        )

    def test_reviewed_projector_pair_accepts_identical_complete_projection(self):
        old, candidate = self.snapshots()
        self.compare(old, candidate)

    def test_refuses_changed_contract_version_when_projection_is_identical(self):
        old, candidate = self.snapshots()
        candidate["contractVersion"] = 1
        with self.assertRaises(operator.Refusal):
            self.compare(old, candidate)

    def test_refuses_changed_schema_contract_when_projection_is_identical(self):
        old, candidate = self.snapshots()
        with self.assertRaises(operator.Refusal):
            self.compare(old, candidate, candidate_schema_sha256="c" * 64)

    def test_refuses_changed_reference_date(self):
        old, candidate = self.snapshots()
        candidate["referenceDate"] = "2026-11-22"
        with self.assertRaises(operator.Refusal):
            self.compare(old, candidate)

    def test_refuses_any_public_content_change(self):
        old, candidate = self.snapshots()
        candidate["content"]["types"]["schedule_entries"][0]["seminar"]["slug"] = "changed"
        with self.assertRaises(operator.Refusal):
            self.compare(old, candidate)

    def test_refuses_changed_unknown_public_field(self):
        old, candidate = self.snapshots()
        candidate["content"]["types"]["schedule_entries"][0]["newField"] = "must not be ignored"
        with self.assertRaises(operator.Refusal):
            self.compare(old, candidate)

    def test_refuses_boolean_and_number_as_equal_public_values(self):
        old, candidate = self.snapshots()
        candidate["content"]["types"]["schedule_entries"][0]["unknownPublicField"]["nested"][0] = 1
        with self.assertRaises(operator.Refusal):
            self.compare(old, candidate)

    def test_strict_archive_reader_rejects_duplicate_json_keys(self):
        payload = b'{"schemaDigest":"' + self.SCHEMA_SHA256.encode() + b'","schemaDigest":"' + self.SCHEMA_SHA256.encode() + b'"}'
        archive_bytes = io.BytesIO()
        with tarfile.open(fileobj=archive_bytes, mode="w:") as archive:
            member = tarfile.TarInfo("snapshot/capture-manifest.json")
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
        archive_bytes.seek(0)
        with tarfile.open(fileobj=archive_bytes, mode="r:") as archive:
            with self.assertRaises(operator.Refusal):
                operator._strict_archive_json(archive, "snapshot/capture-manifest.json")

    def test_refuses_unreviewed_projector_pair_even_when_projection_is_identical(self):
        old, candidate = self.snapshots()
        with self.assertRaises(operator.Refusal):
            self.compare(old, candidate, candidate_projector_contract_sha256="f" * 64)
