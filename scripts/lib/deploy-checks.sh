#!/usr/bin/env bash
# Проверки деплоя, вынесенные из deploy-web.sh отдельным файлом.
#
# Зачем вынесены: оба блока стоят ПОСЛЕ ssh-вызовов (preflight — за `ssh nginx -T`,
# health-check — за переключением symlink), поэтому запуском самого скрипта до них
# не дойти без реального хоста. Существующие проверки в repo-hygiene.test.ts
# работают лишь потому, что отказы по DEPLOY_MODE стоят до всякой сети. Без выноса
# у этих двух проверок не было бы поведенческого теста вовсе — только греп
# исходника, то есть утверждение о тексте, а не о поведении.

# Подключает ли РАЗВЁРНУТАЯ конфигурация файл редиректов НАШЕГО сайта.
# Читает вывод `nginx -T` со stdin. Аргумент — опорный фрагмент пути, обычно имя
# каталога сайта (`${WEB_ROOT##*/}`); без него проверка засчитает `nginx-redirects.conf`
# любого постороннего vhost на том же хосте.
#
# Требуется НЕЗАКОММЕНТИРОВАННАЯ директива include, оканчивающаяся `;`. Прежняя
# проверка искала любое упоминание имени файла где угодно в выводе, поэтому
# закомментированный `# include …` проходил её при мёртвых правилах, а деплой
# выглядел успешным.
#
# Форма шаблона: путь может быть в кавычках (nginx это допускает), а директива —
# не первой в строке, поэтому якорь `(^|;)`, а не `^`. Оба случая давали ложное
# «include отсутствует» и останавливали исправный деплой.
redirects_include_active() {
  local marker="${1:-}"
  grep -Eq "(^|;)[[:space:]]*include[[:space:]]+[\"']?[^;#\"']*${marker}[^;#\"']*nginx-redirects\.conf[\"']?[[:space:]]*;"
}

# Хост из URL, без схемы, порта и пути.
url_host() {
  local rest="${1#*://}"
  rest="${rest%%/*}"
  rest="${rest%%\?*}"
  printf '%s' "${rest%%:*}"
}

# Отвечает ли сайт по адресу: редирект проходится осознанно, на конечной странице
# требуется 200 И тот же хост, что запрашивали.
#
# Прежняя проверка `curl -fsS` без `-L` выходила с нулём на 3xx: `-f` роняет только
# на кодах ≥400. После появления 80→443 (certbot) она печатала бы «Health check OK»,
# ни разу не открыв сайт.
#
# Хост сверяется намеренно, и это не перестраховка: без сверки проверка засчитывает
# 200, полученный СОВСЕМ С ДРУГОГО САЙТА, куда увёл редирект. Проверено запуском —
# при `301 → чужой хост, отдающий 200` функция возвращала 0. Порт и схему не
# сравниваем: штатный 80→443 меняет именно их.
health_check() {
  local url="$1" out code effective
  out="$(curl -sS -L -o /dev/null --max-time 10 -w '%{http_code} %{url_effective}' "$url" 2>/dev/null)" || {
    echo "health_check: запрос к ${url} не выполнен" >&2
    return 1
  }
  code="${out%% *}"
  effective="${out#* }"

  if [ "$code" != "200" ]; then
    echo "health_check: ${url} вернул ${code}, ожидался 200" >&2
    return 1
  fi
  if [ "$(url_host "$effective")" != "$(url_host "$url")" ]; then
    echo "health_check: редирект увёл на чужой хост — запрошен ${url}, отвечал ${effective}" >&2
    return 1
  fi
}

