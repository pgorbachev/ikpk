import hashlib
import base64
import getpass
import importlib.util
import io
import json
import re
import sqlite3
import subprocess
import shutil
import stat
import tarfile
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from scripts.lib import rehearsal_host
from scripts.lib.rehearsal_host import _copy_atomic, _switch_pointer
from scripts.lib.rehearsal_state import RehearsalState


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("staging193_operator", ROOT / "scripts/rehearsal/staging193.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


def sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def backup_archive(operation_id="operator-test"):
    with tempfile.TemporaryDirectory(prefix="ikpk-offhost-source-") as temporary:
        root = Path(temporary)
        database = root / "database.sqlite"
        db = sqlite3.connect(database)
        db.execute("CREATE TABLE content (body TEXT NOT NULL)")
        db.execute("INSERT INTO content VALUES ('accepted editor write')")
        db.commit()
        db.close()
        database_bytes = database.read_bytes()
        image_bytes = b"image bytes"
        media = [{"url": "/uploads/photo.jpg", "file": "media/sha256:photo",
                  "sha256": sha(image_bytes), "size": len(image_bytes), "originalName": "photo.jpg",
                  "mode": 0o640, "uid": 987, "gid": 987}]
        media_bytes = json.dumps({"media": media}, sort_keys=True).encode() + b"\n"
        manifest_bytes = json.dumps({"version": 1, "operationId": operation_id,
            "databaseSha256": sha(database_bytes), "mediaManifestSha256": sha(media_bytes),
            "media": media}, sort_keys=True).encode() + b"\n"
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as output:
            for name, payload in (("database.sqlite", database_bytes), ("media-manifest.json", media_bytes),
                                  ("manifest.json", manifest_bytes), ("media/sha256:photo", image_bytes)):
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                info.mode = 0o600
                output.addfile(info, io.BytesIO(payload))
        return archive.getvalue()


class RehearsalHostFilesystemTests(unittest.TestCase):
    def test_initial_prod_config_template_binds_real_profile_and_all_writer_routes(self):
        config = json.loads((ROOT / "scripts/initial-prod-rehearsal.json").read_text(encoding="utf-8"))
        rehearsal_host._validate_target_binding(config)
        self.assertEqual(config["profile"], "initial-prod")
        self.assertEqual(config["initialOperationId"], rehearsal_host.INITIAL_PROD_OPERATION_ID)
        self.assertEqual(config["paymentEndpointProd"], rehearsal_host.INITIAL_PROD_PAYMENT_ENDPOINT)
        self.assertEqual(config["writerUnits"], ["ikpk-cms.service"])
        self.assertEqual(len(config["writerProbeUrls"]), len(config["writerPrefixes"]))
        self.assertEqual(config["targetHost"], rehearsal_host.INITIAL_PROD_HOST)
        self.assertEqual(config["allowedSourceRef"], "refs/heads/main")

    def test_production_static_config_isolated_and_bound_to_current_production_data(self):
        config = json.loads((ROOT / "scripts/production-static-rehearsal.json").read_text(encoding="utf-8"))
        rehearsal_host._validate_target_binding(config)
        self.assertEqual(config["profile"], "production-static")
        self.assertNotEqual(config["stateDir"], "/var/lib/ikpk-rehearsal/initial-prod")
        self.assertNotEqual(config["stateDir"], "/var/lib/ikpk-rehearsal/staging194")
        self.assertEqual(config["cmsDatabase"], "/var/lib/ikpk-cms/trial/data/data.db")
        self.assertEqual(config["currentStatic"], "/var/www/ikpk/current")
        self.assertEqual(config["staticReleaseRoot"], "/var/www/ikpk/releases")
        for changed in ({**config, "targetHost": "194.226.99.10"},
                        {**config, "currentStatic": "/opt/ikpk-cms/current"},
                        {**config, "cmsDatabase": "/tmp/unrelated.db"},
                        {**config, "mediaRoots": []}):
            with self.subTest(changed=changed), self.assertRaises(rehearsal_host.HostFailure):
                rehearsal_host._validate_target_binding(changed)

    def test_initial_prod_ci_admission_uses_exact_canonical_main_push_run(self):
        sha = "a" * 40
        run_row = {"databaseId": 123, "headSha": sha, "event": "push", "status": "completed",
                   "conclusion": "success", "attempt": 2, "workflowName": "Tests",
                   "headBranch": "main", "createdAt": "2026-10-19T09:00:00Z"}
        jobs = {"jobs": [{"name": name, "status": "completed", "conclusion": "success"}
                         for name in operator.REQUIRED_TEST_JOBS]}
        outputs = iter(("", "pgorbachev/ikpk", sha, json.dumps([run_row]), json.dumps(jobs)))
        commands = []
        def fake_capture(argv):
            commands.append(argv)
            return next(outputs)
        with patch.object(operator, "capture", side_effect=fake_capture):
            provenance = operator.validate_sha_and_ci(sha, "initial-prod")
        self.assertEqual((provenance["ref"], provenance["headBranch"], provenance["runId"], provenance["attempt"]),
                         ("refs/heads/main", "main", 123, 2))
        self.assertIn(f"repos/{operator.CANONICAL_REPOSITORY}/git/ref/heads/main", " ".join(commands[2]))

    def test_initial_prod_binding_is_fixed_to_main_target_and_operation(self):
        data = {"profile": "initial-prod", "allowedSourceRef": "refs/heads/main",
                "targetHost": "89.111.184.196", "initialOperationId": "initial-prod-20261019-A-01",
                "cmsHealthUrl": "http://127.0.0.1:1337/_health",
                "siteHealthUrl": "https://ikpk.su/", "siteBaseUrl": "https://ikpk.su",
                "siteReleaseUrl": "https://ikpk.su/release.json",
                "preserveProbeUrl": "https://ikpk.su/", "paymentStatusProbeUrl": "https://ikpk.su/api/payments/rehearsal/status",
                "siteProbeUrls": ["https://ikpk.su/"], "writerProbeUrls": ["https://ikpk.su/api"]}
        rehearsal_host._validate_target_binding(data)
        for changed in ({**data, "targetHost": "194.226.99.10"},
                        {**data, "allowedSourceRef": "refs/heads/dev"},
                        {**data, "initialOperationId": "another-operation"},
                        {**data, "siteProbeUrls": ["https://194.226.99.10/"]}):
            with self.subTest(changed=changed), self.assertRaises(rehearsal_host.HostFailure):
                rehearsal_host._validate_target_binding(changed)

    def test_initial_prod_recovery_refuses_before_opening_state(self):
        args = Namespace(profile="initial-prod", action="recover",
                          operation_id="initial-prod-20261019-A-01", backup_sha256=None)
        config = {"profile": "initial-prod", "stateDir": "/var/lib/ikpk/initial-prod"}
        with patch.object(rehearsal_host.os, "geteuid", return_value=0), \
             patch.object(rehearsal_host, "_root_config", return_value=config) as load_config, \
             patch.object(rehearsal_host, "RehearsalState") as state:
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "recovery is disabled"):
                rehearsal_host.dispatch(args)
        load_config.assert_called_once_with(rehearsal_host.INITIAL_PROD_CONFIG_PATH, expected_profile="initial-prod")
        state.assert_not_called()

    def test_initial_prod_operator_refuses_recovery_before_any_ssh(self):
        args = Namespace(profile="initial-prod", host=None, command="recover",
                         operation_id="initial-prod-20261019-A-01", backup_dir=None)
        with patch.object(operator, "ssh_remote", side_effect=AssertionError("must not connect")):
            with self.assertRaisesRegex(operator.Refusal, "no DB restore command"):
                operator.invoke(args)

    def test_inactive_initial_prod_old_pair_records_no_fake_process_proof(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-inactive-prod-baseline-") as temporary:
            root = Path(temporary)
            database = root / "data.db"
            database.write_bytes(b"existing production database")
            environment_file = root / "trial.env"
            environment_file.write_text("# no database overrides\n", encoding="utf-8")
            cms, static, uploads = root / "cms", root / "static", root / "uploads"
            for directory in (cms, static, uploads):
                directory.mkdir()
            config = {"profile": "initial-prod", "currentCms": str(root / "current-cms"),
                      "currentStatic": str(root / "current-static"), "cmsDatabase": str(database),
                      "mediaRoots": [{"prefix": "/uploads/", "path": str(uploads)}],
                      "cmsUnit": "ikpk-cms.service"}
            def command(argv, **kwargs):
                prop = argv[2]
                if "ActiveState" in prop:
                    value = "inactive\n"
                elif "MainPID" in prop:
                    value = "0\n"
                elif "EnvironmentFiles" in prop:
                    value = f"{environment_file} (ignore_errors=no)\n"
                else:
                    value = f"DATABASE_CLIENT=sqlite DATABASE_FILENAME={database} HOME=/var/lib/ikpk-cms/trial/data\n"
                return subprocess.CompletedProcess(argv, 0, stdout=value, stderr="")
            with patch.object(rehearsal_host, "_current_target", side_effect=[cms, static]), \
                 patch.object(rehearsal_host, "_cms_payload_sha256", return_value="a" * 64), \
                 patch.object(rehearsal_host, "_tree_sha256", return_value="b" * 64), \
                 patch.object(rehearsal_host, "_config_sha256", return_value="c" * 64), \
                 patch.object(rehearsal_host, "INITIAL_PROD_CMS_ENV_FILE", environment_file), \
                 patch.object(rehearsal_host, "run", side_effect=command), \
                 patch.object(rehearsal_host, "_database_process_proof", side_effect=AssertionError("fake proof")):
                result = rehearsal_host._old_pair(config)
            self.assertEqual(result["cmsDatabaseProof"], {
                "kind": "inactive-configured-db", "activeState": "inactive", "mainPid": 0,
                "database": str(database.resolve()), "configSha256": "c" * 64,
                "environmentFile": str(environment_file), "databaseClient": "sqlite"})

            def extra_environment_command(argv, **kwargs):
                result = command(argv, **kwargs)
                if "EnvironmentFiles" in argv[2]:
                    return subprocess.CompletedProcess(argv, 0,
                        stdout=f"{environment_file} (ignore_errors=no) /etc/ikpk-cms/extra.env (ignore_errors=no)\n",
                        stderr="")
                return result

            with patch.object(rehearsal_host, "_current_target", side_effect=[cms, static]), \
                 patch.object(rehearsal_host, "_cms_payload_sha256", return_value="a" * 64), \
                 patch.object(rehearsal_host, "_tree_sha256", return_value="b" * 64), \
                 patch.object(rehearsal_host, "_config_sha256", return_value="c" * 64), \
                 patch.object(rehearsal_host, "INITIAL_PROD_CMS_ENV_FILE", environment_file), \
                 patch.object(rehearsal_host, "run", side_effect=extra_environment_command):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "unreviewed CMS environment-file set"):
                    rehearsal_host._old_pair(config)

    def test_staging_old_pair_still_requires_a_live_database_process_proof(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-active-staging-baseline-") as temporary:
            root = Path(temporary)
            database = root / "data.db"
            database.write_bytes(b"staging database")
            config = {"profile": "staging194", "cmsUnit": "ikpk-cms.service",
                      "currentCms": str(root / "current-cms"), "currentStatic": str(root / "current-static"),
                      "cmsDatabase": str(database),
                      "mediaRoots": [{"prefix": "/uploads/", "path": str(root)}]}
            with patch.object(rehearsal_host, "_current_target", side_effect=[root, root]), \
                 patch.object(rehearsal_host, "_cms_payload_sha256", return_value="a" * 64), \
                 patch.object(rehearsal_host, "_tree_sha256", return_value="b" * 64), \
                 patch.object(rehearsal_host, "_config_sha256", return_value="c" * 64), \
                 patch.object(rehearsal_host, "_service_pid", side_effect=rehearsal_host.HostFailure("CMS service has no live MainPID")):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "live MainPID"):
                    rehearsal_host._old_pair(config)

    def test_host_binding_rejects_wrong_host_and_cross_host_probe_urls(self):
        data = {"allowedSourceRef": "refs/heads/dev", "targetHost": "194.226.99.10",
                "cmsHealthUrl": "http://127.0.0.1:1338/_health",
                "siteHealthUrl": "https://194.226.99.10/", "siteBaseUrl": "https://194.226.99.10",
                "siteReleaseUrl": "https://194.226.99.10/release.json",
                "preserveProbeUrl": "https://194.226.99.10/",
                "paymentStatusProbeUrl": "https://194.226.99.10/api/payments/rehearsal/status",
                "siteProbeUrls": ["https://194.226.99.10/"],
                "writerProbeUrls": ["https://194.226.99.10/api"]}
        rehearsal_host._validate_target_binding(data)
        for changed in (
            {**data, "targetHost": "193.124.115.99"},
            {**data, "cmsHealthUrl": "https://ikpk.su/_health"},
            {**data, "siteProbeUrls": ["https://193.124.115.99/"]},
            {**data, "writerProbeUrls": ["https://193.124.115.99/api"]},
        ):
            with self.subTest(changed=changed):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "staging194"):
                    rehearsal_host._validate_target_binding(changed)

    def _activate_for_media_probe_test(self, media_inventory, cms_health_url="http://127.0.0.1:1338/_health"):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-media-probe-") as temporary:
            root = Path(temporary)
            live_database = root / "live.sqlite"
            live_database.write_bytes(b"old database")
            capture = root / "capture"
            capture.mkdir()
            (capture / "media-manifest.json").write_text(
                json.dumps({"media": media_inventory}), encoding="utf-8")
            config = {"cmsDatabase": str(live_database), "currentCms": str(root / "current"),
                      "releaseRoot": str(root / "releases"), "cmsUnit": "ikpk-cms-prototype193.service",
                      "cmsHealthUrl": cms_health_url}
            commands = []

            def run_command(argv, **kwargs):
                commands.append(argv)
                return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

            with patch.object(rehearsal_host, "_assert_no_database_handles"), \
                 patch.object(rehearsal_host, "_copy_atomic"), \
                 patch.object(rehearsal_host, "_switch_pointer"), \
                 patch.object(rehearsal_host, "_wait_health"), \
                 patch.object(rehearsal_host, "_service_pid", return_value=123), \
                 patch.object(rehearsal_host, "_database_process_proof", return_value={}), \
                 patch.object(rehearsal_host, "run", side_effect=run_command):
                rehearsal_host._activate_cms(config, root / "new-release", root / "candidate.db", capture)
            return [argv for argv in commands if argv[0] == "/usr/bin/curl"]

    def test_cms_activation_probes_upload_when_sorted_manifest_starts_with_legacy_media(self):
        legacy = {"url": "/media/_w/1200/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp",
                  "originalName": "_w/1200/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp"}
        upload = {"url": "/uploads/1_1727008400454_5a30189ad6.webp",
                  "originalName": "1_1727008400454_5a30189ad6.webp"}

        probes = self._activate_for_media_probe_test([legacy, upload])

        self.assertEqual(len(probes), 1)
        self.assertEqual(probes[0][-1], "http://127.0.0.1:1338/uploads/1_1727008400454_5a30189ad6.webp")

    def test_initial_prod_cms_activation_probes_upload_on_configured_1337_port(self):
        upload = {"url": "/uploads/prod-image.webp", "originalName": "prod-image.webp"}
        probes = self._activate_for_media_probe_test([upload], "http://127.0.0.1:1337/_health")
        self.assertEqual(probes[0][-1], "http://127.0.0.1:1337/uploads/prod-image.webp")

    def test_cms_activation_fails_clearly_when_capture_has_no_upload_entry(self):
        legacy = {"url": "/media/_w/1200/uploads/legacy.webp",
                  "originalName": "_w/1200/uploads/legacy.webp"}

        with self.assertRaisesRegex(rehearsal_host.HostFailure, "no /uploads/ entry"):
            self._activate_for_media_probe_test([legacy])

    def test_unprivileged_build_has_a_systemd_runtime_deadline_before_client_timeout(self):
        completed = subprocess.CompletedProcess([], 0, stdout="finished", stderr="")
        with patch.object(rehearsal_host.pwd, "getpwnam", return_value=type("User", (), {"pw_name": "ikpk-cms"})()), \
             patch.object(rehearsal_host, "run", return_value=completed) as run_command:
            result = rehearsal_host._run_as_cms({"cmsUser": "ikpk-cms"}, Path("/tmp/cms"),
                                                 ["/usr/bin/npm", "ci"], timeout=90)
        command = run_command.call_args.args[0]
        self.assertIn("--property=RuntimeMaxSec=60s", command)
        self.assertIn("--property=TimeoutStopSec=15s", command)
        self.assertEqual(run_command.call_args.kwargs["timeout"], 90)
        self.assertEqual(result, "finished")

    def test_cms_artifact_build_can_mount_only_its_validated_dependency_tree_read_only(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-readonly-cms-deps-") as temporary:
            dependencies = Path(temporary) / "deps/node_modules"
            dependencies.mkdir(parents=True)
            completed = subprocess.CompletedProcess([], 0, stdout="finished", stderr="")
            user = type("User", (), {"pw_name": "ikpk-cms"})()
            with patch.object(rehearsal_host.pwd, "getpwnam", return_value=user), \
                 patch.object(rehearsal_host, "run", return_value=completed) as run_command:
                rehearsal_host._run_as_cms({"cmsUser": "ikpk-cms"}, Path("/tmp/cms"),
                    ["/usr/bin/bash", "build-cms-artifact.sh"], read_only_path=dependencies.resolve())

            command = run_command.call_args.args[0]
            self.assertIn(f"--property=ReadOnlyPaths={dependencies.resolve()}", command)
            self.assertEqual(command[-2:], ["/usr/bin/bash", "build-cms-artifact.sh"])

    def test_prepared_candidate_refuses_reused_generation_with_strapi_version_mismatch(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-strapi-mismatch-") as temporary:
            root = Path(temporary)
            source_sha, operation_id = "a" * 40, "strapi-op"
            source = root / f"{source_sha}-{operation_id}"
            cms = source / "cms"
            cms.mkdir(parents=True)
            (source / ".ikpk-rehearsal-ci.json").write_text(json.dumps(
                {"sourceSha": source_sha, "ref": "refs/heads/dev"}))
            (cms / "package.json").write_text(json.dumps({"dependencies": {"@strapi/strapi": "5.51.1"}}))
            lock = {"packages": {"node_modules/@strapi/strapi": {"version": "5.51.2"}}}
            lock_bytes = json.dumps(lock, sort_keys=True).encode()
            (cms / "package-lock.json").write_bytes(lock_bytes)
            dependencies = root / "deps/node_modules"
            (dependencies / "@strapi/strapi").mkdir(parents=True)
            (dependencies / "@strapi/strapi/package.json").write_text(json.dumps({"version": "5.51.2"}))
            (cms / "node_modules").symlink_to(dependencies, target_is_directory=True)
            artifact = rehearsal_host._cms_artifact_path(source, operation_id)
            (artifact / "dist/config").mkdir(parents=True)
            (artifact / "database").mkdir()
            (artifact / "scripts").mkdir()
            (artifact / "package.json").write_text(json.dumps({"dependencies": {"@strapi/strapi": "5.51.1"}}))
            (artifact / "package-lock.json").write_bytes(lock_bytes)
            for name in ("tsconfig.json", "dist/config/database.js", "database/.migrations-expected",
                         "scripts/run-data-migrations.mjs"):
                (artifact / name).write_text("test")
            (artifact / "node_modules").symlink_to(dependencies, target_is_directory=True)
            web_dependencies = source / "web/node_modules"
            for package in ("astro", "tsx"):
                (web_dependencies / package).mkdir(parents=True)
                (web_dependencies / package / "package.json").write_text("{}")
            (web_dependencies / ".bin").mkdir()
            for package in ("astro", "tsx"):
                (web_dependencies / package / "bin.js").write_text("")
                (web_dependencies / ".bin" / package).symlink_to(f"../{package}/bin.js")
            expected = {"version": 1, "lockSha256": sha(lock_bytes), "profile": "full-build",
                        "nodeVersion": "v24.1.0", "nodeAbi": "137", "platform": "linux",
                        "architecture": "x64"}
            config = {"allowedSourceRef": "refs/heads/dev", "cmsUser": getpass.getuser()}
            with patch.object(rehearsal_host, "_cms_build_generation", return_value=(root / "unused", expected)), \
                 patch.object(rehearsal_host, "_validate_cms_build_generation", return_value=dependencies.resolve()):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "identities do not match"):
                    rehearsal_host._validate_prepared_cms_candidate(
                        config, source, operation_id, {"sourceSha": source_sha, "ref": "refs/heads/dev"})

    def test_prefence_candidate_installs_full_cms_deps_then_builds_artifact_with_bounded_heap(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-artifact-heap-") as temporary:
            source = Path(temporary) / "candidate"
            (source / "cms").mkdir(parents=True)
            (source / "web").mkdir()
            dependencies = Path(temporary) / "shared-deps/node_modules"
            dependencies.mkdir(parents=True)
            user = type("User", (), {"pw_name": "ikpk-cms", "pw_uid": 0, "pw_gid": 0})()
            calls = []

            def run_as_cms(_config, cwd, argv, **kwargs):
                calls.append((cwd, argv, kwargs))
                if "build-cms-artifact.sh" in " ".join(argv):
                    artifact = Path(argv[-1])
                    artifact.mkdir(parents=True)
                return ""

            with patch.object(rehearsal_host, "_prepare_cms_build_dependencies", return_value=dependencies), \
                 patch.object(rehearsal_host, "_validate_prepared_cms_candidate",
                              return_value=(source, source / ".staging193-rehearsal/op/migration/cms-artifact", dependencies)), \
                 patch.object(rehearsal_host.pwd, "getpwnam", return_value=user), \
                 patch.object(rehearsal_host.os, "chown"), patch.object(rehearsal_host.os, "chmod"), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=run_as_cms):
                rehearsal_host._prepare_cms_candidate(
                    {"cmsUser": "ikpk-cms"}, source, "op", {"sourceSha": "a" * 40})

            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][1], ["/usr/bin/npm", "ci", "--no-audit", "--no-fund"])
            self.assertEqual(calls[0][0], source / "web")
            self.assertEqual(calls[1][1][:2], ["/usr/bin/bash", str(source / "scripts/build-cms-artifact.sh")])
            self.assertEqual(calls[1][2]["timeout"], 3600)
            self.assertEqual(calls[1][2]["environment"], {"NODE_OPTIONS": "--max-old-space-size=1536"})
            self.assertEqual(calls[1][2]["read_only_path"], dependencies)

    def test_complete_cms_build_dependency_generation_is_reused_without_mutation(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-build-deps-") as temporary:
            root = Path(temporary)
            source_cms = root / "source/cms"
            source_cms.mkdir(parents=True)
            lock = {"packages": {"node_modules/@strapi/strapi": {"version": "5.20.0"}}}
            lock_bytes = json.dumps(lock, sort_keys=True).encode()
            (source_cms / "package-lock.json").write_bytes(lock_bytes)
            (source_cms / "package.json").write_text(json.dumps({"dependencies": {"@strapi/strapi": "5.20.0"}}))
            release_root = root / "artifact/releases"
            release_root.mkdir(parents=True)
            config = {"releaseRoot": str(release_root), "cmsUser": getpass.getuser()}
            lock_hash = hashlib.sha256(lock_bytes).hexdigest()
            runtime = {"abi": "137", "platform": "linux", "arch": "x64"}
            key = f"{lock_hash}-full-build-node24.1.0-linux-x64-abi137"
            generation = root / "artifact/deps" / key
            dependencies = generation / "node_modules"
            strapi = dependencies / "@strapi/strapi"
            strapi.mkdir(parents=True)
            (generation / "package-lock.json").write_bytes(lock_bytes)
            (strapi / "package.json").write_text(json.dumps({"version": "5.20.0"}))
            expected = {"version": 1, "lockSha256": lock_hash, "profile": "full-build",
                        "nodeVersion": "v24.1.0", "nodeAbi": "137", "platform": "linux",
                        "architecture": "x64"}
            (generation / ".complete").write_text(json.dumps(expected))
            result = lambda stdout: subprocess.CompletedProcess([], 0, stdout=stdout, stderr="")
            current_user = rehearsal_host.pwd.getpwnam(getpass.getuser())
            before = {path.relative_to(generation).as_posix(): path.read_bytes()
                      for path in generation.rglob("*") if path.is_file()}
            with patch.object(rehearsal_host, "run", side_effect=[result("v24.1.0\n"),
                         result(json.dumps(runtime)), result("v24.1.0\n"), result(json.dumps(runtime))]), \
                 patch.object(rehearsal_host.pwd, "getpwnam", return_value=current_user), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=AssertionError("ready deps must not reinstall")):
                reused = rehearsal_host._prepare_cms_build_dependencies(config, root / "source")

            self.assertEqual(reused, dependencies.resolve())
            self.assertEqual(key.split("-full-build-", 1)[0], lock_hash)
            after = {path.relative_to(generation).as_posix(): path.read_bytes()
                     for path in generation.rglob("*") if path.is_file()}
            self.assertEqual(after, before)

    def test_packaged_cms_uploads_reuse_the_external_original_name_tree(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-media-link-") as temporary:
            root = Path(temporary)
            artifact = root / "cms-artifact"
            uploads = artifact / "public/uploads"
            uploads.mkdir(parents=True)
            (uploads / ".gitkeep").write_text("", encoding="utf-8")
            external = root / "staging-uploads"
            external.mkdir(mode=0o700)
            (external / "photo original.jpg").write_bytes(b"editor media")
            config = {"cmsUser": getpass.getuser(),
                      "mediaRoots": [{"prefix": "/uploads/", "path": str(external)}]}
            resolved = rehearsal_host._configure_candidate_uploads(config, artifact)
            self.assertEqual(resolved, external.resolve())
            self.assertTrue(uploads.is_symlink())
            self.assertEqual(uploads.resolve(), external.resolve())
            self.assertEqual((uploads / "photo original.jpg").read_bytes(), b"editor media")
            self.assertEqual(len(rehearsal_host._cms_payload_sha256(artifact, external)), 64)

    def test_cms_payload_accepts_operation_source_dependencies_and_internal_bin_links(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-node-modules-") as temporary:
            root = Path(temporary) / "source/op/.staging193-rehearsal/op/migration"
            artifact = root / "cms-artifact"
            artifact.mkdir(parents=True)
            dependencies = root.parent.parent.parent.parent / "cms/node_modules"
            (dependencies / "@strapi/strapi/bin").mkdir(parents=True)
            (dependencies / "@strapi/strapi/bin/strapi.js").write_text("runtime", encoding="utf-8")
            (dependencies / ".bin").mkdir()
            (dependencies / ".bin/strapi").symlink_to("../@strapi/strapi/bin/strapi.js")
            (artifact / "node_modules").symlink_to(dependencies, target_is_directory=True)
            (artifact / "package-lock.json").write_text("{}", encoding="utf-8")
            (artifact / "public").mkdir()
            uploads = Path(temporary) / "uploads"
            uploads.mkdir()
            (artifact / "public/uploads").symlink_to(uploads, target_is_directory=True)
            self.assertEqual(len(rehearsal_host._cms_payload_sha256(artifact, uploads, dependencies)), 64)
            wrong_dependencies = root.parent.parent.parent.parent / "other/cms/node_modules"
            wrong_dependencies.mkdir(parents=True)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "not a private installed dependency tree"):
                rehearsal_host._cms_payload_sha256(artifact, uploads, wrong_dependencies)

            legacy = Path(temporary) / "legacy-release"
            (legacy / "node_modules/.bin").mkdir(parents=True)
            outside = Path(temporary) / "outside"
            outside.write_text("not a dependency", encoding="utf-8")
            (legacy / "node_modules/.bin/escape").symlink_to(outside)
            (legacy / "public").mkdir()
            (legacy / "public/uploads").symlink_to(uploads, target_is_directory=True)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "escapes node_modules"):
                rehearsal_host._cms_payload_sha256(legacy, uploads)

    def test_backup_and_release_tree_use_real_lstat_results(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-backup-lstat-") as temporary:
            root = Path(temporary)
            database = root / "live.sqlite"
            db = sqlite3.connect(database)
            db.execute("CREATE TABLE content (body TEXT NOT NULL)")
            db.execute("INSERT INTO content VALUES ('preserved')")
            db.commit()
            db.close()
            uploads = root / "uploads"
            uploads.mkdir()
            shared_photo = b"same photo bytes in separate namespaces"
            (uploads / "photo.jpg").write_bytes(shared_photo)
            static_media = root / "old-static/media"
            static_media.mkdir(parents=True)
            (static_media / "legacy.jpg").write_bytes(shared_photo)
            (root / "backups").mkdir()
            config = {"cmsDatabase": str(database), "backupRoot": str(root / "backups"),
                      "mediaRoots": [{"path": str(uploads), "prefix": "/uploads/"},
                                     {"path": str(static_media), "prefix": "/media/"}]}
            # /proc handle inspection is Linux-specific; exercise the real SQLite backup,
            # media walk, lstat checks, tar creation and digest verification on this host.
            with patch.object(rehearsal_host, "_assert_no_database_handles"):
                manifest = rehearsal_host._backup(config, "lstat-op")
            backup_dir = root / "backups/lstat-op"
            archive_bytes = (backup_dir / "backup.tar").read_bytes()
            self.assertEqual(sha(archive_bytes), manifest["archiveSha256"])
            self.assertEqual({row["url"].split("/", 2)[1] for row in manifest["media"]}, {"uploads", "media"})
            self.assertEqual({row["url"] for row in manifest["media"]},
                             {"/uploads/photo.jpg", "/media/legacy.jpg"})
            self.assertEqual({row["file"] for row in manifest["media"]},
                             {f"media/sha256:{sha(shared_photo)}"})
            offhost = root / "offhost"
            offhost.mkdir()
            operator.persist_offhost_backup(offhost, "lstat-op", "a" * 40, archive_bytes,
                                            manifest["archiveSha256"])
            db = sqlite3.connect(f"file:{backup_dir / 'database.sqlite'}?mode=ro", uri=True)
            try:
                self.assertEqual(db.execute("SELECT body FROM content").fetchone()[0], "preserved")
            finally:
                db.close()
            release = root / "release"
            (release / "nested").mkdir(parents=True)
            (release / "index.html").write_text("served", encoding="utf-8")
            (release / "nested/asset").write_bytes(b"asset")
            self.assertEqual(len(rehearsal_host._tree_sha256(release)), 64)

    def test_source_archive_extraction_is_bound_to_operation_and_provenance(self):
        sha_value = "a" * 40
        provenance = {"sourceSha": sha_value, "ref": "refs/heads/dev", "workflow": "Tests",
                      "workflowName": "Tests", "headBranch": "dev", "event": "push", "runId": 7,
                      "attempt": 1, "repository": "pgorbachev/ikpk", "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/7"}
        payload_buffer = io.BytesIO()
        with tarfile.open(fileobj=payload_buffer, mode="w:") as archive:
            for name, payload in (("candidate.txt", b"candidate"), ("cms/index.js", b"source CMS"),
                                  (".ikpk-rehearsal-ci.json", json.dumps(provenance).encode())):
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
        payload = payload_buffer.getvalue()
        digest = sha(payload)
        with tempfile.TemporaryDirectory(prefix="ikpk-source-admission-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            config = {"releaseRoot": str(releases), "allowedSourceRef": "refs/heads/dev",
                      "cmsUser": getpass.getuser(), "backupRoot": str(root / "backups")}
            candidate = releases / f"{sha_value}-source-op"
            self.assertEqual(rehearsal_host._extract_source_archive(config, sha_value, "source-op", payload,
                digest, provenance), candidate.resolve())
            self.assertEqual((candidate / "candidate.txt").read_bytes(), b"candidate")
            self.assertEqual(json.loads((candidate / ".ikpk-rehearsal-ci.json").read_text()), provenance)
            self.assertEqual(rehearsal_host._extract_source_archive(config, sha_value, "source-op", payload,
                digest, provenance), candidate.resolve())
            old_cms = (candidate / "cms/index.js").read_bytes()
            second = rehearsal_host._extract_source_archive(config, sha_value, "source-op-2", payload,
                digest, provenance)
            (second / "cms/index.js").write_bytes(b"second operation build output")
            self.assertEqual((candidate / "cms/index.js").read_bytes(), old_cms)
            self.assertNotEqual(second, candidate)

    def test_new_cms_command_prepares_before_journal_fence_and_backup(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-prefence-order-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            (root / "state").mkdir()
            state = RehearsalState(root / "state")
            archive = b"admitted source"
            sha_value = "a" * 40
            provenance = {"sourceSha": sha_value, "ref": "refs/heads/dev", "workflow": "Tests",
                          "workflowName": "Tests", "headBranch": "dev", "event": "push", "runId": 7,
                          "attempt": 1, "repository": "pgorbachev/ikpk", "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/7"}
            config = {"releaseRoot": str(releases), "allowedSourceRef": "refs/heads/dev",
                      "cmsUser": getpass.getuser(), "backupRoot": str(root / "backups")}
            args = Namespace(operation_id="prefence-op", source_sha=sha_value,
                             provenance_b64=base64.b64encode(json.dumps(provenance).encode()).decode(),
                             archive_sha256=sha(archive), offhost_sha256=None)
            events = []
            source_root = releases / f"{sha_value}-{args.operation_id}"
            (root / "backups").mkdir()

            def prepare(_config, candidate, operation_id, _provenance):
                events.append("prepare")
                self.assertEqual(operation_id, args.operation_id)
                self.assertFalse(state.journal_path.exists())
                self.assertFalse(state.marker_path.exists())
                return candidate / ".staging193-rehearsal" / operation_id / "migration/cms-artifact"

            def start(_config, operation_state, operation_id, source_sha):
                events.append("start")
                operation_state.begin(operation_id, source_sha, {"cmsPath": "/old/cms"})
                operation_state.confirm_fence(operation_id, lambda: True)
                return operation_state.phase(operation_id)

            def backup(_config, operation_id):
                events.append("backup")
                directory = Path(config["backupRoot"]) / operation_id
                directory.mkdir()
                (directory / "manifest.json").write_text(json.dumps({"archiveSha256": "b" * 64}), encoding="utf-8")
                return {"archiveSha256": "b" * 64}

            host_stdin = type("HostStdin", (), {"buffer": io.BytesIO(archive)})()
            with patch.object(rehearsal_host.sys, "stdin", host_stdin), \
                 patch.object(rehearsal_host, "_extract_source_archive",
                              side_effect=lambda *_args: events.append("extract") or source_root), \
                 patch.object(rehearsal_host, "_prepare_cms_candidate", side_effect=prepare), \
                 patch.object(rehearsal_host, "_start_acquisition", side_effect=start), \
                 patch.object(rehearsal_host, "_verify_fence", side_effect=lambda *_args: events.append("verify")), \
                 patch.object(rehearsal_host, "_backup", side_effect=backup):
                result = rehearsal_host._cms_update(config, state, args)

            self.assertEqual(events, ["extract", "prepare", "start", "verify", "backup"])
            self.assertTrue(result["offhostBackupRequired"])
            self.assertEqual(result["backupSha256"], "b" * 64)

    def test_offhost_followup_reuses_prepared_candidate_without_npm_or_build(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-cms-prefence-followup-") as temporary:
            root = Path(temporary)
            state_root = root / "state"
            state_root.mkdir()
            state = RehearsalState(state_root)
            operation_id, sha_value = "prepared-op", "a" * 40
            state.begin(operation_id, sha_value, {"cmsPath": "/old/cms"})
            state.confirm_fence(operation_id, lambda: True)
            backup_root = root / "backups"
            manifest_dir = backup_root / operation_id
            manifest_dir.mkdir(parents=True)
            (manifest_dir / "manifest.json").write_text(json.dumps({"archiveSha256": "b" * 64}), encoding="utf-8")
            provenance = {"sourceSha": sha_value, "ref": "refs/heads/dev", "workflow": "Tests",
                          "workflowName": "Tests", "headBranch": "dev", "event": "push", "runId": 7,
                          "attempt": 1, "repository": "pgorbachev/ikpk", "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/7"}
            config = {"releaseRoot": str(root / "releases"), "backupRoot": str(backup_root),
                      "cmsDatabase": str(root / "live.db"), "cmsUnit": "ikpk-cms-prototype193.service",
                      "cmsHealthUrl": "http://127.0.0.1:1338/_health"}
            source_root = root / "candidate"
            args = Namespace(operation_id=operation_id, source_sha=sha_value,
                             provenance_b64=base64.b64encode(json.dumps(provenance).encode()).decode(),
                             archive_sha256=None, offhost_sha256="b" * 64)
            events = []
            host_stdin = type("HostStdin", (), {"buffer": type("NoRead", (), {
                "read": lambda *_args: self.fail("off-host follow-up must not read a new archive")})()})()
            with patch.object(rehearsal_host.sys, "stdin", host_stdin), \
                 patch.object(rehearsal_host, "_candidate_root", return_value=source_root), \
                 patch.object(rehearsal_host, "_validate_prepared_cms_candidate",
                              side_effect=lambda *_args: events.append("validate-prepared") or (source_root, source_root / "artifact", source_root / "deps/node_modules")), \
                 patch.object(rehearsal_host, "_prepare_cms_candidate",
                              side_effect=AssertionError("follow-up must not rebuild or install")), \
                 patch.object(rehearsal_host, "_start_acquisition", return_value=state.phase(operation_id)), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=AssertionError("follow-up must not run npm")), \
                 patch.object(rehearsal_host, "_verify_fence"), \
                 patch.object(rehearsal_host, "_backup_manifest", return_value={"archiveSha256": "b" * 64}), \
                 patch.object(rehearsal_host, "_install_migrated_database",
                              return_value=(root / "candidate.db", root / "artifact", "c" * 64)), \
                 patch.object(rehearsal_host, "_create_capture_bundle", return_value=root / "capture"), \
                 patch.object(rehearsal_host, "_activate_cms", return_value={"db": "accepted"}), \
                 patch.object(rehearsal_host, "_wait_health"):
                result = rehearsal_host._cms_update(config, state, args)

            self.assertEqual(events, ["validate-prepared"])
            self.assertEqual(result["phase"], "cms-activated")

    def test_static_build_uses_capture_snapshot_for_prepare_and_build(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-capture-env-") as temporary:
            source = Path(temporary) / "candidate"
            web = source / "web"
            snapshot_dir = web / ".snapshot"
            snapshot_dir.mkdir(parents=True)
            (snapshot_dir / "snapshot.json").write_text('{"snapshotId":"snap:editor-data"}', encoding="utf-8")
            (source / ".ikpk-rehearsal-ci.json").write_text(json.dumps({"sourceSha": "a" * 40}), encoding="utf-8")
            retained = Path(temporary) / "releases"
            old_public = retained / "old" / "public"
            (old_public / "_astro").mkdir(parents=True)
            (old_public / "_astro/legacy.0123456789.css").write_text("previous hash asset", encoding="utf-8")
            calls = []

            def run_build(_config, cwd, argv, **kwargs):
                calls.append((argv, kwargs.get("environment")))
                if argv[:3] == ["/usr/bin/npm", "run", "build:demo193"]:
                    dist = web / "dist-demo193"
                    dist.mkdir()
                    (dist / "index.html").write_text("candidate", encoding="utf-8")
                return ""

            with patch.object(rehearsal_host, "_validate_prepared_web_dependencies"), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=run_build):
                dist, _ = rehearsal_host._build_static({"staticReleaseRoot": str(retained),
                                                        "siteBaseUrl": "https://194.226.99.10"}, source,
                                                       Path(temporary) / "capture")
            self.assertFalse(any(argv[:2] == ["/usr/bin/npm", "ci"] for argv, _ in calls),
                             "static build must reuse web dependencies prepared before the fence")
            expected = {"CONTENT_SNAPSHOT_DIR": str(snapshot_dir), "DEMO_PROFILE": "demo193",
                        "DEPLOY_MODE": "stand", "PAYMENT_ROLE": "ci", "DEMO_FORMS": "stub",
                        "CHAT_LOADER_SRC": "none", "CHAT_OFFLINE_MESSAGE": "absent",
                        "DEMO_SITE_URL": "https://194.226.99.10"}
            snapshot_call = next(item for item in calls if "capture-content-snapshot.ts" in " ".join(item[0]))
            build_call = next(item for item in calls if item[0][:3] == ["/usr/bin/npm", "run", "build:demo193"])
            self.assertEqual(snapshot_call[1], expected)
            self.assertEqual(build_call[1], expected)
            release = json.loads((dist / "release.json").read_text(encoding="utf-8"))
            self.assertEqual(release["commit"], "a" * 40)
            self.assertEqual(stat.S_IMODE((dist / "release.json").stat().st_mode), 0o644,
                             "release metadata must be readable by the static web server")
            self.assertEqual((dist / "_astro/legacy.0123456789.css").read_text(encoding="utf-8"),
                             "previous hash asset")

    def test_static_build_can_include_the_owner_approved_staging194_chat_loader(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-chat-env-") as temporary:
            root = Path(temporary)
            source = root / "candidate"
            web = source / "web"
            snapshot_dir = web / ".snapshot"
            snapshot_dir.mkdir(parents=True)
            (snapshot_dir / "snapshot.json").write_text('{"snapshotId":"snap:editor-data"}', encoding="utf-8")
            (source / ".ikpk-rehearsal-ci.json").write_text(json.dumps({"sourceSha": "a" * 40}), encoding="utf-8")
            releases = root / "releases"
            releases.mkdir()
            calls = []

            def run_build(_config, cwd, argv, **kwargs):
                calls.append((argv, kwargs.get("environment")))
                if argv[:3] == ["/usr/bin/npm", "run", "build:demo193"]:
                    dist = cwd / "dist-demo193"
                    dist.mkdir()
                    (dist / "index.html").write_text("candidate", encoding="utf-8")
                return ""

            with patch.object(rehearsal_host, "_validate_prepared_web_dependencies"), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=run_build):
                rehearsal_host._build_static({"staticReleaseRoot": str(releases),
                                              "siteBaseUrl": "https://194.226.99.10"}, source,
                    root / "capture", chat_loader_src=rehearsal_host.STAGING194_CHAT_LOADER_SRC)

            build_environments = [environment for argv, environment in calls
                                  if argv[0] == "/usr/bin/npm"]
            self.assertEqual(len(build_environments), 1)
            self.assertEqual(build_environments[0]["CHAT_LOADER_SRC"],
                             "https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js")
            self.assertEqual(build_environments[0]["CHAT_LOADER_PROFILE"], "staging194-static-main")
            self.assertEqual(build_environments[0]["DEMO_FORMS"], "stub")
            self.assertEqual(build_environments[0]["PAYMENT_ROLE"], "ci")

    def test_static_build_refuses_unapproved_chat_loader_or_non_staging_profile(self):
        for config, loader in (
            ({}, "https://attacker.example/loader.js"),
            ({"profile": "initial-prod"}, rehearsal_host.STAGING194_CHAT_LOADER_SRC),
        ):
            with self.subTest(config=config, loader=loader):
                with self.assertRaisesRegex(rehearsal_host.HostFailure,
                                            "only staging194 static-main may use the owner-approved chat loader"):
                    rehearsal_host._build_static(config, Path("/unused"), Path("/unused"), chat_loader_src=loader)

    def test_initial_prod_static_build_preserves_chat_loader_for_capture_and_build(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-initial-prod-chat-env-") as temporary:
            root = Path(temporary)
            source = root / "candidate"
            web = source / "web"
            snapshot_dir = web / ".snapshot"
            snapshot_dir.mkdir(parents=True)
            source_sha, run_id, attempt = "a" * 40, 12345, 2
            snapshot = {
                "snapshotId": "snap:initial-prod-env",
                "sourcePolicy": "initial-production",
                "sourceAge": "source-bound",
                "origin": {"sourceId": "initial-prod-server-db"},
                "captureProof": {"captureId": rehearsal_host.INITIAL_PROD_OPERATION_ID,
                                 "sourceSha": source_sha, "runId": run_id, "attempt": attempt,
                                 "targetHost": rehearsal_host.INITIAL_PROD_HOST, "siteUrl": "https://ikpk.su"},
            }
            (snapshot_dir / "snapshot.json").write_text(json.dumps(snapshot), encoding="utf-8")
            (source / ".ikpk-rehearsal-ci.json").write_text(
                json.dumps({"sourceSha": source_sha, "runId": run_id, "attempt": attempt}), encoding="utf-8")
            releases = root / "releases"
            releases.mkdir()
            calls = []

            def run_build(_config, cwd, argv, **kwargs):
                calls.append((argv, kwargs.get("environment")))
                if argv[:3] == ["/usr/bin/npm", "run", "build"]:
                    (cwd / "dist").mkdir()
                    (cwd / "dist/index.html").write_text("candidate", encoding="utf-8")
                return ""

            with patch.object(rehearsal_host, "_validate_prepared_web_dependencies"), \
                 patch.object(rehearsal_host, "_run_as_cms", side_effect=run_build):
                rehearsal_host._build_static({"profile": "initial-prod", "staticReleaseRoot": str(releases)},
                                             source, root / rehearsal_host.INITIAL_PROD_OPERATION_ID / "capture")

            self.assertEqual(len(calls), 2)
            self.assertTrue(all(environment["CHAT_LOADER_SRC"] == rehearsal_host.INITIAL_PROD_CHAT_LOADER_SRC
                                for _, environment in calls))
            self.assertTrue(all("CHAT_OFFLINE_MESSAGE" not in environment for _, environment in calls))

    def test_exported_candidate_contains_exact_retained_static_bytes(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-export-") as temporary:
            root = Path(temporary)
            release_root = root / "releases"
            release = release_root / f"{'a' * 40}-export-op"
            release.mkdir(parents=True)
            (release / "index.html").write_text("candidate", encoding="utf-8")
            (release / "release.json").write_text(json.dumps({"commit": "a" * 40}), encoding="utf-8")
            candidate = root / "sources" / f"{'a' * 40}-export-op"
            snapshot = candidate / "web/.snapshot/snapshot.json"
            capture = candidate / ".staging193-rehearsal/export-op/capture/manifest.json"
            snapshot.parent.mkdir(parents=True)
            capture.parent.mkdir(parents=True)
            snapshot.write_text('{"snapshotId":"snap:captured"}', encoding="utf-8")
            capture.write_text('{"operationId":"export-op"}', encoding="utf-8")

            class State:
                @staticmethod
                def phase(_operation_id):
                    return {"phase": "cms-activated", "sourceSha": "a" * 40}

            payload = rehearsal_host._export_static({"staticReleaseRoot": str(release_root),
                                                       "releaseRoot": str(root / "sources")}, State(),
                                                       "export-op", "a" * 40)
            with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
                self.assertEqual(archive.extractfile("static/index.html").read(), b"candidate")
                self.assertEqual(json.loads(archive.extractfile("static/release.json").read()), {"commit": "a" * 40})
                self.assertEqual(json.loads(archive.extractfile("snapshot/snapshot.json").read()), {"snapshotId": "snap:captured"})
                self.assertEqual(json.loads(archive.extractfile("snapshot/capture-manifest.json").read()), {"operationId": "export-op"})

    def test_post_switch_checks_old_hashed_asset_url_against_serving_origin(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-hash-check-") as temporary:
            root = Path(temporary)
            old_assets = root / "old/public/_astro"
            new_assets = root / ("new-" + "a" * 40 + "/_astro")
            old_assets.mkdir(parents=True)
            new_assets.mkdir(parents=True)
            old_pagefind = root / "old/public/pagefind/fragment"
            new_pagefind = root / ("new-" + "a" * 40 + "/pagefind/fragment")
            old_pagefind.mkdir(parents=True)
            new_pagefind.mkdir(parents=True)
            (old_assets / "old.0123456789.css").write_bytes(b"old hashed CSS")
            (new_assets / "new.abcdef0123.js").write_bytes(b"new hashed JS")
            (old_pagefind / "ru_2cf1958.pf_fragment").write_bytes(b"old Pagefind fragment")
            (new_pagefind / "ru_7a12345.pf_fragment").write_bytes(b"new Pagefind fragment")
            commands = []

            def request(argv, **_kwargs):
                commands.append(argv)
                return subprocess.CompletedProcess(argv, 0, "200", "")

            with patch.object(rehearsal_host, "run", side_effect=request):
                rehearsal_host._verify_retained_hashed_assets({"staticReleaseRoot": str(root),
                                                                 "siteBaseUrl": "https://194.226.99.10"})
            urls = {argv[-1] for argv in commands}
            self.assertIn("https://194.226.99.10/_astro/old.0123456789.css", urls)
            self.assertIn("https://194.226.99.10/_astro/new.abcdef0123.js", urls)
            self.assertIn("https://194.226.99.10/pagefind/fragment/ru_2cf1958.pf_fragment", urls)

    def test_capture_builder_invokes_existing_sealer_path(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-capture-entrypoint-") as temporary:
            root = Path(temporary)
            source = root / "candidate"
            (source / "scripts/lib").mkdir(parents=True)
            (source / "web").mkdir()
            (source / "cms/src").mkdir(parents=True)
            sealer = source / "scripts/lib/seal-staging193-capture.mjs"
            sealer.write_bytes((ROOT / "scripts/lib/seal-staging193-capture.mjs").read_bytes())
            database = root / "candidate.sqlite"
            db = sqlite3.connect(database)
            db.execute("CREATE TABLE empty (value TEXT)")
            db.commit()
            db.close()
            uploads = root / "uploads"
            uploads.mkdir()
            static_media = root / "static-media"
            static_media.mkdir()
            (uploads / "photo.jpg").write_bytes(b"upload bytes")
            (static_media / "legacy.jpg").write_bytes(b"static media bytes")
            capture_root = source / ".staging193-rehearsal" / "capture-op"
            config = {"cmsUser": getpass.getuser(), "mediaRoots": [
                {"path": str(uploads), "prefix": "/uploads/"},
                {"path": str(static_media), "prefix": "/media/"},
            ]}
            captured = {}

            def run_sealer(_config, cwd, argv, **_kwargs):
                captured["cwd"] = cwd
                captured["argv"] = argv
                self.assertTrue(Path(argv[1]).is_file())
                return ""

            with patch.object(rehearsal_host, "_run_as_cms", side_effect=run_sealer):
                result = rehearsal_host._create_capture_bundle(config, "capture-op", "a" * 40, source, database)
            self.assertEqual(result, capture_root / "capture")
            self.assertEqual(Path(captured["argv"][1]), sealer)
            self.assertEqual(Path(captured["argv"][1]).name, "seal-staging193-capture.mjs")
            media_rows = json.loads((result / "media-manifest.json").read_text(encoding="utf-8"))["media"]
            self.assertEqual({row["url"].split("/", 2)[1] for row in media_rows}, {"uploads", "media"})

    def test_recovery_restores_uploads_by_bytes_and_static_media_by_old_pointer_only(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-static-media-recovery-") as temporary:
            root = Path(temporary)
            state_root = root / "state"
            state_root.mkdir()
            state = rehearsal_host.RehearsalState(state_root)
            operation_id = "static-media-recovery"
            source_sha = "a" * 40
            backup_root = root / "backups"
            backup_root.mkdir()
            cms_releases = root / "cms-releases"
            old_cms = cms_releases / "old"
            candidate_cms = cms_releases / "candidate"
            old_cms.mkdir(parents=True)
            candidate_cms.mkdir()
            current_cms = root / "current-cms"
            current_cms.symlink_to(candidate_cms)
            static_releases = root / "static-releases"
            old_static = static_releases / "old"
            candidate_static = static_releases / "candidate"
            (old_static / "media").mkdir(parents=True)
            (candidate_static / "media").mkdir(parents=True)
            (old_static / "media/legacy.jpg").write_bytes(b"old static media")
            (candidate_static / "media/legacy.jpg").write_bytes(b"candidate static media")
            current_static = root / "current-static"
            current_static.symlink_to(old_static)
            uploads = root / "uploads"
            uploads.mkdir()
            (uploads / "editor.jpg").write_bytes(b"old upload")
            live_database = root / "live.sqlite"

            def write_db(path: Path, value: str) -> None:
                existed = path.exists()
                db = sqlite3.connect(path)
                if existed:
                    db.execute("UPDATE content SET body=?", (value,))
                else:
                    db.execute("CREATE TABLE content (body TEXT NOT NULL)")
                    db.execute("INSERT INTO content VALUES (?)", (value,))
                db.commit()
                db.close()

            write_db(live_database, "old database")
            config = {"stateDir": str(state_root), "backupRoot": str(backup_root),
                      "cmsDatabase": str(live_database), "cmsUnit": "ikpk-cms-test.service",
                      "writerUnits": ["ikpk-cms-test.service"], "cmsHealthUrl": "http://127.0.0.1/health",
                      "siteHealthUrl": "https://127.0.0.1/", "currentCms": str(current_cms),
                      "releaseRoot": str(cms_releases), "currentStatic": str(current_static),
                      "staticReleaseRoot": str(static_releases),
                      "mediaRoots": [{"path": str(uploads), "prefix": "/uploads/"},
                                     {"path": str(current_static / "media"), "prefix": "/media/"}]}
            old_pair = {"cmsPath": str(old_cms.resolve()), "staticPath": str(old_static.resolve()),
                        "staticTreeSha256": rehearsal_host._tree_sha256(old_static)}
            state.begin(operation_id, source_sha, old_pair)
            with patch.object(rehearsal_host, "_assert_no_database_handles"):
                manifest = rehearsal_host._backup(config, operation_id)
            backup_dir = backup_root / operation_id
            offhost = backup_dir / "offhost-backup"
            shutil.copytree(backup_dir, offhost, ignore=shutil.ignore_patterns("offhost-backup"))
            (uploads / "editor.jpg").write_bytes(b"candidate upload")
            write_db(live_database, "candidate database")
            current_static.unlink()
            current_static.symlink_to(candidate_static)
            candidate_media_before = (candidate_static / "media/legacy.jpg").read_bytes()
            active = {"started": False}

            def systemctl(argv, **_kwargs):
                if len(argv) > 1 and argv[1] == "start":
                    active["started"] = True
                if len(argv) > 1 and argv[1] == "is-active":
                    return subprocess.CompletedProcess(argv, 0 if active["started"] else 3, "", "")
                return subprocess.CompletedProcess(argv, 0, "", "")

            with patch.object(rehearsal_host, "_set_flag"), \
                 patch.object(rehearsal_host, "_write_gate"), \
                 patch.object(rehearsal_host, "_verify_fence"), \
                 patch.object(rehearsal_host, "_stop_writers"), \
                 patch.object(rehearsal_host, "_assert_no_database_handles"), \
                 patch.object(rehearsal_host, "_wait_health"), \
                 patch.object(rehearsal_host, "_service_pid", return_value=123), \
                 patch.object(rehearsal_host, "_database_process_proof", return_value={}), \
                 patch.object(rehearsal_host, "run", side_effect=systemctl):
                result = rehearsal_host._recover(config, state, operation_id)

            self.assertEqual(result["phase"], "recovered")
            self.assertEqual(current_static.resolve(), old_static.resolve())
            self.assertEqual(current_cms.resolve(), old_cms.resolve())
            self.assertEqual((candidate_static / "media/legacy.jpg").read_bytes(), candidate_media_before)
            self.assertEqual((old_static / "media/legacy.jpg").read_bytes(), b"old static media")
            self.assertEqual((uploads / "editor.jpg").read_bytes(), b"old upload")
            db = sqlite3.connect(f"file:{live_database}?mode=ro", uri=True)
            try:
                self.assertEqual(db.execute("SELECT body FROM content").fetchone()[0], "old database")
            finally:
                db.close()
            self.assertEqual({row["url"].split("/", 2)[1] for row in manifest["media"]}, {"uploads", "media"})

    def test_bad_static_media_backup_entry_is_rejected_before_upload_restore(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-bad-static-media-") as temporary:
            root = Path(temporary)
            uploads = root / "uploads"
            uploads.mkdir()
            (uploads / "keep.jpg").write_bytes(b"current uploads")
            backup = root / "backup"
            backup.mkdir()
            (backup / "media/sha256:bad").parent.mkdir(parents=True)
            (backup / "media/sha256:bad").write_bytes(b"bad digest")
            config = {"mediaRoots": [{"path": str(uploads), "prefix": "/uploads/"},
                                     {"path": str(root / "unavailable-current-media"), "prefix": "/media/"}]}
            valid_bytes = b"legacy media captured in backup"
            valid_file = backup / "media/sha256:valid"
            valid_file.write_bytes(valid_bytes)
            valid_entry = {"url": "/media/legacy.jpg", "originalName": "legacy.jpg",
                           "file": "media/sha256:valid", "sha256": sha(valid_bytes),
                           "mode": 0o640, "uid": 987, "gid": 987}
            # A recovery with a missing current media tree still succeeds: /media is
            # restored by selecting the old static release, never by writing this path.
            rehearsal_host._restore_media(config, backup, {"media": [valid_entry]})
            self.assertFalse((root / "unavailable-current-media").exists())
            self.assertFalse(list(uploads.iterdir()))

            invalid_cases = [
                ("digest", {**valid_entry, "file": "media/sha256:bad", "sha256": "0" * 64},
                 "media bytes failed digest"),
                ("url-mismatch", {**valid_entry, "originalName": "different.jpg"},
                 "does not match configured URL roots"),
                ("unsafe-path", {**valid_entry, "url": "/media/../escape.jpg",
                                  "originalName": "../escape.jpg"}, "media path is unsafe"),
            ]
            for label, entry, message in invalid_cases:
                with self.subTest(case=label):
                    (uploads / "keep.jpg").write_bytes(b"current uploads")
                    with self.assertRaisesRegex(rehearsal_host.HostFailure, message):
                        rehearsal_host._restore_media(config, backup, {"media": [entry]})
                    self.assertEqual((uploads / "keep.jpg").read_bytes(), b"current uploads")

    def test_imported_offhost_backup_is_bound_to_server_archive_digest(self):
        operation_id = "operator-test"
        archive_bytes = backup_archive(operation_id)
        digest = sha(archive_bytes)
        with tempfile.TemporaryDirectory(prefix="ikpk-offhost-import-") as temporary:
            root = Path(temporary)
            server_backup = root / operation_id
            server_backup.mkdir()
            (server_backup / "manifest.json").write_text(json.dumps({
                "operationId": operation_id, "archiveSha256": digest,
            }))
            (server_backup / "backup.tar").write_bytes(b"corrupt server-side copy")
            config = {"backupRoot": str(root)}
            offhost = rehearsal_host._import_offhost_backup(config, operation_id, archive_bytes, digest)
            manifest = rehearsal_host._backup_manifest({"backupRoot": str(root)}, operation_id, offhost)
            self.assertEqual(manifest["archiveSha256"], digest)
            self.assertEqual(manifest["operationId"], operation_id)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "exact server-captured backup"):
                rehearsal_host._import_offhost_backup(config, operation_id, archive_bytes, "0" * 64)

    def test_nginx_validation_failure_restores_both_previous_gate_files(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-nginx-gate-") as temporary:
            root = Path(temporary)
            map_file = root / "writer-map.conf"
            server_file = root / "writer-server.conf"
            map_file.write_text("previous map\n")
            server_file.write_text("previous server gate\n")
            active = f"{map_file}\n{server_file}\nikpk_rehearsal_write_block"
            calls = [
                __import__("subprocess").CompletedProcess(["nginx", "-T"], 0, active, ""),
                rehearsal_host.HostFailure("simulated nginx -t rejection"),
                __import__("subprocess").CompletedProcess(["nginx", "-t"], 1, "", "old config checked"),
            ]
            config = {"writerPrefixes": ["/admin"], "preservePrefixes": ["/api/payments/status"],
                      "nginxMapFile": str(map_file), "nginxServerGateFile": str(server_file),
                      "nginxBinary": "nginx", "nginxService": "nginx.service"}
            with patch.object(rehearsal_host, "run", side_effect=calls):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "simulated nginx -t rejection"):
                    rehearsal_host._write_gate(config, True)
            self.assertEqual(map_file.read_text(), "previous map\n")
            self.assertEqual(server_file.read_text(), "previous server gate\n")

    def test_writer_gate_matches_normalized_uri_and_keeps_path_boundaries(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-nginx-gate-normalized-") as temporary:
            root = Path(temporary)
            map_file = root / "writer-map.conf"
            server_file = root / "writer-server.conf"
            active = f"{map_file}\n{server_file}\nikpk_rehearsal_write_block"
            config = {"writerPrefixes": ["/admin"], "preservePrefixes": ["/api/payments/"],
                      "nginxMapFile": str(map_file), "nginxServerGateFile": str(server_file),
                      "nginxBinary": "nginx", "nginxService": "nginx.service"}
            with patch.object(rehearsal_host, "run", side_effect=[
                    subprocess.CompletedProcess(["nginx", "-T"], 0, active, ""),
                    subprocess.CompletedProcess(["nginx", "-t"], 0, "", ""),
                    subprocess.CompletedProcess(["systemctl", "reload"], 0, "", "")]):
                rehearsal_host._write_gate(config, True)

            generated = map_file.read_text()
            self.assertIn('map "$request_method:$uri" $ikpk_rehearsal_write_block {', generated)
            self.assertIn(r"~*^(POST|PUT|PATCH|DELETE):/admin(?:/|$) 1;", generated)
            self.assertIn(r"~*^(POST|PUT|PATCH|DELETE):/api/payments(?:/|$) 0;", generated)
            writer_pattern = re.compile(r"^(POST|PUT|PATCH|DELETE):/admin(?:/|$)", re.IGNORECASE)
            # Nginx's $uri is normalized and excludes query arguments: an encoded /admin
            # path maps to POST:/admin, while query strings cannot change the path decision.
            self.assertRegex("POST:/admin", writer_pattern)
            self.assertRegex("POST:/admin/anything", writer_pattern)
            self.assertNotRegex("POST:/administrator", writer_pattern)

    def test_writer_fence_keeps_disabled_payment_status_route_at_404(self):
        commands = []
        def probe(argv, **_kwargs):
            commands.append(argv)
            if argv[-1] == "https://194.226.99.10/api/payments/rehearsal/status":
                return subprocess.CompletedProcess(argv, 0, "404", "")
            if argv[-1] == "https://194.226.99.10/":
                return subprocess.CompletedProcess(argv, 0, "200", "")
            return subprocess.CompletedProcess(argv, 0, "503", "")
        config = {"writerProbeUrls": ["https://194.226.99.10/api"],
                  "preserveProbeUrl": "https://194.226.99.10/",
                  "paymentStatusProbeUrl": "https://194.226.99.10/api/payments/rehearsal/status"}
        with patch.object(rehearsal_host, "run", side_effect=probe):
            rehearsal_host._verify_fence(config)
        self.assertTrue(any("--request" in argv for argv in commands))
        self.assertIn(config["paymentStatusProbeUrl"], [argv[-1] for argv in commands])

    def test_database_replacement_removes_stale_wal_and_shm_and_keeps_mode(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-db-replace-") as temporary:
            root = Path(temporary)
            source = root / "candidate.db"
            destination = root / "live.db"
            for path, value in ((source, "candidate"), (destination, "old")):
                db = sqlite3.connect(path)
                db.execute("CREATE TABLE state(value TEXT)")
                db.execute("INSERT INTO state VALUES (?)", (value,))
                db.commit()
                db.close()
            destination.chmod(0o640)
            Path(str(destination) + "-wal").write_bytes(b"stale WAL")
            Path(str(destination) + "-shm").write_bytes(b"stale SHM")
            _copy_atomic(source, destination)
            self.assertEqual(destination.stat().st_mode & 0o777, 0o640)
            self.assertFalse(Path(str(destination) + "-wal").exists())
            self.assertFalse(Path(str(destination) + "-shm").exists())
            db = sqlite3.connect(f"file:{destination}?mode=ro", uri=True)
            try:
                self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(db.execute("SELECT value FROM state").fetchone()[0], "candidate")
            finally:
                db.close()

    def test_release_pointer_switch_is_atomic_and_stays_inside_retained_root(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-pointer-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            old = releases / "old"
            new = releases / "new"
            old.mkdir()
            new.mkdir()
            pointer = root / "current"
            pointer.symlink_to(old)
            _switch_pointer(pointer, new, releases)
            self.assertEqual(pointer.resolve(), new.resolve())
            outside = root / "outside"
            outside.mkdir()
            with self.assertRaisesRegex(Exception, "escapes configured root"):
                _switch_pointer(pointer, outside, releases)
            self.assertEqual(pointer.resolve(), new.resolve())

    def test_offhost_backup_verifies_actual_database_and_media_member_digests(self):
        archive = backup_archive()
        operator.verify_backup_tar(archive, sha(archive))
        with tempfile.TemporaryDirectory(prefix="ikpk-offhost-copy-") as temporary:
            target = operator.persist_offhost_backup(Path(temporary), "operator-test", "a" * 40,
                                                       archive, sha(archive))
            self.assertEqual(target.read_bytes(), archive)
        with self.assertRaisesRegex(operator.Refusal, "digest"):
            operator.verify_backup_tar(archive + b"tampered", sha(archive))


class StaticMainAdmissionTests(unittest.TestCase):
    def test_capture_projection_digest_binds_field_map_and_snapshot_transformer(self):
        import os
        with tempfile.TemporaryDirectory(prefix="ikpk-capture-projection-") as temporary:
            root = Path(temporary)
            old, new = root / "old", root / "new"
            for source in (old, new):
                (source / "web/scripts/lib").mkdir(parents=True)
                (source / "web/scripts/lib/content-field-map.ts").write_text("export const fields = {};", encoding="utf-8")
                (source / "web/scripts/capture-content-snapshot.ts").write_text("export const transform = 1;", encoding="utf-8")
            original = rehearsal_host._static_main_capture_projection_sha256(old, os.getuid(), os.getgid())
            self.assertEqual(original,
                rehearsal_host._static_main_capture_projection_sha256(new, os.getuid(), os.getgid()))
            (new / "web/scripts/capture-content-snapshot.ts").write_text("export const transform = 2;", encoding="utf-8")
            self.assertNotEqual(original,
                rehearsal_host._static_main_capture_projection_sha256(new, os.getuid(), os.getgid()))

    def test_reuse_refuses_capture_operation_with_later_rollback_state(self):
        for later_record in ("static-main-rollback-intent", "static-main-rollback-completed",
                             "static-main-rolled-back"):
            with self.subTest(later_record=later_record), tempfile.TemporaryDirectory(
                    prefix="ikpk-reuse-terminal-state-") as temporary:
                state = RehearsalState(Path(temporary))
                state._append({"version": 1, "record": "static-main-start", "operationKind": "static-main",
                    "operationId": "capture-op", "sourceSha": "a" * 40, "cmsFingerprint": {"cms": "same"}})
                state._append({"version": 1, "record": "static-main-prepared", "operationKind": "static-main",
                    "operationId": "capture-op", "sourceSha": "a" * 40, "cmsFingerprint": {"cms": "same"}})
                state._append({"version": 1, "record": "static-main-committed", "operationKind": "static-main",
                    "operationId": "capture-op", "sourceSha": "a" * 40})
                state._append({"version": 1, "record": later_record, "operationKind": "static-main",
                    "operationId": "capture-op", "sourceSha": "a" * 40})
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "prepared terminal staging194"):
                    rehearsal_host._verify_reusable_static_capture({}, state, "capture-op", Path("/unused"),
                        {"cms": "same"}, [])

    def _committed_static_main_fixture(self, root: Path, current_name="candidate"):
        releases = root / "releases"
        releases.mkdir()
        old = releases / "old"
        candidate = releases / f"{'a' * 40}-main-op"
        foreign = releases / "foreign"
        for directory, body in ((old, "old"), (candidate, "candidate"), (foreign, "foreign")):
            directory.mkdir()
            (directory / "index.html").write_text(body, encoding="utf-8")
        pointer = root / "current"
        pointer.symlink_to({"candidate": candidate, "foreign": foreign, "old": old}[current_name])
        cms_release = root / "cms-release"
        cms_release.mkdir()
        (cms_release / "payload.json").write_text("cms unchanged", encoding="utf-8")
        current_cms = root / "current-cms"
        current_cms.symlink_to(cms_release)
        state_dir = root / "state"
        state_dir.mkdir()
        state = RehearsalState(state_dir)
        old_digest = rehearsal_host._tree_sha256(old)
        candidate_digest = rehearsal_host._tree_sha256(candidate)
        state._append({"version": 1, "record": "static-main-start", "operationKind": "static-main",
            "operationId": "main-op", "sourceSha": "a" * 40, "oldStaticPath": str(old),
            "oldStaticTreeSha256": old_digest, "provenance": {}})
        state._append({"version": 1, "record": "static-main-prepared", "operationKind": "static-main",
            "operationId": "main-op", "sourceSha": "a" * 40, "staticTreeSha256": candidate_digest,
            "snapshotId": "snapshot-main"})
        state._append({"version": 1, "record": "static-main-committed", "operationKind": "static-main",
            "operationId": "main-op", "sourceSha": "a" * 40, "staticTreeSha256": candidate_digest,
            "snapshotId": "snapshot-main"})
        return {"currentStatic": str(pointer), "staticReleaseRoot": str(releases),
                "currentCms": str(current_cms)}, state, pointer, old, candidate, foreign

    def test_static_main_fails_closed_until_release_policy_is_explicit(self):
        with self.assertRaisesRegex(rehearsal_host.HostFailure, "ci-only-approved"):
            rehearsal_host._static_main_release_policy({"profile": "staging194"})
        with self.assertRaisesRegex(rehearsal_host.HostFailure, "ci-only-approved"):
            rehearsal_host._static_main_release_policy({"profile": "staging194",
                                                         "staticMainReleasePolicy": "published-release-required"})

    def test_static_main_admission_requires_exact_main_tests_push(self):
        config = {"profile": "staging194", "staticMainReleasePolicy": "ci-only-approved"}
        provenance = {"repository": "pgorbachev/ikpk", "ref": "refs/heads/main",
                      "sourceSha": "a" * 40, "workflow": "Tests", "workflowName": "Tests",
                      "event": "push", "headBranch": "main", "runId": 39670066783,
                      "attempt": 2, "status": "completed", "conclusion": "success",
                      "requiredJobs": sorted(rehearsal_host.STATIC_MAIN_REQUIRED_JOBS),
                      "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/39670066783",
                      "additionalWorkflows": [{"workflow": workflow, "headSha": "a" * 40,
                          "event": "push", "headBranch": "main", "runId": index + 100,
                          "attempt": 1, "status": "completed", "conclusion": "success",
                          "requiredJobs": ["required job"],
                          "runUrl": f"https://github.com/pgorbachev/ikpk/actions/runs/{index + 100}"}
                          for index, workflow in enumerate(rehearsal_host.STATIC_MAIN_ADDITIONAL_WORKFLOWS)]}
        rehearsal_host._validate_static_main_admission(config, "a" * 40, provenance)
        for changed in ({**provenance, "ref": "refs/heads/dev", "headBranch": "dev"},
                        {**provenance, "sourceSha": "b" * 40},
                        {**provenance, "event": "pull_request"},
                        {**provenance, "attempt": 0}):
            with self.subTest(changed=changed), self.assertRaises(rehearsal_host.HostFailure):
                rehearsal_host._validate_static_main_admission(config, "a" * 40, changed)

    def test_static_main_host_cli_accepts_explicit_reuse_capture_operation_id(self):
        with patch.object(rehearsal_host, "dispatch") as dispatch:
            dispatch.return_value = {"phase": "browser-check-required"}
            result = rehearsal_host.main(["static-main", "--operation-id", "new-build",
                "--source-sha", "a" * 40, "--provenance-b64", "e30=",
                "--reuse-capture-operation-id", "sealed-capture"])
        self.assertEqual(result, 0)
        self.assertEqual(dispatch.call_args.args[0].reuse_capture_operation_id, "sealed-capture")

    def test_static_main_missing_reuse_operation_refuses_without_fresh_capture(self):
        import types
        import io
        import sys
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-missing-reuse-") as temporary:
            root = Path(temporary)
            release_root = root / "releases"
            static_root = root / "static"
            state_dir = root / "state"
            release_root.mkdir()
            static_root.mkdir()
            state_dir.mkdir()
            old = static_root / "old"
            old.mkdir()
            (old / "index.html").write_text("old", encoding="utf-8")
            pointer = root / "current"
            pointer.symlink_to(old)
            source_sha, operation_id = "a" * 40, "new-build"
            provenance = {"sourceSha": source_sha, "ref": "refs/heads/main"}
            source_root = release_root / f"{source_sha}-{operation_id}"
            source_root.mkdir()
            (source_root / ".ikpk-rehearsal-ci.json").write_text(json.dumps(provenance), encoding="utf-8")
            config = {"profile": "staging194", "staticMainReleasePolicy": "ci-only-approved",
                "releaseRoot": str(release_root), "staticReleaseRoot": str(static_root),
                "currentStatic": str(pointer), "stateDir": str(state_dir), "cmsUser": "cms",
                "currentCms": str(root / "current-cms"), "cmsDatabase": str(root / "live.sqlite"),
                "mediaRoots": [{"prefix": "/uploads/", "path": str(root / "uploads")}],
                "siteBaseUrl": "https://194.226.99.10"}
            archive = b"candidate source archive"
            args = type("Args", (), {"profile": "staging194", "action": "static-main",
                "operation_id": operation_id, "source_sha": source_sha,
                "provenance_b64": __import__("base64").b64encode(json.dumps(provenance).encode()).decode(),
                "archive_sha256": hashlib.sha256(archive).hexdigest(), "browser_digest": None,
                "reuse_capture_operation_id": "missing-capture"})()
            captured = root / "new-capture"
            def make_capture(_config, capture_operation_id, capture_source_sha, _candidate, _database, **_kwargs):
                captured.mkdir()
                (captured / "manifest.json").write_text(json.dumps({
                    "operationId": capture_operation_id, "sourceSha": capture_source_sha}), encoding="utf-8")
                return captured
            built = root / "built"
            built.mkdir()
            def store_static(_config, source_sha, build_operation_id, _built, digest):
                release = static_root / f"{source_sha}-{build_operation_id}"
                release.mkdir()
                (release / "release.json").write_text(json.dumps({"commit": source_sha,
                    "operationId": build_operation_id, "snapshotId": "snap:fresh-capture"}), encoding="utf-8")
                return release
            def make_database_snapshot(_config, operation_root):
                snapshot = operation_root / "new.sqlite"
                snapshot.write_bytes(b"fresh database image")
                return snapshot
            with patch.object(rehearsal_host.os, "geteuid", return_value=0), \
                 patch.object(rehearsal_host, "_root_config", return_value=config), \
                 patch.object(rehearsal_host, "_validate_static_main_admission"), \
                 patch.object(rehearsal_host, "_extract_source_archive", return_value=source_root), \
                 patch.object(rehearsal_host, "_static_main_cms_fingerprint", return_value={"cms": "same"}), \
                 patch.object(rehearsal_host, "_static_main_protected_paths", return_value=[old]), \
                 patch.object(rehearsal_host.pwd, "getpwnam", return_value=types.SimpleNamespace(
                     pw_uid=__import__("os").getuid(), pw_gid=__import__("os").getgid())), \
                 patch.object(rehearsal_host, "_readonly_database_snapshot", side_effect=make_database_snapshot) as snapshot, \
                 patch.object(rehearsal_host, "_create_capture_bundle", side_effect=make_capture) as create_capture, \
                 patch.object(rehearsal_host, "_prepare_static_web_dependencies"), \
                 patch.object(rehearsal_host, "_build_static", return_value=(built, "b" * 64)), \
                 patch.object(rehearsal_host, "_store_static", side_effect=store_static), \
                 patch.object(rehearsal_host.sys, "stdin", io.TextIOWrapper(io.BytesIO(archive))):
                failure = None
                result = None
                try:
                    result = rehearsal_host.dispatch(args)
                except rehearsal_host.HostFailure as error:
                    failure = str(error)
            self.assertIsNotNone(failure,
                f"missing selected capture silently fell back to fresh work: result={result}, "
                f"sqlite_snapshot_calls={snapshot.call_count}, capture_calls={create_capture.call_count}")
            self.assertRegex(failure, "capture|reuse|operation")
            snapshot.assert_not_called()
            create_capture.assert_not_called()

    def test_static_main_reuses_prior_day_snapshot_without_creating_capture_and_protects_inputs(self):
        import os
        import types
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-reuse-positive-") as temporary:
            root = Path(temporary)
            release_root, static_root, state_dir = root / "releases", root / "static", root / "state"
            release_root.mkdir(); static_root.mkdir(); state_dir.mkdir()
            old_static = static_root / "old"
            old_static.mkdir()
            (old_static / "index.html").write_text("old", encoding="utf-8")
            pointer = root / "current-static"
            pointer.symlink_to(old_static)
            source_sha, new_op, old_sha, capture_op = "a" * 40, "new-main-op", "b" * 40, "old-capture-op"
            source_root = release_root / f"{source_sha}-{new_op}"
            source_root.mkdir()
            (source_root / "web").mkdir()
            provenance = {"sourceSha": source_sha, "ref": "refs/heads/main"}
            (source_root / ".ikpk-rehearsal-ci.json").write_text(json.dumps(provenance), encoding="utf-8")
            old_source = release_root / f"{old_sha}-{capture_op}"
            old_source.mkdir()
            old_capture = old_source / ".staging193-rehearsal" / capture_op / "capture"
            old_capture.mkdir(parents=True)
            (old_capture / "manifest.json").write_text("sealed capture manifest", encoding="utf-8")
            old_snapshot = old_source / "web/.snapshot"
            (old_snapshot / "media").mkdir(parents=True)
            snapshot_bytes = json.dumps({"snapshotId": "snap:previous-day", "referenceDate": "2026-10-23"}).encode()
            (old_snapshot / "snapshot.json").write_bytes(snapshot_bytes)
            (old_snapshot / "media/sha256-media").write_bytes(b"original media bytes")
            snapshot_id = "snap:previous-day"
            bundle_digest = "c" * 64
            reference = {"operationId": capture_op, "sourceSha": old_sha, "bundleDigest": bundle_digest}
            reusable = {"capture": old_capture, "sourceRoot": old_source, "snapshotRoot": old_snapshot,
                "snapshotId": snapshot_id, "referenceDate": "2026-10-23", "reusedCapture": reference,
                "mappingDigest": "d" * 64,
                "snapshotInputsSha256": rehearsal_host._static_main_snapshot_inputs_sha256(old_snapshot)}
            config = {"profile": "staging194", "staticMainReleasePolicy": "ci-only-approved",
                "releaseRoot": str(release_root), "staticReleaseRoot": str(static_root),
                "currentStatic": str(pointer), "stateDir": str(state_dir), "cmsUser": "cms",
                "cmsDatabase": str(root / "live.sqlite"),
                "mediaRoots": [{"prefix": "/uploads/", "path": str(root / "uploads")}]}
            Path(config["cmsDatabase"]).write_bytes(b"live database")
            Path(config["mediaRoots"][0]["path"]).mkdir()
            built = root / "built"
            built.mkdir()
            release = static_root / f"{source_sha}-{new_op}"

            def store_static(_config, commit, operation, _built, digest):
                release.mkdir()
                (release / "release.json").write_text(json.dumps({"commit": commit, "operationId": operation,
                    "snapshotId": snapshot_id, "staticTreeSha256": digest, "reusedCapture": reference}),
                    encoding="utf-8")
                return release

            state = RehearsalState(state_dir)
            verifier_output = json.dumps({"snapshotId": snapshot_id, "referenceDate": "2026-10-23",
                "bundleDigest": bundle_digest})
            with patch.object(rehearsal_host, "_validate_static_main_admission"), \
                 patch.object(rehearsal_host, "_static_main_cms_fingerprint", return_value={"cms": "same"}), \
                 patch.object(rehearsal_host, "_static_main_protected_paths", return_value=[]), \
                 patch.object(rehearsal_host, "_verify_reusable_static_capture", return_value=reusable), \
                 patch.object(rehearsal_host.pwd, "getpwnam", return_value=types.SimpleNamespace(
                     pw_uid=os.getuid(), pw_gid=os.getgid())), \
                 patch.object(rehearsal_host, "_readonly_database_snapshot") as sqlite_snapshot, \
                 patch.object(rehearsal_host, "_create_capture_bundle") as create_capture, \
                 patch.object(rehearsal_host, "_prepare_static_web_dependencies") as prepare_web, \
                 patch.object(rehearsal_host, "_run_as_cms", return_value=verifier_output) as run_as_cms, \
                 patch.object(rehearsal_host, "_build_static", return_value=(built, "e" * 64)) as build_static, \
                 patch.object(rehearsal_host, "_store_static", side_effect=store_static):
                result = rehearsal_host._static_main_prepare(config, state, new_op, source_sha, provenance,
                    reuse_capture_operation_id=capture_op)

            self.assertEqual(result["snapshotId"], snapshot_id)
            self.assertEqual(result["phase"], "browser-check-required")
            self.assertEqual((source_root / "web/.snapshot/snapshot.json").read_bytes(), snapshot_bytes)
            self.assertEqual((old_snapshot / "snapshot.json").read_bytes(), snapshot_bytes)
            sqlite_snapshot.assert_not_called()
            create_capture.assert_not_called()
            self.assertTrue(build_static.call_args.kwargs["reuse_snapshot"])
            self.assertEqual(build_static.call_args.kwargs["operation_id"], new_op)
            self.assertEqual(build_static.call_args.kwargs["reused_capture"], reference)
            prepared = rehearsal_host._static_main_prepared(rehearsal_host._static_main_rows(state, new_op))
            self.assertEqual(prepared["reusedCapture"], reference)
            self.assertEqual(prepared["referenceDate"], "2026-10-23")
            protected = {path.resolve() for path in prepare_web.call_args.args[2]}
            materialized = source_root / "web/.snapshot"
            self.assertIn(old_capture.resolve(), protected)
            self.assertIn(old_snapshot.resolve(), protected)
            self.assertIn((materialized / "snapshot.json").resolve(), protected)
            self.assertIn((materialized / "media").resolve(), protected)
            self.assertNotIn(materialized.resolve(), protected)
            self.assertEqual(run_as_cms.call_args.kwargs["read_only_path"], build_static.call_args.kwargs["read_only_paths"])

    def test_static_main_preparation_is_static_only_and_does_not_move_current(self):
        import types
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-prepare-") as temporary:
            root = Path(temporary)
            release_root = root / "releases"
            static_root = root / "static"
            release_root.mkdir()
            static_root.mkdir()
            old = static_root / "old"
            old.mkdir()
            (old / "index.html").write_text("old", encoding="utf-8")
            pointer = root / "current"
            pointer.symlink_to(old)
            candidate = release_root / f"{'a' * 40}-main-op"
            candidate.mkdir()
            provenance = {"repository": "pgorbachev/ikpk", "ref": "refs/heads/main",
                "sourceSha": "a" * 40, "workflow": "Tests", "workflowName": "Tests",
                "event": "push", "headBranch": "main", "runId": 39670066783, "attempt": 2,
                "status": "completed", "conclusion": "success",
                "requiredJobs": sorted(rehearsal_host.STATIC_MAIN_REQUIRED_JOBS),
                "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/39670066783",
                "additionalWorkflows": [{"workflow": workflow, "headSha": "a" * 40,
                    "event": "push", "headBranch": "main", "runId": index + 100,
                    "attempt": 1, "status": "completed", "conclusion": "success",
                    "requiredJobs": ["required job"],
                    "runUrl": f"https://github.com/pgorbachev/ikpk/actions/runs/{index + 100}"}
                    for index, workflow in enumerate(rehearsal_host.STATIC_MAIN_ADDITIONAL_WORKFLOWS)]}
            (candidate / ".ikpk-rehearsal-ci.json").write_text(json.dumps(provenance), encoding="utf-8")
            state_dir = root / "state"
            state_dir.mkdir()
            live_db = root / "live.sqlite"
            live_db.write_bytes(b"live")
            media_root = root / "uploads"
            media_root.mkdir()
            config = {"profile": "staging194", "staticMainReleasePolicy": "ci-only-approved",
                "releaseRoot": str(release_root), "staticReleaseRoot": str(static_root),
                "currentStatic": str(pointer), "stateDir": str(state_dir), "cmsUser": "cms",
                "cmsDatabase": str(live_db), "mediaRoots": [{"prefix": "/uploads/", "path": str(media_root)}]}
            capture = candidate / ".staging193-rehearsal/main-op/capture"
            def make_snapshot(_config, operation_root):
                snapshot = operation_root / "db.sqlite"
                snapshot.write_bytes(b"snapshot")
                return snapshot
            def make_capture(_config, operation_id, source_sha, source_root, _database, **_kwargs):
                capture.mkdir(parents=True)
                (capture / "manifest.json").write_text(json.dumps({"sourceSha": source_sha,
                    "operationId": operation_id}), encoding="utf-8")
                return capture
            built = root / "built"
            built.mkdir()
            release = static_root / f"{'a' * 40}-main-op"
            release.mkdir()
            (release / "index.html").write_text("new", encoding="utf-8")
            (release / "release.json").write_text(json.dumps({"commit": "a" * 40,
                "operationId": "main-op", "snapshotId": "snap:test"}), encoding="utf-8")
            state = RehearsalState(state_dir)
            with patch.object(rehearsal_host, "_static_main_cms_fingerprint", return_value={"cms": "same"}), \
                 patch.object(rehearsal_host, "_static_main_protected_paths", return_value=[root]) as protected_paths, \
                 patch.object(rehearsal_host.pwd, "getpwnam", return_value=types.SimpleNamespace(
                     pw_uid=__import__("os").getuid(), pw_gid=__import__("os").getgid())), \
                 patch.object(rehearsal_host, "_readonly_database_snapshot", side_effect=make_snapshot), \
                 patch.object(rehearsal_host, "_create_capture_bundle", side_effect=make_capture) as create_capture, \
                 patch.object(rehearsal_host, "_prepare_static_web_dependencies") as prepare_web, \
                 patch.object(rehearsal_host, "_build_static", return_value=(built, "b" * 64)) as build_static, \
                 patch.object(rehearsal_host, "_store_static", return_value=release), \
                 patch.object(rehearsal_host, "_switch_pointer") as switch, \
                 patch.object(rehearsal_host, "_stop_writers") as stop_writers, \
                 patch.object(rehearsal_host, "_activate_cms") as activate:
                result = rehearsal_host._static_main_prepare(config, state, "main-op", "a" * 40, provenance)
            self.assertEqual(result["phase"], "browser-check-required")
            self.assertEqual(pointer.resolve(strict=True), old.resolve(strict=True))
            with self.assertRaisesRegex(Exception, "unfinished operation"):
                state.assert_new_operation_allowed("other-op", "b" * 40)
            self.assertFalse(state.marker_path.exists())
            state._append({"version": 1, "record": "static-main-recovered", "operationKind": "static-main",
                           "operationId": "main-op", "sourceSha": "a" * 40})
            state.assert_new_operation_allowed("other-op", "b" * 40)
            switch.assert_not_called()
            stop_writers.assert_not_called()
            activate.assert_not_called()
            create_capture.assert_called_once()
            self.assertEqual(create_capture.call_args.kwargs["read_only_paths"], [root])
            prepare_web.assert_called_once_with(config, candidate.resolve(), [root])
            build_static.assert_called_once_with(
                config, candidate.resolve(), capture, read_only_paths=[root],
                chat_loader_src="https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js",
                operation_id="main-op", reused_capture=None, reuse_snapshot=False)

    def test_static_main_cms_fingerprint_does_not_follow_current_static_media_symlink(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-fingerprint-") as temporary:
            root = Path(temporary)
            cms = root / "cms"
            cms.mkdir()
            (cms / "entry.js").write_text("unchanged")
            current_cms = root / "current-cms"
            current_cms.symlink_to(cms)
            static = root / "static"
            old, new = static / "old", static / "new"
            for release, content in ((old, "old media"), (new, "new media")):
                (release / "media").mkdir(parents=True)
                (release / "media/asset.bin").write_text(content)
            current_static = root / "current-static"
            current_static.symlink_to(old)
            uploads = root / "uploads"
            uploads.mkdir()
            (uploads / "asset.bin").write_text("CMS upload")
            database = root / "cms.sqlite"
            database.write_bytes(b"database")
            config = {"currentCms": str(current_cms), "currentStatic": str(current_static),
                "cmsDatabase": str(database), "cmsUnit": "cms.service",
                "mediaRoots": [{"prefix": "/uploads/", "path": str(uploads)},
                               {"prefix": "/media/", "path": str(current_static / "media")}]
            }
            completed = subprocess.CompletedProcess(["systemctl"], 0, "Environment=stable\n", "")
            with patch.object(rehearsal_host, "_service_pid", return_value=123), \
                 patch.object(rehearsal_host, "_database_process_proof", return_value={"pid": 123}), \
                 patch.object(rehearsal_host, "_cms_payload_sha256", return_value="payload"), \
                 patch.object(rehearsal_host, "run", return_value=completed):
                before = rehearsal_host._static_main_cms_fingerprint(config)
                rehearsal_host._switch_pointer(current_static, new, static)
                after = rehearsal_host._static_main_cms_fingerprint(config)
            self.assertEqual(before, after)

    def test_static_main_protected_paths_cover_live_cms_inputs(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-readonly-") as temporary:
            root = Path(temporary)
            cms, data, uploads = root / "cms", root / "data", root / "uploads"
            cms.mkdir(); data.mkdir(); uploads.mkdir()
            (data / "cms.sqlite").write_bytes(b"db")
            env_file = root / "cms.env"
            unit_file = root / "cms.service"
            dropin = root / "cms.conf"
            for path in (env_file, unit_file, dropin):
                path.write_text("protected")
            current_cms = root / "current-cms"
            current_cms.symlink_to(cms)
            config = {"currentCms": str(current_cms), "cmsDatabase": str(data / "cms.sqlite"),
                      "mediaRoots": [{"prefix": "/uploads/", "path": str(uploads)}], "cmsUnit": "cms.service"}
            output = (f"EnvironmentFiles=-{env_file} (ignore_errors=no)\n"
                      f"FragmentPath={unit_file}\nDropInPaths={dropin}\n")
            with patch.object(rehearsal_host, "run", return_value=subprocess.CompletedProcess(
                    ["systemctl"], 0, output, "")):
                protected = set(rehearsal_host._static_main_protected_paths(config))
            self.assertTrue({path.resolve() for path in (cms, data, uploads, env_file, unit_file, dropin)}
                            .issubset(protected))

    def test_static_main_rollback_refuses_to_clobber_a_newer_static_pointer(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-cas-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            old, candidate, newer = (releases / name for name in ("old", "candidate", "newer"))
            for directory in (old, candidate, newer):
                directory.mkdir()
                (directory / "index.html").write_text(directory.name, encoding="utf-8")
            pointer = root / "current"
            pointer.symlink_to(newer)
            start = {"operationId": "main-op", "sourceSha": "a" * 40,
                     "oldStaticPath": str(old), "oldStaticTreeSha256": rehearsal_host._tree_sha256(old)}
            state_dir = root / "state"
            state_dir.mkdir()
            state = RehearsalState(state_dir)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "no longer points to this candidate"):
                rehearsal_host._static_main_rollback(
                    {"currentStatic": str(pointer), "staticReleaseRoot": str(releases)}, state, start, candidate)
            self.assertEqual(pointer.resolve(strict=True), newer.resolve(strict=True))

    def test_static_main_explicit_committed_rollback_records_operator_and_reason_and_is_idempotent(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-committed-rollback-") as temporary:
            config, state, pointer, old, _candidate, _foreign = self._committed_static_main_fixture(Path(temporary))
            current_cms = Path(config["currentCms"])
            cms_target = current_cms.resolve(strict=True)
            cms_digest = rehearsal_host._tree_sha256(cms_target)
            result = rehearsal_host._static_main_recover(
                config, state, "main-op", rollback_committed=True,
                operator_name="release-operator", reason="Post-activation route smoke failed")
            self.assertEqual(result["phase"], "rolled-back")
            self.assertEqual(pointer.resolve(strict=True), old.resolve(strict=True))
            self.assertEqual(current_cms.resolve(strict=True), cms_target)
            self.assertEqual(rehearsal_host._tree_sha256(cms_target), cms_digest)
            records = state._operation_rows("main-op")
            intent = next(row for row in records if row.get("record") == "static-main-rollback-intent")
            completed = next(row for row in records if row.get("record") == "static-main-rollback-completed")
            self.assertEqual(intent["operator"], "release-operator")
            self.assertEqual(intent["reason"], "Post-activation route smoke failed")
            self.assertEqual(completed["candidateStaticTreeSha256"], completed["committedStaticTreeSha256"])
            count = len(records)
            repeated = rehearsal_host._static_main_recover(
                config, state, "main-op", rollback_committed=True,
                operator_name="release-operator", reason="Post-activation route smoke failed")
            self.assertEqual(repeated["phase"], "rolled-back")
            self.assertEqual(len(state._operation_rows("main-op")), count)
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "already completed with different"):
                rehearsal_host._static_main_recover(
                    config, state, "main-op", rollback_committed=True,
                    operator_name="release-operator", reason="Different rollback reason")

    def test_static_main_commit_retry_is_refused_after_committed_rollback(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-commit-after-rollback-") as temporary:
            config, state, pointer, old, candidate, _foreign = self._committed_static_main_fixture(Path(temporary))
            rehearsal_host._static_main_recover(
                config, state, "main-op", rollback_committed=True,
                operator_name="release-operator", reason="Post-activation route smoke failed")
            digest = rehearsal_host._tree_sha256(candidate)
            with patch.object(rehearsal_host, "_validate_static_main_admission"):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "cannot be committed after rollback"):
                    rehearsal_host._static_main_commit(config, state, "main-op", "a" * 40, {}, digest)
            self.assertEqual(pointer.resolve(strict=True), old.resolve(strict=True))

    def test_static_main_committed_rollback_refuses_foreign_pointer_and_changed_old_tree(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-rollback-foreign-") as temporary:
            config, state, pointer, _old, _candidate, foreign = self._committed_static_main_fixture(
                Path(temporary), current_name="foreign")
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "no longer points to this candidate"):
                rehearsal_host._static_main_recover(
                    config, state, "main-op", rollback_committed=True,
                    operator_name="release-operator", reason="Post-activation route smoke failed")
            self.assertEqual(pointer.resolve(strict=True), foreign.resolve(strict=True))
            self.assertFalse(any(row.get("record") == "static-main-rollback-intent"
                                 for row in state._operation_rows("main-op")))

        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-rollback-old-tree-") as temporary:
            config, state, pointer, old, _candidate, _foreign = self._committed_static_main_fixture(Path(temporary))
            (old / "index.html").write_text("changed old tree", encoding="utf-8")
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "exact old static tree"):
                rehearsal_host._static_main_recover(
                    config, state, "main-op", rollback_committed=True,
                    operator_name="release-operator", reason="Post-activation route smoke failed")
            self.assertNotEqual(pointer.resolve(strict=True), old.resolve(strict=True))
            self.assertFalse(any(row.get("record") == "static-main-rollback-intent"
                                 for row in state._operation_rows("main-op")))

    def test_static_main_committed_rollback_finishes_journal_after_switch_crash(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-rollback-crash-") as temporary:
            config, state, pointer, old, _candidate, _foreign = self._committed_static_main_fixture(Path(temporary))

            def switch_then_crash(config, _state, start, _candidate, **_kwargs):
                rehearsal_host._switch_pointer(Path(config["currentStatic"]), old,
                                               Path(config["staticReleaseRoot"]))
                raise rehearsal_host.HostFailure("simulated crash after pointer switch")

            with patch.object(rehearsal_host, "_static_main_rollback", side_effect=switch_then_crash):
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "simulated crash"):
                    rehearsal_host._static_main_recover(
                        config, state, "main-op", rollback_committed=True,
                        operator_name="release-operator", reason="Post-activation route smoke failed")
            self.assertEqual(pointer.resolve(strict=True), old.resolve(strict=True))
            self.assertFalse(any(row.get("record") == "static-main-rollback-completed"
                                 for row in state._operation_rows("main-op")))
            result = rehearsal_host._static_main_recover(
                config, state, "main-op", rollback_committed=True,
                operator_name="release-operator", reason="Post-activation route smoke failed")
            self.assertEqual(result["phase"], "rolled-back")
            self.assertTrue(any(row.get("record") == "static-main-rollback-completed"
                                for row in state._operation_rows("main-op")))

    def test_static_main_crash_recovery_restores_old_tree_only_after_durable_switch_intent(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-recover-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            old, candidate = releases / "old", releases / f"{'a' * 40}-main-op"
            old.mkdir()
            candidate.mkdir()
            (old / "index.html").write_text("old")
            (candidate / "index.html").write_text("candidate")
            pointer = root / "current"
            pointer.symlink_to(candidate)
            state_dir = root / "state"
            state_dir.mkdir()
            state = RehearsalState(state_dir)
            old_sha = rehearsal_host._tree_sha256(old)
            digest = rehearsal_host._tree_sha256(candidate)
            state._append({"version": 1, "record": "static-main-start", "operationKind": "static-main",
                "operationId": "main-op", "sourceSha": "a" * 40, "oldStaticPath": str(old),
                "oldStaticTreeSha256": old_sha})
            state._append({"version": 1, "record": "static-main-switch-intent", "operationKind": "static-main",
                "operationId": "main-op", "sourceSha": "a" * 40, "oldStaticPath": str(old),
                "candidateStaticPath": str(candidate), "staticTreeSha256": digest})
            result = rehearsal_host._static_main_recover(
                {"currentStatic": str(pointer), "staticReleaseRoot": str(releases)}, state, "main-op")
            self.assertEqual(result["phase"], "recovered")
            self.assertEqual(pointer.resolve(strict=True), old.resolve(strict=True))
            self.assertTrue(any(row.get("record") == "static-main-recovered"
                                for row in state._operation_rows("main-op")))


    def test_readonly_sqlite_snapshot_includes_wal_without_changing_live_bytes(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-sqlite-") as temporary:
            root = Path(temporary)
            database = root / "live.sqlite"
            connection = sqlite3.connect(database)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE content (body TEXT NOT NULL)")
            connection.execute("INSERT INTO content VALUES ('current CMS content')")
            connection.commit()
            wal = Path(str(database) + "-wal")
            before = (database.read_bytes(), wal.read_bytes() if wal.exists() else None)
            operation = root / "operation"
            operation.mkdir()
            snapshot = rehearsal_host._readonly_database_snapshot(
                {"cmsDatabase": str(database)}, operation)
            check = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
            try:
                self.assertEqual(check.execute("SELECT body FROM content").fetchone()[0],
                                 "current CMS content")
            finally:
                check.close()
            after = (database.read_bytes(), wal.read_bytes() if wal.exists() else None)
            self.assertEqual(after, before)
            connection.close()

    def test_static_main_probe_failure_restores_exact_old_static_tree(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-rollback-") as temporary:
            root = Path(temporary)
            releases = root / "releases"
            releases.mkdir()
            old, candidate = releases / "old", releases / f"{'a' * 40}-main-op"
            old.mkdir()
            candidate.mkdir()
            (old / "index.html").write_text("old bytes", encoding="utf-8")
            (candidate / "index.html").write_text("candidate bytes", encoding="utf-8")
            digest = rehearsal_host._tree_sha256(candidate)
            (candidate / "release.json").write_text(json.dumps({"commit": "a" * 40,
                "operationId": "main-op", "snapshotId": "snap:test"}), encoding="utf-8")
            pointer = root / "current"
            pointer.symlink_to(old)
            state_dir = root / "state"
            state_dir.mkdir()
            state = RehearsalState(state_dir)
            config = {"profile": "staging194", "staticMainReleasePolicy": "ci-only-approved",
                "staticReleaseRoot": str(releases), "currentStatic": str(pointer),
                "siteHealthUrl": "https://194.226.99.10/", "siteProbeUrls": []}
            provenance = {"repository": "pgorbachev/ikpk", "ref": "refs/heads/main",
                "sourceSha": "a" * 40, "workflow": "Tests", "workflowName": "Tests",
                "event": "push", "headBranch": "main", "runId": 39670066783, "attempt": 2,
                "status": "completed", "conclusion": "success",
                "requiredJobs": sorted(rehearsal_host.STATIC_MAIN_REQUIRED_JOBS),
                "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/39670066783",
                "additionalWorkflows": [{"workflow": workflow, "headSha": "a" * 40,
                    "event": "push", "headBranch": "main", "runId": index + 100,
                    "attempt": 1, "status": "completed", "conclusion": "success",
                    "requiredJobs": ["required job"],
                    "runUrl": f"https://github.com/pgorbachev/ikpk/actions/runs/{index + 100}"}
                    for index, workflow in enumerate(rehearsal_host.STATIC_MAIN_ADDITIONAL_WORKFLOWS)]}
            start = {"version": 1, "record": "static-main-start", "operationKind": "static-main",
                "operationId": "main-op", "sourceSha": "a" * 40, "provenance": provenance,
                "oldStaticPath": str(old.resolve()), "oldStaticTreeSha256": rehearsal_host._tree_sha256(old),
                "cmsFingerprint": {"cms": "same"}, "configSha256": rehearsal_host._config_sha256(config)}
            prepared = {"version": 1, "record": "static-main-prepared", "operationKind": "static-main",
                "operationId": "main-op", "sourceSha": "a" * 40, "staticTreeSha256": digest,
                "snapshotId": "snap:test"}
            state._append(start)
            state._append(prepared)
            with patch.object(rehearsal_host, "_static_main_cms_fingerprint", return_value={"cms": "same"}), \
                 patch.object(rehearsal_host, "_wait_health"), \
                 patch.object(rehearsal_host, "_served_release_matches",
                               side_effect=rehearsal_host.HostFailure("served release probe failed")), \
                 patch.object(rehearsal_host, "_activate_cms") as activate, \
                 patch.object(rehearsal_host, "_stop_writers") as stop_writers:
                with self.assertRaisesRegex(rehearsal_host.HostFailure, "old static tree was restored"):
                    rehearsal_host._static_main_commit(config, state, "main-op", "a" * 40,
                                                       provenance, digest)
            self.assertEqual(pointer.resolve(strict=True), old.resolve(strict=True))
            activate.assert_not_called()
            stop_writers.assert_not_called()
            self.assertTrue(any(row.get("record") == "static-main-rolled-back"
                                for row in state._operation_rows("main-op")))

    def test_static_main_commit_probes_encoded_media_before_durable_commit(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-media-commit-") as temporary:
            root = Path(temporary)
            source_sha = "a" * 40
            releases = root / "releases"
            releases.mkdir()
            candidate = releases / f"{source_sha}-main-op"
            (candidate / "_astro").mkdir(parents=True)
            (candidate / "index.html").write_text("candidate", encoding="utf-8")
            (candidate / "_astro/app.abcdef123456.js").write_text("asset", encoding="utf-8")
            old = releases / "old"
            old.mkdir()
            (old / "index.html").write_text("old", encoding="utf-8")
            pointer = root / "current"
            pointer.symlink_to(old)
            candidate_digest = rehearsal_host._tree_sha256(candidate)

            capture = root / "source" / f"{source_sha}-main-op/.staging193-rehearsal/main-op/capture"
            capture.mkdir(parents=True)
            media_url = "/uploads/проба media.jpg"
            (capture / "media-manifest.json").write_text(
                json.dumps({"media": [{"url": media_url}]}), encoding="utf-8")

            state_dir = root / "state"
            state_dir.mkdir()
            state = RehearsalState(state_dir)
            provenance = {"repository": "pgorbachev/ikpk", "ref": "refs/heads/main",
                "sourceSha": source_sha, "workflow": "Tests", "workflowName": "Tests",
                "event": "push", "headBranch": "main", "runId": 39670066783, "attempt": 2,
                "status": "completed", "conclusion": "success",
                "requiredJobs": sorted(rehearsal_host.STATIC_MAIN_REQUIRED_JOBS),
                "runUrl": "https://github.com/pgorbachev/ikpk/actions/runs/39670066783",
                "additionalWorkflows": [{"workflow": workflow, "headSha": source_sha,
                    "event": "push", "headBranch": "main", "runId": index + 100,
                    "attempt": 1, "status": "completed", "conclusion": "success",
                    "requiredJobs": ["required job"],
                    "runUrl": f"https://github.com/pgorbachev/ikpk/actions/runs/{index + 100}"}
                    for index, workflow in enumerate(rehearsal_host.STATIC_MAIN_ADDITIONAL_WORKFLOWS)]}
            config = {"profile": "staging194", "staticMainReleasePolicy": "ci-only-approved",
                      "staticReleaseRoot": str(releases), "currentStatic": str(pointer),
                      "releaseRoot": str(root / "source"), "siteHealthUrl": "https://site.test/health",
                      "siteBaseUrl": "https://site.test", "siteReleaseUrl": "https://site.test/release.json",
                      "siteProbeUrls": ["https://site.test/"]}
            fingerprint = {"cms": "unchanged"}
            state._append({"version": 1, "record": "static-main-start", "operationKind": "static-main",
                           "operationId": "main-op", "sourceSha": source_sha, "provenance": provenance,
                           "oldStaticPath": str(old.resolve()),
                           "oldStaticTreeSha256": rehearsal_host._tree_sha256(old),
                           "configSha256": rehearsal_host._config_sha256(config),
                           "cmsFingerprint": fingerprint})
            state._append({"version": 1, "record": "static-main-prepared", "operationKind": "static-main",
                           "operationId": "main-op", "sourceSha": source_sha,
                           "staticTreeSha256": candidate_digest, "snapshotId": "snapshot-main"})
            curl_commands = []

            def curl(argv, **_kwargs):
                curl_commands.append(argv)
                if argv[-1] == config["siteReleaseUrl"]:
                    release = {"commit": source_sha, "operationId": "main-op",
                               "staticTreeSha256": candidate_digest, "snapshotId": "snapshot-main"}
                    return subprocess.CompletedProcess(argv, 0, json.dumps(release), "")
                if "--write-out" in argv:
                    return subprocess.CompletedProcess(argv, 0, "200", "")
                return subprocess.CompletedProcess(argv, 0, "", "")

            with patch.object(rehearsal_host, "_static_main_cms_fingerprint", return_value=fingerprint), \
                 patch.object(rehearsal_host, "run", side_effect=curl):
                result = rehearsal_host._static_main_commit(
                    config, state, "main-op", source_sha, provenance, candidate_digest)

            self.assertEqual(result["phase"], "committed")
            self.assertEqual(pointer.resolve(strict=True), candidate.resolve(strict=True))
            self.assertTrue(any(row.get("record") == "static-main-committed"
                                for row in state._operation_rows("main-op")))
            encoded_media_url = "https://site.test/uploads/%D0%BF%D1%80%D0%BE%D0%B1%D0%B0%20media.jpg"
            self.assertIn(encoded_media_url, [argv[-1] for argv in curl_commands])

    def test_generic_recovery_refuses_static_main_operation_kind(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-static-main-kind-") as temporary:
            state_dir = Path(temporary)
            state = RehearsalState(state_dir)
            state._append({"version": 1, "record": "static-main-start",
                           "operationKind": "static-main", "operationId": "main-op",
                           "sourceSha": "a" * 40})
            with self.assertRaisesRegex(rehearsal_host.HostFailure, "cannot enter CMS/database recovery"):
                rehearsal_host._recover({}, state, "main-op")


if __name__ == "__main__":
    unittest.main()
