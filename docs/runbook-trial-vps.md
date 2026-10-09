# Пробное развёртывание на VPS 89.111.143.219

**Статус: проба, не production.** Машина временная и может быть пересоздана. DNS не меняется,
`ikpk.su` остаётся на старом хостинге. Платежи — тестовая роль `ci`, формы — заглушка
(`DEMO_FORMS=stub`): реальных платежей и отправки заявок в CRM нет. Эти упрощения относятся
только к этой машине.

Объявленное состояние — `deploy/environments/trial.env`. Всё ниже воспроизводит машину с нуля.
Серверные команды выполняет владелец в своей root-сессии; из этой ветки на сервер никто не ходит.

## Что проверено, а что нет

| Проверено локально (`bash deploy/trial/selftest.sh`, контейнер ubuntu:26.04) | Проверится только на машине |
|---|---|
| отказ `prepare-host.sh` на чужой ОС, архитектуре и при нехватке места | создание swap, `fstab` |
| копия и восстановление (`backup-exercise.sh`), отказ при расхождении базы | настоящий systemd, Strapi на 1 ГБ |
| `refresh-site.sh` на макете CMS: успех, отказ сборки, неверный вход; пароль и токен не в argv и не в выводе | кнопка «Обновить сайт» целиком, время и пик памяти |
| конфигурация `:443` проходит `nginx -t`, идемпотентна | выпуск IP-сертификата Let's Encrypt |
| провижининг окружения `trial` (`web/tests/trial-environment.test.ts`; контейнерная часть требует места в Docker) | сам `bootstrap-vps.sh` по ssh |
| клиентский `deploy.sh` на моках ssh/curl/npm (`web/tests/trial-deploy-cli.test.ts`): режимы, отказы, СТОП 10, повторный запуск, секреты не в argv | настоящий ssh, Strapi, ключ хоста |

## Главный вход: одна команда на Mac

```bash
# [Mac] в чистом worktree этой ветки; один раз:
export SSH_KEY=~/.ssh/<ключ, авторизованный у root на VPS>   # обязателен, умолчания нет
export EXPECTED_HOST_FINGERPRINT='SHA256:…'     # из консоли провайдера (ожидается ZB2U2ocI…)
deploy/trial/deploy.sh secrets                  # ~/ikpk-trial/secrets.env, 0600, не перезаписывается
deploy/trial/deploy.sh hostkey --trust          # добавляет ключ хоста, только если отпечаток совпал

deploy/trial/deploy.sh plan                     # только чтение: что будет сделано, что пропущено
deploy/trial/deploy.sh run                      # ИЗМЕНЯЕТ сервер; без subcommand ничего не делает
```

`run` идёт по этапам: **preflight** (чистый SHA, ОС/диск, ключ хоста, секреты, зависимости) →
**prepare** (доставка скриптов, swap) → **bootstrap** CMS и дерева сборки → **СТОП (код 10)** на
super-admin и токен Full access → после повторного `run`: **import** → **publish**
(первый выпуск, замер времени и памяти) → **https** → **verify** → **backup**-упражнение.

Остановка — единственное место, где нужен человек. **Формы регистрации первого администратора не
будет:** редактор контента из `secrets.env` создаётся самой CMS при старте, и `/admin/init` сразу
отвечает `hasAdmin: true` (проверено на машине). Редактор не может выпускать токены, поэтому
super-admin создаёт `deploy/trial/deploy.sh superadmin` — штатная интерактивная команда Strapi
`admin:create-user` по `ssh -t` (пароль вводится в терминале, в argv и чат не попадает). Дальше
`deploy.sh tunnel`, вход в `/admin` этим super-admin, Settings → API Tokens → Full access, токен
в `~/ikpk-trial/api-token` (0600) без показа на экране, затем `deploy/trial/deploy.sh run`.
Токен прошлой базы после пересоздания машины сервер отвергнет — `run` скажет это явно.

