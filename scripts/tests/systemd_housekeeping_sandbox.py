#!/usr/bin/env python3
"""Bounded local systemd proof for housekeeping ReadWritePaths only.

Run as root inside an isolated Linux VM. It never contacts a site or reads
service configuration/secrets. All writable probes use unique scratch paths.
"""

import json
import argparse
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "scripts/install-rehearsal-host.sh"
EXPECTED_READ_WRITE_LINE = (
    "ReadWritePaths=/var/www/ikpk $site_state_dir $state_dir $cleanup_profile_state_dirs "
    "/var/lib/ikpk-rehearsal/site-publication $cleanup_backup_root $cleanup_profile_artifact_roots"
)


def run(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    if check and result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {args[0]} {args[1:]}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--read-write-line",
        help="exact ReadWritePaths= line from the reviewed installer; use when that file is not mounted",
    )
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("run this probe as root inside an isolated Linux VM")
    if not shutil.which("systemd-analyze") or not shutil.which("systemctl"):
        raise SystemExit("systemd tools are unavailable; no sandbox result")
    installer = INSTALLER.read_text(encoding="utf-8") if INSTALLER.is_file() else ""
    raw_read_write_line = args.read_write_line or os.environ.get("IKPK_SANDBOX_READ_WRITE_LINE")
    if raw_read_write_line is None:
        raw_read_write_line = next((line for line in installer.splitlines()
                                    if line.startswith("ReadWritePaths=")), None)
    if raw_read_write_line != EXPECTED_READ_WRITE_LINE:
        raise SystemExit("ReadWritePaths line differs from the reviewed installer policy")
    if installer and "ProtectSystem=strict" not in installer:
        raise SystemExit("installer no longer exposes ProtectSystem=strict")
    read_write_line = raw_read_write_line.split("=", 1)[1]

    token = f"{os.getpid()}-{secrets.token_hex(4)}"
    service = f"ikpk-housekeeping-sandbox-{token}.service"
    scratch = Path("/var/lib") / f"ikpk-sandbox-proof-{token}"
    denied_root = scratch / "denied-sibling"
    unit_path = Path("/run/systemd/system") / service
    helper_path = Path("/run") / f"ikpk-housekeeping-sandbox-{token}.py"
    if scratch.exists() or denied_root.exists() or unit_path.exists() or helper_path.exists():
        raise SystemExit("unique scratch path already exists; refusing to reuse it")

    selected_backup = scratch / "staging194" / "backups"
    profile_backup_roots = [
        scratch / "initial-prod" / "backups",
        scratch / "production-static" / "backups",
        scratch / "production-paired" / "backups",
    ]
    state_dir = scratch / "state"
    site_state = scratch / "site-state"
    profile_state_dirs = [scratch / f"profile-state-{name}"
                          for name in ("initial-prod", "production-static", "production-paired")]
    scratch_created = False
    helper_created = False
    unit_created = False
    try:
        scratch.mkdir(mode=0o700)
        scratch_created = True
        for directory in (selected_backup, *profile_backup_roots, state_dir, site_state, *profile_state_dirs,
                          denied_root):
            directory.mkdir(parents=True, mode=0o700, exist_ok=False)
        (state_dir / "site-publication").mkdir(mode=0o700)

        expanded_rw = read_write_line
        replacements = {
            "/var/www/ikpk": str(site_state),
            "/var/lib/ikpk-rehearsal/site-publication": str(state_dir / "site-publication"),
            "$site_state_dir": str(site_state),
            "$state_dir": str(state_dir),
            "$cleanup_profile_state_dirs": " ".join(f"-{path}" for path in profile_state_dirs),
            "$cleanup_backup_root": str(selected_backup),
            "$cleanup_profile_artifact_roots": " ".join(f"-{path}" for path in profile_backup_roots),
        }
        for variable, path in replacements.items():
            expanded_rw = expanded_rw.replace(variable, path)
        if "$" in expanded_rw or "/var/www/ikpk" in expanded_rw or "/var/lib/ikpk-rehearsal" in expanded_rw:
            raise SystemExit("live service path or unexpanded installer variable in scratch unit")

        report_path = selected_backup / "probe-result.json"
        allowed = [selected_backup, *profile_backup_roots]
        with helper_path.open("x", encoding="utf-8") as helper_file:
            helper_created = True
            helper_file.write(
            "import json, pathlib, sys\n"
            "report = {'allowed': [], 'deniedWriteSucceeded': False}\n"
            "output = pathlib.Path(sys.argv[1])\n"
            "for index, raw in enumerate(sys.argv[2:-1]):\n"
            "    target = pathlib.Path(raw) / ('probe-' + str(index))\n"
            "    target.write_text('ok', encoding='ascii')\n"
            "    report['allowed'].append(target.exists())\n"
            "denied = pathlib.Path(sys.argv[-1]) / 'must-not-write'\n"
            "try:\n"
            "    denied.write_text('bad', encoding='ascii')\n"
            "    report['deniedWriteSucceeded'] = True\n"
            "except OSError:\n"
            "    report['deniedWriteSucceeded'] = False\n"
            "output.write_text(json.dumps(report, sort_keys=True), encoding='utf-8')\n",
            )
        helper_path.chmod(0o700)
        with unit_path.open("x", encoding="utf-8") as unit_file:
            unit_created = True
            unit_file.write(
            "[Unit]\nDescription=Temporary IKPK housekeeping sandbox probe\n"
            "[Service]\nType=oneshot\nUser=root\nGroup=root\nNoNewPrivileges=yes\n"
            "ProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\n"
            f"ReadWritePaths={expanded_rw}\n"
            f"ExecStart={sys.executable} {helper_path} {report_path} "
            + " ".join(str(path) for path in allowed)
            + f" {denied_root}\n",
            )
        unit_path.chmod(0o644)

        run(["systemctl", "daemon-reload"])
        run(["systemd-analyze", "verify", str(unit_path)])
        run(["systemctl", "start", service])
        report = json.loads(report_path.read_text(encoding="utf-8"))
        if report != {"allowed": [True] * len(allowed), "deniedWriteSucceeded": False}:
            raise RuntimeError("ProtectSystem/ReadWritePaths probe did not enforce expected scratch boundary")
        print(f"PASS: strict systemd sandbox allowed {len(allowed)} scratch backup roots and denied sibling ({token})")
        return 0
    finally:
        if unit_created:
            run(["systemctl", "stop", service], check=False)
            run(["systemctl", "reset-failed", service], check=False)
            unit_path.unlink(missing_ok=True)
            run(["systemctl", "daemon-reload"], check=False)
        if helper_created:
            helper_path.unlink(missing_ok=True)
        if scratch_created:
            shutil.rmtree(scratch)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise
