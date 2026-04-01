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

cat >"/etc/nginx/sites-available/${SITE_NAME}.conf" <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name ${DOMAIN};

  root ${WEB_ROOT}/current;
  index index.html;

  location / {
    try_files \$uri \$uri/ =404;
  }

  error_page 404 /404.html;
}
NGINX

ln -sfn "/etc/nginx/sites-available/${SITE_NAME}.conf" "/etc/nginx/sites-enabled/${SITE_NAME}.conf"
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx
REMOTE

echo "[bootstrap] Done. Nginx serves ${WEB_ROOT}/current"
