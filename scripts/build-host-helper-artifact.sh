#!/usr/bin/env bash
set -euo pipefail

if (($# != 1)); then
  echo "usage: $0 OUTPUT_TAR_GZ" >&2
  exit 2
fi

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT=$1
mkdir -p -- "$(dirname -- "$OUTPUT")"

cd "$ROOT"
git archive --format=tar HEAD -- \
  scripts/install-rehearsal-host.sh \
  scripts/lib/rehearsal_state.py \
  scripts/lib/housekeeping_journal.py \
  scripts/lib/rehearsal_host.py \
  scripts/lib/rehearsal_config.py \
  scripts/staging193-rehearsal.json \
  scripts/initial-prod-rehearsal.json \
  scripts/production-static-rehearsal.json \
  scripts/production-paired-rehearsal.json | gzip -n > "$OUTPUT"
