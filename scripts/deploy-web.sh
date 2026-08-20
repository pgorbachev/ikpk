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

# Адрес САЙТА отделён от ssh-цели намеренно. Это разные вещи, и совпадают они
# только сейчас, пока стенд отвечает по IP без TLS: runbook зовёт скрипт с
# `<ip-сервера>`, но после появления домена запрос по IP уводит редиректом на
# домен (health-check отвергнет смену хоста) либо упирается в сертификат,
# выписанный на домен. Проверка при этом идёт ПОСЛЕ переключения релиза, то есть
# ошибка стоила бы ложного «деплой провален» на исправной выкладке.
SITE_URL_EXPLICIT="${SITE_URL:-}"
SITE_URL="${SITE_URL:-http://${HOST}/}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Проверки, у которых есть поведенческие тесты (web/tests/deploy-checks.test.ts).
# Вынесены в отдельный файл потому, что обе стоят за ssh-вызовами: запуском самого
# скрипта до них не дойти без реального хоста.
# shellcheck source=lib/deploy-checks.sh
source "${SCRIPT_DIR}/lib/deploy-checks.sh"
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
# Роль клиентской сборки (задачи 5.10, 6.14): DEPLOY_MODE и PAYMENT_ROLE совпадают по
# имени случайно (оба значения — stand|prod), но это РАЗНЫЕ переключатели — DEMO_FORMS
# управляет формами ЗАЯВКИ (CRM Bitrix24), PAYMENT_ROLE — платёжным контуром. Без явного
# экспорта здесь `npm run build` собрал бы роль `ci` (умолчание при отсутствии
# переменной) — безопасную CI-сборку без формы, а не заказанный контур.
export PAYMENT_ROLE="$DEPLOY_MODE"
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
# Проверяется ВЕСЬ набор ссылок на формы, а не наличие хотя бы одного файла.
#
# Первая редакция считала файлы с `/demo-zayavka` и с боевым хостом: этого мало —
# заглушку в набор могла внести сама служебная страница, а прод-проверке хватало
# одного совпадения, и остальные формы могли вести куда угодно. Кастомный
# `DEMO_FORMS=<host>` не сверялся вовсе.
#
# Признак ссылки на форму: `crm_form` (формы Bitrix24, в том числе на своём портале)
# либо путь заглушки. Коды grep разбираются явно — 0 нашёл, 1 не нашёл, 2+ ошибка.
# Порталов Bitrix24 у заказчика НЕСКОЛЬКО: в данных встречаются b24-cbqwqo и
# b24-kbo5ls (проверка это и обнаружила — привязка к одному хосту отвергала
# законную боевую сборку). Поэтому в прод-режиме признак общий: адрес формы на
# портале Bitrix24, а не конкретный поддомен. Заглушка при этом запрещена, и чужой
# домен тоже не пройдёт.
case "$DEPLOY_MODE" in
  prod) EXPECT_RE='^https://b24-[a-z0-9]+\.bitrix24site\.ru/crm_form_' ; EXPECT_HUMAN='https://b24-*.bitrix24site.ru/crm_form_*' ;;
  stand)
    if [[ "$DEMO_FORMS" == "stub" ]]; then
      EXPECT_RE='^(/demo-zayavka|https://[^/]+/demo-zayavka)$'
      EXPECT_HUMAN='/demo-zayavka'
    else
      EXPECT_RE="^https://${DEMO_FORMS}/crm_form_"
      EXPECT_HUMAN="https://${DEMO_FORMS}/crm_form_*"
    fi
    ;;
esac

set +e
form_links=$(grep -roh 'href="[^"]*\(crm_form\|demo-zayavka\)[^"]*"' "$DIST_DIR" --include='*.html' 2>/dev/null \
  | sed 's/^href="//; s/"$//' | sort -u)
grep_rc=$?
set -e
if (( grep_rc > 1 )); then
  echo "не удалось прочитать $DIST_DIR (grep код $grep_rc) — проверка форм не выполнена" >&2
  exit 1
fi

form_count=$(printf '%s\n' "$form_links" | grep -c . || true)
if (( form_count == 0 )); then
  echo "В сборке нет ни одной ссылки на форму заявки — проверять нечего, загрузка отменена." >&2
  echo "Ожидался набор вида ${EXPECT_HUMAN}." >&2
  exit 1
fi

wrong=$(printf '%s\n' "$form_links" | grep -vE "$EXPECT_RE" || true)
if [[ -n "$wrong" ]]; then
  echo "Ссылки форм не соответствуют режиму ${DEPLOY_MODE} (ожидалось ${EXPECT_HUMAN}):" >&2
  printf '%s\n' "$wrong" | head -5 >&2
  echo "Загрузка отменена: в режиме stand это увело бы заявки в CRM заказчика," >&2
  echo "в режиме prod — потеряло бы обращения клиентов." >&2
  exit 1
fi
echo "[deploy] Проверка форм: ${form_count} различных адресов, все соответствуют ${EXPECT_HUMAN}"

