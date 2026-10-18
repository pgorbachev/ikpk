#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PREFIX=/usr/local
while (($#)); do
  case "$1" in
    --prefix) PREFIX=${2:?missing prefix}; shift 2 ;;
    *) echo "usage: $0 [--prefix ABSOLUTE-PREFIX]" >&2; exit 2 ;;
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
echo "installed rehearsal host entrypoint: $SBIN/ikpk-rehearsal"
