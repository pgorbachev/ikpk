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
  # 265 правил существовали только в репозитории — на сервере старые адреса
  # отдавали 404, а проверить 301 на стенде было нечем.
  #
  # Файл создаётся пустым ниже, до `nginx -t`: include одного отсутствующего
  # файла — ошибка конфигурации, а пустой include законен и значит «правил пока
  # нет».
  include ${WEB_ROOT}/shared/nginx-redirects.conf;

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
REMOTE

echo "[bootstrap] Done. Nginx serves ${WEB_ROOT}/current"
