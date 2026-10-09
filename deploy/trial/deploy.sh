#!/usr/bin/env bash
# Пробная машина: ЕДИНАЯ точка входа с машины владельца (Mac). Ведёт оператора по этапам,
# не дублируя bootstrap-vps.sh и серверные скрипты пробы, а вызывая их.
#
#   deploy/trial/deploy.sh                 # справка; ничего не делает
#   deploy/trial/deploy.sh preflight       # только чтение: проверки здесь и на сервере
#   deploy/trial/deploy.sh plan            # только чтение: что `run` сделает, а что пропустит
#   deploy/trial/deploy.sh run             # ИЗМЕНЯЕТ сервер: ведёт по этапам до ручной остановки
#   deploy/trial/deploy.sh <этап>          # один этап (с предварительным preflight):
#                                          #   prepare | bootstrap | import | publish | https | verify | backup
#   deploy/trial/deploy.sh secrets|hostkey [--trust]|superadmin|tunnel|forget
#
# Конфигурация — переменными окружения (значения секретов здесь не принимаются):
#   SSH_KEY — ОБЯЗАТЕЛЕН, умолчания нет (чтобы не пробовать неожиданный ключ на новой машине)
#   VPS_IP (89.111.143.219)   STATE_DIR (~/ikpk-trial)
#   SECRETS_FILE ($STATE_DIR/secrets.env)   EXPECTED_HOST_FINGERPRINT (SHA256:… из консоли провайдера)
#   STRAPI_API_TOKEN_FILE ($STATE_DIR/api-token, права 0600)  либо STRAPI_API_TOKEN  либо ввод без эха
#   LOCAL_PORT (13370)  MIN_FREE_MB (6000)
#
# Коды выхода: 0 — готово; 1 — этап не удался; 2 — предпроверка/использование (изменений не было);
# 10 — ОСТАНОВКА ДЛЯ РУЧНОГО ДЕЙСТВИЯ: сообщение называет точную команду продолжения.
#
# Повторный запуск идёт от НАБЛЮДАЕМОГО состояния сервера (SHA дерева сборки, служба, super-admin,
# release.json, сертификат, копии), а не от памяти клиента: пересозданная машина распознаётся сама.
# Клиентская память (STATE_DIR/deploy.state) хранит одно: отпечаток файла секретов на момент
# первого развёртывания. Отметки «импорт выполнен» нет намеренно: она переживала пересоздание машины
# с тем же IP, и первый выпуск падал на пустой CMS. Пока на сервере нет release.json, импорт
# повторяется (он идемпотентен по legacy_id).
#
# Секреты: значения не печатаются и не попадают в argv. Файл секретов читается подоболочкой только для
# bootstrap-vps.sh; токен API идёт в окружение дочернего процесса и в `curl -K -` через stdin.
# Не делает: DNS, реальную оплату и CRM (режим пробы задан в deploy/environments/trial.env),
# создание super-admin и токена (это делает человек: `superadmin` — интерактивный
# ввод через службы Strapi, токен выпускается в панели).
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
VPS_IP="${VPS_IP:-89.111.143.219}"
SSH_KEY="${SSH_KEY:-}"
STATE_DIR="${STATE_DIR:-$HOME/ikpk-trial}"
SECRETS_FILE="${SECRETS_FILE:-$STATE_DIR/secrets.env}"
STATE_FILE="${STATE_DIR}/deploy.state"
KNOWN_HOSTS="${KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
LOCAL_PORT="${LOCAL_PORT:-13370}"
MIN_FREE_MB="${MIN_FREE_MB:-6000}"
REMOTE_BIN="/opt/ikpk-trial/bin"
BOOTSTRAP_SCRIPT="${BOOTSTRAP_SCRIPT:-$ROOT/scripts/bootstrap-vps.sh}"
ARTIFACT_SCRIPT="${ARTIFACT_SCRIPT:-$ROOT/scripts/build-cms-artifact.sh}"
TRIAL_ENV="$ROOT/deploy/environments/trial.env"
SERVER_SCRIPTS=(prepare-host.sh setup-https-ip.sh refresh-site.sh backup-exercise.sh create-super-admin.cjs)

SELF="deploy/trial/deploy.sh"
SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${KNOWN_HOSTS}" -o ConnectTimeout=15)
TUNNEL_PID=""
SHA=""
PROBE=""

say() { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] ! %s\n' "$*" >&2; }
die() { local code="$1"; shift; printf '[deploy] %s\n' "$*" >&2; exit "$code"; }
cleanup() { [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true; }
trap cleanup EXIT

rssh() { ssh "${SSH_OPTS[@]}" "root@${VPS_IP}" "$@"; }
perm_of() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }
sha256_of() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1; }
resume_cmd() {
  local env=""
  [[ "$VPS_IP" != "89.111.143.219" ]] && env+="VPS_IP=${VPS_IP} "
  env+="SSH_KEY=${SSH_KEY} "
  printf '%s%s %s' "$env" "$SELF" "$1"
}

# --- клиентская память (только то, чего с сервера не увидеть) ---
state_get() { [[ -f "$STATE_FILE" ]] && awk -F= -v k="$1@${VPS_IP}" '$1==k{sub(/^[^=]*=/,""); print; exit}' "$STATE_FILE" || true; }
state_set() {
  mkdir -p "$STATE_DIR"; local tmp; tmp="$(mktemp "${STATE_DIR}/.state.XXXXXX")"
  { [[ -f "$STATE_FILE" ]] && grep -v -F -- "$1@${VPS_IP}=" "$STATE_FILE" || true; printf '%s@%s=%s\n' "$1" "$VPS_IP" "$2"; } >"$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$STATE_FILE"
}

# --- предпроверка на клиенте ---
PRE_FAILS=0
fail() { warn "$1"; PRE_FAILS=$((PRE_FAILS + 1)); }

