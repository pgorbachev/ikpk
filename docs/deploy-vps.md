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
ssh -i ~/.ssh/id_ed25519_vdsina_root -o BatchMode=yes root@146.103.124.113 "echo ok"
```

## 2. Первичная настройка сервера

Скрипт ставит Nginx и готовит структуру релизов в `/var/www/ikpk`:

```bash
cd /Users/pgorbachev/projects/private/ikpk
bash scripts/bootstrap-vps.sh 146.103.124.113
```

Опциональные переменные:

```bash
DOMAIN=ikpk.su bash scripts/bootstrap-vps.sh 146.103.124.113
SSH_KEY=~/.ssh/custom_key bash scripts/bootstrap-vps.sh 146.103.124.113
```

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
DEPLOY_MODE=stand ./scripts/deploy-web.sh 193.124.115.99

# боевой сайт: формы ведут в CRM заказчика
DEPLOY_MODE=prod ./scripts/deploy-web.sh <ip>

# стенд со своим тестовым порталом Bitrix24 вместо заглушки
DEPLOY_MODE=stand DEMO_FORMS=b24-test123.bitrix24site.ru ./scripts/deploy-web.sh <ip>
```

Деплой загружает `deploy/nginx-redirects.conf` в `shared/` — vhost подключает файл
по постоянному пути. После деплоя проверить, что перенаправления действуют, иначе о
них узнают только при переключении DNS:

```bash
curl -o /dev/null -sw '%{http_code} %{redirect_url}\n' http://<ip>/kontakty/
curl -o /dev/null -sw '%{http_code} %{redirect_url}\n' http://<ip>/contacts
```

Опциональные переменные:

```bash
KEEP_RELEASES=10 DEPLOY_MODE=stand ./scripts/deploy-web.sh 193.124.115.99
SSH_KEY=~/.ssh/id_ed25519_ikpk_vps DEPLOY_MODE=stand ./scripts/deploy-web.sh 193.124.115.99
```

## 4. Что важно

- Текущий деплой касается только `web` (Astro static). `cms`/Strapi в этот runbook не входит.
- После смены домена укажите `DOMAIN=ikpk.su` в bootstrap, чтобы Nginx отвечал по хосту.
- Для HTTPS отдельно добавьте Certbot (или внешний reverse proxy/CDN).
