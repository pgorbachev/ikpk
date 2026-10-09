#!/usr/bin/env bash
# Пробная машина (docs/runbook-trial-vps.md, шаг 2): проверка ОС и временный swap.
# Запуск НА СЕРВЕРЕ от root, до bootstrap-vps.sh. Идемпотентен; ничего, кроме swap-файла и
# строки в /etc/fstab, не меняет. Секретов не читает и не печатает.
set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_MB="${SWAP_MB:-2048}"
MIN_FREE_MB="${MIN_FREE_MB:-6000}"

[[ "$(id -u)" == 0 ]] || { echo "[prepare] нужен root" >&2; exit 2; }

# OS_RELEASE и ARCH переопределяются только самопроверкой (selftest.sh).
# shellcheck disable=SC1090
. "${OS_RELEASE:-/etc/os-release}"
ARCH="${ARCH:-$(uname -m)}"
if [[ "${ID}-${VERSION_ID}" != "ubuntu-26.04" || "$ARCH" != "x86_64" ]]; then
  echo "[prepare] ожидается ubuntu-26.04 x86_64, а здесь ${ID}-${VERSION_ID} ${ARCH}: отказ" >&2
  exit 2
fi

if swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  echo "[prepare] unchanged: swap ${SWAP_FILE} уже включён"
else
  free_mb="$(df -Pm / | awk 'NR==2{print $4}')"
  if ((free_mb < SWAP_MB + MIN_FREE_MB)); then
    echo "[prepare] свободно ${free_mb} МБ, нужно не меньше $((SWAP_MB + MIN_FREE_MB)) (swap ${SWAP_MB} + ${MIN_FREE_MB} под CMS и сайт): отказ" >&2
    exit 3
  fi
  if [[ ! -f "$SWAP_FILE" ]]; then
    fallocate -l "${SWAP_MB}M" "$SWAP_FILE" 2>/dev/null || dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_MB" status=none
    chmod 600 "$SWAP_FILE"
    mkswap -q "$SWAP_FILE"
  fi
  swapon "$SWAP_FILE"
  echo "[prepare] changed: swap ${SWAP_FILE} ${SWAP_MB} МБ включён"
fi
grep -qE "^${SWAP_FILE}[[:space:]]" /etc/fstab || {
  printf '%s none swap sw 0 0\n' "$SWAP_FILE" >>/etc/fstab
  echo "[prepare] changed: строка swap добавлена в /etc/fstab"
}

echo "[prepare] память и диск:"
free -m
df -h / | tail -1
echo "[prepare] ok"