# ── Гейты платёжной формы: адрес и секреты (задачи 6.1 и 6.2).
#
# Сама механика — в `scripts/lib/deploy-checks.sh`, потому что этот блок стоит ПОСЛЕ
# ssh-загрузки релиза: запуском скрипта до него не дойти без реального хоста, и без
# выноса у гейтов был бы только греп исходника. Так же вынесены preflight и health-check.
# Приведено к матрице ролей (задачи 6.13, 6.14): роль сборки — тот же DEPLOY_MODE
# (stand|prod), третий аргумент payment_endpoint_matches — она, а не булев признак
# «демо». Адрес стенда — своя база `<origin стенда>/api`, а не недостижимый `.invalid`
# прежней матрицы (design.md, Решение 13): mock-адрес закреплён за ролью `preview`,
# которая через этот скрипт не публикуется вовсе.
case "$DEPLOY_MODE" in
  prod)
    EXPECT_ENDPOINT="${PAYMENT_ENDPOINT_PROD:-https://api.ikpk.su}"
    EXPECT_SERVICE_MODE="prod"
    EXPECT_SHOP_ID="409285"
    ;;
  stand)
    EXPECT_ENDPOINT="${PAYMENT_ENDPOINT_STAND:-http://193.124.115.99/api}"
    EXPECT_SERVICE_MODE="test"
    EXPECT_SHOP_ID="1440249"
    ;;
esac

echo "[deploy] Проверка роли и адреса платёжной формы (роль ${DEPLOY_MODE})"
if ! payment_endpoint_matches "$DIST_DIR" "$EXPECT_ENDPOINT" "$DEPLOY_MODE"; then
  echo "Загрузка отменена: артефакт не несёт активную форму заказанного контура —" >&2
  echo "либо адрес не тот, либо роль не объявлена/не та." >&2
  exit 1
fi

# Значения секретов ищутся только те, что переданы в окружение вызова. Пустой список —
# «проверить не удалось», а не «утечек нет», поэтому отказ либо назван явно
# (`PAYMENT_SECRET_SCAN=skip`), либо деплой останавливается.
secret_args=()
for name in YOOKASSA_SECRET_KEY HMAC_KEY_CURRENT HMAC_KEY_PREVIOUS; do
  [[ -n "${!name:-}" ]] && secret_args+=("$name=${!name}")
