# Deploy Astro Frontend to VPS (Ubuntu 24.04)

Этот runbook разворачивает `web/` как статический сайт через Nginx на VPS.

## 1. Добавить SSH-ключ для root

Используется ключ `~/.ssh/id_ed25519_ikpk_vps`. Проверка входа:

```bash
ssh -i ~/.ssh/id_ed25519_ikpk_vps -o BatchMode=yes root@146.103.124.113 "echo ok"
```

Если ключ ещё не добавлен на сервер (первичная настройка), зайдите по паролю и добавьте:

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo "<вставьте_публичный_ключ_id_ed25519_ikpk_vps.pub>" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
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

```bash
cd /Users/pgorbachev/projects/private/ikpk
SSH_KEY=~/.ssh/id_ed25519_ikpk_vps bash scripts/deploy-web.sh 146.103.124.113
```

Опциональные переменные:

```bash
KEEP_RELEASES=10 SSH_KEY=~/.ssh/id_ed25519_ikpk_vps bash scripts/deploy-web.sh 146.103.124.113
```

## 4. Что важно

- Текущий деплой касается только `web` (Astro static). `cms`/Strapi в этот runbook не входит.
- После смены домена укажите `DOMAIN=ikpk.su` в bootstrap, чтобы Nginx отвечал по хосту.
- Для HTTPS отдельно добавьте Certbot (или внешний reverse proxy/CDN).
