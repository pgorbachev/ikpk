#!/usr/bin/env bash
set -euo pipefail

# Атомарный деплой статики (releases + symlink current, хранит 5 релизов).
# Ключ доступа задаётся через SSH_KEY (по умолчанию — ключ проекта; тело
# ключа лежит только локально в ~/.ssh, в репозиторий не попадает).
# На сервере должен быть настроен nginx-vhost для сайта (root WEB_ROOT/current).
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <host-or-ip>"
  echo "Example: SSH_KEY=~/.ssh/id_ed25519_ikpk_vps $0 <server-ip>"
  exit 1
fi

HOST="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WEB_DIR="${WEB_DIR:-${REPO_ROOT}/web}"
DIST_DIR="${DIST_DIR:-${WEB_DIR}/dist}"

SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_ikpk_vps}"
SITE_NAME="${SITE_NAME:-ikpk}"
WEB_ROOT="${WEB_ROOT:-/var/www/${SITE_NAME}}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
RELEASE_ID="${RELEASE_ID:-$(date -u +%Y%m%d%H%M%S)}"
REMOTE_RELEASE_DIR="${WEB_ROOT}/releases/${RELEASE_ID}"

SSH_ARGS=(
  -i "$SSH_KEY"
  -o BatchMode=yes
  -o ConnectTimeout=10
)

if [[ "${SSH_STRICT_HOST_KEY_CHECKING:-yes}" == "no" ]]; then
  SSH_ARGS+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
fi

# Режим форм задаётся ЯВНО и умолчания не имеет.
#
# Прежде скрипт по умолчанию ставил DEMO_FORMS=stub, а runbook предлагал звать его
# без переопределения — то есть оператор, следующий документации, развернул бы
# боевой сайт, где все заявки уходят на страницу-заглушку. Обращения клиентов
# терялись бы молча: сборка зелёная, страницы отдаются.
#
# Обратная ошибка так же дорога: стенд, собранный в прод-режиме, пишет заявки в
# CRM заказчика. Поэтому оба режима называются вслух, и умолчания нет ни у одного.
if [[ -z "${DEPLOY_MODE:-}" ]]; then
  cat >&2 <<'USAGE'
Не задан DEPLOY_MODE. Режим форм выбирается явно:

  DEPLOY_MODE=stand  — стенд: формы ведут на локальную заглушку /demo-zayavka,
                       обращения в CRM не создаются;
  DEPLOY_MODE=prod   — боевой сайт: формы ведут в CRM заказчика;
  DEPLOY_MODE=stand DEMO_FORMS=b24-test123.bitrix24site.ru — стенд со своим
                       тестовым порталом вместо заглушки.

Умолчания нет намеренно: любая из двух ошибок молча теряет заявки либо пишет
тестовые обращения в CRM заказчика.
USAGE
  exit 2
fi

case "$DEPLOY_MODE" in
  stand)
    DEMO_FORMS="${DEMO_FORMS:-stub}"
    echo "[deploy] Режим СТЕНД (DEMO_FORMS=$DEMO_FORMS — формы заявки заглушены)"
    ;;
  prod)
    if [[ -n "${DEMO_FORMS:-}" ]]; then
      echo "DEPLOY_MODE=prod несовместим с DEMO_FORMS=$DEMO_FORMS: выберите одно." >&2
      exit 2
    fi
    DEMO_FORMS=""
    echo "[deploy] Режим БОЕВОЙ: формы ведут в реальную CRM заказчика"
    ;;
  *)
    echo "Неизвестный DEPLOY_MODE=$DEPLOY_MODE. Допустимо: stand, prod." >&2
    exit 2
    ;;
esac
export DEMO_FORMS
npm --prefix "$WEB_DIR" ci
npm --prefix "$WEB_DIR" run build

if [[ ! -d "$DIST_DIR" ]]; then
  echo "[deploy] dist directory not found: $DIST_DIR" >&2
  exit 1
fi

echo "[deploy] Uploading release ${RELEASE_ID} to ${SSH_USER}@${HOST}:${REMOTE_RELEASE_DIR}"
COPYFILE_DISABLE=1 tar -C "$DIST_DIR" -cf - . | /usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" \
  "mkdir -p '${REMOTE_RELEASE_DIR}' && tar --no-same-owner -xf - -C '${REMOTE_RELEASE_DIR}'"

# Правила перенаправления живут в shared/, а не в релизе: они относятся к серверу,
# а не к конкретной сборке, и vhost подключает их по постоянному пути. Без этой
# загрузки генератор писал конфиг только в репозиторий, и заявленные правила на
# сервере не действовали вовсе.
REDIRECTS_SRC="${REPO_ROOT}/deploy/nginx-redirects.conf"
if [[ ! -f "$REDIRECTS_SRC" ]]; then
  echo "Нет $REDIRECTS_SRC — запустите: npm --prefix web run redirects:gen" >&2
  exit 1
fi
echo "[deploy] Uploading nginx redirects ($(grep -c '^location' "$REDIRECTS_SRC") rules)"
/usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" \
  "mkdir -p '${WEB_ROOT}/shared' && cat > '${WEB_ROOT}/shared/nginx-redirects.conf'" < "$REDIRECTS_SRC"

echo "[deploy] Switching current symlink and reloading nginx"
/usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" \
  "WEB_ROOT='${WEB_ROOT}' RELEASE_ID='${RELEASE_ID}' KEEP_RELEASES='${KEEP_RELEASES}' bash -s" <<'REMOTE'
set -euo pipefail

release_dir="${WEB_ROOT}/releases/${RELEASE_ID}"
ln -sfn "$release_dir" "${WEB_ROOT}/current"

mapfile -t releases < <(ls -1dt "${WEB_ROOT}"/releases/* 2>/dev/null || true)
if (( ${#releases[@]} > KEEP_RELEASES )); then
  for old_release in "${releases[@]:KEEP_RELEASES}"; do
    rm -rf -- "$old_release"
  done
fi

nginx -t
systemctl reload nginx
REMOTE

if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 10 "http://${HOST}/" >/dev/null; then
    echo "[deploy] Health check OK: http://${HOST}/"
  else
    echo "[deploy] Warning: health check failed at http://${HOST}/" >&2
  fi
fi

echo "[deploy] Done. Active release: ${RELEASE_ID}"