done
if (( ${#secret_args[@]} == 0 )); then
  if [[ "${PAYMENT_SECRET_SCAN:-}" == "skip" ]]; then
    echo "[deploy] Проверка секретов ПРОПУЩЕНА явным PAYMENT_SECRET_SCAN=skip (значения не переданы)" >&2
  else
    echo "Проверка секретов не выполнена: ни одно значение не передано" >&2
    echo "(YOOKASSA_SECRET_KEY, HMAC_KEY_CURRENT, HMAC_KEY_PREVIOUS)." >&2
    echo "Это «не смогли проверить», а не «утечек нет». Передайте значения либо назовите" >&2
    echo "отказ явно: PAYMENT_SECRET_SCAN=skip." >&2
    exit 1
  fi
else
  echo "[deploy] Проверка секретов в сборке"
  if ! dist_has_no_secret_values "$DIST_DIR" "${secret_args[@]}"; then
    echo "Загрузка отменена: значение секрета попало в статику." >&2
    exit 1
  fi
fi

# ── Preflight: активный vhost обязан подключать файл редиректов.
#
# Загрузка файла в shared/ этого НЕ доказывает: `nginx -t` проходит и без include,
# и деплой завершался бы успешно при неработающих 264 правилах. На уже развёрнутом
# сервере include не появляется сам — vhost пишет только bootstrap, а повторно его
# запускать нельзя: он перезаписывает конфиг целиком и снесёт правки certbot.
#
# Проверяем РАЗВЁРНУТУЮ конфигурацию через `nginx -T` (она печатает все включённые
# файлы) и отказываемся до переключения релиза.
echo "[deploy] Preflight: подключён ли файл редиректов активным vhost"
# Вывод ssh кладётся в файл, а не идёт в конвейер: под `pipefail` статус конвейера —
# код САМОЙ ПРАВОЙ упавшей команды, то есть grep'а. Код ssh (255 при обрыве связи)
# терялся бы, и оператор на транзиентном сбое сети получил бы диагноз «vhost не
# подключает редиректы» с инструкцией править исправный боевой конфиг руками.
nginx_dump="$(mktemp)"
trap 'rm -f "$nginx_dump"' EXIT
if ! /usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" 'nginx -T 2>/dev/null' >"$nginx_dump"; then
  echo "[deploy] Preflight ПРОВАЛЕН: не удалось получить конфигурацию nginx по ssh с ${HOST}." >&2
  echo "Это сбой связи или доступа, а НЕ признак отсутствующего include." >&2
  exit 1
fi

# Имя каталога сайта передаётся намеренно: без него засчитается файл редиректов
# любого постороннего vhost на том же хосте.
if ! redirects_include_active "${WEB_ROOT##*/}" <"$nginx_dump"; then
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

# ── Гейт установленного контура: readiness, доступность, CORS (задача 6.13). ────
#
# ДО ПУБЛИКАЦИИ (до переключения symlink): спека требует доказать, что объявленный
# эндпоинт достижим и сервер сообщает ожидаемые несекретные признаки режима и shopId —
# совпадение адреса само по себе ничего не доказывает (design.md, Решение 13).
#
# readiness — ТОЛЬКО изнутри host (`/readyz` наружу не публикуется, задача 5.10c):
# исходник `deploy-checks.sh` со вставленным вызовом уходит по ssh и исполняется прямо
# на хосте, где `127.0.0.1:8787` разрешается на установленный сервис. Так гейт
# ОСТАЁТСЯ ОДНИМ (та же `payment_readiness_matches`, что и в `deploy-checks-payment-role.test.ts`),
# а не копией её разбора JSON здесь.
echo "[deploy] Проверка readiness установленного контура (изнутри host)"
if ! { cat "${SCRIPT_DIR}/lib/deploy-checks.sh"; printf 'payment_readiness_matches http://127.0.0.1:8787/readyz "$1" "$2"\n'; } \
  | /usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" "bash -s -- '${EXPECT_SERVICE_MODE}' '${EXPECT_SHOP_ID}'"
then
  echo "Загрузка отменена: readiness установленного контура (роль ${DEPLOY_MODE}) не подтвердил" >&2
  echo "режим ${EXPECT_SERVICE_MODE} и магазин ${EXPECT_SHOP_ID} — сервис не тот или не тем магазином." >&2
  exit 1
fi

# Доступность ПУБЛИЧНОГО пути — проба, ничего не создающая (OPTIONS, не POST): совпадение
# адреса и работающий readiness — про разные предметы, ни один не заменяет другой (спека,
# Requirement «Личность контура сообщается несекретным readiness-ответом»).
#
# ОДНА проба на контур, не две (исправлено по находке владельца O-4, 2026-08-19/20):
# у `stand` — `payment_endpoint_reachable` (без `Origin`, ей и не положен — same-origin,
# CORS не участвует). У `prod` — только `payment_cors_allows`: она САМА проверяет и `204`,
# и заголовок на ОДНОМ запросе с `Origin` (design.md, Решение 13, п.4: «тот же OPTIONS
# служит и проверкой CORS»). Раздельный вызов `payment_endpoint_reachable` без `Origin` для
# prod был бы ВТОРЫМ, отличным от браузерного, запросом — «204 без Origin» плюс «заголовок
# верен при Origin, а код ответа при Origin не проверен» проходили бы гейт при живом 403 на
# фактическом preflight.
if [[ "$DEPLOY_MODE" == "prod" ]]; then
  echo "[deploy] Проверка доступности и CORS одним preflight-запросом (OPTIONS с Origin ${EXPECT_ENDPOINT}/payments)"
  if ! payment_cors_allows "$EXPECT_ENDPOINT" "https://ikpk.su"; then
    echo "Загрузка отменена: платёжный эндпоинт недостижим или CORS не разрешает origin боевого сайта." >&2
    exit 1
  fi
else
  echo "[deploy] Проверка доступности объявленного эндпоинта (OPTIONS ${EXPECT_ENDPOINT}/payments)"
  if ! payment_endpoint_reachable "$EXPECT_ENDPOINT"; then
    echo "Загрузка отменена: объявленный платёжный эндпоинт недостижим снаружи." >&2
    exit 1
  fi
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
  if health_check "$SITE_URL"; then
    echo "[deploy] Health check OK: ${SITE_URL}"
  else
    # Провал health-check — это провал деплоя, а не примечание. Прежде скрипт
    # печатал Warning и доходил до «Done» с кодом 0: сломанный релиз выглядел
    # успешным. Symlink уже переключён, поэтому откат — отдельное решение (см.
    # docs/tech-debt.md), но код выхода обязан быть ненулевым.
    echo "[deploy] Health check ПРОВАЛЕН: ${SITE_URL} не отвечает как ожидалось" >&2
    if [ -z "${SITE_URL_EXPLICIT:-}" ]; then
      echo "Адрес проверки собран из ssh-хоста и может быть не адресом сайта: после" >&2
      echo "появления домена и TLS запрос по IP уводит редиректом на домен (проверка" >&2
      echo "отвергнет смену хоста) либо упирается в сертификат, выписанный на домен." >&2
      echo "Задайте адрес сайта явно: SITE_URL=https://<домен>/ ./scripts/deploy-web.sh <ip>" >&2
    fi
    echo "Релиз ${RELEASE_ID} уже активен. Откат: переключить symlink current на" >&2
    echo "предыдущий каталог в ${WEB_ROOT}/releases и перезагрузить nginx." >&2
    exit 1
  fi
else
  echo "[deploy] curl недоступен — health check НЕ выполнен" >&2
  exit 1
fi

echo "[deploy] Done. Active release: ${RELEASE_ID}"
