#!/usr/bin/env bash
set -euo pipefail

if (($# != 1)); then
  echo 'usage: build-seminar-proof-artifact.sh OUTPUT_TAR_GZ' >&2
  exit 2
fi
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
OUTPUT=$1
case "$OUTPUT" in /*) ;; *) echo 'output must be an absolute path' >&2; exit 2 ;; esac
required=(
  web/package.json web/package-lock.json web/astro.config.mjs
  web/scripts/seminar-migration/render-audit.ts
  web/scripts/seminar-migration/rehearse.py
  web/tests/seminar-real-migration.migration.test.ts
  web/tests/seminar-separate-fields.migration.test.ts
  fixtures/content-snapshot/collapsible_panels.json fixtures/content-snapshot/url_map.csv
  cms/src/lib/demo193-source-empty-fields.json
  web/scripts/capture-content-snapshot.ts
  web/scripts/lib/{capture-snapshot-contract,content-field-map,content-snapshot,content-media-store,historical-exceptions,content-contract}.ts
  scripts/lib/{staging193-capture-bundle,server-capture-sqlite,seal-staging193-capture}.mjs
  cms/src/components/{shared/seo,seminar/document-record,seminar/registry-fact,seminar/nmo-fact}.json
)
for type in institute course-group seminar teacher article schedule-entry news-item promotion page video-playlist; do
  required+=("cms/src/api/$type/content-types/$type/schema.json")
done
for path in "${required[@]}"; do
  git cat-file -e "HEAD:$path" || { echo "required proof input is absent from HEAD: $path" >&2; exit 1; }
done
[[ -n $(git ls-tree -r --name-only HEAD -- web/src) ]] || { echo 'web/src is absent from HEAD' >&2; exit 1; }
git ls-tree -r HEAD -- web/src | awk '$1 == "120000" { exit 1 }' || { echo 'web/src contains a symlink rejected by the renderer' >&2; exit 1; }
# The proof hashes the full source tree. A dirty, untracked or ignored source
# file would make a Git archive differ from the renderer actually reviewed.
[[ -z $(git status --porcelain=v1 --untracked-files=all -- web cms/src/components "${required[@]}") ]] || { echo 'proof inputs contain uncommitted or untracked files' >&2; exit 1; }
[[ -z $(git ls-files --others --ignored --exclude-standard -- web/src) ]] || { echo 'web/src contains ignored files that the renderer would hash' >&2; exit 1; }
mkdir -p -- "$(dirname -- "$OUTPUT")"
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || { echo 'output already exists' >&2; exit 1; }
temp=$(mktemp "${OUTPUT}.XXXXXXXX")
trap 'rm -f -- "$temp"' EXIT
git archive --format=tar HEAD -- web cms/src/components "${required[@]}" | gzip -n > "$temp"
# Exclusive hard-link publication prevents accidental overwrite of a racing file.
ln -- "$temp" "$OUTPUT"
rm -- "$temp"
trap - EXIT
printf 'Proof source revision: %s\n' "$(git rev-parse HEAD)"
shasum -a 256 -- "$OUTPUT"
