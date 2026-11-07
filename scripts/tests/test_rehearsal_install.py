import os
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import rehearsal_config


ROOT = Path(__file__).resolve().parents[2]


class InstalledEntrypointTests(unittest.TestCase):
    def test_existing_production_config_adds_only_reviewed_housekeeping_paths(self):
        template_path = ROOT / "scripts/production-static-rehearsal.json"
        template = json.loads(template_path.read_text(encoding="utf-8"))
        current = dict(template)
        current.pop("sitePublicationMarker")
        with tempfile.TemporaryDirectory(prefix="ikpk-prod-config-migration-") as temporary:
            root = Path(temporary)
            config_path, local_template = root / "production.json", root / "template.json"
            original = json.dumps(current, indent=2).encode()
            config_path.write_bytes(original)
            local_template.write_text(json.dumps(template), encoding="utf-8")
            rehearsal_config.check(str(config_path), str(local_template))
            rehearsal_config.migrate(str(config_path), str(local_template))
            self.assertEqual(json.loads(config_path.read_text()), template)
            backups = list(root.glob("production.json.pre-update-*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)

    def test_production_migration_keeps_installed_payment_probe_and_adds_missing_lock(self):
        template = {
            "profile": "initial-prod",
            "paymentStatusProbeUrl": "https://payments.example/template",
            "publicationLock": "/var/www/ikpk/.publication.lock",
            "cmsUser": "cms",
        }
        installed_probe = "https://payments.example/installed?keep=exact"
        current = dict(template)
        current.pop("publicationLock")
        current["paymentStatusProbeUrl"] = installed_probe
        with tempfile.TemporaryDirectory(prefix="ikpk-probe-preserve-") as temporary:
            root = Path(temporary)
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            original = json.dumps(current, indent=2).encode()
            config_path.write_bytes(original)
            rehearsal_config.check(str(config_path), str(template_path))
            rehearsal_config.migrate(str(config_path), str(template_path))
            migrated = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(migrated["paymentStatusProbeUrl"], installed_probe)
            self.assertEqual(migrated["publicationLock"], template["publicationLock"])
            self.assertEqual(migrated["cmsUser"], "cms")
            self.assertEqual(list(root.glob("rehearsal.json.pre-update-*.bak"))[0].read_bytes(), original)

    def test_production_probe_difference_alone_does_not_rewrite_config(self):
        template = {"profile": "production-static", "paymentStatusProbeUrl": "https://payments.example/template"}
        current = {"profile": "production-static", "paymentStatusProbeUrl": "https://payments.example/installed"}
        with tempfile.TemporaryDirectory(prefix="ikpk-probe-noop-") as temporary:
            root = Path(temporary)
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            original = json.dumps(current).encode()
            config_path.write_bytes(original)
            rehearsal_config.migrate(str(config_path), str(template_path))
            self.assertEqual(config_path.read_bytes(), original)
            self.assertFalse(list(root.glob("*.bak")))

    def test_production_migration_refuses_probe_drift_combined_with_another_change(self):
        template = {
            "profile": "production-paired",
            "paymentStatusProbeUrl": "https://payments.example/template",
            "cmsUser": "cms",
        }
        current = {
            "profile": "production-paired",
            "paymentStatusProbeUrl": "https://payments.example/installed",
            "cmsUser": "other",
        }
        with tempfile.TemporaryDirectory(prefix="ikpk-probe-refuse-") as temporary:
            root = Path(temporary)
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            config_path.write_text(json.dumps(current), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unrelated differences"):
                rehearsal_config.check(str(config_path), str(template_path))
            self.assertEqual(json.loads(config_path.read_text()), current)

    def test_real_production_templates_keep_foreign_probe_and_fill_one_missing_field(self):
        cases = (
            ("initial-prod-rehearsal.json", "publicationLock"),
            ("production-static-rehearsal.json", "siteRefreshState"),
            ("production-paired-rehearsal.json", "sitePublicationMarker"),
        )
        installed_probe = "https://payments.example/installed-not-template"
        for filename, missing in cases:
            template = json.loads((ROOT / "scripts" / filename).read_text(encoding="utf-8"))
            current = dict(template)
            current.pop(missing)
            current["paymentStatusProbeUrl"] = installed_probe
            with tempfile.TemporaryDirectory(prefix="ikpk-real-probe-") as temporary:
                root = Path(temporary)
                template_path, config_path = root / "template.json", root / "rehearsal.json"
                template_path.write_text(json.dumps(template), encoding="utf-8")
                config_path.write_text(json.dumps(current), encoding="utf-8")
                rehearsal_config.migrate(str(config_path), str(template_path))
                migrated = json.loads(config_path.read_text(encoding="utf-8"))
                self.assertEqual(migrated["paymentStatusProbeUrl"], installed_probe)
                self.assertEqual(migrated[missing], template[missing])
                for key, value in template.items():
                    if key != "paymentStatusProbeUrl":
                        self.assertEqual(migrated[key], value, filename)

    def test_production_migration_does_not_invent_a_missing_payment_probe(self):
        template = json.loads((ROOT / "scripts/initial-prod-rehearsal.json").read_text(encoding="utf-8"))
        current = dict(template)
        current.pop("paymentStatusProbeUrl")
        with tempfile.TemporaryDirectory(prefix="ikpk-missing-probe-") as temporary:
            root = Path(temporary)
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            original = json.dumps(current)
            config_path.write_text(original, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unrelated differences"):
                rehearsal_config.migrate(str(config_path), str(template_path))
            self.assertEqual(config_path.read_text(encoding="utf-8"), original)
            self.assertFalse(list(root.glob("*.bak")))

    def test_staging_migration_refuses_payment_probe_drift(self):
        template = {"profile": "staging194", "paymentStatusProbeUrl": "https://payments.example/template"}
        current = {"profile": "staging194", "paymentStatusProbeUrl": "https://payments.example/installed"}
        with tempfile.TemporaryDirectory(prefix="ikpk-staging-probe-") as temporary:
            root = Path(temporary)
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            config_path.write_text(json.dumps(current), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unrelated differences"):
                rehearsal_config.migrate(str(config_path), str(template_path))
            self.assertFalse(list(root.glob("*.bak")))

    def test_real_staging194_config_without_profile_migrates_and_installer_accepts_it(self):
        template_path = ROOT / "scripts/staging193-rehearsal.json"
        template = json.loads(template_path.read_text(encoding="utf-8"))
        self.assertNotIn("profile", template)
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-real-staging-config-") as temporary:
            root = Path(temporary)
            config_path = root / "rehearsal.json"
            current = dict(template)
            current.pop("sitePublicationMarker")
            current.pop("temporaryRoot")
            current["siteRefreshState"] = "/var/lib/ikpk-cms-prototype193/staging/site-refresh194/state"
            current["allowedSourceRef"] = "refs/heads/dev"
            original = json.dumps(current, indent=2).encode()
            config_path.write_bytes(original)
            rehearsal_config.check(str(config_path), str(template_path))
            rehearsal_config.migrate(str(config_path), str(template_path))
            self.assertEqual(json.loads(config_path.read_text(encoding="utf-8")), template)
            self.assertEqual(len(list(root.glob("rehearsal.json.pre-update-*.bak"))), 1)
            self.assertEqual(template["siteRefreshState"],
                             "/var/lib/ikpk-cms-prototype193/staging/site-refresh194/state/state.json")

        installer = (ROOT / "scripts/install-rehearsal-host.sh").read_text(encoding="utf-8")
        self.assertIn('profile = config.get("profile", "staging194")', installer)
        self.assertNotIn('config["profile"]', installer)

    def test_staging194_dev_to_main_migration_is_atomic_backed_up_and_preserves_other_keys(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-config-migration-") as temporary:
            root = Path(temporary)
            template = {"profile": "staging194", "allowedSourceRef": "refs/heads/main",
                        "cmsDatabase": "/var/lib/site/data.db", "customSetting": {"keep": True}}
            current = {**template, "allowedSourceRef": "refs/heads/dev"}
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            original = json.dumps(current, indent=2).encode()
            config_path.write_bytes(original)
            rehearsal_config.check(str(config_path), str(template_path))
            rehearsal_config.migrate(str(config_path), str(template_path))
            self.assertEqual(json.loads(config_path.read_text()), template)
            backups = list(root.glob("rehearsal.json.pre-update-*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)

    def test_staging194_migration_refuses_unrelated_config_differences(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-config-refuse-") as temporary:
            root = Path(temporary)
            template = {"profile": "staging194", "allowedSourceRef": "refs/heads/main", "cmsUser": "cms"}
            current = {**template, "allowedSourceRef": "refs/heads/dev", "cmsUser": "other"}
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            config_path.write_text(json.dumps(current), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unrelated differences"):
                rehearsal_config.check(str(config_path), str(template_path))
            self.assertEqual(json.loads(config_path.read_text()), current)
            self.assertFalse(list(root.glob("*.bak")))

    def test_existing_staging194_config_may_omit_defaulted_cms_environment_file_without_rewrite(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-staging194-existing-config-default-") as temporary:
            root = Path(temporary)
            template = {"profile": "staging194", "allowedSourceRef": "refs/heads/main",
                        "cmsUser": "cms", "cmsEnvironmentFile": "/etc/ikpk-cms/site-build-current194.env"}
            current = dict(template)
            current.pop("cmsEnvironmentFile")
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            original = json.dumps(current, indent=2).encode("utf-8") + b"\n"
            config_path.write_bytes(original)

            rehearsal_config.check(str(config_path), str(template_path))

            self.assertEqual(config_path.read_bytes(), original)
            self.assertFalse(list(root.glob("*.bak")))

            production_template = {"profile": "production-paired", "cmsUser": "cms",
                                   "cmsEnvironmentFile": "/etc/ikpk-cms/trial.env"}
            production_config = {key: value for key, value in production_template.items()
                                 if key != "cmsEnvironmentFile"}
            production_template_path = root / "production-template.json"
            production_config_path = root / "production.json"
            production_template_path.write_text(json.dumps(production_template), encoding="utf-8")
            production_config_path.write_text(json.dumps(production_config), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unrelated differences"):
                rehearsal_config.check(str(production_config_path), str(production_template_path))

    def test_staging194_migration_replace_failure_preserves_compatible_dev_config(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-config-atomic-failure-") as temporary:
            root = Path(temporary)
            template = {"profile": "staging194", "allowedSourceRef": "refs/heads/main", "cmsUser": "cms"}
            current = {**template, "allowedSourceRef": "refs/heads/dev"}
            template_path, config_path = root / "template.json", root / "rehearsal.json"
            template_path.write_text(json.dumps(template), encoding="utf-8")
            original = json.dumps(current, indent=2)
            config_path.write_text(original, encoding="utf-8")
            with patch.object(rehearsal_config.os, "replace", side_effect=OSError("injected replace failure")):
                with self.assertRaisesRegex(OSError, "injected replace failure"):
                    rehearsal_config.migrate(str(config_path), str(template_path))
            self.assertEqual(json.loads(config_path.read_text()), current)
            backups = list(root.glob("rehearsal.json.pre-update-*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), original)

    def test_installed_package_contains_all_imports_and_has_working_entrypoint(self):
        with tempfile.TemporaryDirectory(prefix="ikpk-rehearsal-install-") as temporary:
            prefix = Path(temporary) / "prefix"
            install = subprocess.run(["bash", str(ROOT / "scripts/install-rehearsal-host.sh"), "--prefix", str(prefix)],
                                     cwd=ROOT, text=True, capture_output=True, check=False)
            self.assertEqual(install.returncode, 0, install.stderr)
            package = prefix / "lib/ikpk-rehearsal"
            self.assertEqual({path.name for path in package.iterdir()},
                             {"rehearsal_state.py", "housekeeping_journal.py", "rehearsal_host.py"})
            smoke = subprocess.run([str(prefix / "sbin/ikpk-rehearsal"), "--help"],
                                   text=True, capture_output=True, check=False,
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual(smoke.returncode, 0, smoke.stderr)
            self.assertIn("cms-update", smoke.stdout)
            self.assertIn("static-publish", smoke.stdout)

    def test_housekeeping_unit_allows_stale_pointer_parent_without_requiring_prod_lock_on_194(self):
        installer = (ROOT / "scripts/install-rehearsal-host.sh").read_text(encoding="utf-8")
        self.assertIn('ExecStart=$SBIN/ikpk-rehearsal --profile $service_profile cleanup-site', installer)
        self.assertIn("ProtectSystem=strict", installer)
        self.assertIn("PrivateTmp=yes", installer)
        self.assertIn("ReadWritePaths=/var/www/ikpk $site_state_dir $state_dir", installer)
        self.assertIn("$cleanup_backup_root", installer)
        self.assertIn("$cleanup_profile_artifact_roots", installer)
        for path in (
            "-/var/lib/ikpk-rehearsal/initial-prod/backups",
            "-/var/lib/ikpk-rehearsal/production-static/backups",
            "-/var/lib/ikpk-rehearsal/production-paired/backups",
        ):
            self.assertIn(path, installer)
        self.assertIn('json.load(source)["backupRoot"]', installer)
        self.assertIn('json.load(source)["releaseRoot"]', installer)
        self.assertIn("$cleanup_cms_release_root", installer)
        self.assertNotIn("ReadWritePaths=/var/www/ikpk/releases /var/www/ikpk/.publication.lock", installer)
        for profile in ("initial-prod", "production-static", "production-paired"):
            self.assertIn("-/var/lib/ikpk-rehearsal/" + profile, installer)
        self.assertIn("the 194 transport serialize through", installer)
        self.assertIn("Do not require that prod-only inode on 194", installer)

    def test_housekeeping_keeps_timer_retry_without_activating_level_trigger_path(self):
        installer = (ROOT / "scripts/install-rehearsal-host.sh").read_text(encoding="utf-8")
        self.assertIn("INSTALL_DISABLED=0", installer)
        self.assertIn("--install-disabled) INSTALL_DISABLED=1; shift ;;", installer)
        self.assertIn("[--install-disabled]", installer)
        self.assertIn("--staging193-existing-config)", installer)
        self.assertIn('elif (( INSTALL_EXISTING_CONFIG_ONLY )); then', installer)
        self.assertIn('if ! cmp -s "$CONFIG" "$TEMPLATE" && (( ! INSTALL_EXISTING_CONFIG_ONLY )); then', installer)
        self.assertIn('if (( INSTALL_EXISTING_CONFIG_ONLY )); then\n      echo \'existing rehearsal config disappeared during helper refresh; refusing to create it\'', installer)
        start = installer.index("  systemctl daemon-reload")
        end = installer.index("\nfi\necho \"installed rehearsal host entrypoint", start)
        activation = "\n".join(line[2:] for line in installer[start:end].splitlines())
        self.assertNotIn("PathExists=", installer)
        stop_path = installer.index('systemctl stop ikpk-site-housekeeping.path')
        stop_timer = installer.index('systemctl stop ikpk-site-housekeeping.timer')
        stop_service = installer.index('systemctl stop ikpk-site-housekeeping.service')
        disable = installer.index('systemctl disable ikpk-site-housekeeping.path')
        timer_enable = installer.index('systemctl enable --now ikpk-site-housekeeping.timer')
        self.assertLess(stop_path, stop_timer)
        self.assertLess(stop_timer, stop_service)
        self.assertLess(stop_service, disable)
        self.assertLess(disable, installer.index('install -m 0644 "$ROOT/scripts/lib/rehearsal_state.py"'))
        self.assertLess(disable, installer.index('cat >"$SBIN/ikpk-rehearsal"'))
        self.assertGreater(timer_enable, installer.index('cat >"$SBIN/ikpk-rehearsal"'))
        self.assertIn('rm -f -- "$systemd_dir/ikpk-site-housekeeping.path"', installer)
        self.assertIn("OnUnitActiveSec=10min", installer)
        self.assertNotIn("enable --now ikpk-site-housekeeping.path", activation)

        with tempfile.TemporaryDirectory(prefix="ikpk-housekeeping-systemctl-") as temporary:
            root = Path(temporary)
            stub = root / "systemctl"
            stub.write_text(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_CALLS\"\n"
                "[[ \"${SYSTEMCTL_FAIL:-}\" != \"$*\" ]] || exit 42\n",
                encoding="utf-8",
            )
            stub.chmod(0o755)
            for disabled, expected in (
                (1, ["daemon-reload"]),
                (0, ["daemon-reload", "enable --now ikpk-site-housekeeping.timer"]),
            ):
                calls = root / f"calls-{disabled}"
                run = subprocess.run(
                    ["bash", "-c", f"set -e\nINSTALL_DISABLED={disabled}\nsystemd_dir={root}\n{activation}"],
                    env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                         "SYSTEMCTL_CALLS": str(calls)},
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(calls.read_text(encoding="utf-8").splitlines(), expected)

            # Execute the installer's actual stop/disable preflight followed by
            # its helper writes. Failures before the write leave old bytes intact.
            systemd_dir = root / "systemd"
            systemd_dir.mkdir()
            old_path = systemd_dir / "ikpk-site-housekeeping.path"
            old_path.write_bytes(b"legacy PathExists unit\n")
            old_timer = systemd_dir / "ikpk-site-housekeeping.timer"
            old_timer.write_bytes(b"existing ten-minute retry timer\n")
            old_service = systemd_dir / "ikpk-site-housekeeping.service"
            old_service.write_bytes(b"existing cleanup service\n")
            prefix = root / "prefix"
            installed_lib = prefix / "lib/ikpk-rehearsal"
            installed_sbin = prefix / "sbin"
            installed_lib.mkdir(parents=True)
            installed_sbin.mkdir(parents=True)
            original = {
                installed_lib / name: f"old {name}\n".encode()
                for name in ("rehearsal_state.py", "housekeeping_journal.py", "rehearsal_host.py")
            }
            original[installed_sbin / "ikpk-rehearsal"] = b"old launcher\n"
            for path, content in original.items():
                path.write_bytes(content)
            guard_start = installer.index("HOUSEKEEPING_TRANSITION=0")
            guard_end = installer.index('\nLIB="$PREFIX/lib/ikpk-rehearsal"', guard_start)
            writes_start = guard_end + 1
            writes_end = installer.index('\nif [[ -n "$INSTALL_CONFIG_PROFILE" ]]; then', writes_start)
            preflight = installer[guard_start:guard_end].replace(
                "systemd_dir=/etc/systemd/system", f"systemd_dir={systemd_dir}")
            install_fragment = (
                "set -e\n"
                f"ROOT={ROOT}\nPREFIX={prefix}\nINSTALL_CONFIG_PROFILE=staging193\n"
                f"{preflight}\n{installer[writes_start:writes_end]}\n"
            )
            stub = root / "systemctl"
            stub.write_text(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_CALLS\"\n"
                "[[ \"${SYSTEMCTL_FAIL:-}\" != \"$*\" ]] || exit 42\n",
                encoding="utf-8",
            )
            stub.chmod(0o755)
            absent_systemd = root / "fresh-systemd"
            absent_systemd.mkdir()
            absent_fragment = installer[guard_start:guard_end].replace(
                "systemd_dir=/etc/systemd/system", f"systemd_dir={absent_systemd}")
            absent_calls = root / "calls-absent-unit"
            absent = subprocess.run(
                ["bash", "-c", f"set -e\nPREFIX={prefix}\nINSTALL_CONFIG_PROFILE=staging193\n{absent_fragment}"],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(absent_calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(absent.returncode, 0, absent.stderr)
            self.assertFalse(absent_calls.exists(), "fresh install must skip disable for an absent unit")

            incomplete_systemd = root / "incomplete-systemd"
            incomplete_systemd.mkdir()
            incomplete_path = incomplete_systemd / "ikpk-site-housekeeping.path"
            incomplete_path.write_bytes(b"legacy PathExists unit\n")
            incomplete_fragment = installer[guard_start:guard_end].replace(
                "systemd_dir=/etc/systemd/system", f"systemd_dir={incomplete_systemd}")
            incomplete_calls = root / "calls-incomplete-units"
            run = subprocess.run(
                ["bash", "-c", f"set -e\nPREFIX={prefix}\nINSTALL_CONFIG_PROFILE=staging193\n{incomplete_fragment}\n{installer[writes_start:writes_end]}"],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(incomplete_calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertFalse(incomplete_calls.exists())
            self.assertEqual(incomplete_path.read_bytes(), b"legacy PathExists unit\n")
            for path, content in original.items():
                self.assertEqual(path.read_bytes(), content, path.name)

            # An isolated prefix is not a host install, even if the host has an
            # old unit file. It must not call systemctl or alter that unit.
            isolated_prefix = root / "isolated-prefix"
            isolated_systemd = root / "isolated-systemd"
            isolated_systemd.mkdir()
            isolated_unit = isolated_systemd / "ikpk-site-housekeeping.path"
            isolated_unit.write_bytes(b"host unit must remain untouched\n")
            isolated_fragment = installer[guard_start:guard_end].replace(
                "systemd_dir=/etc/systemd/system", f"systemd_dir={isolated_systemd}")
            isolated_calls = root / "calls-isolated-prefix"
            isolated = subprocess.run(
                ["bash", "-c", f"set -e\nPREFIX={isolated_prefix}\nINSTALL_CONFIG_PROFILE=\n{isolated_fragment}"],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(isolated_calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(isolated.returncode, 0, isolated.stderr)
            self.assertFalse(isolated_calls.exists(), "isolated prefix must not invoke host systemctl")
            self.assertEqual(isolated_unit.read_bytes(), b"host unit must remain untouched\n")

            host_prefix = root / "host-prefix"
            host_prefix.mkdir()
            stub.write_text(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_CALLS\"\n"
                "[[ \"${SYSTEMCTL_FAIL:-}\" != \"$*\" ]] || exit 42\n",
                encoding="utf-8",
            )
            stub.chmod(0o755)
            host_scope_fragment = installer[guard_start:guard_end].replace(
                "systemd_dir=/etc/systemd/system", f"systemd_dir={isolated_systemd}").replace(
                    '"$PREFIX" -ef /usr/local', f'"$PREFIX" -ef {host_prefix}')
            for index, alias in enumerate((str(host_prefix), str(host_prefix) + "/",
                                           str(host_prefix) + "/.")):
                isolated_unit.write_bytes(b"legacy host unit\n")
                (isolated_systemd / "ikpk-site-housekeeping.timer").write_bytes(b"existing retry timer\n")
                alias_calls = root / f"calls-host-prefix-alias-{index}"
                run = subprocess.run(
                    ["bash", "-c", f"set -e\nPREFIX={alias}\nINSTALL_CONFIG_PROFILE=\n{host_scope_fragment}"],
                    env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                         "SYSTEMCTL_CALLS": str(alias_calls)},
                    text=True, capture_output=True, check=False,
                )
                self.assertEqual(run.returncode, 2, run.stderr)
                self.assertFalse(alias_calls.exists(), "host refresh without a profile must refuse before systemctl")
                self.assertEqual(isolated_unit.read_bytes(), b"legacy host unit\n")

            calls = root / "calls-disable-failure"
            run = subprocess.run(
                ["bash", "-c", install_fragment],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(calls),
                     "SYSTEMCTL_FAIL": "disable ikpk-site-housekeeping.path"},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 42, run.stderr)
            self.assertEqual(old_path.read_bytes(), b"legacy PathExists unit\n")
            self.assertEqual(old_timer.read_bytes(), b"existing ten-minute retry timer\n")
            self.assertEqual(old_service.read_bytes(), b"existing cleanup service\n")
            self.assertEqual(calls.read_text(encoding="utf-8").splitlines(),
                             ["stop ikpk-site-housekeeping.path", "stop ikpk-site-housekeeping.timer",
                              "stop ikpk-site-housekeeping.service", "disable ikpk-site-housekeeping.path"])
            self.assertIn("preserve cleanup.request; under the publication and operation locks", run.stderr)
            for path, content in original.items():
                self.assertEqual(path.read_bytes(), content, path.name)

            calls = root / "calls-timer-enable-failure"
            trap_setup_end = installer.index('if [[ -z "$INSTALL_CONFIG_PROFILE"', guard_start)
            trap_setup = installer[guard_start:trap_setup_end]
            run = subprocess.run(
                ["bash", "-c", f"set -e\nINSTALL_DISABLED=0\n{trap_setup}\nHOUSEKEEPING_TRANSITION=1\n{activation}"],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(calls),
                     "SYSTEMCTL_FAIL": "enable --now ikpk-site-housekeeping.timer"},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 42, run.stderr)
            self.assertEqual(calls.read_text(encoding="utf-8").splitlines(),
                             ["daemon-reload", "enable --now ikpk-site-housekeeping.timer"])
            self.assertIn("preserve cleanup.request; under the publication and operation locks", run.stderr)

            # Rerunning after a failed transition stops the remaining legacy
            # units, replaces the helper, and leaves timer activation last.
            calls = root / "calls-recovery-rerun"
            run = subprocess.run(
                ["bash", "-c", install_fragment],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertFalse(old_path.exists())
            self.assertNotEqual(installed_sbin.joinpath("ikpk-rehearsal").read_bytes(),
                                b"old launcher\n")
            self.assertEqual(calls.read_text(encoding="utf-8").splitlines(),
                             ["stop ikpk-site-housekeeping.path", "stop ikpk-site-housekeeping.timer",
                              "stop ikpk-site-housekeeping.service", "disable ikpk-site-housekeeping.path"])
            calls = root / "calls-recovery-timer"
            run = subprocess.run(
                ["bash", "-c", "set -e\nINSTALL_DISABLED=0\nsystemd_dir=/etc/systemd/system\n" + activation],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(calls.read_text(encoding="utf-8").splitlines(),
                             ["daemon-reload", "enable --now ikpk-site-housekeeping.timer"])

            old_path.write_bytes(b"legacy PathExists unit\n")
            calls = root / "calls-install-disabled-transition"
            disabled_install = install_fragment.replace(
                "INSTALL_CONFIG_PROFILE=staging193", "INSTALL_CONFIG_PROFILE=staging193\nINSTALL_DISABLED=1")
            run = subprocess.run(
                ["bash", "-c", disabled_install + "\n" + activation],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            disabled_calls = calls.read_text(encoding="utf-8").splitlines()
            self.assertEqual(disabled_calls, [
                "stop ikpk-site-housekeeping.path", "stop ikpk-site-housekeeping.timer",
                "disable ikpk-site-housekeeping.timer", "stop ikpk-site-housekeeping.service",
                "disable ikpk-site-housekeeping.path", "daemon-reload",
            ])
            self.assertNotIn("enable --now ikpk-site-housekeeping.timer", disabled_calls)
            self.assertFalse(old_path.exists())

            # A prior interrupted install may already have removed the path
            # unit. Disabled mode must still stop and disable an existing timer.
            calls = root / "calls-install-disabled-without-path"
            run = subprocess.run(
                ["bash", "-c", disabled_install + "\n" + activation],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            disabled_without_path_calls = calls.read_text(encoding="utf-8").splitlines()
            self.assertEqual(disabled_without_path_calls, [
                "stop ikpk-site-housekeeping.timer", "disable ikpk-site-housekeeping.timer",
                "stop ikpk-site-housekeeping.service", "daemon-reload",
            ])
            self.assertNotIn("enable --now ikpk-site-housekeeping.timer", disabled_without_path_calls)
            self.assertFalse(old_path.exists())


            # Recheck at the write site: disappearance after preflight must not
            # fall through to the ordinary template creation path.
            config_start = installer.index('if [[ -e "$CONFIG" || -L "$CONFIG" ]]; then',
                                            installer.index('installed_config=0'))
            config_end = installer.index('\n  python3 - "$TEMPLATE" <<\'PY\'', config_start)
            config_block = installer[config_start:config_end]
            absent_config = root / "config-disappeared.json"
            run = subprocess.run(
                ["bash", "-c", f"set -e\nCONFIG={absent_config}\nTEMPLATE={ROOT}/scripts/staging193-rehearsal.json\nINSTALL_EXISTING_CONFIG_ONLY=1\n{config_block}"],
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertFalse(absent_config.exists())
            self.assertFalse(list(root.glob("config-disappeared.json.new.*")))

    def test_staging193_config_uses_staging194_helper_validation_profile(self):
        installer = (ROOT / "scripts/install-rehearsal-host.sh").read_text(encoding="utf-8")
        parser_start = installer.index("PREFIX=/usr/local")
        parser_end = installer.index('\n[[ "$PREFIX"', parser_start)
        parser = installer[parser_start:parser_end]

        mapping_start = installer.index("  service_profile=$INSTALL_CONFIG_PROFILE", parser_end)
        mapping_line_end = installer.index("\n", installer.index("&& service_profile=staging194", mapping_start))
        mapping = installer[mapping_start:mapping_line_end]
        validation_start = installer.index(
            '  if ! PYTHONDONTWRITEBYTECODE=1 "$SBIN/ikpk-rehearsal" --profile ', parser_end)
        validation_end = installer.index("\n  fi", validation_start) + len("\n  fi")
        validation = installer[validation_start:validation_end]
        ordered_blocks = "\n".join(
            block for _, block in sorted(((mapping_start, mapping), (validation_start, validation)))
        )

        with tempfile.TemporaryDirectory(prefix="ikpk-profile-validation-") as temporary:
            root = Path(temporary)
            sbin = root / "sbin"
            sbin.mkdir()
            calls = root / "calls"
            stub = sbin / "ikpk-rehearsal"
            stub.write_text(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$PROFILE_CALLS\"\n",
                encoding="utf-8",
            )
            stub.chmod(0o755)

            for option, expected in (
                ("--staging193-config", "--profile staging194 validate-config"),
                ("--initial-prod-config", "--profile initial-prod validate-config"),
                ("--production-static-config", "--profile production-static validate-config"),
                ("--production-paired-config", "--profile production-paired validate-config"),
            ):
                calls.unlink(missing_ok=True)
                script = (
                    "set -euo pipefail\n"
                    f"set -- {option}\n"
                    f"{parser}\n"
                    f"SBIN={sbin}\n"
                    "installed_config=0\n"
                    f"{ordered_blocks}\n"
                )
                run = subprocess.run(
                    ["bash", "-c", script],
                    env={**os.environ, "PROFILE_CALLS": str(calls)},
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(calls.read_text(encoding="utf-8").strip(), expected)


if __name__ == "__main__":
    unittest.main()