Повторный запуск безопасен: решения принимаются по **наблюдаемому** состоянию сервера (SHA дерева
сборки, служба, super-admin, `release.json`, сертификат, копия), поэтому пересозданная машина
распознаётся сама. Секреты не пересоздаются; если `secrets.env` изменился после первого развёртывания,
bootstrap отказывается (смена ломает вход и шифрованные поля). Новый SHA — тот же `run`: переустановит
код и выпустит сайт заново; импорт идёт всякий раз, когда на сервере нет `release.json` (в том числе
на пересозданной машине с тем же IP) — он идемпотентен. Зависимости CMS на Mac (`cms/node_modules`)
этап bootstrap ставит сам по lockfile. Отдельный этап — `deploy.sh <prepare|bootstrap|
import|publish|https|verify|backup>`; сброс клиентской памяти для пересозданной машины —
`deploy.sh forget`.

Коды выхода: `0` готово · `1` этап не удался · `2` предпроверка (изменений не было) · `10` ручная
остановка. Секреты не печатаются и не передаются через argv. Пп. 2–11 ниже — то, что делает скрипт,
и ручной режим на случай, когда нужен один шаг.

## Где что выполняется

Каждый блок кода помечен: **[Mac]** — на машине владельца, в корне чистого worktree этой ветки;
**[VPS]** — на сервере. Серверные команды запускаются **с Mac по ssh** через функцию `vps`, чтобы
не было промежуточного «зайти и вставить»; интерактивная root-сессия на сервере годится только для
ручного осмотра. Один раз в сессии терминала на Mac:

```bash
# [Mac]
export SSH_KEY=~/.ssh/<ключ root>          # ключ, чей публичный вариант есть у root на VPS
export VPS_IP=89.111.143.219
vps() { ssh -i "$SSH_KEY" "root@${VPS_IP}" "$@"; }
```

Серверные скрипты пробы устанавливаются на сервер **один раз и в фиксированный путь**
`/opt/ikpk-trial/bin/` (п. 2) и дальше вызываются только по этому пути. Репозитория на сервере нет.

## 0. Сверить ключ хоста

В консоли провайдера открыть отпечаток ключа ED25519 сервера и сравнить с записью в `known_hosts`
рабочего места: `ED25519 SHA256:ZB2U2ocIxD4VQ4cMNtmO2b4vWdh1IiIqfTi0Of3i0pg`. Не совпал — стоп.

## 1. Секреты

```bash
# [Mac]
bash deploy/trial/gen-secrets.sh          # создаёт ~/ikpk-trial/secrets.env, 0600, не перезаписывает
```

Файл вне репозитория; значения не печатаются. В чат и в Git их не отправлять. Пароль
администратора контента — внутри файла (`CONTENT_ADMIN_PASSWORD`).

## 2. Установить скрипты пробы и подготовить хост

```bash
# [Mac] доставка четырёх серверных скриптов в /opt/ikpk-trial/bin (root:root, 0755)
COPYFILE_DISABLE=1 tar -C deploy/trial -cf - \
    prepare-host.sh setup-https-ip.sh refresh-site.sh backup-exercise.sh \
  | vps 'install -d -o root -g root -m 0755 /opt/ikpk-trial/bin \
         && tar -C /opt/ikpk-trial/bin --no-same-owner -xf - \
         && chown -R root:root /opt/ikpk-trial/bin && chmod 0755 /opt/ikpk-trial/bin/*.sh \
         && ls -l /opt/ikpk-trial/bin'

# [Mac → VPS] выполняется на сервере
vps /opt/ikpk-trial/bin/prepare-host.sh
```

Повторная доставка после правки скриптов — той же командой (перезапись на месте). Проверяет Ubuntu 26.04 x86_64 и свободное место, создаёт `/swapfile` 2 ГБ (`SWAP_MB`) и строку в
`/etc/fstab`. Повторный запуск — `unchanged`.

## 3. Выкатить CMS и дерево сборки сайта

Из **чистого** worktree этой ветки (`web`, `media-originals`, `cms/src` без изменений: скрипт
отказывает на грязном дереве). SHA, который попадёт в `release.json`, — `HEAD` этой ветки.

