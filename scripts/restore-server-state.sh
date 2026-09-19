#!/usr/bin/env bash
set -euo pipefail

# Восстановление последней резервной копии, снятой `scripts/bootstrap-vps.sh BACKUP_ONLY=1`
# (change `server-provisioning`, Requirement «Резервная копия предшествует разрушающим
# действиям»), в подтверждённый каталог рядом с релизами. Раздачу скрипт не меняет и потому
# разрушающим действием не является: предварительная копия не нужна.
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

# Восстановление СТАВИТ копию рядом с релизами и НЕ переключает раздачу. Путь публикации
# у сайта один — установленный launcher (deploy-gating, «Опубликованное состояние сайта
# одно»); прежняя редакция этого скрипта переключала действующий релиз сама и была вторым
# путём. Копия кладётся в `${WEB_ROOT}/restored/`, а не в `releases/`: каталог релизов —
# окно удержания (действующий + четыре предыдущих), и посторонний каталог в нём вытеснял бы
# настоящую цель отката. Восстановленное дерево — свидетельство для оператора, а не релиз.
restore_id="restore-$(date -u +%Y%m%dT%H%M%SZ)"
target="${WEB_ROOT}/restored/${restore_id}"
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

# Неподтверждённая копия не остаётся на диске: частичный каталог рядом с подтверждёнными
# выглядел бы как годная копия для следующего оператора.
if ((compared == 0)); then
  rm -rf -- "$target"
  echo "Сравнивать было нечего: копия ${latest} не содержит файлов — это НЕ подтверждение восстановления; ${target} удалён" >&2
  exit 2
fi
if ((mismatched > 0)); then
  rm -rf -- "$target"
  echo "Восстановление не подтверждено: расхождений ${mismatched} из ${compared}; ${target} удалён" >&2
  exit 1
fi

echo "restored=${restore_id}"
echo "path=${target}"
echo "activation=launcher-only"
echo "Копия восстановлена в ${target} и НЕ активирована: раздача не тронута, переключение выполняет только launcher" >&2
