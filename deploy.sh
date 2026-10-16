#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
unset NODE_OPTIONS NODE_PATH
exec node "$ROOT/scripts/deploy.mjs" "$@"
