#!/usr/bin/env bash
set -euo pipefail

# The worker validates the protected launch context before installing dependencies.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
unset NODE_OPTIONS NODE_PATH
exec node "$ROOT/web/scripts/publication-worker.ts" "$@"
