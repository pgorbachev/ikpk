# Runbook: установка ревизии на демостенд

Предмет — демостенд `193.124.115.99` (Debian 13, 948 МБ): CMS на `127.0.0.1:1337` и
постоянное дерево кнопки «Обновить сайт». Production, DNS и публичный релиз сайта
(`/var/www/ikpk/current`) эта процедура **не трогает**. Публикация сайта — отдельный путь,
[docs/deploy-vps.md](deploy-vps.md).

Почему не `scripts/bootstrap-vps.sh` целиком: провижининг переписывает
`/etc/ikpk-cms/stand.env` ровно из `SECRET_NAMES` и требует все значения в окружении оператора.
На стенде в этом файле лежат ещё `CONTENT_ADMIN_EMAIL`/`CONTENT_ADMIN_PASSWORD`, которых в
`SECRET_NAMES` нет, — полный прогон молча их удалил бы. Поэтому ревизия ставится шагами того же
провижининга, а секреты не покидают сервер.

Все шаги ниже выполняются из **своего** worktree на нужном SHA, ssh — ключом
`~/.ssh/id_ed25519_ikpk_vps` под `root`:

```bash
SHA=<полный SHA>
git fetch origin && git worktree add --detach ../ikpk-stand-install-${SHA:0:8} "$SHA"
SSH=(ssh -i ~/.ssh/id_ed25519_ikpk_vps -o BatchMode=yes -o IdentitiesOnly=yes root@193.124.115.99)
```

## 1. Подготовка артефактов (на машине оператора)

- **CMS:** `scripts/build-cms-artifact.sh /tmp/ikpk-cms-artifact-<sha8>` — сборка и проверки
  собранного вывода (tsconfig, путь базы, число миграций).
- **Дерево сборки сайта:** ровно то, что шлёт провижининг, —
  `bash -c 'source scripts/lib/site-build-archive.sh && site_build_archive "$PWD"' > /tmp/ikpk-site-build-<sha8>.tar.gz`.
  `git archive` детерминирован: SHA-256 архива, собранного дважды из одного коммита, совпадает,
  поэтому готовый архив сверяется с пересобранным, а не принимается на слово.

Проверки до установки:

```bash
tar -tzf /tmp/ikpk-site-build-<sha8>.tar.gz | grep -x fixtures/content-snapshot/collapsible_panels.json
tar -tzf /tmp/ikpk-site-build-<sha8>.tar.gz | grep -x fixtures/content-snapshot/url_map.csv
shasum -a 256 cms/package-lock.json /tmp/ikpk-cms-artifact-<sha8>/package-lock.json   # совпали → deps на стенде уже есть
diff -r cms/database/migrations /tmp/ikpk-cms-artifact-<sha8>/database/migrations
```

Без двух фикстур кнопка падает на рендере `/oplata` (`ENOENT .snapshot/collapsible_panels.json`).
Если `package-lock.json` сайта или CMS сменился, эта процедура не годится: нужен `npm ci` на
стенде (46 минут, теснит CMS по памяти) — запускайте провижининг.

## 2. Секреты: существующий механизм

Секреты **не передаются** при установке ревизии. Они уже лежат на стенде:

| файл | владелец, режим | содержимое |
|---|---|---|
| `/etc/ikpk-cms/stand.env` | `ikpk-cms`, `0600` | шесть секретов Strapi из `SECRET_NAMES` и `CONTENT_ADMIN_*` |
| `/root/ikpk-content-admin.env` | `root`, `0600` | учётка администратора контента |

Юнит читает первый файл через `EnvironmentFile=`. Значения в вывод не печатать: проверять
только имена (`sed -E 's/=.*/=<r>/'`). Смена секретов — задача провижининга, а не этой процедуры.

## 3. Установка

**Точка отката** (`STAMP=$(date -u +%Y%m%dT%H%M%SZ)`,
`BACKUP=/var/backups/ikpk/cms-before-<sha8>-$STAMP`) — на сервере. Базу и дерево сборки стенд
не копирует: это среда разработки, содержимое CMS там не ценно, а медиа приезжают из git по SHA.
Сохраняются только файлы, без которых откат невозможен (несколько КБ):

```bash
mkdir -p "$BACKUP"
cp -a /etc/systemd/system/ikpk-cms.service "$BACKUP/ikpk-cms.service"
cp -a /opt/ikpk-cms/current/.cms-commit "$BACKUP/cms-commit"
cp -a /var/lib/ikpk-site-build/.source-commit "$BACKUP/source-commit"
readlink -f /opt/ikpk-cms/current > "$BACKUP/cms-release"
readlink -f /var/www/ikpk/current > "$BACKUP/site-current"
```

**Релиз CMS** — новый каталог, неизменные файлы связываются жёсткой ссылкой:

```bash
REL=/opt/ikpk-cms/releases/$STAMP; PREV=$(cat "$BACKUP/cms-release")
"${SSH[@]}" "mkdir -p $REL"
rsync -az --link-dest="$PREV" --rsh="ssh -i ~/.ssh/id_ed25519_ikpk_vps" \
  /tmp/ikpk-cms-artifact-<sha8>/ root@193.124.115.99:$REL/
```

