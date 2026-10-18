#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PREFIX=/usr/local
INSTALL_STAGING193_CONFIG=0
while (($#)); do
  case "$1" in
    --prefix) PREFIX=${2:?missing prefix}; shift 2 ;;
    --staging193-config) INSTALL_STAGING193_CONFIG=1; shift ;;
    *) echo "usage: $0 [--prefix ABSOLUTE-PREFIX] [--staging193-config]" >&2; exit 2 ;;
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
if (( INSTALL_STAGING193_CONFIG )); then
  (( EUID == 0 )) || { echo 'staging193 config installation requires root' >&2; exit 2; }
  CONFIG_DIR=/etc/ikpk
  CONFIG="$CONFIG_DIR/rehearsal.json"
  TEMPLATE="$ROOT/scripts/staging193-rehearsal.json"
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
for name in ("stateDir", "backupRoot"):
    import os
    os.makedirs(config[name], mode=0o700, exist_ok=True)
    os.chown(config[name], 0, 0)
    os.chmod(config[name], 0o700)
PY
  if ! PYTHONDONTWRITEBYTECODE=1 "$SBIN/ikpk-rehearsal" validate-config; then
    if (( installed_config )); then rm -f -- "$CONFIG"; fi
    echo 'staging193 config validation failed; no rehearsal operation is enabled' >&2
    exit 2
  fi
fi
echo "installed rehearsal host entrypoint: $SBIN/ikpk-rehearsal"
