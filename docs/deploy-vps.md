# Deploy Astro Frontend to VPS (Ubuntu 24.04)

Этот runbook разворачивает `web/` как статический сайт через Nginx на VPS.

## 1. Добавить SSH-ключ для root

Локально получить публичный ключ (по умолчанию используется `~/.ssh/id_ed25519_vdsina_root`):

```bash
cat ~/.ssh/id_ed25519_vdsina_root.pub
```

На сервере (после входа по паролю):

```bash
mkdir -p /root/.ssh
chmod 700 /root/.ssh
echo "<вставьте_публичный_ключ_сюда>" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

Проверка входа по ключу:

```bash
ssh -i ~/.ssh/id_ed25519_vdsina_root -o BatchMode=yes root@<ip-сервера> "echo ok"
```

## 2. Первичная настройка сервера

Скрипт ставит Nginx и готовит структуру релизов в `/var/www/ikpk`:

```bash
cd /Users/pgorbachev/projects/private/ikpk
bash scripts/bootstrap-vps.sh <ip-сервера>
```

Опциональные переменные:

```bash
DOMAIN=ikpk.su bash scripts/bootstrap-vps.sh <ip-сервера>
SSH_KEY=~/.ssh/custom_key bash scripts/bootstrap-vps.sh <ip-сервера>
```

Ключ, если его ещё нет:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_ikpk_vps -C ikpk-vps
ssh-copy-id -o StrictHostKeyChecking=accept-new -i ~/.ssh/id_ed25519_ikpk_vps.pub root@<ip-сервера>
```

Скрипты ходят с `BatchMode=yes` — пароль они запросить не могут, поэтому ключ нужен до
первого запуска. Умолчания у скриптов **разные** (`bootstrap-vps.sh` — `id_ed25519_vdsina_root`,
`deploy-web.sh` — `id_ed25519_ikpk_vps`), так что `SSH_KEY=` лучше передавать явно обоим.

## 3. Деплой сайта

Скрипт:
1. делает `npm ci && npm run build` в `web/`,
2. загружает `web/dist` как новый релиз,
3. переключает symlink `current`,
4. перезагружает Nginx.

**Режим форм задаётся явно, умолчания нет.** Причина: обе ошибки молча дорогие —
боевой сайт с заглушкой теряет заявки клиентов, а стенд в боевом режиме пишет
тестовые обращения в CRM заказчика.

```bash
cd /Users/pgorbachev/projects/private/ikpk

# стенд: формы ведут на локальную заглушку /demo-zayavka
DEPLOY_MODE=stand ./scripts/deploy-web.sh <ip-сервера>

# боевой сайт: формы ведут в CRM заказчика
DEPLOY_MODE=prod ./scripts/deploy-web.sh <ip>

# стенд со своим тестовым порталом Bitrix24 вместо заглушки
DEPLOY_MODE=stand DEMO_FORMS=b24-test123.bitrix24site.ru ./scripts/deploy-web.sh <ip>
```

**Аргумент — ssh-цель, а не адрес сайта.** Пока стенд отвечает по IP без TLS, это одно
и то же, и health-check по умолчанию идёт на `http://<аргумент>/`. Как только появится
домен с сертификатом, адрес проверки надо задать явно:

```bash
SITE_URL=https://ikpk.su/ DEPLOY_MODE=prod ./scripts/deploy-web.sh <ip>
```

Без этого проверка по IP уйдёт редиректом на домен (health-check отвергнет смену
хоста) либо упрётся в сертификат, выписанный на домен, — и деплой сообщит о провале
на исправной выкладке, уже переключив symlink.

Деплой загружает `deploy/nginx-redirects.conf` в `shared/` — vhost подключает файл
по постоянному пути. После деплоя проверить, что перенаправления действуют, иначе о
них узнают только при переключении DNS:

```bash
curl -o /dev/null -sw '%{http_code} %{redirect_url}\n' http://<ip>/kontakty/
curl -o /dev/null -sw '%{http_code} %{redirect_url}\n' http://<ip>/contacts
```

### Одноразовая правка на уже развёрнутом сервере

Деплой отказывается работать, если активный vhost не подключает файл редиректов —
он проверяет это через `nginx -T` **до** переключения релиза. На сервере, поднятом
до появления `include`, правку надо внести один раз руками.

**`bootstrap-vps.sh` повторно запускать нельзя:** он пишет vhost целиком, только
`listen 80`, и снесёт 443-блок с редиректом на https, которые добавил certbot.
Скрипт теперь сам отказывается перезаписывать существующий конфиг (код выхода 3) и
подсказывает эту процедуру; обойти можно через `FORCE_VHOST=1`, но тогда сначала
резервная копия.

```bash
ssh root@<ip-сервера>
cp /etc/nginx/sites-available/ikpk.conf /etc/nginx/sites-available/ikpk.conf.bak
# внутрь блока server { … } добавить строку:
#   include /var/www/ikpk/shared/nginx-redirects.conf;
touch /var/www/ikpk/shared/nginx-redirects.conf
nginx -t && systemctl reload nginx
```

Если `nginx -t` упал — вернуть конфиг из `.bak` и разобраться, не перезагружая
nginx: до `reload` старая конфигурация продолжает работать.


Опциональные переменные:

```bash
KEEP_RELEASES=10 DEPLOY_MODE=stand ./scripts/deploy-web.sh <ip-сервера>
SSH_KEY=~/.ssh/id_ed25519_ikpk_vps DEPLOY_MODE=stand ./scripts/deploy-web.sh <ip-сервера>
```

## 4. Что важно

- Текущий деплой касается только `web` (Astro static). `cms`/Strapi в этот runbook не входит.
- После смены домена укажите `DOMAIN=ikpk.su` в bootstrap, чтобы Nginx отвечал по хосту.
- Для HTTPS отдельно добавьте Certbot (или внешний reverse proxy/CDN).
