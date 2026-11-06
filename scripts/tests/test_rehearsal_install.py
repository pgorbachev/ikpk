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
        start = installer.index("  # Older versions enabled a level-triggered PathExists unit.")
        end = installer.index("\nfi\necho \"installed rehearsal host entrypoint", start)
        activation = "\n".join(line[2:] for line in installer[start:end].splitlines())
        self.assertNotIn("PathExists=", installer)
        self.assertIn('systemctl disable --now ikpk-site-housekeeping.path', installer)
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

            old_path = root / "ikpk-site-housekeeping.path"
            old_path.write_text("legacy PathExists unit", encoding="utf-8")
            calls = root / "calls-old-path"
            run = subprocess.run(
                ["bash", "-c", f"set -e\nsystemd_dir={root}\n{activation}"],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(calls)},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(calls.read_text(encoding="utf-8").splitlines(),
                             ["disable --now ikpk-site-housekeeping.path", "daemon-reload",
                              "enable --now ikpk-site-housekeeping.timer"])
            self.assertFalse(old_path.exists())

            calls = root / "calls-disable-failure"
            old_path.write_text("legacy PathExists unit", encoding="utf-8")
            run = subprocess.run(
                ["bash", "-c", f"set -e\nsystemd_dir={root}\n{activation}"],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                     "SYSTEMCTL_CALLS": str(calls),
                     "SYSTEMCTL_FAIL": "disable --now ikpk-site-housekeeping.path"},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(run.returncode, 42, run.stderr)
            self.assertTrue(old_path.exists(), "failed disable must not remove the old unit file")

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
