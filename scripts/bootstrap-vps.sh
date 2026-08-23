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
# Отдельное имя и отдельный сертификат для админки системы управления (не
# канонические имена сайта — те переключает `prod-serving-on-nginx`). Пустое
# умолчание запрещено намеренно: `cms._` не является именем, на которое можно
# выпустить сертификат, — оператор обязан задать ADMIN_DOMAIN явно.
ADMIN_DOMAIN="${ADMIN_DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

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
  "SITE_NAME='${SITE_NAME}' WEB_ROOT='${WEB_ROOT}' DOMAIN='${DOMAIN}' ADMIN_DOMAIN='${ADMIN_DOMAIN}' CERTBOT_EMAIL='${CERTBOT_EMAIL}' bash -s" <<'REMOTE'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# Админка системы управления раздаётся только по TLS (спека
# cms-content-authoring-and-migration, «Админка и её API раздаются только по
# TLS») — незаданное имя не отдаёт панель по умолчанию, оно fail-closed валит
# bootstrap: сертификат не на что выпускать.
if [[ -z "${ADMIN_DOMAIN}" ]]; then
  echo "[bootstrap] ADMIN_DOMAIN не задан — задайте отдельное имя для админки системы управления (например cms.${SITE_NAME}.example)." >&2
  exit 4
fi

apt-get update
apt-get install -y nginx rsync certbot python3-certbot-nginx openssl

mkdir -p "${WEB_ROOT}/releases"
mkdir -p "${WEB_ROOT}/shared"
chown -R root:root "${WEB_ROOT}"

# Самоподписанный плейсхолдер, чтобы `nginx -t` прошёл ДО первого выпуска
# сертификата: `ssl_certificate` не может ссылаться на файл, которого ещё
# нет, а certbot --nginx ниже сам подменит эти пути на свои после проверки
# домена.
ADMIN_TLS_DIR="/etc/ikpk-admin-tls/${ADMIN_DOMAIN}"
if [[ ! -f "${ADMIN_TLS_DIR}/fullchain.pem" ]]; then
  mkdir -p "${ADMIN_TLS_DIR}"
  openssl req -x509 -nodes -days 1 -newkey rsa:2048 \
    -subj "/CN=${ADMIN_DOMAIN}" \
    -keyout "${ADMIN_TLS_DIR}/privkey.pem" \
    -out "${ADMIN_TLS_DIR}/fullchain.pem"
fi