```bash
# [Mac] сборка артефакта и запуск bootstrap (сам ходит на сервер по ssh)
scripts/build-cms-artifact.sh /tmp/ikpk-cms-artifact-trial
set -a; . ~/ikpk-trial/secrets.env; set +a
ENVIRONMENT=trial DOMAIN="$VPS_IP" SSH_KEY="$SSH_KEY" \
  CMS_ARTIFACT_SOURCE=/tmp/ikpk-cms-artifact-trial \
  bash scripts/bootstrap-vps.sh "$VPS_IP"
```

Что произойдёт: пакеты из `trial.env`, пользователь `ikpk-cms`, база SQLite в
`/var/lib/ikpk-cms/trial/data`, файл секретов `/etc/ikpk-cms/trial.env` (0600), артефакт CMS,
дерево сборки сайта в `/var/lib/ikpk-site-build` (+ `.source-commit`), `npm ci`, юнит
`ikpk-cms.service` с `DEMO_FORMS=stub`, `PAYMENT_ROLE=ci`, vhost nginx на `:80`. Ожидание старта
службы — до `SERVICE_HEALTH_TIMEOUT=1800` с; при неудаче артефакт откатывается.

**Ожидаемая длительность на 1 vCPU / ~1 ГБ (замеры стенда):** `npm ci` ≈ 20 мин, первый старт
Strapi 8–14 мин. Это не зависание; прерывать не нужно.

**После этого шага сайта ещё НЕТ.** Проверено по коду: `bootstrap-vps.sh` не собирает сайт, не
запускает съём и не создаёт `release.json`; vhost раздаёт `/var/www/ikpk/current`, а этой ссылки
до первого выпуска (п. 6) не существует, то есть сайт по `http://${VPS_IP}/` не отдаётся (nginx без `current` отвечает ошибкой). Признак успеха
этого шага — только то, что команда завершилась без ошибки, а служба активна:
`vps systemctl is-active ikpk-cms`. Панель CMS по HTTP **не публикуется**.

## 4. Super-admin и токен (вручную, через туннель, до HTTPS)

Форма регистрации не появится: редактор контента (`CONTENT_ADMIN_EMAIL` / `CONTENT_ADMIN_PASSWORD`
из `secrets.env`) создан CMS при старте, `hasAdmin` уже `true`. Super-admin нужен, чтобы выпустить
токен для п. 5; создаётся штатной командой Strapi, интерактивно:

```bash
# [Mac → VPS] интерактивно, пароль вводится в терминале
deploy/trial/deploy.sh superadmin
```

Редактор нужен для п. 6 (кнопка и `refresh-site.sh`).

```bash
# [Mac] туннель держать открытым (отдельное окно терминала) до конца п. 5
ssh -i "$SSH_KEY" -N -L 1337:127.0.0.1:1337 "root@${VPS_IP}"
# [Mac, браузер] http://127.0.0.1:1337/admin → войти super-admin → Settings → API Tokens → Full access
```

## 5. Наполнить CMS (обязательно для первого выпуска)

Съём содержимого **отказывает на пустой CMS**: типы `institutes`, `course_groups`, `seminars`,
`articles`, `teachers` обязаны быть непустыми, иначе снимок не записывается
(`web/scripts/capture-content-snapshot.ts`, `SKELETON_TYPES`). Поэтому первый выпуск на пустой CMS
невозможен, а импорт — не «необязательный».

```bash
# [Mac] в панели (через туннель) создать временный API-токен «Full access»;
# значение вставить только в окружение этого терминала, не в чат и не в файл
read -rs STRAPI_API_TOKEN; export STRAPI_API_TOKEN
export STRAPI_URL=http://127.0.0.1:1337
( cd scripts && npm ci && npm run import:dry )   # сначала сухой прогон
( cd scripts && npm run import )                  # затем настоящий (данные — discovery/entities)
```

После импорта токен удалить в панели. Не проверено: сколько времени займёт импорт медиа на этой
машине и пройдёт ли съём п. 6 на импортированных данных — это покажет п. 6; сбой съёма там —
блокер, его вывод нужно прислать как есть.

