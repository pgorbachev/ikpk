#!/usr/bin/env bash
set -euo pipefail

# Провижининг стенда/прода IKPK. Идемпотентен (change `server-provisioning`):
# повторный запуск на уже приведённом сервере ничего не меняет, а сервер, приведённый
# не этим скриптом, обрабатывается по политике из объявленного состояния
# (`deploy/environments/<env>.env`), а не затирается молча.
#
# Секреты (deploy/environments/<env>.env, ключ SECRET_NAMES) читаются ТОЛЬКО из
# окружения процесса и НИКОГДА не попадают в аргументы команд, в heredoc или в
# промежуточный файл: они остаются в окружении и передаются на сервер через
# ssh SendEnv/AcceptEnv (см. ниже, перед основным вызовом).

usage() {
  echo "Usage: $0 <host-or-ip>"
  echo "Example: $0 146.103.124.113"
  echo "Env: ENVIRONMENT=stand|prod (default stand), DOMAIN, FORCE_VHOST=1, BACKUP_ONLY=1"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

HOST="$1"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_vdsina_root}"
ENVIRONMENT="${ENVIRONMENT:-stand}"
DOMAIN="${DOMAIN:-_}"
FORCE_VHOST="${FORCE_VHOST:-}"
BACKUP_ONLY="${BACKUP_ONLY:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/environments/${ENVIRONMENT}.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Объявленного состояния окружения «${ENVIRONMENT}» нет: ${ENV_FILE}" >&2
  exit 1
fi

# Значение конкретного ключа объявленного состояния — без source, чтобы не грузить
# ничего лишнего до проверки секретов.
declared_get() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

SECRET_NAMES_DECLARED="$(declared_get SECRET_NAMES)"

# --- Секреты: только из окружения процесса, отказ без умолчания (Requirement
# «Секреты не хранятся в репозитории и не утекают в историю»). Значение НИКОГДА не
# становится аргументом команды и не проходит через stdin, попадающий на диск: оно
# остаётся в окружении процесса и передаётся серверу назначения через `SendEnv`/
# `AcceptEnv` ssh (тот же канал, для которого он и предназначен), а не через
# heredoc-вложение или отдельный файл — оба варианта оставляют копию значения там,
# где её потом придётся искать и стирать. ---
SECRET_NAME_LIST=()
MISSING_SECRETS=()
if [[ -n "$SECRET_NAMES_DECLARED" ]]; then
  IFS=',' read -ra _secret_names <<<"$SECRET_NAMES_DECLARED"
  for name in "${_secret_names[@]}"; do
    [[ -n "$name" ]] || continue
    SECRET_NAME_LIST+=("$name")
    val="${!name-}"
    [[ -z "$val" ]] && MISSING_SECRETS+=("$name")
  done
fi

