#!/usr/bin/env bash
set -uo pipefail
# Не используем `set -e` целиком: скрипт обязан пройти ВСЕ проверки и посчитать оба
# числа, даже когда часть проверок падает — падение одной не должно обрывать остальные.

# Проверка достигнутого состояния по покрытию (change `server-provisioning`,
# Requirement «Провижининг проверяет достигнутое состояние по покрытию»). Отдельный
# исполняемый артефакт, а не хвост провижининга: дрейф ловится между запусками.
#
# Три исхода, различимых кодом выхода:
#   0 — состояние достигнуто (declared = checked + manual + unverifiable, unverifiable = 0)
#   1 — несоответствия найдены
#   2 — измерить не удалось (сервер недостижим, либо ноль проверок выполнено)
#
# Usage: verify-server-state.sh [host] ; ENVIRONMENT=stand|prod (умолчание stand)

HOST="${1:-target}"
ENVIRONMENT="${ENVIRONMENT:-stand}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/environments/${ENVIRONMENT}.env"
FROM_HOST="$(hostname 2>/dev/null || echo unknown)"

EXIT_OK=0
EXIT_MISMATCH=1
EXIT_UNMEASURED=2

print_unmeasured() {
  echo "declared=0"
  echo "checked=0"
  echo "manual=0"
  echo "unverifiable=0"
  echo "from=${FROM_HOST}"
  echo "измерить не удалось: $*" >&2
  exit "$EXIT_UNMEASURED"
}

# «target» — сентинел «эта же машина», используемый тестами (design.md, Решение 2:
# цель проверки — контейнер, живой стенд — только приёмка). Любое другое значение —
# настоящий удалённый адрес: сначала подтверждаем достижимость на сетевом уровне
# (независимо от ssh), затем делегируем этот же скрипт туда по ssh.
if [[ "$HOST" != "target" ]]; then
  if ! timeout 3 bash -c "exec 3<>/dev/tcp/${HOST}/22" 2>/dev/null; then
    print_unmeasured "сервер ${HOST} недостижим (порт 22 не отвечает за 3с)"
  fi
  SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_vdsina_root}"
  SSH_ARGS=(-i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=5)
  if [[ "${SSH_STRICT_HOST_KEY_CHECKING:-yes}" == "no" ]]; then
    SSH_ARGS+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
  fi
  if /usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER:-root}@${HOST}" \
    "ENVIRONMENT='${ENVIRONMENT}' bash -s target" <"${BASH_SOURCE[0]}"; then
    exit "$EXIT_OK"
  else
    rc=$?
    if [[ "$rc" == "$EXIT_MISMATCH" ]]; then exit "$EXIT_MISMATCH"; fi
    print_unmeasured "удалённый прогон проверки на ${HOST} не завершился измеримо (код ${rc})"
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  print_unmeasured "объявленного состояния окружения «${ENVIRONMENT}» нет: ${ENV_FILE}"
fi

# Построчный разбор вместо `source` — см. bootstrap-vps.sh: значения объявленного
# состояния — свободный текст (PROPERTY_*_REASON) и не обязаны быть валидным
# bash-синтаксисом.
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
VHOST="/etc/nginx/sites-available/${SITE_NAME}.conf"
REVISION_FILE="${REVISION_FILE:-/var/lib/ikpk-provision/revision}"
NETWORK_PROPERTY_NAME="${NETWORK_CLOSEDNESS_PROPERTY:-}"