## 6. Первый выпуск сайта (создаёт `release.json`)

```bash
# [Mac → VPS] выполняется на сервере; читает учётку редактора из /etc/ikpk-cms/trial.env,
# пароль и токен не попадают ни в argv, ни в вывод
vps /opt/ikpk-trial/bin/refresh-site.sh
```

Скрипт входит под учёткой редактора и запускает тот же маршрут, что кнопка «Обновить сайт»:
съём → сборка под `MemoryMax=550M` → запись `releases/content-<ts>` с `release.json` → атомарное
переключение `current` → сверка пары `commit` + `snapshotId` с раздачей. Печатает статус,
**длительность и минимум `MemAvailable`** — их записать в отчёт пробы. На 1 ГБ без swap сборка не
помещается, со swap 2 ГБ помещается, но медленно (стенд: 17–24 мин, TD-74).

**Сайт считается работающим только после этого шага**, и только если статус `succeeded`:

```bash
# [Mac]
curl -s "http://${VPS_IP}/release.json"            # commit = SHA из п. 3, snapshotId заполнен
curl -sI "http://${VPS_IP}/" | head -1              # HTTP/1.1 200 OK
```

## 7. HTTPS по IP

```bash
# [Mac → VPS] выполняется на сервере
vps /opt/ikpk-trial/bin/setup-https-ip.sh "$VPS_IP"
```

certbot 5.8.0 в `/opt/certbot` (штатный 4.0.0 в Ubuntu 26.04 IP не умеет), сертификат профиля
`shortlived` на ~6,5 суток, `:443` в `/etc/nginx/conf.d/ikpk-trial-tls.conf`, таймер продления
дважды в сутки. Панель CMS доступна по `https://89.111.143.219/admin` (браузер на Mac).

Названные ограничения: продление идёт через `--standalone`, то есть nginx **останавливается на
секунды** при каждом продлении. Проверка на Mac: `curl -sv "https://${VPS_IP}/"` — сертификат
принят без `-k`. Не выпустился — это блокер пробы, а не повод переходить на самоподписанный.

## 8. Сценарий редактора

1. `https://89.111.143.219/admin` → войти учётной записью редактора.
2. Создать семинар, опубликовать.
3. Нажать «Обновить сайт», дождаться статуса «Готово».
4. Страница семинара появилась на `https://89.111.143.219/`; в `release.json` сменился
   `snapshotId`.

Тот же маршрут без UI — `vps /opt/ikpk-trial/bin/refresh-site.sh` (п. 6).

## 9. Выкладка нового кода (без кнопки)

Фиксированный порядок, каждый шаг на машине владельца:

1. Взять SHA `main` с успешным `Tests` (`refs/heads/main`, push/schedule).
2. Чистый worktree на этом SHA (ветку пробы перебазировать на него).
3. Повторить п. 3 (артефакт CMS + `bootstrap-vps.sh`): он доставит новое дерево сборки и
   `.source-commit`.
4. `[Mac → VPS]` `vps /opt/ikpk-trial/bin/refresh-site.sh` — собирает сайт на новом коде и проверяет
   пару `commit` + `snapshotId`.
5. `[Mac]` сверить `curl -s "http://${VPS_IP}/release.json"`: `commit` равен выпущенному SHA.

## 10. Откат

- Сайт на предыдущий релиз (тот же маршрут, что «Откатить» в UI; атомарная смена `current`):

  ```bash
  # [Mac → VPS] выполняется на сервере
  vps /opt/ikpk-trial/bin/refresh-site.sh restore
  ```

- CMS на предыдущий артефакт: bootstrap делает это сам при неудачном старте; вручную:

  ```bash
  # [Mac → VPS] выполняется на сервере; сначала посмотреть, какие релизы есть
  vps 'ls -1 /opt/ikpk-cms/releases; readlink /opt/ikpk-cms/current'
  vps 'ln -sfn releases/<прежний> /opt/ikpk-cms/current && systemctl restart ikpk-cms'
  ```

