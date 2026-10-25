#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PREFIX=/usr/local
INSTALL_CONFIG_PROFILE=
while (($#)); do
  case "$1" in
    --prefix) PREFIX=${2:?missing prefix}; shift 2 ;;
    --staging193-config) INSTALL_CONFIG_PROFILE=staging193; shift ;;
    --initial-prod-config) INSTALL_CONFIG_PROFILE=initial-prod; shift ;;
    --production-static-config) INSTALL_CONFIG_PROFILE=production-static; shift ;;
    *) echo "usage: $0 [--prefix ABSOLUTE-PREFIX] [--staging193-config|--initial-prod-config|--production-static-config]" >&2; exit 2 ;;
  esac
done
[[ "$PREFIX" = /* && "$PREFIX" != / ]] || { echo 'prefix must be an absolute non-root path' >&2; exit 2; }

LIB="$PREFIX/lib/ikpk-rehearsal"
SBIN="$PREFIX/sbin"
install -d -m 0755 "$LIB" "$SBIN"
install -m 0644 "$ROOT/scripts/lib/rehearsal_state.py" "$LIB/rehearsal_state.py"
install -m 0644 "$ROOT/scripts/lib/rehearsal_host.py" "$LIB/rehearsal_host.py"
cat >"$SBIN/ikpk-rehearsal" <<EOF
#!/usr/bin/env python3
import sys
sys.path.insert(0, "$LIB")
from rehearsal_host import main
raise SystemExit(main())
EOF
chmod 0755 "$SBIN/ikpk-rehearsal"
PYTHONDONTWRITEBYTECODE=1 "$SBIN/ikpk-rehearsal" --help >/dev/null
if [[ -n "$INSTALL_CONFIG_PROFILE" ]]; then
  (( EUID == 0 )) || { echo 'rehearsal config installation requires root' >&2; exit 2; }
  CONFIG_DIR=/etc/ikpk
  if [[ "$INSTALL_CONFIG_PROFILE" == initial-prod ]]; then
    CONFIG="$CONFIG_DIR/rehearsal-initial-prod.json"
    TEMPLATE="$ROOT/scripts/initial-prod-rehearsal.json"
  elif [[ "$INSTALL_CONFIG_PROFILE" == production-static ]]; then
    CONFIG="$CONFIG_DIR/rehearsal-production-static.json"
    TEMPLATE="$ROOT/scripts/production-static-rehearsal.json"
  else
    CONFIG="$CONFIG_DIR/rehearsal.json"
    TEMPLATE="$ROOT/scripts/staging193-rehearsal.json"
  fi
  installed_config=0
  install -d -o root -g root -m 0755 "$CONFIG_DIR"
  if [[ -e "$CONFIG" || -L "$CONFIG" ]]; then
    [[ -f "$CONFIG" && ! -L "$CONFIG" ]] || { echo 'existing rehearsal config is not a regular file' >&2; exit 2; }
    cmp -s "$CONFIG" "$TEMPLATE" || { echo 'existing rehearsal config differs from the reviewed versioned template' >&2; exit 2; }
  else
    temporary="$CONFIG.new.$$"
    install -o root -g root -m 0600 "$TEMPLATE" "$temporary"
    mv -T -- "$temporary" "$CONFIG"
    installed_config=1
  fi
  python3 - "$TEMPLATE" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    config = json.load(source)
import os, pwd, stat
account = pwd.getpwnam(config["cmsUser"])
home = account.pw_dir
if not os.path.isabs(home) or home == "/":
    raise SystemExit("CMS service account has no safe absolute HOME")
created = False
try:
    os.mkdir(home, 0o700)
    created = True
except FileExistsError:
    pass
if created:
    os.chown(home, account.pw_uid, account.pw_gid)
    os.chmod(home, 0o700)
info = os.lstat(home)
if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
    raise SystemExit("CMS service HOME must be a real directory")
if info.st_uid != account.pw_uid or info.st_gid != account.pw_gid or info.st_mode & 0o077 or info.st_mode & 0o700 != 0o700:
    raise SystemExit("existing CMS service HOME must be owned by the service account with private permissions")
for name in ("stateDir", "backupRoot"):
    os.makedirs(config[name], mode=0o700, exist_ok=True)
    os.chown(config[name], 0, 0)
    os.chmod(config[name], 0o700)
if config["profile"] == "production-static":
    if os.path.lexists(config["releaseRoot"]):
        info = os.lstat(config["releaseRoot"])
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SystemExit("production-static source root must be a real directory")
    os.makedirs(config["releaseRoot"], mode=0o700, exist_ok=True)
    os.chown(config["releaseRoot"], 0, account.pw_gid)
    os.chmod(config["releaseRoot"], 0o750)
PY
  if ! PYTHONDONTWRITEBYTECODE=1 "$SBIN/ikpk-rehearsal" --profile "$INSTALL_CONFIG_PROFILE" validate-config; then
    if (( installed_config )); then rm -f -- "$CONFIG"; fi
    echo 'rehearsal config validation failed; no operation is enabled' >&2
    exit 2
  fi
fi
echo "installed rehearsal host entrypoint: $SBIN/ikpk-rehearsal"