# Автоматические проверки по ИМЕНИ свойства. Имя неизвестное этому реестру — код 2:
# не засчитывается ни в «проверено», ни в «несоответствие» (Requirement «У каждого
# объявленного свойства SHALL быть проверка» — свойство без реестрового имени проверку
# не проходит вообще, поэтому равенство declared = checked + manual + unverifiable для
# него не выполнится).
check_auto() {
  local name="$1"
  case "$name" in
  RELEASES_DIR) [[ -d "${WEB_ROOT}/releases" ]] ;;
  SHARED_DIR) [[ -d "${WEB_ROOT}/shared" ]] ;;
  VHOST_ENABLED) [[ -L "/etc/nginx/sites-enabled/${SITE_NAME}.conf" ]] ;;
  VHOST_INCLUDE) grep -qF "include ${WEB_ROOT}/shared/nginx-redirects.conf;" "$VHOST" 2>/dev/null ;;
  VHOST_GZIP) grep -qF "gzip on;" "$VHOST" 2>/dev/null ;;
  REDIRECTS_FILE) [[ -f "${WEB_ROOT}/shared/nginx-redirects.conf" ]] ;;
  NGINX_RUNNING) pgrep -x nginx >/dev/null 2>&1 ;;
  DEFAULT_SITE_DISABLED) [[ ! -e /etc/nginx/sites-enabled/default ]] ;;
  REVISION_RECORDED) [[ -s "$REVISION_FILE" ]] ;;
  PACKAGES_INSTALLED)
    local ok=1
    IFS=',' read -ra _pkgs <<<"${PACKAGES:-}"
    for p in "${_pkgs[@]}"; do
      [[ -n "$p" ]] || continue
      dpkg -s "$p" >/dev/null 2>&1 || ok=0
    done
    [[ "$ok" == 1 ]]
    ;;
  CMS_DATA_DIR) [[ -n "${CMS_DATA_DIR:-}" && -d "${CMS_DATA_DIR}" ]] ;;
  SERVICE_ACCOUNT) [[ -n "${SERVICE_ACCOUNT:-}" ]] && id "$SERVICE_ACCOUNT" >/dev/null 2>&1 ;;
  SERVICE_UNIT) [[ -n "${SERVICE_UNIT:-}" && -f "${SERVICE_UNIT}" ]] && grep -qF "${SERVICE_ADDR:-__none__}" "$SERVICE_UNIT" ;;
  SERVICE_ADDR_LOOPBACK)
    local host_part="${SERVICE_ADDR%%:*}"
    [[ "$host_part" == "127.0.0.1" || "$host_part" == "::1" || "$host_part" == "localhost" ]]
    ;;
  SERVICE_PROXY)
    # Пустой снипет — это ОБЪЯВЛЕННОЕ отключение проксирования, а не «нечего проверять».
    # Прежде ветвь начиналась с требования непустого значения и возвращала 1, поэтому на
    # стенде, где проксирование отключено намеренно, проверка состояния не могла вернуть
    # 0 НИКОГДА: объявленное состояние само же объявлялось несоответствием.
    if [[ -z "${SERVICE_PROXY_SNIPPET:-}" ]]; then
      [[ ! -f "$VHOST" ]] || ! grep -qE '^[[:space:]]*include[[:space:]].*ikpk-cms\.conf;' "$VHOST"
      return $?
    fi
    [[ -n "${SERVICE_ADDR:-}" ]] &&
      grep -qF "proxy_pass http://${SERVICE_ADDR}" "$SERVICE_PROXY_SNIPPET" 2>/dev/null &&
      grep -qF "include ${SERVICE_PROXY_SNIPPET};" "$VHOST" 2>/dev/null
    ;;
  *) return 2 ;;
  esac
}

declared=0
checked=0
manual=0
unverifiable=0
mismatched=()

for var in $(compgen -v | grep -E '^PROPERTY_.+_CLASS$'); do
  name="${var#PROPERTY_}"
  name="${name%_CLASS}"
  klass="${!var}"
  declared=$((declared + 1))

  case "$klass" in
  auto)
    check_auto "$name"
    rc=$?
    if [[ "$rc" == 2 ]]; then
      echo "${name}: неизвестное свойство — автоматическая проверка не определена"
    elif [[ "$rc" == 0 ]]; then
      checked=$((checked + 1))
      if [[ -n "$NETWORK_PROPERTY_NAME" && "$name" == "$NETWORK_PROPERTY_NAME" ]]; then
        echo "${name}: ok (с сервера — внешняя недоступность отдельно не подтверждена)"
      fi
    else
      mismatched+=("$name")
      echo "${name}: не достигнуто"
    fi
    ;;
  manual)
    evidence_var="PROPERTY_${name}_EVIDENCE"
    evidence="${!evidence_var-}"
    if [[ -z "$evidence" ]]; then
      mismatched+=("$name")
      echo "${name}: ручное свойство без свидетельства"
    else
      ev_rev="${evidence%%:*}"
      if [[ -n "${PROVISION_REVISION:-}" && "$ev_rev" == "$PROVISION_REVISION" ]]; then
        manual=$((manual + 1))
      else
        mismatched+=("$name")
        echo "${name}: свидетельство устарело (ревизия свидетельства ${ev_rev} != текущая ${PROVISION_REVISION:-?})"
      fi
    fi
    ;;
  unverifiable)
    reason_var="PROPERTY_${name}_REASON"
    deadline_var="PROPERTY_${name}_DEADLINE"
    reason="${!reason_var-}"
    deadline="${!deadline_var-}"
    unverifiable=$((unverifiable + 1))
    echo "${name}: непроверяемое свойство. причина: ${reason:-?}. срок: ${deadline:-?}."
    ;;
  *)
    mismatched+=("$name")
    echo "${name}: класс вне {auto, manual, unverifiable}: ${klass}"
    ;;
  esac
done

echo "declared=${declared}"
echo "checked=${checked}"
echo "manual=${manual}"
echo "unverifiable=${unverifiable}"
echo "from=${FROM_HOST}"

if ((checked == 0)); then
  echo "измерить не удалось: ни одна автоматическая проверка не выполнилась" >&2
  exit "$EXIT_UNMEASURED"
fi

sum=$((checked + manual + unverifiable))
if ((sum != declared)) || ((unverifiable != 0)) || ((${#mismatched[@]} > 0)); then
  echo "несоответствия найдены: ${mismatched[*]:-<равенство не выполняется>}" >&2
  exit "$EXIT_MISMATCH"
fi

echo "состояние достигнуто"
exit "$EXIT_OK"
