#!/usr/bin/env bash
# Пробная машина (docs/runbook-trial-vps.md, шаг 7): HTTPS по IP без DNS.
# Запуск НА СЕРВЕРЕ от root, ПОСЛЕ bootstrap-vps.sh (nginx и vhost на :80 уже есть).
#
#   /opt/ikpk-trial/bin/setup-https-ip.sh 89.111.143.219
#
# Что делает: certbot 5.8.0 в /opt/certbot (в штатном репозитории Ubuntu 26.04 — 4.0.0, IP он
# не умеет), сертификат Let's Encrypt профиля shortlived (живёт ~6 суток), конфигурация
# :443 в /etc/nginx/conf.d, таймер продления. Идемпотентен.
#
# Ограничения, названные вслух:
# - challenge идёт через --standalone на :80, поэтому каждое продление на секунды
#   останавливает nginx (pre/post-hook). Для пробной машины принято; для production
#   challenge переносится в vhost.
# - :443 проксирует панель CMS (/admin, /content-manager, /upload, /i18n) на 127.0.0.1:1337
#   и всё остальное — на тот же nginx по :80, чтобы сайт отдавался одной конфигурацией.
set -euo pipefail

IP="${1:?укажите IP-адрес сервера}"
CERTBOT_VERSION="${CERTBOT_VERSION:-5.8.0}"
CERT_NAME="ikpk-trial"
CONF="/etc/nginx/conf.d/ikpk-trial-tls.conf"

[[ "$(id -u)" == 0 ]] || { echo "[https] нужен root" >&2; exit 2; }
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "[https] не IPv4: ${IP}" >&2; exit 2; }
systemctl is-active --quiet nginx || { echo "[https] nginx не запущен: сначала bootstrap-vps.sh" >&2; exit 3; }

if [[ ! -x /opt/certbot/bin/certbot ]] || [[ "$(/opt/certbot/bin/certbot --version 2>&1)" != "certbot ${CERTBOT_VERSION}" ]]; then
  python3 -m venv /opt/certbot
  /opt/certbot/bin/pip install -q "certbot==${CERTBOT_VERSION}"
  echo "[https] changed: certbot ${CERTBOT_VERSION} установлен в /opt/certbot"
else
  echo "[https] unchanged: certbot ${CERTBOT_VERSION}"
fi

if [[ -s "/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem" ]]; then
  echo "[https] unchanged: сертификат ${CERT_NAME} уже выпущен"
else
  /opt/certbot/bin/certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --standalone --preferred-profile shortlived --cert-name "$CERT_NAME" --ip-address "$IP" \
    --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"
  echo "[https] changed: сертификат ${CERT_NAME} выпущен"
fi

desired="$(cat <<NGINX
# managed-by: deploy/trial/setup-https-ip.sh
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  server_name ${IP};

  ssl_certificate /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${CERT_NAME}/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

  client_max_body_size 64m;

  location ~ ^/(admin|content-manager|upload|i18n)(/|\$) {
    proxy_pass http://127.0.0.1:1337;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;
  }

  location / {
    proxy_pass http://127.0.0.1:80;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto https;
  }
}
NGINX
)"
if [[ -f "$CONF" && "$(cat "$CONF")" == "$desired" ]]; then
  echo "[https] unchanged: ${CONF}"
else
  printf '%s\n' "$desired" >"${CONF}.new"
  mv "${CONF}.new" "$CONF"
  echo "[https] changed: ${CONF}"
fi
nginx -t
systemctl reload nginx

timer_dir=/etc/systemd/system
cat >"${timer_dir}/ikpk-certbot-renew.service" <<UNIT
[Unit]
Description=Продление сертификата IKPK (пробная машина)

[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet
UNIT
cat >"${timer_dir}/ikpk-certbot-renew.timer" <<UNIT
[Unit]
Description=Продление сертификата IKPK дважды в сутки

[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now ikpk-certbot-renew.timer >/dev/null
echo "[https] таймер продления: $(systemctl is-active ikpk-certbot-renew.timer)"
echo "[https] срок: $(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem")"
echo "[https] ok: https://${IP}/"