preflight_local() {
  local c
  for c in git ssh ssh-keygen tar curl node npm; do
    command -v "$c" >/dev/null || fail "нет команды: ${c}"
  done
  command -v shasum >/dev/null || command -v sha256sum >/dev/null || fail "нет shasum/sha256sum"
  [[ "$VPS_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "VPS_IP не IPv4: ${VPS_IP}"

  if SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" && [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
    if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] \
      || [[ -n "$(git -C "$ROOT" status --porcelain -- web media-originals cms/src)" ]]; then
      fail "дерево не чистое: SHA ${SHA} нельзя записывать в релиз (закоммитьте или откатите изменения)"
    fi
  else
    fail "не удалось прочитать SHA из ${ROOT}"
  fi

  if [[ -z "$SSH_KEY" ]]; then
    fail "SSH_KEY не задан: умолчания нет намеренно, укажите ключ, авторизованный у root на этой машине"
  elif [[ ! -r "$SSH_KEY" ]]; then
    fail "нет читаемого ключа SSH: ${SSH_KEY}"
  fi
  if [[ -f "$SECRETS_FILE" ]]; then
    [[ "$(perm_of "$SECRETS_FILE")" == "600" ]] || fail "права ${SECRETS_FILE} должны быть 600"
    local names n
    names="$(sed -n 's/^SECRET_NAMES=//p' "$TRIAL_ENV" | tail -1)"
    IFS=',' read -ra arr <<<"$names"
    for n in "${arr[@]}"; do
      grep -q "^${n}=." "$SECRETS_FILE" || fail "в файле секретов нет значения ${n}"
    done
  else
    fail "нет файла секретов ${SECRETS_FILE}: выполните  ${SELF} secrets"
  fi
  [[ -f "$ROOT/cms/package-lock.json" ]] || fail "нет cms/package-lock.json: артефакт CMS собирается по lockfile"

  if ssh-keygen -F "$VPS_IP" -f "$KNOWN_HOSTS" >/dev/null 2>&1; then
    local fps
    fps="$(ssh-keygen -lF "$VPS_IP" -f "$KNOWN_HOSTS" 2>/dev/null | grep -o 'SHA256:[^ ]*' | sort -u | tr '\n' ' ')"
    say "ключ хоста в known_hosts: ${fps}"
    if [[ -n "${EXPECTED_HOST_FINGERPRINT:-}" && "$fps" != *"${EXPECTED_HOST_FINGERPRINT}"* ]]; then
      fail "отпечаток в known_hosts не совпадает с EXPECTED_HOST_FINGERPRINT: стоп"
    fi
  else
    fail "ключа хоста ${VPS_IP} нет в ${KNOWN_HOSTS}: сверьте отпечаток с консолью провайдера и выполните  ${SELF} hostkey --trust  (с EXPECTED_HOST_FINGERPRINT)"
  fi
}

# --- наблюдаемое состояние сервера: один вызов, только чтение ---
read -r -d '' PROBE_SCRIPT <<'EOF' || true
. /etc/os-release
echo "os=${ID}-${VERSION_ID}"
echo "arch=$(uname -m)"
echo "free_mb=$(df -Pm / | awk 'NR==2{print $4}')"
if swapon --show=NAME --noheadings 2>/dev/null | grep -qx /swapfile; then echo swap=on; else echo swap=off; fi
if [ -x /opt/ikpk-trial/bin/refresh-site.sh ]; then echo scripts=yes; else echo scripts=no; fi
if [ -s /etc/ikpk-cms/trial.env ]; then echo secrets=yes; else echo secrets=no; fi
echo "source_commit=$({ tr -d '[:space:]' </var/lib/ikpk-site-build/.source-commit; } 2>/dev/null || true)"
echo "cms=$(systemctl is-active ikpk-cms 2>/dev/null || true)"
echo "admin=$(curl -fsS --max-time 5 http://127.0.0.1:1337/admin/init 2>/dev/null | grep -o '"hasAdmin":[a-z]*' | cut -d: -f2 || true)"
echo "release_commit=$(curl -fsS --max-time 5 http://127.0.0.1/release.json 2>/dev/null | grep -o '[0-9a-f]\{40\}' | head -1 || true)"
if [ -s /etc/letsencrypt/live/ikpk-trial/fullchain.pem ]; then echo cert=yes; else echo cert=no; fi
if ls /var/backups/ikpk-trial/restic/snapshots 2>/dev/null | grep -q .; then echo backup=yes; else echo backup=no; fi
EOF

probe() { PROBE="$(rssh bash -s <<<"$PROBE_SCRIPT")" || die 2 "сервер недоступен по SSH (ключ, сеть, отпечаток хоста): изменений не было"; }
fact() { sed -n "s/^$1=//p" <<<"$PROBE" | head -1; }

preflight_remote() {
  probe
  local os arch free cms
  os="$(fact os)"; arch="$(fact arch)"; free="$(fact free_mb)"; cms="$(fact cms)"
  say "сервер: ${os} ${arch}, свободно ${free} МБ, swap=$(fact swap), служба CMS=${cms:-нет}"
  [[ "$os" == "ubuntu-26.04" && "$arch" == "x86_64" ]] || fail "ожидается ubuntu-26.04 x86_64, а здесь ${os} ${arch}"
  local need="$MIN_FREE_MB"; [[ "$cms" == "active" ]] && need=1000
  [[ "${free:-0}" =~ ^[0-9]+$ && "$free" -ge "$need" ]] || fail "мало места: ${free:-?} МБ, нужно ≥ ${need}"
}

preflight() {
  PRE_FAILS=0
  preflight_local
  # Сервер опрашиваем, только если локально всё в порядке: SSH с неверным ключом/хостом бессмыслен.
  if [[ "$PRE_FAILS" == 0 ]]; then preflight_remote; fi
  if [[ "$PRE_FAILS" != 0 ]]; then die 2 "предпроверка не пройдена (${PRE_FAILS}): изменений не было"; fi
  say "предпроверка пройдена, SHA ${SHA}"
}

# --- решения по наблюдаемому состоянию ---
need_bootstrap() { [[ "$(fact source_commit)" != "$SHA" || "$(fact cms)" != "active" || "$(fact secrets)" != "yes" ]]; }
need_import() { [[ -z "$(fact release_commit)" ]]; }
need_publish() { [[ "$(fact release_commit)" != "$SHA" ]]; }

show_plan() {
  say "план для ${VPS_IP}, SHA ${SHA}:"
  say "  1 prepare    — доставит скрипты в ${REMOTE_BIN}, swap (идемпотентно): всегда"
  if need_bootstrap; then say "  2 bootstrap  — сделает (дерево на сервере: '$(fact source_commit)', служба: '$(fact cms)')"; else say "  2 bootstrap  — пропуск (SHA и служба уже на месте)"; fi
  if token_available || ! need_import; then say "  3 token      — не требуется или токен уже есть"; else say "  3 token      — ОСТАНОВКА: нужны super-admin и токен Full access (ручной шаг, код 10)"; fi
  if need_import; then say "  4 import     — сделает (на сервере нет release.json; импорт идемпотентен)"; else say "  4 import     — пропуск"; fi
  if need_publish; then say "  5 publish    — сделает (релиз: '$(fact release_commit)')"; else say "  5 publish    — пропуск (релиз на этом SHA)"; fi
  if [[ "$(fact cert)" == "yes" ]]; then say "  6 https      — пропуск (сертификат есть)"; else say "  6 https      — сделает"; fi
  say "  7 verify     — всегда (только чтение)"
  if [[ "$(fact backup)" == "yes" ]]; then say "  8 backup     — пропуск (копия есть; принудительно: ${SELF} backup)"; else say "  8 backup     — сделает (упражнение, не вне VPS)"; fi
}

# --- этапы ---
deliver_scripts() {
  COPYFILE_DISABLE=1 tar -C "$ROOT/deploy/trial" -cf - "${SERVER_SCRIPTS[@]}" \
    | rssh "install -d -o root -g root -m 0755 ${REMOTE_BIN} && tar -C ${REMOTE_BIN} --no-same-owner -xf - && chown -R root:root ${REMOTE_BIN} && chmod 0755 ${REMOTE_BIN}/*.sh"
}

stage_prepare() {
  say "prepare: доставка скриптов в ${REMOTE_BIN} и подготовка хоста"
  deliver_scripts
  rssh "${REMOTE_BIN}/prepare-host.sh"
}

stage_bootstrap() {
  local now prev art
  now="$(sha256_of "$SECRETS_FILE")"; prev="$(state_get secrets_sha256)"
  if [[ -n "$prev" && "$prev" != "$now" && "$(fact secrets)" == "yes" ]]; then
    die 2 "файл секретов изменился после первого развёртывания: смена секретов ломает вход и шифрованные поля CMS. Верните прежний файл или пересоздайте машину и выполните  ${SELF} forget"
  fi
  if [[ ! -d "$ROOT/cms/node_modules" ]]; then
    say "bootstrap: cms/node_modules нет — npm ci по lockfile (несколько минут)"
    (cd "$ROOT/cms" && npm ci)
  fi
  art="${TMPDIR:-/tmp}/ikpk-cms-artifact-trial-${SHA:0:8}"
  say "bootstrap: артефакт CMS → ${art}"
  "$ARTIFACT_SCRIPT" "$art"
  say "bootstrap: доставка и установка (долго: npm ci ≈ 20 мин, старт Strapi 8–14 мин на 1 ГБ)"
  (
    set -a
    # shellcheck disable=SC1090
    . "$SECRETS_FILE"
    set +a
    ENVIRONMENT=trial DOMAIN="$VPS_IP" SSH_KEY="$SSH_KEY" CMS_ARTIFACT_SOURCE="$art" \
      exec bash "$BOOTSTRAP_SCRIPT" "$VPS_IP"
  )
  state_set secrets_sha256 "$now"
}

stop_register() {
  cat >&2 <<MSG
[deploy] СТОП (код 10): нет токена API Full access — его создаёт человек в панели Strapi.
  Важно: учётная запись редактора контента (из secrets.env) создаётся CMS при старте, поэтому форма
  регистрации первого администратора на /admin НЕ появится, а редактор не может выпускать токены.
  1. Создать super-admin штатной командой Strapi (интерактивно: пароль вводится в терминале, не в аргументах):
       $(resume_cmd superadmin)
  2. Отдельное окно терминала, держать открытым:   $(resume_cmd tunnel)
  3. Браузер: http://127.0.0.1:${LOCAL_PORT}/admin → войти этим super-admin →
     Settings → API Tokens → Create new API Token, Token type = Full access → скопировать значение.
  4. Сохранить токен без показа на экране:
       ( umask 077; mkdir -p "${STATE_DIR}"; read -rs -p 'токен: ' t; printf '%s' "\$t" > "${STATE_DIR}/api-token" )
     (или export STRAPI_API_TOKEN в этом терминале, или ввести при запросе).
  5. Продолжить с безопасной точки:                  $(resume_cmd run)
MSG
  exit 10
}

token_available() { [[ -n "${STRAPI_API_TOKEN:-}" || -f "${STRAPI_API_TOKEN_FILE:-${STATE_DIR}/api-token}" ]]; }

get_token() {
  local f="${STRAPI_API_TOKEN_FILE:-${STATE_DIR}/api-token}" t=""
  if [[ -n "${STRAPI_API_TOKEN:-}" ]]; then t="$STRAPI_API_TOKEN"
  elif [[ -f "$f" ]]; then
    [[ "$(perm_of "$f")" =~ ^[46]00$ ]] || die 2 "права ${f} должны быть 600 или 400"
    t="$(tr -d '[:space:]' <"$f")"
  elif { true </dev/tty; } 2>/dev/null; then
    printf '[deploy] Full Access API token (ввод не отображается): ' >&2
    read -rs t </dev/tty || true; echo >&2
  fi
  t="$(printf '%s' "$t" | tr -d '[:space:]')"
  [[ -n "$t" ]] || stop_register
  printf '%s' "$t"
}

open_tunnel() {
  ssh "${SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -N -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:1337" "root@${VPS_IP}" &
  TUNNEL_PID=$!
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${LOCAL_PORT}/_health" 2>/dev/null && return 0
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  die 1 "туннель на 127.0.0.1:${LOCAL_PORT} не поднялся (порт занят? служба CMS не отвечает?)"
}

stage_import() {
  local token code
  token="$(get_token)"
  say "import: туннель и проверка токена"
  open_tunnel
  # Заголовок идёт через stdin конфигурации curl, а не через argv.
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$token" \
    | curl -s -o /dev/null -w '%{http_code}' -K - "http://127.0.0.1:${LOCAL_PORT}/api/institutes" || true)"
  [[ "$code" == "200" ]] || die 1 "токен не принят (HTTP ${code:-нет ответа}): нужен токен типа Full access, создайте заново и повторите  $(resume_cmd run)"
  say "import: токен принят; сухой прогон, затем настоящий импорт (discovery/entities)"
  (
    cd "$ROOT/scripts"
    [[ -d node_modules ]] || npm ci
    export STRAPI_URL="http://127.0.0.1:${LOCAL_PORT}" STRAPI_API_TOKEN="$token"
    npm run import:dry
    npm run import
  )
  say "import: готово. Удалите временный токен в панели CMS и локальный файл ${STATE_DIR}/api-token"
  cleanup; TUNNEL_PID=""
}

stage_publish() {
  say "publish: первый/очередной выпуск сайта (съём → сборка → переключение → сверка); замеры времени и памяти ниже"
  rssh "${REMOTE_BIN}/refresh-site.sh"
}

stage_https() { say "https: сертификат по IP и :443"; rssh "${REMOTE_BIN}/setup-https-ip.sh ${VPS_IP}"; }

stage_verify() {
  local rel code
  rel="$(curl -fsS --max-time 20 "http://${VPS_IP}/release.json")" || die 1 "verify: http://${VPS_IP}/release.json недоступен (первый выпуск не сделан?)"
  grep -q "$SHA" <<<"$rel" || die 1 "verify: commit в release.json не равен ${SHA}"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://${VPS_IP}/" || true)"
  [[ "$code" == "200" ]] || die 1 "verify: http://${VPS_IP}/ отвечает ${code:-нет ответа}"
  say "verify: HTTP — release.json на ${SHA}, главная 200"
  probe
  if [[ "$(fact cert)" == "yes" ]]; then
    curl -fsS --max-time 20 "https://${VPS_IP}/release.json" | grep -q "$SHA" \
      || die 1 "verify: https://${VPS_IP}/release.json не отвечает с доверенным сертификатом (без -k) или commit другой"
    say "verify: HTTPS — сертификат принят без -k"
  else
    warn "verify: сертификата нет, HTTPS не проверен"
  fi
}

stage_backup() {
  say "backup: упражнение копия → восстановление (на этом же диске, НЕ вне VPS)"
  rssh "${REMOTE_BIN}/backup-exercise.sh backup"
  rssh "${REMOTE_BIN}/backup-exercise.sh verify"
}

final_notes() {
  cat <<MSG
[deploy] ГОТОВО (проба, не production): http(s)://${VPS_IP}/ на SHA ${SHA}. DNS не менялся.
[deploy] Остаётся ручным: сценарий редактора в панели (https://${VPS_IP}/admin: семинар → «Обновить сайт»);
         копия вне VPS (rsync репозитория и ключа restic, docs/runbook-trial-vps.md п. 11);
         удаление временного API-токена; решения владельца: RAM, хранилище копий, режим оплаты.
MSG
}

cmd_run() {
  preflight; show_plan
  stage_prepare
  if need_bootstrap; then stage_bootstrap; probe; fi
  if need_import; then stage_import; fi
  if need_publish; then stage_publish; probe; fi
  if [[ "$(fact cert)" != "yes" ]]; then stage_https; fi
  stage_verify
  [[ "$(fact backup)" == "yes" ]] || stage_backup
  final_notes
}

cmd_stage() { # имя
  preflight
  case "$1" in
    prepare) stage_prepare ;;
    bootstrap) stage_bootstrap ;;
    import) stage_import ;;
    publish) stage_publish ;;
    https) stage_https ;;
    verify) stage_verify ;;
    backup) stage_backup ;;
  esac
}