# ── Гейт адреса платёжной формы (задача 6.1) ─────────────────────────────────
#
# Вынесен сюда по той же причине, что и проверки выше: он стоит в `deploy-web.sh`
# ПОСЛЕ ssh-загрузки релиза, поэтому запуском самого скрипта до него не дойти без
# реального хоста, и без выноса у него был бы только греп исходника — утверждение о
# тексте, а не о поведении.
#
# Отдельный проход, а не расширение проверки форм: у формы оплаты нет `href`, её адрес
# живёт в атрибуте, и `grep 'href="..."'` его не увидит по построению. Признак —
# БУКВАЛЬНОЕ равенство, а не regex по образцу хоста: у нашего эндпоинта один
# канонический адрес, в отличие от нескольких порталов Bitrix24.
#
# Аргументы: <каталог сборки> <ожидаемый адрес> <ожидаемая роль ci|preview|stand|prod>.
#
# ПЕРЕПИСАНО по Решению 13 (design.md) и задачам 6.13/6.14: булев признак
# `data-payment-demo` удалён решением владельца 2026-08-18, третий аргумент — РОЛЬ
# сборки, а не флаг. Роль определяет ожидаемый артефакт целиком: у `ci` эндпоинта нет
# вовсе (ноль — законное состояние, а не «проверить не удалось»), у остальных трёх ролей
# ожидается ровно набор адресов, буквально равных `expect_endpoint`.
#
# Ноль найденных атрибутов РОЛИ — ОТКАЗ при любой ожидаемой роли: «роль не объявлена» —
# непройденная проверка, а не «предмета нет» (спека `deploy-gating`, сценарий «роль не
# объявлена»). Проверяется ОТДЕЛЬНЫМ явным счётчиком, а не через `grep -vxF` по
# ожидаемому значению — F1 (сессия красных тестов 2026-08-19): пустой список после
# `grep -vxF` даёт пустую строку после подстановки команды (трейлинг-перевод строки
# срезается), и «проверять нечего» читался бы как «совпало».
payment_endpoint_matches() {
  local dist="${1:-}" expect_endpoint="${2:-}" expect_role="${3:-}"
  if [[ ! -d "$dist" ]]; then
    echo "каталога сборки нет: $dist — проверка платёжного эндпоинта не выполнена" >&2
    return 1
  fi

  local roles rc_r
  set +e
  roles=$(grep -roh 'data-payment-role="[^"]*"' "$dist" --include='*.html' 2>/dev/null \
    | sed 's/^data-payment-role="//; s/"$//' | sort -u)
  rc_r="${PIPESTATUS[0]}"
  set -e
  if (( rc_r > 1 )); then
    echo "не удалось прочитать $dist при поиске роли (grep код $rc_r) — проверка не выполнена" >&2
    return 1
  fi
  local role_count
  role_count=$(printf '%s\n' "$roles" | grep -c . || true)
  if (( role_count == 0 )); then
    echo "в сборке не объявлена ни одна роль (data-payment-role) — проверять нечего" >&2
    echo "ожидалась роль: $expect_role" >&2
    return 1
  fi

  local wrong
  wrong=$(printf '%s\n' "$roles" | grep -vxF "$expect_role" || true)
  if [[ -n "$wrong" ]]; then
    echo "объявленная роль не равна ожидаемой ($expect_role):" >&2
    printf '%s\n' "$wrong" | head -5 >&2
    return 1
  fi

  # Опознавательный признак формы (условие (1) спеки «Активная форма» — независимо от
  # объявленного эндпоинта): найдено независимым ревью (F-3, 2026-08-20). Прежняя
  # редакция проверяла только `data-payment-role`/`data-payment-endpoint`, которые могли
  # оказаться на ЛЮБОМ элементе, а не именно на `<form>` — то есть артефакт, объявляющий
  # роль и эндпоинт без единой формы на странице, проходил бы гейт.
  local forms rc_form
  set +e
  forms=$(grep -roh -E '<form\b[^>]*\bdata-payment-form\b' "$dist" --include='*.html' 2>/dev/null)
  rc_form="${PIPESTATUS[0]}"
  set -e
  if (( rc_form > 1 )); then
    echo "не удалось прочитать $dist при поиске признака формы (grep код $rc_form) — проверка не выполнена" >&2
    return 1
  fi
  local form_count
  form_count=$(printf '%s\n' "$forms" | grep -c . || true)

  local endpoints rc_e
  set +e
  endpoints=$(grep -roh 'data-payment-endpoint="[^"]*"' "$dist" --include='*.html' 2>/dev/null \
    | sed 's/^data-payment-endpoint="//; s/"$//' | sort -u)
  rc_e="${PIPESTATUS[0]}"
  set -e
  if (( rc_e > 1 )); then
    echo "не удалось прочитать $dist при поиске эндпоинта (grep код $rc_e) — проверка не выполнена" >&2
    return 1
  fi
  local endpoint_count
  endpoint_count=$(printf '%s\n' "$endpoints" | grep -c . || true)

  # Роль `ci` не несёт эндпоинта по контракту роли (Requirement «Роль определяет
  # ожидаемый артефакт целиком»): найденный адрес — тоже отказ, даже мок-адрес preview,
  # потому что он всё равно обещает контур, которого в артефакте нет.
  if [[ "$expect_role" == "ci" ]]; then
    if (( endpoint_count != 0 || form_count != 0 )); then
      echo "роль ci не несёт формы и объявленного эндпоинта по контракту роли, а сборка объявляет:" >&2
      printf '%s\n' "$endpoints" | head -5 >&2
      (( form_count != 0 )) && echo "форм с data-payment-form: $form_count" >&2
      return 1
    fi
    printf 'платёжная роль: %s, формы и эндпоинта нет — по контракту роли\n' "$expect_role"
    return 0
  fi

  if (( endpoint_count == 0 )); then
    echo "в сборке роли $expect_role нет ни одного data-payment-endpoint — проверять нечего" >&2
    echo "ожидался адрес: $expect_endpoint" >&2
    return 1
  fi
  if (( form_count == 0 )); then
    echo "в сборке роли $expect_role объявлен эндпоинт, но опознавательного признака формы (data-payment-form) нет ни на одном <form> — проверять нечего" >&2
    return 1
  fi

  wrong=$(printf '%s\n' "$endpoints" | grep -vxF "$expect_endpoint" || true)
  if [[ -n "$wrong" ]]; then
    echo "адрес платёжного эндпоинта не равен ожидаемому ($expect_endpoint):" >&2
    printf '%s\n' "$wrong" | head -5 >&2
    return 1
  fi
  printf 'платёжная роль: %s, форм: %d, эндпоинт: %d адрес(ов), все равны %s\n' \
    "$expect_role" "$form_count" "$endpoint_count" "$expect_endpoint"
}