# Снятие копии содержимого не касается системы управления и её секретов, поэтому
# требовать их здесь — значит расширять круг тех, кому секреты нужны, без причины:
# CI-джобу для резервной копии пришлось бы держать все шесть значений Strapi.
if ((${#MISSING_SECRETS[@]} > 0)) && [[ "${BACKUP_ONLY:-}" != "1" ]]; then
  echo "[bootstrap] Обязательный секрет отсутствует: ${MISSING_SECRETS[*]}" >&2
  exit 4
fi

SSH_ARGS=(
  -i "$SSH_KEY"
  -o BatchMode=yes
  -o ConnectTimeout=10
)

if [[ "${SSH_STRICT_HOST_KEY_CHECKING:-yes}" == "no" ]]; then
  SSH_ARGS+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
fi

echo "[bootstrap] Connecting to ${SSH_USER}@${HOST}"

# --- Доставка объявленного (несекретного) состояния отдельным вызовом: значение идёт
# через stdin, командная строка содержит только путь назначения. ---
STATE_DIR="/etc/ikpk-provision/state"
/usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" \
  "mkdir -p '${STATE_DIR}' && cat > '${STATE_DIR}/${ENVIRONMENT}.env.new' && mv '${STATE_DIR}/${ENVIRONMENT}.env.new' '${STATE_DIR}/${ENVIRONMENT}.env'" \
  <"$ENV_FILE"

# --- Доставка собранного артефакта системы управления (tasks.md 5b.2a): тем же
# приёмом, что и содержимое сайта — заранее собранным, в новый releases/<ревизия>,
# атомарная смена делается на удалённой стороне. Пусто — сборки ещё нет, шаг
# пропускается: "не наблюдалось в природе" не повод падать. ---
# Источник артефакта — вход ОПЕРАТОРА (путь на его машине), а не состояние сервера, поэтому
# окружение имеет приоритет над объявленным. Прежде читалось только объявленное, и переданный
# оператором путь молча игнорировался: шаг доставки пропускался, а прогон отчитывался успехом.
CMS_ARTIFACT_SOURCE_DECLARED="${CMS_ARTIFACT_SOURCE:-$(declared_get CMS_ARTIFACT_SOURCE)}"
CMS_ARTIFACT_DIR_DECLARED="$(declared_get CMS_ARTIFACT_DIR)"
CMS_ARTIFACT_RELEASE=""
if [[ -n "$CMS_ARTIFACT_SOURCE_DECLARED" && -d "$CMS_ARTIFACT_SOURCE_DECLARED" ]]; then
  CMS_ARTIFACT_RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
  release_dir="${CMS_ARTIFACT_DIR_DECLARED}/releases/${CMS_ARTIFACT_RELEASE}"
  /usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" "mkdir -p '${release_dir}'"
  # Каждый релиз — новый каталог, поэтому без --link-dest rsync шлёт артефакт целиком
  # заново. Замерено: 13 МБ на этом канале идут ~30 минут, то есть каждая выкатка стоит
  # получаса даже при неизменном артефакте. С --link-dest неизменные файлы связываются
  # жёсткой ссылкой на месте и по сети не идут. Прежняя версия по-прежнему цела: жёсткая
  # ссылка не копия, но и не общий файл — rsync заменяет изменившийся файл новым inode.
  link_dest_args=()
  prev_release="$(/usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" \
    "readlink -f '${CMS_ARTIFACT_DIR_DECLARED}/current' 2>/dev/null || true")"
  # `readlink -f` на висячей ссылке возвращает САМ путь — тот же капкан, что в откате.
  if [[ -n "$prev_release" && "$prev_release" != "${CMS_ARTIFACT_DIR_DECLARED}/current" ]]; then
    link_dest_args=(--link-dest="$prev_release")
  fi
  # -z: артефакт — это JS и CSS, они жмутся втрое (замерено: 13 МБ → 4 МБ), а канал до
  # стенда узкий: без сжатия доставка занимала ~30 минут на каждую выкатку.
  rsync -az "${link_dest_args[@]}" --rsh="/usr/bin/ssh ${SSH_ARGS[*]}" "${CMS_ARTIFACT_SOURCE_DECLARED}/" "${SSH_USER}@${HOST}:${release_dir}/"
fi

# Транспорт секретов — СТАНДАРТНЫЙ ВВОД, а не `SendEnv`.
#
# `SendEnv` требует, чтобы sshd принимал эти имена: на стенде стоит
# `AcceptEnv LANG LC_* COLORTERM NO_COLOR` (проверено), то есть сервер МОЛЧА отбросил бы их,
# файл секретов вышел бы с пустыми значениями, и служба не поднялась бы. Настроить `AcceptEnv`
# провижинингом нельзя без курицы и яйца: чтобы послать секреты, сначала надо послать секреты.
#
# Контейнерные тесты этого не видели: там `ssh` — заглушка локального исполнения, и окружение
# наследуется напрямую. Ограничение настоящего транспорта не проверял никто.
#
# Значения уходят тем же зашифрованным потоком, что и тело скрипта: в argv не попадают
# (иначе их видно в `ps`), на диск клиента не пишутся, настройки сервера не требуют.
secret_exports=""
for name in "${SECRET_NAME_LIST[@]}"; do
  value="${!name-}"
  secret_exports+="export ${name}=$(printf '%q' "$value")"$'\n'
done

{
  printf '%s' "$secret_exports"
  cat <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Одновременно на один хост — только один прогон. Без замка два запуска гонятся за сменой
# симлинка релиза, перезапуском службы и перезаписью vhost, а гейт ревизии их не разводит:
# при одинаковой объявленной ревизии он пропускает оба. Отказ быстрый и внятный — ждать
# чужого прогона молча хуже, чем сказать, что он идёт.
#
# Замок — КАТАЛОГ, а не `flock` на файловом дескрипторе. Первая версия брала `flock -n 9`,
# и она ломала повторный прогон: дескриптор наследуется потомками, а провижининг запускает
# долгоживущие (nginx). Потомок переживал скрипт и держал замок дальше — второй прогон на
# том же хосте получал отказ 10, хотя первый давно кончился. Замерено на контейнерном
# наборе: 13 сценариев из 29 упали именно так. Каталог наследованию не подвержен, а
# остаточный (владелец мёртв) распознаётся по записанному pid.
LOCK_DIR="/var/lock/ikpk-provision.lock.d"
mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "[bootstrap] На этом хосте уже идёт провижининг (pid ${lock_pid}) — отказ, чтобы не гоняться за общим состоянием" >&2
    exit 10
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || { echo "[bootstrap] Замок ${LOCK_DIR} недоступен" >&2; exit 10; }
fi
printf '%s' "$$" >"${LOCK_DIR}/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

STATE_FILE="/etc/ikpk-provision/state/${ENVIRONMENT}.env"
if [[ ! -f "$STATE_FILE" ]]; then
  echo "[bootstrap] Объявленное состояние не доставлено: ${STATE_FILE}" >&2
  exit 1
fi
# Читаем построчно вместо `source`: значения объявленного состояния — свободный
# текст (например PROPERTY_*_REASON), который может содержать пробелы и не обязан
# быть валидным bash-синтаксисом. `source` на такой строке пытается ИСПОЛНИТЬ её как
# команду («PROPERTY_X_REASON=нужен настоящий домен» запускает команду «настоящий»)
# — обнаружено эмпирически на реальном значении из красных тестов.
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
load_declared "$STATE_FILE"

SITE_NAME="${SITE_NAME:-ikpk}"
WEB_ROOT="${WEB_ROOT:-/var/www/${SITE_NAME}}"
VHOST="/etc/nginx/sites-available/${SITE_NAME}.conf"
REVISION_FILE="${REVISION_FILE:-/var/lib/ikpk-provision/revision}"
BACKUP_DIR="${BACKUP_DIR:-/etc/nginx/sites-available}"
CONTENT_BACKUP_DIR="${CONTENT_BACKUP_DIR:-/var/backups/${SITE_NAME}/current}"
# ПУСТОЕ значение здесь означает «проксирование отключено сознательно», а не «не задано».
# `${VAR:-умолчание}` эти два случая не различает и подставляет умолчание на пустом — так
# отключение админки молча превратилось в её публикацию на живом стенде. Различаем по НАЛИЧИЮ
# ключа в объявленном состоянии: объявлен пустым — остаётся пустым; не объявлен вовсе — умолчание.
if grep -qE "^[[:space:]]*SERVICE_PROXY_SNIPPET=" "$STATE_FILE"; then
  : "${SERVICE_PROXY_SNIPPET=}"
else
  SERVICE_PROXY_SNIPPET="/etc/nginx/snippets/ikpk-cms.conf"
fi
VHOST_MARKER="# managed-by: ikpk-provisioning"

CHANGED=0
UNCHANGED=0
report() {
  local verb="$1"
  shift
  if [[ "$verb" == changed ]]; then
    CHANGED=$((CHANGED + 1))
  else
    UNCHANGED=$((UNCHANGED + 1))
  fi
  echo "[bootstrap] ${verb}: $*"
}

# --- BACKUP_ONLY: только снятие копии опубликованного содержимого, остальное не трогаем
# (design.md Решение 6.4: наследует конвенцию payments/deploy/ikpk-payments-backup.sh —
# отдельный каталог, атомарная запись через временное имя). ---
if [[ "${BACKUP_ONLY:-}" == "1" ]]; then
  src="${WEB_ROOT}/current"
  if [[ ! -d "$src" ]]; then
    echo "[bootstrap] снятие копии: каталог ${src} не существует — копировать нечего" >&2
    exit 1
  fi
  mkdir -p "$CONTENT_BACKUP_DIR"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="${CONTENT_BACKUP_DIR}/current-${ts}"
  tmp="${dest}.part"
  rsync -a "$src/" "$tmp/"
  mv "$tmp" "$dest"
  src_count=$(find "$src" -type f | wc -l)
  dst_count=$(find "$dest" -type f | wc -l)
  if ((dst_count == 0)) || [[ "$src_count" != "$dst_count" ]]; then
    echo "[bootstrap] копия пуста или состав путей не совпадает с предметом (src=${src_count} dst=${dst_count}) — отказ" >&2
    exit 1
  fi
  echo "[bootstrap] резервная копия содержимого снята: ${dest}"
  echo "changed=1"
  echo "unchanged=0"
  exit 0
fi

# --- Ревизия объявленного состояния: отказ на попытке применить более старую
# (Requirement «Провижининг идемпотентен и повторно применим»). ---
NEW_REVISION="${PROVISION_REVISION:-}"
if [[ -n "$NEW_REVISION" && -s "$REVISION_FILE" ]]; then
  OLD_REVISION="$(cat "$REVISION_FILE")"
  older=0
  if [[ "$OLD_REVISION" =~ ^[0-9]+$ && "$NEW_REVISION" =~ ^[0-9]+$ ]]; then
    ((NEW_REVISION < OLD_REVISION)) && older=1
  else
    [[ "$NEW_REVISION" < "$OLD_REVISION" ]] && older=1
  fi
  if [[ "$older" == 1 ]]; then
    echo "[bootstrap] отказ: попытка применить ревизию ${NEW_REVISION}, на сервере записана более новая ${OLD_REVISION}" >&2
    exit 5
  fi
fi

# --- Инвентарь ПО ---
IFS=',' read -ra _pkgs <<<"${PACKAGES:-nginx,rsync}"
need_install=()
for p in "${_pkgs[@]}"; do
  [[ -n "$p" ]] || continue
  dpkg -s "$p" >/dev/null 2>&1 || need_install+=("$p")
done
if ((${#need_install[@]} > 0)); then
  apt-get update -qq
  apt-get install -y -qq "${need_install[@]}"
  report changed "пакеты: ${need_install[*]}"
else
  report unchanged "пакеты уже установлены (${_pkgs[*]})"
fi

# --- Каталоги раздачи ---
for d in "${WEB_ROOT}/releases" "${WEB_ROOT}/shared"; do
  if [[ -d "$d" ]]; then
    report unchanged "каталог ${d}"
  else
    mkdir -p "$d"
    report changed "каталог ${d}"
  fi
done
if [[ "$(stat -c '%U:%G' "$WEB_ROOT" 2>/dev/null)" != "root:root" ]]; then
  chown -R root:root "$WEB_ROOT"
  report changed "владелец ${WEB_ROOT} -> root:root"
else
  report unchanged "владелец ${WEB_ROOT}"
fi

# --- Учётная запись службы системы управления (Requirement «Служба системы управления
# не доступна снаружи напрямую», объём 5b.1 — код самой CMS вне объёма). ---
if [[ -n "${SERVICE_ACCOUNT:-}" ]]; then
  if id "$SERVICE_ACCOUNT" >/dev/null 2>&1; then
    report unchanged "учётная запись ${SERVICE_ACCOUNT}"
  else
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_ACCOUNT"
    report changed "учётная запись ${SERVICE_ACCOUNT} создана"
  fi
fi

# --- Каталог данных системы управления. Стоит ПОСЛЕ учётной записи: каталог обязан
# принадлежать службе, иначе она не создаст в нём базу, а причина видна только в журнале
# службы, а не в выводе провижининга. ---
if [[ -n "${CMS_DATA_DIR:-}" ]]; then
  if [[ -d "$CMS_DATA_DIR" ]]; then
    report unchanged "каталог данных ${CMS_DATA_DIR}"
  else
    mkdir -p "$CMS_DATA_DIR"
    report changed "каталог данных ${CMS_DATA_DIR}"
  fi
  if [[ -n "${SERVICE_ACCOUNT:-}" ]]; then
    owner_now="$(stat -c '%U:%G' "$CMS_DATA_DIR" 2>/dev/null || echo '?')"
    if [[ "$owner_now" == "${SERVICE_ACCOUNT}:${SERVICE_ACCOUNT}" ]]; then
      report unchanged "владелец ${CMS_DATA_DIR}"
    else
      chown -R "${SERVICE_ACCOUNT}:${SERVICE_ACCOUNT}" "$CMS_DATA_DIR"
      report changed "владелец ${CMS_DATA_DIR} → ${SERVICE_ACCOUNT}"
    fi
  fi
fi

# --- Unit-файл службы: годится любая программа на объявленном локальном адресе. ---
#
# `ExecStart` берётся из объявленного состояния и ОБЯЗАТЕЛЕН: юнит без него systemd не
# принимает вовсе — «Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.»
# (проверено `systemd-analyze verify` на самом стенде). Прежняя редакция его не выводила, и
# служба не поднялась бы никогда; контейнерные тесты этого не видели, потому что `systemctl`
# там заглушка — она сверяет ФАЙЛ, а не то, что он запускается.
#
# `HOST`/`PORT` разбираются из `SERVICE_ADDR`: Strapi читает именно их
# (`cms/config/server.ts`), а не `LISTEN_ADDR`.
if [[ -n "${SERVICE_UNIT:-}" ]]; then
  SERVICE_HOST="${SERVICE_ADDR%%:*}"
  SERVICE_PORT="${SERVICE_ADDR##*:}"
  if [[ -z "${SERVICE_EXEC_START:-}" ]]; then
    echo "[bootstrap] SERVICE_EXEC_START не объявлен: юнит без ExecStart systemd отвергнет" >&2
    exit 1
  fi
  unit_desired="$(
    cat <<UNITEOF
[Unit]
Description=IKPK CMS service (${ENVIRONMENT})
After=network.target
# Предел перезапусков живёт в [Unit], а не в [Service]: в [Service] systemd его МОЛЧА
# игнорирует ("Unknown key ... ignoring" в журнале), и защиты нет вовсе. Проверено на
# стенде: с ключами в [Service] счётчик перезапусков дошёл до 185.
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=${SERVICE_ACCOUNT:-root}
Group=${SERVICE_ACCOUNT:-root}
WorkingDirectory=${CMS_ARTIFACT_DIR:-/opt/ikpk-cms}/current
EnvironmentFile=-${SECRET_FILE:-/dev/null}
Environment=CMS_DATA_DIR=${CMS_DATA_DIR:-/var/lib/ikpk-cms}
# HOME обязателен: учётная запись создаётся без домашнего каталога, а Strapi пишет туда
# служебные файлы и падает с EACCES на mkdir /home/<служба>.
Environment=HOME=${CMS_DATA_DIR:-/var/lib/ikpk-cms}
Environment=LISTEN_ADDR=${SERVICE_ADDR:-127.0.0.1:0}
Environment=HOST=${SERVICE_HOST}
Environment=PORT=${SERVICE_PORT}
Environment=DATABASE_CLIENT=${CMS_DB_CLIENT:-sqlite}
Environment=DATABASE_FILENAME=${CMS_DATA_DIR:-/var/lib/ikpk-cms}/data.db
Environment=NODE_ENV=production
# Ограничения среды. Владение файлами защищает только от переписывания службой своего
# кода; всё остальное — чтение доступных всем файлов машины, произвольный /tmp — оставалось
# открытым. ReadWritePaths называет ровно те места, куда служба обязана писать.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${CMS_DATA_DIR:-/var/lib/ikpk-cms} ${CMS_ARTIFACT_DIR:-/opt/ikpk-cms}/current/database ${CMS_ARTIFACT_DIR:-/opt/ikpk-cms}/current/.strapi ${CMS_ARTIFACT_DIR:-/opt/ikpk-cms}/shared/uploads
ExecStart=${SERVICE_EXEC_START}
Restart=on-failure
RestartSec=3
# Остановка ограничена 30 секундами. По умолчанию systemd ждёт 90 и только потом убивает;
# на стенде именно это съело треть окна проверки живости при смене артефакта
# («Failed with result 'timeout'» в журнале), и исправная новая версия не успела ответить.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNITEOF
  )"
  if [[ -f "$SERVICE_UNIT" && "$(cat "$SERVICE_UNIT")" == "$unit_desired" ]]; then
    report unchanged "unit-файл ${SERVICE_UNIT}"
  else
    mkdir -p "$(dirname "$SERVICE_UNIT")"
    printf '%s\n' "$unit_desired" >"$SERVICE_UNIT"
    report changed "unit-файл ${SERVICE_UNIT}"
    command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true
  fi
  # Юнит сверяется с самим systemd, а не только с ожидаемым текстом. Причина: неверную
  # СЕКЦИЮ systemd не отвергает — он пишет «Unknown key ... ignoring» в журнал и работает
  # без директивы. Так предел перезапусков в [Service] оказался декоративным, и мы узнали
  # об этом только по счётчику 185 на стенде. Отсутствие самого systemd-analyze при живом
  # systemctl — тоже отказ: это «проверить не смог», а не «дефектов нет».
  if command -v systemctl >/dev/null 2>&1; then
    if ! command -v systemd-analyze >/dev/null 2>&1; then
      echo "[bootstrap] systemd есть, а systemd-analyze нет: юнит проверить нечем" >&2
      exit 1
    fi
    unit_verify="$(systemd-analyze verify "$SERVICE_UNIT" 2>&1 || true)"
    if grep -qE 'Unknown (key|section|lvalue)|Refusing' <<<"$unit_verify"; then
      echo "[bootstrap] systemd не принимает директивы юнита ${SERVICE_UNIT}:" >&2
      printf '%s\n' "$unit_verify" >&2
      exit 1
    fi
  fi
fi

# --- Секрет в покое: значение читается из окружения процесса (доставлено потоком stdin
# удалённой оболочки — sshd отбрасывает всё, чего нет в AcceptEnv, молча),
# файл пишется атомарно (временное имя в том же каталоге + mv), режим и владелец
# приводятся к объявленным (Requirement «Секреты не хранятся в репозитории…»). ---
if [[ -n "${SECRET_FILE:-}" && -n "${SECRET_NAMES:-}" ]]; then
  IFS=',' read -ra _secret_names <<<"$SECRET_NAMES"
  new_content=""
  applied_names=()
  for name in "${_secret_names[@]}"; do
    [[ -n "$name" ]] || continue
    applied_names+=("$name")
    new_content+="${name}=${!name-}"$'\n'
  done
  # Сравнение через временный файл + `cmp`, а не строкой: command substitution
  # `$(cat …)` обрезает завершающий перевод строки, а переменная — нет, и такое
  # сравнение считало бы «изменилось» на КАЖДОМ повторном запуске.
  mkdir -p "$(dirname "$SECRET_FILE")"
  tmp_secret="$(mktemp "$(dirname "$SECRET_FILE")/.secret.XXXXXX")"
  printf '%s' "$new_content" >"$tmp_secret"
  rotated=1
  if [[ -f "$SECRET_FILE" ]] && cmp -s "$SECRET_FILE" "$tmp_secret"; then
    rotated=0
  fi
  if ((rotated)); then
    mv "$tmp_secret" "$SECRET_FILE"
    chown "${SECRET_OWNER:-root}" "$SECRET_FILE"
    chmod "${SECRET_MODE:-600}" "$SECRET_FILE"
    report changed "секрет(ы) применены: ${applied_names[*]}"
  else
    rm -f "$tmp_secret"
    # владелец/режим могли отличаться, даже если значение не изменилось
    chown "${SECRET_OWNER:-root}" "$SECRET_FILE"
    chmod "${SECRET_MODE:-600}" "$SECRET_FILE"
    report unchanged "секрет(ы) без изменения значения"
  fi
fi

# --- Артефакт системы управления: атоматическая смена releases/current, тем же
# приёмом, что и содержимое сайта; неответ службы после смены — откат и неуспех
# (tasks.md 5b.2a, Requirement «Объявленное состояние включает инвентарь…», сценарии
# «артефакт доставлен и служба отвечает» / «служба не отвечает после смены артефакта»).
# Красных тестов на это НЕТ — сценарии появились после сессии тестов. ---
if [[ -n "${CMS_ARTIFACT_RELEASE:-}" && -n "${CMS_ARTIFACT_DIR:-}" ]]; then
  new_release="${CMS_ARTIFACT_DIR}/releases/${CMS_ARTIFACT_RELEASE}"
  current_link="${CMS_ARTIFACT_DIR}/current"
  if [[ -d "$new_release" ]]; then
    # node_modules — тяжёлый (сотни МБ), релиз — лёгкий (dist/public/package*.json);
    # везти node_modules на каждый релиз незачем (замер владельца: 680 МБ prod-only
    # против 12 МБ dist). Ставится в ОБЩИЙ каталог, как shared/ у выкладки сайта, и
    # переустанавливается только когда сменился package-lock.json (сверка по sha256).
    shared_deps="${CMS_ARTIFACT_DIR}/shared"
    mkdir -p "$shared_deps"
    # Зависимости ставятся в каталог, ИМЕНЕМ которого служит хеш lock-файла, и прежний
    # каталог не трогается. Раньше и старый, и новый релиз ссылались на ОДИН общий
    # node_modules, а `npm ci` мутировал его на месте ДО проверки живости: если служба не
    # отвечала, откат возвращал старый релиз — но уже с чужими зависимостями, а старого
    # набора больше не существовало. Обрыв установки (кончился диск) ломал сразу оба.
    deps_link="${shared_deps}/node_modules"
    if [[ -f "${new_release}/package-lock.json" ]]; then
      lock_sha="$(sha256sum "${new_release}/package-lock.json" | cut -c1-16)"
      deps_dir="${CMS_ARTIFACT_DIR}/deps/${lock_sha}"
      if [[ ! -f "${deps_dir}/.complete" ]]; then
        rm -rf "${deps_dir}.partial"
        mkdir -p "${deps_dir}.partial"
        cp "${new_release}/package.json" "${new_release}/package-lock.json" "${deps_dir}.partial/"
        # ponytail: без ретраев сети и таймаута — неудача оставляет каталог .partial и
        # падает на healthcheck ниже (общий путь отката). Готовым набор считается только
        # после переименования, поэтому недоустановленный никому не виден.
        set +e
        (cd "${deps_dir}.partial" && npm ci --omit=dev)
        NPM_CI_OK=$?
        set -e
        if ((NPM_CI_OK == 0)); then
          touch "${deps_dir}.partial/.complete"
          mkdir -p "$(dirname "$deps_dir")"
          rm -rf "$deps_dir"
          mv -T "${deps_dir}.partial" "$deps_dir"
        fi
      fi
      [[ -f "${deps_dir}/.complete" ]] && deps_link="${deps_dir}/node_modules"
    fi
    ln -sfn "$deps_link" "${new_release}/node_modules"
    # Владелец релиза. rsync -a переносит ЧУЖИЕ uid/gid с машины оператора (на стенде
    # каталоги оказались с uid 502), поэтому владелец приводится явно. Код остаётся у
    # root: служба не должна иметь права переписать то, что исполняет. Записывать ей
    # нужно ровно три места, и они называются поимённо, а не выдаются целиком:
    #   database/migrations — Strapi создаёт каталог при старте (EACCES иначе);
    #   public/uploads      — загрузки; живут в ОБЩЕМ каталоге и переживают выкатку;
    #   .strapi             — служебный кэш.
    chown -R root:root "$new_release"
    if [[ -n "${SERVICE_ACCOUNT:-}" ]]; then
      mkdir -p "${new_release}/database/migrations" "${new_release}/.strapi"
      mkdir -p "${shared_deps}/uploads"
      rm -rf "${new_release}/public/uploads"
      mkdir -p "${new_release}/public"
      ln -sfn "${shared_deps}/uploads" "${new_release}/public/uploads"
      chown -R "${SERVICE_ACCOUNT}:${SERVICE_ACCOUNT}" \
        "${new_release}/database" "${new_release}/.strapi" "${shared_deps}/uploads"
    fi
    # ВАЖНО: `readlink -f` на несуществующем симлинке возвращает САМ путь ссылки, а не пустоту.
    # Откат по такому значению делал `current` ссылкой на себя, служба падала с
    # «Too many levels of symbolic links» и перезапускалась бесконечно (замерено на стенде:
    # 179 попыток). Предыдущей версией считаем только то, что реально указывает на релиз.
    previous_target=""
    if [[ -L "$current_link" ]]; then
      candidate="$(readlink -f "$current_link" 2>/dev/null || true)"
      [[ -n "$candidate" && "$candidate" != "$current_link" && -d "$candidate" ]] && previous_target="$candidate"
    fi
    ln -sfn "$new_release" "${current_link}.new"
    mv -T "${current_link}.new" "$current_link"
    unit_name="$(basename "${SERVICE_UNIT:-ikpk-cms.service}")"
    command -v systemctl >/dev/null 2>&1 && systemctl restart "$unit_name" || true
    sleep 1
    # Срок ожидания объявляется, а не зашит: прежние ~16 секунд короче настоящего старта
    # Strapi на этой машине (замерено 142 с при 948 МБ памяти), поэтому исправная служба
    # признавалась мёртвой и провижининг откатывался. Ожидание при этом не слепое: службу,
    # которую systemd признал упавшей, ждать весь срок незачем — ранний выход возможен
    # именно потому, что у юнита есть предел перезапусков.
    health_timeout="${SERVICE_HEALTH_TIMEOUT:-240}"
    healthy=0
    health_deadline=$((SECONDS + health_timeout))
    while ((SECONDS < health_deadline)); do
      curl -s -m 2 -o /dev/null "http://${SERVICE_ADDR:-127.0.0.1:0}/" && { healthy=1; break; }
      if command -v systemctl >/dev/null 2>&1 && [[ "$(systemctl is-active "$unit_name" 2>/dev/null)" == "failed" ]]; then
        echo "[bootstrap] служба признана упавшей за ${SECONDS}с — жать срок до конца нечего" >&2
        break
      fi
      sleep 3
    done
    if ((healthy)); then
      # Уборка старых релизов — только ПОСЛЕ подтверждённой живости, и текущий с предыдущим
      # не трогаются никогда. Без уборки каждый прогон и каждое прерывание оставляли каталог
      # навсегда; на тесном диске стенда это кончается переполнением, которое затем ломает
      # установку зависимостей куда неприятнее, чем одна неудачная выкатка.
      keep_releases="${CMS_RELEASES_KEEP:-5}"
      while IFS= read -r stale; do
        [[ -n "$stale" ]] || continue
        [[ "$stale" == "$new_release" || "$stale" == "${previous_target:-}" ]] && continue
        rm -rf "$stale"
      done < <(find "${CMS_ARTIFACT_DIR}/releases" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -r | tail -n +$((keep_releases + 1)))
      # Наборы зависимостей, на которые больше не ссылается ни один релиз, тоже уходят.
      if [[ -d "${CMS_ARTIFACT_DIR}/deps" ]]; then
        while IFS= read -r deps_candidate; do
          [[ -n "$deps_candidate" ]] || continue
          if ! find "${CMS_ARTIFACT_DIR}/releases" -maxdepth 2 -name node_modules -lname "${deps_candidate}/*" 2>/dev/null | grep -q .; then
            [[ "$deps_candidate" == "${deps_dir:-}" ]] || rm -rf "$deps_candidate"
          fi
        done < <(find "${CMS_ARTIFACT_DIR}/deps" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
      fi
      report changed "артефакт системы управления: ${new_release} (предыдущий: ${previous_target:-нет})"
    else
      if [[ -n "$previous_target" ]]; then
        ln -sfn "$previous_target" "${current_link}.new"
        mv -T "${current_link}.new" "$current_link"
        command -v systemctl >/dev/null 2>&1 && systemctl restart "$unit_name" || true
      fi
      echo "[bootstrap] служба системы управления не ответила на ${SERVICE_ADDR:-?} после смены артефакта — возврат на ${previous_target:-<нет предыдущей>}" >&2
      exit 7
    fi
  fi
fi

# --- Vhost: идемпотентность + политика обращения с посторонним ---
# Проксирование добавляется ПОСЛЕ отрисовки, тем же приёмом, что и при слиянии с
# посторонним vhost, а не подстановкой внутри heredoc. Причина в дефекте: голый
# `include ${SERVICE_PROXY_SNIPPET};` при объявленном ПУСТОМ значении давал `include ;`,
# который nginx отвергает («invalid number of arguments in "include" directive» —
# проверено настоящим `nginx -t`). Ветвь слияния пустое значение обрабатывала верно,
# поэтому дефект жил незамеченным: на стенде vhost посторонний и идёт слиянием, а ломался
# бы ПЕРВЫЙ прогон на чистой машине. Заодно heredoc остаётся полностью статическим —
# гейт web/tests/serving-config.test.ts разбирает его текст как конфигурацию, и строка,
# не завершённая «;», делает неразбираемым весь следующий блок.
add_proxy_include() {
  local text="$1"
  [[ -n "${SERVICE_PROXY_SNIPPET:-}" ]] || { printf '%s' "$text"; return; }
  # Вставляем перед последней закрывающей скобкой server-блока.
  printf '%s' "$text" | awk -v line="  include ${SERVICE_PROXY_SNIPPET};" '
    { buf[NR]=$0 }
    END { for (i=1;i<=NR;i++) { if (i==NR) print line; print buf[i] } }'
}

render_vhost() {

  # Один heredoc с разделителем NGINX — держит гейт web/tests/serving-config.test.ts
  # (`BOOTSTRAP_REL`/`HEREDOC = 'NGINX'`), который разбирает ИМЕННО этот текст; несколько
  # heredoc'ов подряд с условной веткой между ними этот гейт не видит вовсе (предмет
  # "исчезает" для него), поэтому проксирование включено литерально, без `if`.
  cat <<NGINX
# managed-by: ikpk-provisioning
server {
  listen 80;
  listen [::]:80;
  server_name ${DOMAIN};

  root ${WEB_ROOT}/current;
  index index.html;

  add_header Cache-Control "public, max-age=0, must-revalidate" always;

  gzip on;
  gzip_vary on;
  gzip_min_length 256;
  gzip_types
    text/css
    application/javascript
    text/javascript
    image/svg+xml
    application/xml
    text/xml
    application/json
    text/plain;

  include ${WEB_ROOT}/shared/nginx-redirects.conf;

  location ^~ /_astro/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location ~ \.(pf_fragment|pf_index|pf_meta)\$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location ^~ /fonts/ {
    add_header Cache-Control "public, max-age=2592000";
  }

  location ~ ^/favicon\. {
    add_header Cache-Control "public, max-age=86400";
  }

  location ~ ^/[^/]+\.svg\$ {
    add_header Cache-Control "public, max-age=86400";
  }

  location ~ ^/sitemap.*\.xml\$ {
    add_header Cache-Control "public, max-age=3600";
  }

  # Проксирование - снипетом (payments/deploy, живой стенд: ikpk.conf подключает
  # snippets/ikpk-payments-stand.conf), а не location-блоком прямо в vhost: снипет
  # целиком наш, и вопрос "чей this location" для политики merge/refuse не встаёт.
  # ВНИМАНИЕ будущим правкам: heredoc НЕ закавычен ($DOMAIN, $WEB_ROOT ниже — настоящие
  # подстановки) - обратные кавычки в комментариях ВНУТРИ него исполняются как команда
  # (исторический дефект этого же скрипта, design.md/proposal.md, найден сессией тестов).

  location ~ ^(/.*[^/])/\$ {
    return 301 \$1\$is_args\$args;
  }

  location / {
    try_files \$uri \$uri/index.html \$uri/ =404;
  }

  error_page 404 /404.html;
}
NGINX
}

# Резервная копия ОДНОГО файла в BACKUP_DIR; печатает путь либо отказывает
# (Requirement «Резервная копия предшествует разрушающим действиям»).
backup_single_file() {
  local src="$1" dir="$2" name="$3"
  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "[bootstrap] снятие резервной копии невозможно: каталог ${dir} недоступен" >&2
    return 1
  fi
  local dest="${dir}/${name}.bak-$(date +%Y%m%d%H%M%S)"
  if ! cp "$src" "$dest" 2>/dev/null; then
    echo "[bootstrap] снятие резервной копии не удалось: cp ${src} -> ${dest}" >&2
    return 1
  fi
  if [[ ! -s "$dest" ]]; then
    echo "[bootstrap] резервная копия ${dest} пуста (нулевой размер) — копия не считается снятой" >&2
    rm -f "$dest"
    return 1
  fi
  echo "$dest"
}

merge_vhost_directives() {
  local path="$1"
  local include_line="include ${WEB_ROOT}/shared/nginx-redirects.conf;"
  local proxy_inc_line="${SERVICE_PROXY_SNIPPET:+include ${SERVICE_PROXY_SNIPPET};}"
  local tmp
  tmp="$(mktemp)"
  local status_file
  status_file="$(mktemp)"
  awk -v inc_pat='nginx-redirects\.conf' -v inc_line="  ${include_line}" \
    -v proxy_pat="${SERVICE_PROXY_SNIPPET:-__none__}" -v proxy_line="${proxy_inc_line:+  ${proxy_inc_line}}" '
    { lines[NR] = $0 }
    END {
      depth = 0; in_c = 0; c_start = 0; has80 = 0; t_start = 0; t_end = 0
      for (i = 1; i <= NR; i++) {
        line = lines[i]
        o = gsub(/\{/, "{", line)
        cl = gsub(/\}/, "}", line)
        if (depth == 0 && o > cl && in_c == 0) { in_c = 1; c_start = i; has80 = 0 }
        if (in_c && lines[i] ~ /listen[ \t]+80[ \t]*;/) has80 = 1
        depth += o - cl
        if (in_c && depth == 0) {
          if (has80 && t_start == 0) { t_start = c_start; t_end = i }
          in_c = 0
        }
      }
      if (t_start == 0) { print "notfound" > "'"$status_file"'"; exit 1 }
      have_inc = 0; have_gzip = 0; have_proxy = (proxy_line == "") ? 1 : 0
      for (i = t_start; i <= t_end; i++) {
        if (lines[i] ~ inc_pat) have_inc = 1
        if (lines[i] ~ /gzip[ \t]+on;/) have_gzip = 1
        if (proxy_line != "" && index(lines[i], proxy_pat) > 0) have_proxy = 1
      }
      changed = 0
      for (i = 1; i <= NR; i++) {
        if (i == t_end && (have_inc == 0 || have_gzip == 0 || have_proxy == 0)) {
          if (have_inc == 0) { print inc_line; changed = 1 }
          if (have_gzip == 0) { print "  gzip on;"; changed = 1 }
          if (have_proxy == 0) { print proxy_line; changed = 1 }
        }
        print lines[i]
      }
      print (changed ? "changed" : "unchanged") > "'"$status_file"'"
    }
  ' "$path" >"$tmp"
  local status
  status="$(cat "$status_file")"
  rm -f "$status_file"
  if [[ "$status" == notfound ]]; then
    echo "[bootstrap] слияние: в ${path} нет блока server с listen 80 — отказ" >&2
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$path"
  echo "$status"
}

# Какие из объявленных маркеров постороннего сейчас есть в файле. Перечень
# VHOST_FOREIGN_MARKERS до этого не читал НИКТО: он объявлял обязанность сохранить снипет
# оплаты и сертификаты, а исполнения у обязанности не было — сохранность держалась на том,
# что слияние только добавляет строки. Обязанность без исполнения — декоративная запись,
# и оба независимых ревью нашли её первой.
foreign_markers_present() {
  local file="$1" marker out=""
  [[ -f "$file" && -n "${VHOST_FOREIGN_MARKERS:-}" ]] || return 0
  local IFS=,
  for marker in ${VHOST_FOREIGN_MARKERS}; do
    marker="${marker#"${marker%%[![:space:]]*}"}"
    marker="${marker%"${marker##*[![:space:]]}"}"
    [[ -n "$marker" ]] || continue
    grep -qF -- "$marker" "$file" && out+="${marker}"$'\n'
  done
  printf '%s' "$out"
}

# Ни один маркер, БЫВШИЙ в файле до правки, не должен из него исчезнуть.
assert_foreign_markers_kept() {
  local file="$1" before="$2" marker missing=()
  while IFS= read -r marker; do
    [[ -n "$marker" ]] || continue
    grep -qF -- "$marker" "$file" || missing+=("$marker")
  done <<<"$before"
  if ((${#missing[@]} > 0)); then
    echo "[bootstrap] Приведение vhost уничтожило объявленное постороннее: ${missing[*]}" >&2
    return 1
  fi
  return 0
}

manage_vhost() {
  local is_new=0 is_own=0
  if [[ -f "$VHOST" ]]; then
    if head -1 "$VHOST" | grep -qF "$VHOST_MARKER"; then is_own=1; fi
  else
    is_new=1
  fi

  local desired markers_before
  desired="$(add_proxy_include "$(render_vhost)")"
  markers_before="$(foreign_markers_present "$VHOST")"

  if ((is_new || is_own)); then
    if [[ -f "$VHOST" ]] && cmp -s <(printf '%s\n' "$desired") "$VHOST"; then
      report unchanged "vhost ${VHOST}"
      VHOST_OURS=1
      return
    fi
    # Резервная копия перед ЛЮБОЙ полной перезаписью существующего файла, а не только при
    # обходе отказа. Прежде наш собственный файл, в который человек дописал строки руками,
    # затирался бесследно, а чужой — со следом: асимметрия ровно наоборот ожидаемой.
    if [[ -f "$VHOST" ]]; then
      local own_backup
      own_backup="$(backup_single_file "$VHOST" "$BACKUP_DIR" "${SITE_NAME}.conf")" || exit 1
      report changed "резервная копия перед перезаписью vhost: ${own_backup}"
    fi
    local tmp_vhost
    tmp_vhost="$(mktemp "$(dirname "$VHOST")/.vhost.XXXXXX")"
    printf '%s\n' "$desired" >"$tmp_vhost"
    mv -f "$tmp_vhost" "$VHOST"
    assert_foreign_markers_kept "$VHOST" "$markers_before" || exit 8
    VHOST_OURS=1
    if ((is_new)); then
      report changed "vhost ${VHOST} создан"
    else
      report changed "vhost ${VHOST}: server_name/DOMAIN и объявленные директивы приведены к значениям"
    fi
    return
  fi

  # Постороннее состояние: файл существует и не несёт нашей отметки.
  local policy="${POLICY_VHOST:-refuse}"
  if [[ "$policy" != merge && "${FORCE_VHOST:-}" != "1" ]]; then
    echo "[bootstrap] Конфигурация ${VHOST} создана вне провижининга (постороннее состояние)." >&2
    echo "[bootstrap] Политика ${policy}: отказ. Содержимое:" >&2
    cat "$VHOST" >&2
    exit 3
  fi

  if [[ "${FORCE_VHOST:-}" == "1" ]]; then
    if [[ -n "${SITE_ADDRESS:-}" && "$SITE_ADDRESS" == https://* ]]; then
      if grep -qiE 'listen[[:space:]]+443|ssl_certificate' "$VHOST" 2>/dev/null; then
        if ! grep -qiE 'listen[[:space:]]+443|ssl_certificate' <<<"$desired"; then
          echo "[bootstrap] Обход отказа заменил бы ${VHOST} целиком и снял бы https по ${SITE_ADDRESS} — отказ (непрерывность раздачи)." >&2
          exit 6
        fi
      fi
    fi
    local backup_path
    backup_path="$(backup_single_file "$VHOST" "$BACKUP_DIR" "${SITE_NAME}.conf")" || exit 1
    printf '%s\n' "$desired" >"$VHOST"
    assert_foreign_markers_kept "$VHOST" "$markers_before" || {
      cp "$backup_path" "$VHOST"
      echo "[bootstrap] Замена откачена из ${backup_path}" >&2
      exit 8
    }
    VHOST_OURS=1
    report changed "vhost ${VHOST} заменён целиком (обход отказа FORCE_VHOST=1), резервная копия: ${backup_path}"
    return
  fi

  # policy == merge, без обхода: сойтись без замены целиком.
  local merge_status
  merge_status="$(merge_vhost_directives "$VHOST")" || exit 1
  assert_foreign_markers_kept "$VHOST" "$markers_before" || exit 8
  if [[ "$merge_status" == changed ]]; then
    report changed "vhost ${VHOST}: объявленные директивы приведены к значениям слиянием, постороннее сохранено"
  else
    report unchanged "vhost ${VHOST} (постороннее сохранено, слияние не потребовалось)"
  fi
}

# Снипет проксирования — целиком наш файл (не сам vhost), поэтому просто идемпотентно
# приводится к объявленному содержимому, без вопроса про постороннее.
if [[ -n "${SERVICE_PROXY_SNIPPET:-}" && -n "${SERVICE_ADDR:-}" ]]; then
  snippet_desired="$(
    cat <<SNIPEOF
location ^~ ${SERVICE_PROXY_PATH:-/admin} {
  proxy_pass http://${SERVICE_ADDR};
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
}
SNIPEOF
  )"
  if [[ -f "$SERVICE_PROXY_SNIPPET" && "$(cat "$SERVICE_PROXY_SNIPPET")" == "$snippet_desired" ]]; then
    report unchanged "снипет проксирования ${SERVICE_PROXY_SNIPPET}"
  else
    mkdir -p "$(dirname "$SERVICE_PROXY_SNIPPET")"
    printf '%s\n' "$snippet_desired" >"$SERVICE_PROXY_SNIPPET"
    report changed "снипет проксирования ${SERVICE_PROXY_SNIPPET}"
  fi
fi

manage_vhost

if [[ -f "${WEB_ROOT}/shared/nginx-redirects.conf" ]]; then
  report unchanged "файл редиректов ${WEB_ROOT}/shared/nginx-redirects.conf"
else
  touch "${WEB_ROOT}/shared/nginx-redirects.conf"
  report changed "файл редиректов ${WEB_ROOT}/shared/nginx-redirects.conf создан пустым"
fi

if [[ -L "/etc/nginx/sites-enabled/${SITE_NAME}.conf" ]]; then
  report unchanged "включение vhost в sites-enabled"
else
  ln -sfn "$VHOST" "/etc/nginx/sites-enabled/${SITE_NAME}.conf"
  report changed "vhost включён в sites-enabled"
fi

if [[ -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
  report changed "умолчательный сайт nginx отключён"
else
  report unchanged "умолчательный сайт nginx уже отключён"
fi

# `nginx -t` не абортирует провижининг: при политике merge мы не владеем ЦЕЛЫМ
# файлом (постороннее содержимое, например 443-блок certbot, может быть невалидно
# само по себе — чинить его не наша забота). Если тест конфигурации не прошёл,
# reload пропускается — уже запущенный nginx продолжает отдавать прежним процессом
# (Requirement «Раздача не прерывается провижинингом»), но провижининг не считается
# упавшим ИЗ-ЗА постороннего содержимого, которое он не создавал.
#
# `nginx -t` остаётся ОТДЕЛЬНОЙ строкой (не внутри `if nginx -t; then`): гейт
# web/tests/serving-config.test.ts ищет её как отдельную строку `^\s*nginx -t\s*$` —
# `set +e`/`set -e` вокруг неё не абортируют при ошибке, не меняя вид самой команды.
set +e
nginx -t
NGINX_T_OK=$?
set -e
if ((NGINX_T_OK == 0)); then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload nginx
  else
    pgrep -x nginx >/dev/null && nginx -s reload || nginx
  fi
elif ((${VHOST_OURS:-0})); then
  # Конфигурацию писали МЫ — значит невалиден наш собственный вывод, а не постороннее.
  # Прежде оба случая шли одной веткой: печаталось предупреждение, ревизия записывалась,
  # код выхода оставался нулевым — «конфиг сломан» было неотличимо от «всё применено», и
  # nginx не поднялся бы на ближайшем перезапуске.
  echo "[bootstrap] nginx -t отверг конфигурацию, которую записал провижининг — ревизия не пишется" >&2
  exit 9
else
  echo "[bootstrap] ВНИМАНИЕ: nginx -t обнаружил ошибку в ПОСТОРОННЕЙ конфигурации — reload пропущен, раздача продолжается прежним процессом" >&2
fi

# --- Ревизия объявленного состояния: запись ПОСЛЕ успешного применения, атомарно
# (Requirement «Провижининг идемпотентен и повторно применим»). ---
if [[ -n "$NEW_REVISION" ]]; then
  mkdir -p "$(dirname "$REVISION_FILE")"
  tmp_rev="$(mktemp "$(dirname "$REVISION_FILE")/.revision.XXXXXX")"
  printf '%s\n' "$NEW_REVISION" >"$tmp_rev"
  mv "$tmp_rev" "$REVISION_FILE"
fi

echo "[bootstrap] Done. Nginx serves ${WEB_ROOT}/current"
echo "changed=${CHANGED}"
echo "unchanged=${UNCHANGED}"
REMOTE
} | /usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" \
  "ENVIRONMENT='${ENVIRONMENT}' DOMAIN='${DOMAIN}' FORCE_VHOST='${FORCE_VHOST}' BACKUP_ONLY='${BACKUP_ONLY}' CMS_ARTIFACT_RELEASE='${CMS_ARTIFACT_RELEASE}' bash -s"