**Дерево сборки сайта:** `"${SSH[@]}" "tar -C /var/lib/ikpk-site-build -xzf -" < /tmp/ikpk-site-build-<sha8>.tar.gz`.
Распаковка от root возвращает режимы из архива, поэтому следом **обязательно** повторить блок
прав из `scripts/bootstrap-vps.sh` (ветка `SITE_BUILD_WORKSPACE`): `web` и `web/public` —
`root:ikpk-cms 3775`; `.snapshot`, `dist-snapshot`, `dist`, `public/media`, `.astro` и
`node_modules/{.astro,.vite,.cache}` — `ikpk-cms 0755`; `web/src/lib/media-manifest.json` —
`root:ikpk-cms 0664`. Пропуск даёт `EACCES` на кнопке (так уже было: `mkdir dist-snapshot`).

**Подключение и переключение CMS** — на сервере:

```bash
lock=$(sha256sum "$REL/package-lock.json" | cut -c1-16); test -f /opt/ikpk-cms/deps/$lock/.complete
echo "$SHA" > "$REL/.cms-commit"
ln -sfn /opt/ikpk-cms/deps/$lock/node_modules "$REL/node_modules"
ln -sfn /opt/ikpk-cms/shared/uploads "$REL/public/uploads"; chown -h ikpk-cms:ikpk-cms "$REL/public/uploads"
install -d -o ikpk-cms -g ikpk-cms "$REL/.strapi"
echo "$SHA" > /var/lib/ikpk-site-build/.source-commit
sed -i "s/IKPK_INSTALLED_COMMIT=$(cat $BACKUP/cms-commit)\$/IKPK_INSTALLED_COMMIT=$SHA/" /etc/systemd/system/ikpk-cms.service
ln -sfn "$REL" /opt/ikpk-cms/current.new && mv -T /opt/ikpk-cms/current.new /opt/ikpk-cms/current
systemctl daemon-reload && systemctl restart ikpk-cms
```

Перед `sed` убедиться, что строка `IKPK_INSTALLED_COMMIT=<прежний SHA>` в юните есть
(`grep -q`): иначе замена молча ничего не сделает.

## 4. Проверки SHA и здоровья

Ждать `/admin` = 200 **до 30 минут** (`SERVICE_HEALTH_TIMEOUT=1800` в
`deploy/environments/stand.env`: старт Strapi здесь 2–10 минут и больше; 27.09.2026 при установке `7f70578f` — 8 мин 18 с):

```bash
for i in $(seq 1 360); do [ "$(curl -s -m5 -o /dev/null -w '%{http_code}' http://127.0.0.1:1337/admin)" = 200 ] && break; sleep 5; done
```

Затем все три SHA обязаны совпасть с устанавливаемым:

```bash
cat /opt/ikpk-cms/current/.cms-commit
cat /var/lib/ikpk-site-build/.source-commit
systemctl show ikpk-cms -p Environment --value | tr ' ' '\n' | grep ^IKPK_INSTALLED_COMMIT=
```

И ещё: `systemctl is-active ikpk-cms` = `active`; `readlink -f /var/www/ikpk/current` равен
`$BACKUP/site-current` (публичный релиз не переключался); в журнале службы нет `dropColumn`;
фикстуры в `/var/lib/ikpk-site-build/fixtures/content-snapshot/` совпадают по SHA-256 с
`git show $SHA:fixtures/content-snapshot/<файл>`.

Админка снаружи закрыта; вход — туннелем `ssh -N -L 11337:127.0.0.1:1337 root@193.124.115.99`,
затем `http://127.0.0.1:11337/admin` (11337, а не 1337: локальный 1337 может быть занят своим Strapi).

## 5. Обновление контента кнопкой

Кнопку «Обновить сайт» в админке нажимает **владелец под ограниченной ролью** администратора
контента — не установщик: приёмка проверяет именно права этой роли. Кнопка снимает живой снимок,
собирает сайт в `/var/lib/ikpk-site-build/web`, проверяет его по `http://127.0.0.1/release.json`
(`Host: staging.ikpk.su`) и только затем переключает `/var/www/ikpk/current`.
Состояние операции: `/var/www/ikpk/shared/site-refresh/state.json` (`status`, `phase`,
`message`); при `failed` действующий сайт не меняется.

## 6. Откат

Если `/admin` не ответил за срок — вернуть всё из `$BACKUP`:

```bash
ln -sfn "$(cat $BACKUP/cms-release)" /opt/ikpk-cms/current.new && mv -T /opt/ikpk-cms/current.new /opt/ikpk-cms/current
cp -a "$BACKUP/ikpk-cms.service" /etc/systemd/system/ikpk-cms.service
cp -a "$BACKUP/source-commit" /var/lib/ikpk-site-build/.source-commit
# дерево сборки: заново распаковать архив ПРЕЖНЕГО SHA (site_build_archive из его worktree), затем блок прав из шага 3
systemctl daemon-reload && systemctl restart ikpk-cms
```

Копии базы нет намеренно. Поэтому релиз с **миграцией** базы этой процедурой не откатывается
чисто: прежний код встретит уже изменённую схему. Для такого релиза перед установкой снять
`sqlite3 /var/lib/ikpk-cms/stand/data/data.db ".backup $BACKUP/data.db"` вручную. Прежний релиз CMS
остаётся в `/opt/ikpk-cms/releases/`, пока его не вытеснит провижининг.

Публичный сайт этой процедурой не откатывается: он не переключался. Если его переключила кнопка —
откат сайта описан в [docs/deploy-vps.md](deploy-vps.md#откат).