# ── Гейт readiness установленного контура (задача 6.13) ─────────────────────
#
# Единственное доказательство личности контура, которое принимает гейт (спека,
# Requirement «Личность контура сообщается несекретным readiness-ответом»): совпадение
# адреса ничего не доказывает — за ним может стоять другой процесс или другой магазин.
# Аргументы: <адрес /readyz, изнутри host> <ожидаемый mode> <ожидаемый shopId>.
#
# «Ответил, но не тем» и «не ответил вовсе» не различаются намеренно — оба
# останавливают публикацию тем же способом (спека: «гейту нужен положительный признак
# ожидаемого контура, а не отсутствие отрицательного»).
payment_readiness_matches() {
  local url="${1:-}" expect_mode="${2:-}" expect_shop="${3:-}"
  local raw code body
  raw="$(curl -sS --max-time 10 -w $'\n%{http_code}' "$url" 2>/dev/null)" || {
    echo "payment_readiness_matches: запрос к $url не выполнен" >&2
    return 1
  }
  code="${raw##*$'\n'}"
  body="${raw%$'\n'*}"
  if [[ "$code" != "200" ]]; then
    echo "payment_readiness_matches: $url вернул ${code:-<нет ответа>}, ожидался 200" >&2
    return 1
  fi
  # Разбор — в node, а не sed/grep: состав ответа проверяется ИСЧЕРПЫВАЮЩЕ (ровно три
  # поля, лишнее — тоже отказ), и это надёжнее делать структурным разбором JSON, чем
  # текстовым совпадением, которое не отличит лишнее поле от значения внутри строки.
  if ! node -e '
      const [body, mode, shop] = process.argv.slice(1);
      let parsed;
      try { parsed = JSON.parse(body); } catch { process.exit(1); }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) process.exit(1);
      const keys = Object.keys(parsed).sort();
      if (JSON.stringify(keys) !== JSON.stringify(["mode", "shopId", "status"])) process.exit(1);
      if (parsed.status !== "ready" || parsed.mode !== mode || parsed.shopId !== shop) process.exit(1);
    ' "$body" "$expect_mode" "$expect_shop"
  then
    echo "payment_readiness_matches: $url ответил, но не подтвердил mode=$expect_mode shopId=$expect_shop:" >&2
    printf '%s\n' "$body" | head -c 300 >&2
    echo >&2
    return 1
  fi
}

