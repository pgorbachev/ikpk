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

# ── Артефакт сверяется с ЗАКАЗАННЫМ режимом, а не с самим собой.
#
# Проверка `DEPLOY_MODE` выше сторожит вызов; собрать при этом можно другое:
# `web/.env` (он в .gitignore, то есть невидим в ревью), экспорт из профиля оболочки
# или правка `src/lib/forms.ts`. Существующий build-гейт определяет режим ПО
# артефакту, поэтому «собрано не то, что заказано» он увидеть не может по построению.
#
# Смотрим на то, что реально уедет на сервер, и требуем непустой результат: ноль
# найденных ссылок на формы — это «проверить не удалось», а не «всё верно».
PROD_FORM_HOST='b24-cbqwqo.bitrix24site.ru'

# Коды возврата grep разбираются явно: 0 — нашёл, 1 — не нашёл, 2+ — ошибка чтения.
# Без этого `x=$(grep … | wc -l)` под `set -euo pipefail` роняет скрипт молча, когда
# совпадений законно ноль — на первом же деплое стенда так и вышло: `prod_pages`
# равен нулю по замыслу, а скрипт упал до вывода собственной проверки. Смешивать «не
# нашёл» с «не смог прочитать» тоже нельзя: второе означает, что проверка не
# выполнена.
count_pages() {
  local pattern="$1" list rc
  set +e
  list=$(grep -rl -- "$pattern" "$DIST_DIR" 2>/dev/null)
  rc=$?
  set -e
  case "$rc" in
    0) printf '%s\n' "$list" | grep -c . ;;
    1) echo 0 ;;
    *) echo "grep не смог прочитать $DIST_DIR (код $rc) — проверка артефакта не выполнена" >&2
       exit 1 ;;
  esac
}

stub_pages=$(count_pages '/demo-zayavka')
prod_pages=$(count_pages "$PROD_FORM_HOST")
echo "[deploy] Проверка артефакта: страниц с заглушкой ${stub_pages}, с боевым хостом ${prod_pages}"

case "$DEPLOY_MODE" in
  stand)
    if (( stub_pages == 0 )); then
      echo "Собран НЕ стенд: ссылок на /demo-zayavka в сборке нет. Загрузка отменена." >&2
      echo "Проверьте web/.env и переменные окружения: DEMO_FORMS должен быть задан." >&2
      exit 1
    fi
    if (( prod_pages > 0 )); then
      echo "В сборке стенда ${prod_pages} страниц с боевым хостом форм ${PROD_FORM_HOST}." >&2
      echo "Заявки со стенда уйдут в CRM заказчика. Загрузка отменена." >&2
      exit 1
    fi
    ;;
  prod)
    if (( prod_pages == 0 )); then
      echo "Собран НЕ боевой сайт: ссылок на ${PROD_FORM_HOST} в сборке нет." >&2
      echo "Заявки клиентов уходили бы в никуда. Загрузка отменена." >&2
      exit 1
    fi
    if (( stub_pages > 0 )); then
      echo "В боевой сборке ${stub_pages} страниц ведут на заглушку /demo-zayavka." >&2
      echo "Заявки клиентов терялись бы молча. Загрузка отменена." >&2
      exit 1
    fi
    ;;
esac

# ── Preflight: активный vhost обязан подключать файл редиректов.
#
# Загрузка файла в shared/ этого НЕ доказывает: `nginx -t` проходит и без include,
# и деплой завершался бы успешно при неработающих 265 правилах. На уже развёрнутом
# сервере include не появляется сам — vhost пишет только bootstrap, а повторно его
# запускать нельзя: он перезаписывает конфиг целиком и снесёт правки certbot.
#
# Проверяем РАЗВЁРНУТУЮ конфигурацию через `nginx -T` (она печатает все включённые
# файлы) и отказываемся до переключения релиза.
echo "[deploy] Preflight: подключён ли файл редиректов активным vhost"
if ! /usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" \
  "nginx -T 2>/dev/null | grep -q 'include .*${WEB_ROOT##*/}.*nginx-redirects.conf\|nginx-redirects.conf'"; then
  cat >&2 <<PREFLIGHT
Активный vhost не подключает ${WEB_ROOT}/shared/nginx-redirects.conf — правила
перенаправления не будут действовать, а деплой выглядел бы успешным.

Одноразовая правка на сервере (bootstrap повторно НЕ запускать — он перезапишет
vhost и снесёт конфигурацию certbot):

  cp /etc/nginx/sites-available/ikpk.conf /etc/nginx/sites-available/ikpk.conf.bak
  # внутрь блока server { … } добавить строку:
  #   include ${WEB_ROOT}/shared/nginx-redirects.conf;
  touch ${WEB_ROOT}/shared/nginx-redirects.conf
  nginx -t && systemctl reload nginx

После этого повторите деплой. Резервная копия остаётся в *.bak.
PREFLIGHT
  exit 1
fi

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
    # Провал health-check — это провал деплоя, а не примечание. Прежде скрипт
    # печатал Warning и доходил до «Done» с кодом 0: сломанный релиз выглядел
    # успешным. Symlink уже переключён, поэтому откат — отдельное решение (см.
    # docs/tech-debt.md), но код выхода обязан быть ненулевым.
    echo "[deploy] Health check ПРОВАЛЕН: http://${HOST}/ не отвечает" >&2
    echo "Релиз ${RELEASE_ID} уже активен. Откат: переключить symlink current на" >&2
    echo "предыдущий каталог в ${WEB_ROOT}/releases и перезагрузить nginx." >&2
    exit 1
  fi
else
  echo "[deploy] curl недоступен — health check НЕ выполнен" >&2
  exit 1
fi

echo "[deploy] Done. Active release: ${RELEASE_ID}"