# Существующий vhost НЕ перезаписываем без явного разрешения.
#
# Конфиг пишется целиком, включая блок 443 ssl админки; certbot --nginx ниже
# только подменяет ssl_certificate/-_key на выпущенный сертификат — саму
# структуру vhost он не порождает. Повторный bootstrap на боевом хосте без
# FORCE_VHOST вернул бы конфигурацию к состоянию ДО этой подмены и обнулил
# `server_name`, если забыли DOMAIN. Раньше это происходило молча, а деплой к
# тому же де-факто отправлял оператора запускать bootstrap повторно — чтобы
# добрать `include` редиректов.
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
  listen 443 ssl;
  listen [::]:443 ssl;
  # ADMIN_DOMAIN — отдельное имя админки системы управления, добавленное в
  # ТОТ ЖЕ vhost по SNI: отдельный блок server на тот же порт держал бы два
  # блока server в одном heredoc, а `tests/serving-config.test.ts` (уже
  # принятый гейт `static-serving`) требует ровно один. Сертификат ниже
  # выпускается ИМЕННО на ADMIN_DOMAIN, отдельно от сертификата канонических
  # имён сайта (тот — предмет `prod-serving-on-nginx`).
  server_name ${DOMAIN} ${ADMIN_DOMAIN};

  # Сертификат админки системы управления (не канонические имена сайта — те
  # переключает \`prod-serving-on-nginx\`). \`ssl_certificate\` смотрит на
  # самоподписанный плейсхолдер, созданный выше, до первого выпуска настоящего
  # сертификата; certbot --nginx ниже подменяет оба пути на свои после
  # проверки домена и настраивает автопродление.
  ssl_certificate ${ADMIN_TLS_DIR}/fullchain.pem;
  ssl_certificate_key ${ADMIN_TLS_DIR}/privkey.pem;

  root ${WEB_ROOT}/current;
  index index.html;

  # Кеш-политика страниц. Работает как умолчание для всего, что не перехвачено
  # правилом по адресу ниже: nginx не складывает add_header по уровням —
  # правило, объявившее свой заголовок, серверный набор целиком теряет.
  # always — чтобы страницу ошибки (404) тоже отдавать этой политикой, а не
  # оставлять её без заголовка и без защиты от эвристического кеширования
  # браузером по Last-Modified.
  add_header Cache-Control "public, max-age=0, must-revalidate" always;

  # Сжатие задаётся этим конфигом, а не наследуется от умолчания дистрибутива
  # (там gzip_types закомментирован, и сжимается только text/html). text/html
  # в перечень не входит: nginx сжимает его всегда, а повторное упоминание
  # даёт предупреждение duplicate MIME type. woff2, png, jpeg, webp и
  # application/octet-stream не входят: это уже сжатое содержимое, в том числе
  # файлы данных поиска pagefind (расширения .pf_* эта таблица не знает и
  # относит их к application/octet-stream) — повторное сжатие их увеличивает.
  # Для XML и JavaScript указаны оба ходовых написания: отображение
  # расширение → тип задаёт mime.types nginx, а не этот конфиг, и наш хост
  # отдаёт .xml как text/xml, .js как application/javascript.
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

  # Правила перенаправления со старых адресов: генерируются из карты адресов
  # (npm run redirects:gen) и загружаются деплоем в shared/. Без этого include
  # 264 правила существовали только в репозитории — на сервере старые адреса
  # отдавали 404, а проверить 301 на стенде было нечем.
  #
  # Файл создаётся пустым ниже, до `nginx -t`: include одного отсутствующего
  # файла — ошибка конфигурации, а пустой include законен и значит «правил пока
  # нет».
  include ${WEB_ROOT}/shared/nginx-redirects.conf;

  # Админка системы управления и её API раздаются только по TLS (спека
  # cms-content-authoring-and-migration, «Админка и её API раздаются только по
  # TLS»): по HTTP — перенаправление, а не обслуживание, иначе пароль
  # администратора и cookie сессии ушли бы открытым текстом. Данные сотрудника
  # разделяемому кешу хранить нельзя (дельта static-serving, класс адресов
  # системы управления) — поэтому ровно no-store, без соседства с public.
  location ^~ /admin/ {
    add_header Cache-Control "no-store" always;
    proxy_pass http://127.0.0.1:1337;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    if (\$scheme = http) {
      return 301 https://\$host\$request_uri;
    }
  }

  location ^~ /api/ {
    add_header Cache-Control "no-store" always;
    proxy_pass http://127.0.0.1:1337;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    if (\$scheme = http) {
      return 301 https://\$host\$request_uri;
    }
  }

  # /_astro/ — имя несёт хеш содержимого сборки Astro, поэтому годовое
  # обещание безопасно: замена содержимого меняет и имя файла. Без always —
  # годовой immutable не должен попасть на ответ 404 в окне переключения
  # выкладки (symlink current меняется атомарно, но запрос может застать
  # старую сборку без нового файла).
  location ^~ /_astro/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # Данные поискового индекса pagefind — по расширению имени, а не по каталогу
  # /pagefind/: там же лежит загрузчик с постоянными именами, которому долгий
  # срок противопоказан. Имя несёт хеш содержимого тем же способом, что и
  # /_astro/.
  location ~ \.(pf_fragment|pf_index|pf_meta)\$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # Шрифты лежат на критическом пути отрисовки (страницы объявляют их через
  # link rel=preload), а имена у них постоянные. Месяц, а не год: замена
  # шрифта возможна только переименованием файла, и короткий срок ограничивает
  # цену ошибки.
  location ^~ /fonts/ {
    add_header Cache-Control "public, max-age=2592000";
  }

  # favicon.ico и favicon.svg — по имени файла, а не перечислением: набор
  # форматов иконки со временем меняется.
  location ~ ^/favicon\. {
    add_header Cache-Control "public, max-age=86400";
  }

  # Векторная графика в корне сайта (hero-main.svg, logo-wordmark.svg,
  # logo-icon.svg и т.п.) — на критическом пути отрисовки, но, в отличие от
  # /_astro/, без хеша содержимого в имени: правка файла под тем же адресом —
  # обычная замена, поэтому годовой срок и immutable этому классу не положены.
  # Правило записано ПОСЛЕ правила favicon. намеренно: /favicon.svg подходит
  # под оба регулярных выражения, а nginx берёт первое совпавшее — favicon.
  # обязан обслуживать /favicon.svg, а не этот класс. Один сегмент пути в
  # регулярном выражении, а не \$.svg\$: класс задан КОРНЕМ сайта, а не любым
  # .svg, — .svg под /media/ отдаётся политикой страниц.
  location ~ ^/[^/]+\.svg\$ {
    add_header Cache-Control "public, max-age=86400";
  }

  # Карта сайта и её части (sitemap-index.xml, sitemap-0.xml, ...).
  # /sitemap.xml сюда не попадает: в сборке такого файла нет, адрес отдаётся
  # правилом перенаправления из include выше, а точное совпадение в nginx
  # выигрывает у этого регулярного выражения — исключать адрес здесь не нужно.
  location ~ ^/sitemap.*\.xml\$ {
    add_header Cache-Control "public, max-age=3600";
  }

  location / {
    # Порядок здесь несущий. Сайт адресует страницы БЕЗ завершающего слэша
    # (ikpk.su/kontakty — как старый сайт, и так же в canonical и в карте
    # сайта), а раскладка файлов каталогами: /kontakty/index.html. Если
    # \$uri/ окажется раньше \$uri/index.html, nginx на запрос /kontakty
    # ответит 301 на /kontakty/ — адрес разойдётся с каноническим, и вся
    # затея потеряет смысл.
    #
    # Свой Cache-Control этот блок не объявляет — страницы отдаются серверным
    # умолчанием политики страниц. Тем же наследованием, но по своей отдельной
    # цепочке (это отдельные location = <адрес>, наследующие прямо от server,
    # а не через этот блок), живут и 264 правила перенаправления, подключённые
    # include выше.
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

# Выпуск и обновление сертификата — ВЫЗОВ, а не пункт инструкции оператору:
# необязательный шаг в тексте инструкции — ровно то расхождение, из-за
# которого TLS админки не был гарантирован (design.md, D-раздел про TLS).
# `--nginx` сам подменит ssl_certificate/-_key на свои пути в блоке выше.
if [[ -n "${CERTBOT_EMAIL}" ]]; then
  certbot --nginx -d "${ADMIN_DOMAIN}" -m "${CERTBOT_EMAIL}" --agree-tos --non-interactive --redirect
else
  certbot --nginx -d "${ADMIN_DOMAIN}" --register-unsafely-without-email --agree-tos --non-interactive --redirect
fi

# Продление по умолчанию уже ставит пакет certbot (таймер systemd), но здесь
# оно включено явно: продление сертификата не обязано зависеть от того, что
# по умолчанию сделал пакетный менеджер дистрибутива.
systemctl enable --now certbot.timer
REMOTE

echo "[bootstrap] Done. Nginx serves ${WEB_ROOT}/current"
