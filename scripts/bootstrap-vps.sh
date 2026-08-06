#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <host-or-ip>"
  echo "Example: $0 146.103.124.113"
  exit 1
fi

HOST="$1"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_vdsina_root}"
SITE_NAME="${SITE_NAME:-ikpk}"
WEB_ROOT="${WEB_ROOT:-/var/www/${SITE_NAME}}"
DOMAIN="${DOMAIN:-_}"

SSH_ARGS=(
  -i "$SSH_KEY"
  -o BatchMode=yes
  -o ConnectTimeout=10
)

if [[ "${SSH_STRICT_HOST_KEY_CHECKING:-yes}" == "no" ]]; then
  SSH_ARGS+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
fi

echo "[bootstrap] Connecting to ${SSH_USER}@${HOST}"
/usr/bin/ssh "${SSH_ARGS[@]}" "${SSH_USER}@${HOST}" \
  "SITE_NAME='${SITE_NAME}' WEB_ROOT='${WEB_ROOT}' DOMAIN='${DOMAIN}' bash -s" <<'REMOTE'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y nginx rsync

mkdir -p "${WEB_ROOT}/releases"
mkdir -p "${WEB_ROOT}/shared"
chown -R root:root "${WEB_ROOT}"

# Существующий vhost НЕ перезаписываем без явного разрешения.
#
# Здесь конфиг пишется целиком, только `listen 80`, а certbot добавляет в этот же
# файл 443-блок и редирект на https. Повторный bootstrap на боевом хосте вернул бы
# конфигурацию к HTTP-only и обнулил `server_name`, если забыли DOMAIN. Раньше это
# происходило молча, а деплой к тому же де-факто отправлял оператора запускать
# bootstrap повторно — чтобы добрать `include` редиректов.
VHOST="/etc/nginx/sites-available/${SITE_NAME}.conf"
if [[ -f "$VHOST" && "${FORCE_VHOST:-}" != "1" ]]; then
  cat >&2 <<EXISTING
Конфигурация ${VHOST} уже существует и НЕ будет перезаписана.

Если нужен только include файла редиректов — добавьте строку внутрь блока server:
  include ${WEB_ROOT}/shared/nginx-redirects.conf;
затем: nginx -t && systemctl reload nginx

Перезаписать целиком (снесёт правки certbot, сделайте резервную копию):
  FORCE_VHOST=1 ... bootstrap-vps.sh ${HOST}
EXISTING
  mkdir -p "${WEB_ROOT}/shared"
  touch "${WEB_ROOT}/shared/nginx-redirects.conf"
  exit 3
fi

if [[ -f "$VHOST" ]]; then
  cp "$VHOST" "${VHOST}.bak-$(date +%Y%m%d%H%M%S)"
  echo "[bootstrap] Резервная копия vhost: ${VHOST}.bak-*"
fi

cat >"$VHOST" <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name ${DOMAIN};

  root ${WEB_ROOT}/current;
  index index.html;

  # Правила перенаправления со старых адресов: генерируются из карты адресов
  # (npm run redirects:gen) и загружаются деплоем в shared/. Без этого include
  # 265 правил существовали только в репозитории — на сервере старые адреса
  # отдавали 404, а проверить 301 на стенде было нечем.
  #
  # Файл создаётся пустым ниже, до `nginx -t`: include одного отсутствующего
  # файла — ошибка конфигурации, а пустой include законен и значит «правил пока
  # нет».
  include ${WEB_ROOT}/shared/nginx-redirects.conf;

  location / {
    # Порядок здесь несущий. Сайт адресует страницы БЕЗ завершающего слэша
    # (ikpk.su/kontakty — как старый сайт, и так же в canonical и в карте
    # сайта), а раскладка файлов каталогами: /kontakty/index.html. Если
    # \$uri/ окажется раньше \$uri/index.html, nginx на запрос /kontakty
    # ответит 301 на /kontakty/ — адрес разойдётся с каноническим, и вся
    # затея потеряет смысл.
    try_files \$uri \$uri/index.html \$uri/ =404;
  }

  error_page 404 /404.html;
}
NGINX

touch "${WEB_ROOT}/shared/nginx-redirects.conf"

ln -sfn "$VHOST" "/etc/nginx/sites-enabled/${SITE_NAME}.conf"
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx
REMOTE

echo "[bootstrap] Done. Nginx serves ${WEB_ROOT}/current"