# ── Гейт CORS кросс-origin контура (задача 6.13) ─────────────────────────────
#
# Только для контура, у которого API раздаётся на origin, отличном от origin сайта
# (спека, Requirement «CORS ограничен доменом сайта»); у стенда его нет — same-origin
# запрос браузер не сверяет с CORS вовсе. Аргументы: <объявленная база API> <origin сайта>.
payment_cors_allows() {
  local base="${1:-}" origin="${2:-}"
  local headers allow
  headers="$(curl -sS --max-time 10 -X OPTIONS -H "Origin: ${origin}" -D - -o /dev/null "${base}/payments" 2>/dev/null)" || {
    echo "payment_cors_allows: запрос OPTIONS к ${base}/payments не выполнен" >&2
    return 1
  }
  allow=$(printf '%s' "$headers" | tr -d '\r' | grep -i '^access-control-allow-origin:' \
    | sed -E 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin:[[:space:]]*//' | tail -1)
  if [[ -z "$allow" ]]; then
    echo "payment_cors_allows: ${base}/payments не вернул Access-Control-Allow-Origin — отказ, а не «проверять нечего»" >&2
    return 1
  fi
  if [[ "$allow" != "$origin" ]]; then
    echo "payment_cors_allows: Access-Control-Allow-Origin=$allow, ожидался $origin" >&2
    return 1
  fi
}

# ── Проба доступности публичного пути (задача 6.13) ──────────────────────────
#
# `OPTIONS <объявленная база>/payments` → `204`: проба SHALL NOT создавать запись,
# расходовать попытку оплаты или обращаться к ЮKassa (спека, Requirement «Установленные
# платёжные контуры нельзя публиковать выключенными или перепутанными») — поэтому POST и
# GET .../status здесь не годятся, ровно один запрос методом OPTIONS. Функция сама
# дописывает `/payments`: в артефакте объявлена БАЗА (клиент дописывает путь так же).
payment_endpoint_reachable() {
  local base="${1:-}"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X OPTIONS "${base}/payments" 2>/dev/null) || {
    echo "payment_endpoint_reachable: запрос OPTIONS к ${base}/payments не выполнен" >&2
    return 1
  }
  if [[ "$code" != "204" ]]; then
    echo "payment_endpoint_reachable: ${base}/payments ответил ${code:-<нет ответа>}, ожидался 204" >&2
    return 1
  fi
}

# ── Гейт секретов в артефакте (задача 6.2) ───────────────────────────────────
#
# Отдельная проверка от гейта адреса: они стерегут разные утечки — ЗНАЧЕНИЕ секрета
# против АДРЕСА назначения. Аргументы: <каталог сборки> <ИМЯ=значение>…
#
# Пустой список значений — ОТКАЗ, а не проход: «нечего искать» означает «проверить не
# удалось». Явный отказ оформляется вызывающей стороной, а не молчанием здесь.
dist_has_no_secret_values() {
  local dist="${1:-}"; shift || true
  if [[ ! -d "$dist" ]]; then
    echo "каталога сборки нет: $dist — проверка секретов не выполнена" >&2
    return 1
  fi
  if (( $# == 0 )); then
    echo "ни одного значения для поиска не передано — проверка секретов не выполнена" >&2
    return 1
  fi

  local pair name value hits rc leaked=()
  for pair in "$@"; do
    name="${pair%%=*}"
    value="${pair#*=}"
    if [[ -z "$value" ]]; then
      echo "значение $name пустое — проверка секретов не выполнена" >&2
      return 1
    fi
    set +e
    hits=$(grep -rlF -- "$value" "$dist" 2>/dev/null | head -5)
    rc=$?
    set -e
    if (( rc > 1 )); then
      echo "не удалось прочитать $dist при поиске $name (grep код $rc) — проверка не выполнена" >&2
      return 1
    fi
    [[ -n "$hits" ]] && leaked+=("$name: $(printf '%s ' $hits)")
  done
  if (( ${#leaked[@]} > 0 )); then
    echo "в сборке найдены значения секретов:" >&2
    printf '%s\n' "${leaked[@]}" >&2
    return 1
  fi
  printf 'секреты в сборке: искали %d значени(й), ни одного не найдено\n' "$#"
}