## 11. Резервная копия и восстановление (упражнение)

```bash
# [Mac → VPS] выполняется на сервере
vps /opt/ikpk-trial/bin/backup-exercise.sh backup   # sqlite .backup + integrity_check + restic
vps /opt/ikpk-trial/bin/backup-exercise.sh verify   # восстановление в одноразовый каталог и сверка
```

Репозиторий restic — `/var/backups/ikpk-trial/restic`, ключ — `/etc/ikpk-backup/restic.pass`
(создаётся на сервере). **Это не копия вне VPS:** она на том же диске. Чтобы упражнение стало
off-site, владелец забирает репозиторий и ключ **в разные места**. Ключ при этом не печатается
на экран:

```bash
# [Mac] репозиторий копий
rsync -a -e "ssh -i $SSH_KEY" "root@${VPS_IP}:/var/backups/ikpk-trial/restic/" ~/ikpk-trial/restic-copy/
# [Mac] ключ restic — в отдельный файл 0600, лучше затем в менеджер паролей
( umask 077; vps cat /etc/ikpk-backup/restic.pass > ~/ikpk-trial/restic.pass )
```

Окончательное хранилище выбирается до реального запуска.

## 12. Что теряется при пересоздании машины

| Что | Где лежит | Теряется | Как восстановить |
|---|---|---|---|
| База CMS (SQLite) и загрузки | `/var/lib/ikpk-cms/trial/data`, `/opt/ikpk-cms/shared/uploads` | да | из копии (п. 11) или заново п. 4–5 |
| Секреты CMS | `/etc/ikpk-cms/trial.env` | да | повторить п. 3 с тем же `secrets.env`; **смена секретов ломает вход и шифрованные поля** |
| Super-admin Strapi | в базе | да | п. 4 |
| Ключ restic | `/etc/ikpk-backup/restic.pass` | да, и тогда копии нечитаемы | хранить вне VPS |
| Скрипты пробы | `/opt/ikpk-trial/bin` | да | п. 2 (доставка заново) |
| Сертификат | `/etc/letsencrypt` | да | п. 7 (лимиты Let's Encrypt на выпуск) |
| Swap | `/swapfile` | да | п. 2 (`prepare-host.sh`) |
| Релизы сайта | `/var/www/ikpk/releases` | да | `vps /opt/ikpk-trial/bin/refresh-site.sh` (п. 6) или п. 9 |

Повтор с нуля (всё с Mac): `vps`-функция → пп. 2 (установка скриптов и подготовка хоста) → 3 → 4 → 5 (импорт) → 6 (первый выпуск) → 7 (HTTPS), затем 8. Переменные: `ENVIRONMENT=trial`, `DOMAIN`, `SSH_KEY`, `VPS_IP`,
`CMS_ARTIFACT_SOURCE`, секреты из `secrets.env`; прочее объявлено в `trial.env`.

## 13. Честные ограничения пробы

- 1 ГБ RAM + временный swap 2 ГБ; времена и пик памяти — по замеру п. 6 (первый выпуск), а не по обещанию.
- SQLite — рабочая гипотеза, а не утверждённое решение владельца; в `cms` нет драйвера `pg`.
- Старый `deploy/environments/prod.env` (Debian 13, Postgres) этой пробой **не исполнен** и не
  проверен.
- Оплата `ci` и формы-заглушка — не боевой режим; выбор режима за владельцем.
- Нет автоматического отката по сбою проверки после переключения, нет мониторинга.
- OpenSpec не заводился по прямому указанию владельца; расхождение между спеками
  `site-refresh-from-cms` и `manual-publication-only` не разрешено — перед реальным запуском
  его надо закрыть.

## 14. Открытые решения владельца

1. **RAM** — оставить 1 ГБ или увеличить (по измеренным длительности и пику).
2. **Хранилище копий вне VPS** — S3/restic (рекомендовано; нужны endpoint, бакет, ключ доступа,
   отдельный от ключа restic) или pull на Mac владельца (бесплатно, но зависит от доступности Mac).
3. **Оплата** — режим для боевого запуска.
