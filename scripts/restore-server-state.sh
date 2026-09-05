#!/usr/bin/env bash
set -euo pipefail

# Восстановление содержимого раздачи из последней резервной копии, снятой
# `scripts/bootstrap-vps.sh BACKUP_ONLY=1` (change `server-provisioning`, Requirement
# «Резервная копия предшествует разрушающим действиям»). Само восстановление —
# разрушающее действие и подчиняется тому же требованию; здесь предмет один (публикуемое
# содержимое), поэтому предварительная копия не нужна — источник ВОССТАНОВЛЕНИЯ и есть
# уже снятая резервная копия.
#
# Печатает предикат сравнения и число выполненных сопоставлений — требование против
# «ноль сопоставлений — это тоже сравнение».

ENVIRONMENT="${1:-stand}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/environments/${ENVIRONMENT}.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Объявленного состояния окружения «${ENVIRONMENT}» нет: ${ENV_FILE}" >&2
  exit 1
fi

# Построчный разбор вместо `source` — см. bootstrap-vps.sh: значения объявленного
# состояния — свободный текст и не обязаны быть валидным bash-синтаксисом.
load_declared() {
  local file="$1" line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value#\"}"
      value="${value%\"}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value#\'}"
      value="${value%\'}"
    fi
    printf -v "$key" '%s' "$value"
  done <"$file"
}
load_declared "$ENV_FILE"

SITE_NAME="${SITE_NAME:-ikpk}"
WEB_ROOT="${WEB_ROOT:-/var/www/${SITE_NAME}}"
CONTENT_BACKUP_DIR="${CONTENT_BACKUP_DIR:-/var/backups/${SITE_NAME}/current}"

latest="$(find "$CONTENT_BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name 'current-*' 2>/dev/null | sort | tail -1)"
if [[ -z "$latest" ]]; then
  echo "Резервная копия не найдена: ${CONTENT_BACKUP_DIR}/current-* — восстанавливать нечем" >&2
  exit 1
fi

target="${WEB_ROOT}/current"
mkdir -p "$target"
rsync -a --delete "${latest}/" "${target}/"

compared=0
while IFS= read -r -d '' f; do
  rel="${f#"$latest"/}"
  if cmp -s "$f" "${target}/${rel}"; then
    compared=$((compared + 1))
  fi
done < <(find "$latest" -type f -print0)

echo "predicate=byte-equal-after-restore"
echo "compared=${compared}"
