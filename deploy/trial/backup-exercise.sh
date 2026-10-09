#!/usr/bin/env bash
# Пробная машина: УПРАЖНЕНИЕ с резервной копией и восстановлением на тестовых данных.
# Запуск НА СЕРВЕРЕ от root. Это НЕ копия вне VPS: репозиторий restic лежит на этом же
# диске, пока владелец не выбрал внешнее хранилище. Вне VPS копия оказывается только после
# шага «забрать» из docs/runbook-trial-vps.md (ключ restic при этом хранится отдельно).
#
#   bash backup-exercise.sh backup     # снять копию: база (sqlite .backup), загрузки, релиз
#   bash backup-exercise.sh verify     # восстановить ПОСЛЕДНЮЮ копию в одноразовый каталог и сверить
#
# Восстановление не трогает действующие данные и не переключает сайт.
set -euo pipefail

MODE="${1:-}"
REPO="${RESTIC_REPOSITORY:-/var/backups/ikpk-trial/restic}"
PASS_FILE="${RESTIC_PASSWORD_FILE:-/etc/ikpk-backup/restic.pass}"
DB="${CMS_DB:-/var/lib/ikpk-cms/trial/data/data.db}"
UPLOADS="${CMS_UPLOADS:-/opt/ikpk-cms/shared/uploads}"
WEB_ROOT="${WEB_ROOT:-/var/www/ikpk}"
STAGE="${STAGE:-/var/backups/ikpk-trial/stage}"

[[ "$(id -u)" == 0 ]] || { echo "[backup] нужен root" >&2; exit 2; }
[[ "$MODE" == backup || "$MODE" == verify ]] || { echo "использование: $0 backup|verify" >&2; exit 2; }
command -v restic >/dev/null && command -v sqlite3 >/dev/null || { echo "[backup] нужны restic и sqlite3" >&2; exit 2; }

if [[ ! -s "$PASS_FILE" ]]; then
  install -d -m 700 "$(dirname "$PASS_FILE")"
  (umask 077; openssl rand -base64 32 >"$PASS_FILE")
  echo "[backup] создан ключ репозитория ${PASS_FILE}: СКОПИРУЙТЕ его себе вне VPS, без него копия не читается"
fi
export RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD_FILE="$PASS_FILE"
restic cat config >/dev/null 2>&1 || { install -d -m 700 "$REPO"; restic init -q; echo "[backup] репозиторий создан: ${REPO}"; }

if [[ "$MODE" == backup ]]; then
  [[ -f "$DB" ]] || { echo "[backup] нет базы ${DB}" >&2; exit 3; }
  rm -rf "$STAGE"; install -d -m 700 "$STAGE"
  # Онлайн-копия средствами SQLite: безопасна при работающей CMS. Копирование файла под
  # записью дало бы несогласованную базу.
  sqlite3 "$DB" ".backup '${STAGE}/data.db'"
  [[ "$(sqlite3 "${STAGE}/data.db" 'PRAGMA integrity_check;')" == ok ]] || { echo "[backup] integrity_check копии не ok" >&2; exit 4; }
  sqlite3 "${STAGE}/data.db" "SELECT count(*) FROM sqlite_master WHERE type='table';" >"${STAGE}/tables.count"
  readlink -f "${WEB_ROOT}/current" >"${STAGE}/current.path"
  release_live="${WEB_ROOT}/current/release.json"
  [[ -f "$release_live" ]] && cp "$release_live" "${STAGE}/release.json" || true
  paths=("$STAGE")
  [[ -d "$UPLOADS" ]] && paths+=("$UPLOADS")
  [[ -d "${WEB_ROOT}/current" ]] && paths+=("$(readlink -f "${WEB_ROOT}/current")")
  restic backup -q --tag trial "${paths[@]}"
  rm -rf "$STAGE"
  restic snapshots --latest 1 --compact
  echo "[backup] ok: копия снята (на этом же диске, не вне VPS)"
  exit 0
fi

# verify: восстановление в одноразовый каталог и сверка по признакам.
TARGET="$(mktemp -d /var/tmp/ikpk-restore.XXXXXX)"
trap 'rm -rf "$TARGET"' EXIT
restic restore -q latest --target "$TARGET"
restored_db="$(find "$TARGET" -path '*stage/data.db' -o -name data.db | head -1)"
[[ -n "$restored_db" ]] || { echo "[verify] в копии нет data.db" >&2; exit 5; }
[[ "$(sqlite3 "$restored_db" 'PRAGMA integrity_check;')" == ok ]] || { echo "[verify] integrity_check восстановленной базы не ok" >&2; exit 5; }
tables="$(sqlite3 "$restored_db" "SELECT count(*) FROM sqlite_master WHERE type='table';")"
live_tables="$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table';")"
[[ "$tables" == "$live_tables" ]] || { echo "[verify] таблиц в копии ${tables}, в живой базе ${live_tables}" >&2; exit 5; }
rel="$(find "$TARGET" -name release.json | head -1)"
if [[ -n "$rel" && -f "${WEB_ROOT}/current/release.json" ]]; then
  cmp -s "$rel" "${WEB_ROOT}/current/release.json" && echo "[verify] release.json совпал с действующим" ||
    echo "[verify] release.json отличается от действующего (сайт обновлялся после копии?)"
fi
echo "[verify] ok: integrity_check=ok, таблиц ${tables}, файлов в копии $(find "$TARGET" -type f | wc -l)"