usage() { sed -n '2,/^set -e/{/^set -e/!p;}' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

cmd="${1:-help}"
case "$cmd" in
  help|-h|--help) usage ;;
  preflight) preflight ;;
  plan) preflight; show_plan; say "это только план: изменений не было" ;;
  run) cmd_run ;;
  prepare|bootstrap|import|publish|https|verify|backup) cmd_stage "$cmd" ;;
  superadmin)
    [[ -n "$SSH_KEY" ]] || die 2 "SSH_KEY не задан"
    say "создание super-admin: те же службы Strapi, что у admin:create-user, но из собранного артефакта"
    say "(штатная admin:create-user вызывает tsc и на артефакте без TS-исходников падает с TS18003)"
    deliver_scripts
    # Окружение должно совпадать с юнитом ikpk-cms.service; секреты приходят из его EnvironmentFile,
    # а не через argv. Работающая служба не останавливается; второй процесс порт не слушает.
    exec ssh -t "${SSH_OPTS[@]}" "root@${VPS_IP}" \
      "systemd-run --pty --wait --collect --quiet -p User=ikpk-cms -p Group=ikpk-cms -p WorkingDirectory=/opt/ikpk-cms/current -p EnvironmentFile=/etc/ikpk-cms/trial.env -E HOME=/var/lib/ikpk-cms/trial/data -E CMS_DATA_DIR=/var/lib/ikpk-cms/trial/data -E HOST=127.0.0.1 -E PORT=1338 -E NODE_ENV=production -E DATABASE_CLIENT=sqlite -E DATABASE_FILENAME=/var/lib/ikpk-cms/trial/data/data.db /usr/bin/node ${REMOTE_BIN}/create-super-admin.cjs" ;;
  secrets) exec bash "$ROOT/deploy/trial/gen-secrets.sh" "$SECRETS_FILE" ;;
  tunnel)
    [[ -n "$SSH_KEY" ]] || die 2 "SSH_KEY не задан"
    say "туннель http://127.0.0.1:${LOCAL_PORT} → ${VPS_IP}:1337 (админка: /admin). Остановить: Ctrl-C"
    exec ssh "${SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -N -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:1337" "root@${VPS_IP}" ;;
  hostkey)
    command -v ssh-keyscan >/dev/null || die 2 "нет ssh-keyscan"
    scanned="$(ssh-keyscan -t ed25519 "$VPS_IP" 2>/dev/null)"
    [[ -n "$scanned" ]] || die 2 "ключ хоста ${VPS_IP} получить не удалось"
    fp="$(ssh-keygen -lf - <<<"$scanned" | grep -o 'SHA256:[^ ]*')"
    say "ключ ED25519 хоста ${VPS_IP}: ${fp}"
    if [[ "${2:-}" == "--trust" ]]; then
      [[ -n "${EXPECTED_HOST_FINGERPRINT:-}" ]] || die 2 "для --trust задайте EXPECTED_HOST_FINGERPRINT из консоли провайдера"
      [[ "$fp" == "$EXPECTED_HOST_FINGERPRINT" ]] || die 2 "отпечаток ${fp} не совпадает с EXPECTED_HOST_FINGERPRINT: НЕ добавляю"
      mkdir -p "$(dirname "$KNOWN_HOSTS")"; printf '%s\n' "$scanned" >>"$KNOWN_HOSTS"
      say "добавлено в ${KNOWN_HOSTS}"
    else
      say "сверьте с консолью провайдера; затем: EXPECTED_HOST_FINGERPRINT=${fp} ${SELF} hostkey --trust"
    fi ;;
  forget)
    if [[ -f "$STATE_FILE" ]]; then
      tmp="$(mktemp "${STATE_DIR}/.state.XXXXXX")"; grep -v -F -- "@${VPS_IP}=" "$STATE_FILE" >"$tmp" || true
      chmod 600 "$tmp"; mv "$tmp" "$STATE_FILE"
    fi
    say "клиентская память о ${VPS_IP} стёрта (секреты и токен не тронуты)" ;;
  *) usage >&2; die 2 "неизвестная команда: ${cmd}" ;;
esac
