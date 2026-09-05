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
# Разбор объявленного состояния — общий для всех трёх скриптов.
. "$ROOT/scripts/lib/declared.sh"
load_declared "$ENV_FILE"

SITE_NAME="${SITE_NAME:-ikpk}"
WEB_ROOT="${WEB_ROOT:-/var/www/${SITE_NAME}}"
CONTENT_BACKUP_DIR="${CONTENT_BACKUP_DIR:-/var/backups/${SITE_NAME}/current}"

latest="$(find "$CONTENT_BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name 'current-*' 2>/dev/null | sort | tail -1)"
if [[ -z "$latest" ]]; then
  echo "Резервная копия не найдена: ${CONTENT_BACKUP_DIR}/current-* — восстанавливать нечем" >&2
  exit 1
fi

# Восстановление создаёт НОВЫЙ каталог релиза и переключает симлинк, тем же приёмом, что
# и выкладка. Прежняя версия писала rsync-ом прямо в `${WEB_ROOT}/current`, и это ломалось
# двумя способами: если `current` уже симлинк — запись шла СКВОЗЬ него и портила каталог
# действующего релиза на месте; если `current` ещё не было — `mkdir -p` создавал обычный
# каталог, и следующий `ln -sfn` из выкладки клал бы ссылку ВНУТРЬ него, а не заменял его,
# после чего nginx бесконечно отдавал бы восстановленное старое содержимое при «успешных»
# выкатках.
release_id="restore-$(date -u +%Y%m%dT%H%M%SZ)"
target="${WEB_ROOT}/releases/${release_id}"
mkdir -p "$target"
rsync -a --delete "${latest}/" "${target}/"

# Считаются ОБА исхода. Прежде инкремент стоял только внутри `cmp -s`, поэтому разошедшийся
# файл не попадал ни в вывод, ни в код возврата, а `compared=0` (сравнивать было нечего)
# выглядел успехом — то самое «не смог проверить», выданное за «расхождений нет».
# `diff -rq` вместо ручного обхода: он же ловит файлы, которых в цели нет вовсе, и
# лишние в цели — ручное сравнение по списку копии этого не видело.
compared="$(find "$latest" -type f | wc -l | tr -d ' ')"
diff_out="$(diff -rq "$latest" "$target" 2>&1 || true)"
if [[ -n "$diff_out" ]]; then
  printf '%s\n' "$diff_out" >&2
  mismatched="$(printf '%s\n' "$diff_out" | wc -l | tr -d ' ')"
else
  mismatched=0
fi

echo "predicate=byte-equal-after-restore"
echo "compared=${compared}"
echo "mismatched=${mismatched}"

if ((compared == 0)); then
  echo "Сравнивать было нечего: копия ${latest} не содержит файлов — это НЕ подтверждение восстановления" >&2
  exit 2
fi
if ((mismatched > 0)); then
  echo "Восстановление не подтверждено: расхождений ${mismatched} из ${compared}" >&2
  exit 1
fi

ln -sfn "$target" "${WEB_ROOT}/current.new"
mv -T "${WEB_ROOT}/current.new" "${WEB_ROOT}/current"
echo "release=${release_id}"
