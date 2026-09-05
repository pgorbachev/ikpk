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

  # Признаки активной формы (условия (1) и (2) спеки «Активная форма») проверяются НА
  # ОДНОМ элементе <form>: найдено независимым ревью (F-3, 2026-08-20), ужесточено по
  # находке ревью владельца (P1, 2026-08-20). Прежняя редакция считала формы и эндпоинты
  # РАЗДЕЛЬНО — форма без эндпоинта плюс `data-payment-endpoint` на любом другом элементе
  # складывались в проход. Теперь эндпоинт извлекается только изнутри тега формы с
  # `data-payment-form`, а КАЖДОЕ вхождение признака эндпоинта в HTML обязано лежать в
  # таком теге: расхождение счётчиков — признак на чужом элементе, отказ.
  # Извлечение построчное (тег формы целиком на одной строке — как в реальной сборке);
  # многострочный тег не прошёл бы молча: он не попал бы в form_tags, и гейт упал бы
  # либо по «ноль форм», либо по расхождению счётчиков — отказ, а не ложный проход.
  local form_tags rc_form
  set +e
  form_tags=$(grep -roh -E '<form\b[^>]*>' "$dist" --include='*.html' 2>/dev/null \
    | grep -E '\bdata-payment-form\b')
  rc_form="${PIPESTATUS[0]}"
  set -e
  if (( rc_form > 1 )); then
    echo "не удалось прочитать $dist при поиске признака формы (grep код $rc_form) — проверка не выполнена" >&2
    return 1
  fi
  local form_count
  form_count=$(printf '%s\n' "$form_tags" | grep -c . || true)

  local endpoint_all rc_e
  set +e
  endpoint_all=$(grep -roh 'data-payment-endpoint="[^"]*"' "$dist" --include='*.html' 2>/dev/null)
  rc_e="${PIPESTATUS[0]}"
  set -e
  if (( rc_e > 1 )); then
    echo "не удалось прочитать $dist при поиске эндпоинта (grep код $rc_e) — проверка не выполнена" >&2
    return 1
  fi
  local endpoint_total
  endpoint_total=$(printf '%s\n' "$endpoint_all" | grep -c . || true)

  # Вхождения эндпоинта внутри тегов активной формы — и формы, объявленные без него.
  local endpoints_in_forms forms_without_endpoint
  endpoints_in_forms=$(printf '%s\n' "$form_tags" | grep -oh 'data-payment-endpoint="[^"]*"' || true)
  # Сначала отбросить пустые строки: `grep -c -v` на пустом входе насчитал бы 1.
  forms_without_endpoint=$(printf '%s\n' "$form_tags" | grep . | grep -c -v 'data-payment-endpoint="' || true)
  local endpoint_in_form_count
  endpoint_in_form_count=$(printf '%s\n' "$endpoints_in_forms" | grep -c . || true)

  local endpoints
  endpoints=$(printf '%s\n' "$endpoints_in_forms" | sed 's/^data-payment-endpoint="//; s/"$//' | sort -u)
  local endpoint_count
  endpoint_count=$(printf '%s\n' "$endpoints" | grep -c . || true)

  # Роль `ci` не несёт эндпоинта по контракту роли (Requirement «Роль определяет
  # ожидаемый артефакт целиком»): найденный адрес — тоже отказ, даже мок-адрес preview,
  # потому что он всё равно обещает контур, которого в артефакте нет.
  if [[ "$expect_role" == "ci" ]]; then
    if (( endpoint_total != 0 || form_count != 0 )); then
      echo "роль ci не несёт формы и объявленного эндпоинта по контракту роли, а сборка объявляет:" >&2
      printf '%s\n' "$endpoint_all" | sort -u | head -5 >&2
      (( form_count != 0 )) && echo "форм с data-payment-form: $form_count" >&2
      return 1
    fi
    printf 'платёжная роль: %s, формы и эндпоинта нет — по контракту роли\n' "$expect_role"
    return 0
  fi

  if (( form_count == 0 )); then
    echo "в сборке роли $expect_role нет ни одной формы с data-payment-form — проверять нечего" >&2
    echo "ожидался адрес на форме: $expect_endpoint" >&2
    return 1
  fi
  if (( forms_without_endpoint != 0 )); then
    echo "в сборке роли $expect_role форм(ы) с data-payment-form без data-payment-endpoint НА ТОМ ЖЕ теге: $forms_without_endpoint — признаки активной формы обязаны быть на одном элементе" >&2
    return 1
  fi
  if (( endpoint_total != endpoint_in_form_count )); then
    echo "data-payment-endpoint найден вне тега активной формы: всего вхождений $endpoint_total, внутри форм $endpoint_in_form_count — признак на чужом элементе останавливает публикацию" >&2
    return 1
  fi
  if (( endpoint_count == 0 )); then
    echo "в сборке роли $expect_role нет ни одного data-payment-endpoint на форме — проверять нечего" >&2
    echo "ожидался адрес: $expect_endpoint" >&2
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

# ── Гейт встраивания виджета чата (change external-widgets) ─────────────────
#
# Симметричный контроль встраивания чата на выкладке — тем же способом, которым гейт уже
# проверяет ссылки форм (`form_links_match_mode`) и платёжный эндпоинт
# (`payment_endpoint_matches`).
#
# Аргументы: <каталог сборки> <режим stand|prod> <сырое значение CHAT_LOADER_SRC>.
#
# ТРЕТИЙ АРГУМЕНТ — СЫРОЕ значение конфигурации, а не вывод из него. Три состояния
# (spec, «Три состояния конфигурации, различимые по построению»): адрес со схемой —
# состояние «адрес задан»; ровно `none` — «отсутствие объявлено явно»; всё прочее
# (пусто, без схемы, `javascript:` без `//`) — «не объявлено ничего». Разбор — ТЕМ ЖЕ
# правилом, что `readChatLoaderConfig` в web/src/lib/external-widgets.ts, продублирован
# здесь в node, потому что потребитель этот — bash-скрипт выкладки, а не сборка Astro.
#
# «Несёт чат» проверяется по-разному для двух состояний (расхождение состояний намеренно,
# не общий признак): для состояния «адрес задан» — литеральная подстрока САМОГО адреса
# (иначе сборка с ДРУГИМ адресом загрузчика на том же фасаде прошла бы как «несёт» —
# сценарий «адрес не тот»); для «отсутствие»/«не объявлено» — литеральная подстрока
# `data-chat-facade`, наш контейнер.
#
# `unspecified` — ОТКАЗ независимо от режима и вывода: объявление конфигурации есть
# решение человека, и его отсутствие не заменяется выводом из состава сборки (spec,
# сценарий 5 «конфигурация не объявлена»).
chat_widget_matches_mode() {
  local dist="${1:-}" mode="${2:-}" raw="${3:-}"
  if [[ ! -d "$dist" ]]; then
    echo "chat_widget_matches_mode: каталога сборки нет: $dist — проверка встраивания чата не выполнена" >&2
    return 1
  fi

  case "$mode" in
    prod|stand) ;;
    *)
      echo "chat_widget_matches_mode: неизвестный режим '${mode}' — проверка встраивания чата не выполнена" >&2
      return 1
      ;;
  esac

  # Разбор состояния — тем же правилом, что readChatLoaderConfig (web/src/lib/
  # external-widgets.ts): строка со схемой → address; ровно 'none' → declared-absent;
  # всё прочее → unspecified. Продублировано намеренно (см. комментарий выше функции).
  local parsed state src
  parsed=$(node -e '
      const raw = process.argv[1];
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        process.stdout.write("address\t" + raw);
      } else if (raw === "none") {
        process.stdout.write("declared-absent\t");
      } else {
        process.stdout.write("unspecified\t");
      }
    ' "$raw")
  state="${parsed%%$'\t'*}"
  src="${parsed#*$'\t'}"

  if [[ "$state" == "unspecified" ]]; then
    echo "chat_widget_matches_mode: конфигурация встраивания чата не объявлена (режим ${mode}) — публикация остановлена" >&2
    return 1
  fi

  local hits rc carries=0
  set +e
  if [[ "$state" == "address" ]]; then
    # Литеральная подстрока ищется в ДВУХ формах, а не одной. Astro сериализует
    # атрибут через стандартное HTML-экранирование: `&` в адресе (обычный разделитель
    # query-параметров) становится `&amp;` в разметке. Поиск только сырой формы не
    # находит `data-chat-loader-src="…?a=1&amp;b=2"` при заданном `…?a=1&b=2` —
    # измерено, `grep -F` с сырым значением не матчит собственный экранированный
    # вывод — и гейт останавливал бы публикацию исправной сборки с адресом,
    # несущим query-параметры. Экранируются только `&`, `<`, `>`, `"`: это ровно
    # набор символов, которые сериализатор атрибутов заменяет сущностями.
    local escaped
    escaped=$(printf '%s' "$src" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g')
    hits=$(grep -rlF --include='*.html' -- "$src" "$dist" 2>/dev/null)
    rc=$?
    if (( rc > 1 )); then
      set -e
      echo "chat_widget_matches_mode: не удалось прочитать $dist при поиске встраивания чата (grep код $rc) — проверка не выполнена" >&2
      return 1
    fi
    if [[ -z "$hits" && "$escaped" != "$src" ]]; then
      hits=$(grep -rlF --include='*.html' -- "$escaped" "$dist" 2>/dev/null)
      rc=$?
      if (( rc > 1 )); then
        set -e
        echo "chat_widget_matches_mode: не удалось прочитать $dist при поиске встраивания чата (grep код $rc) — проверка не выполнена" >&2
        return 1
      fi
    fi
  else
    hits=$(grep -rlF --include='*.html' -- 'data-chat-facade' "$dist" 2>/dev/null)
    rc=$?
    if (( rc > 1 )); then
      set -e
      echo "chat_widget_matches_mode: не удалось прочитать $dist при поиске встраивания чата (grep код $rc) — проверка не выполнена" >&2
      return 1
    fi
  fi
  set -e
  [[ -n "$hits" ]] && carries=1

  # Ожидаемое: встраивание есть ровно тогда, когда объявлен адрес — в ОБОИХ режимах.
  # Стенд прод-лайк (решение владельца 2026-09-05): он обязан показывать то, что покажет
  # боевой сайт, поэтому режим здесь больше ничего не решает. Отличие стенда живёт в том,
  # КУДА указывает адрес — тестовый портал против портала заказчика, — и это вход
  # оператора, а не ветвь сборки. Пока тестового адреса нет, стенд объявляет отсутствие
  # явно (`declared-absent`), и обе стороны сходятся на нуле.
  local expect_carries
  if [[ "$state" == "address" ]]; then
    expect_carries=1
  else
    expect_carries=0
  fi

  if (( carries == expect_carries )); then
    printf 'встраивание чата: %s, режим %s — соответствует\n' "$state" "$mode"
    return 0
  fi

  if (( expect_carries == 1 )); then
    echo "chat_widget_matches_mode: режим ${mode} ожидает встраивание чата (адрес ${src}), в сборке его нет" >&2
  else
    echo "chat_widget_matches_mode: режим ${mode} не ожидает встраивание чата (состояние: ${state}), а сборка его несёт" >&2
  fi
  return 1
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
  local raw meta code ctype body
  raw="$(curl -sS --max-time 10 -w $'\n%{http_code}\t%{content_type}' "$url" 2>/dev/null)" || {
    echo "payment_readiness_matches: запрос к $url не выполнен" >&2
    return 1
  }
  meta="${raw##*$'\n'}"
  body="${raw%$'\n'*}"
  code="${meta%%$'\t'*}"
  ctype="${meta#*$'\t'}"
  if [[ "$code" != "200" ]]; then
    echo "payment_readiness_matches: $url вернул ${code:-<нет ответа>}, ожидался 200" >&2
    return 1
  fi
  # Content-Type — часть контракта readiness (найдено ревью владельца, P1, 2026-08-20):
  # корректный JSON под text/plain — это ДРУГОЙ сервис или прокси-заглушка, а не
  # подтверждение контура. Параметры (`; charset=...`) допустимы, подмена типа — нет.
  local ctype_lc
  ctype_lc=$(printf '%s' "$ctype" | tr '[:upper:]' '[:lower:]')
  if [[ "$ctype_lc" != "application/json" && "$ctype_lc" != application/json\;* ]]; then
    echo "payment_readiness_matches: $url ответил Content-Type «${ctype:-<пусто>}», ожидался application/json" >&2
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
  local raw headers code allow
  # Код ответа и заголовок проверяются НА ОДНОМ запросе с Origin (найдено ревью
  # владельца, P2, 2026-08-20): прежде 204 утверждала другая проба БЕЗ Origin
  # (payment_endpoint_reachable), и фактический preflight, падающий 403 с правильным
  # Access-Control-Allow-Origin, складывался в зелёный гейт.
  raw="$(curl -sS --max-time 10 -X OPTIONS -H "Origin: ${origin}" -D - -o /dev/null \
    -w $'\n__HTTP_CODE__\t%{http_code}' "${base}/payments" 2>/dev/null)" || {
    echo "payment_cors_allows: запрос OPTIONS к ${base}/payments не выполнен" >&2
    return 1
  }
  code="${raw##*$'\t'}"
  headers="${raw%$'\n'__HTTP_CODE__*}"
  if [[ "$code" != "204" ]]; then
    echo "payment_cors_allows: OPTIONS с Origin ${origin} к ${base}/payments вернул ${code:-<нет ответа>}, ожидался 204 — preflight фактически не пройден" >&2
    return 1
  fi
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

# ── Гейт ссылок на формы заявки ──────────────────────────────────────────────
#
# Артефакт сверяется с ЗАКАЗАННЫМ режимом, а не с самим собой. Проверка
# `DEPLOY_MODE` в `deploy-web.sh` сторожит вызов; собрать при этом можно другое:
# `web/.env` (он в .gitignore, то есть невидим в ревью), экспорт из профиля оболочки
# или правка `src/lib/forms.ts`. Build-гейт определяет режим ПО артефакту, поэтому
# «собрано не то, что заказано» он увидеть не может по построению.
#
# Вынесен сюда из `deploy-web.sh` по той же причине, что и соседние проверки: блок
# стоит ПОСЛЕ `npm run build` и ПОСЛЕ ssh-загрузки релиза, то есть запуском самого
# скрипта до него не дойти без реального хоста. До выноса у гейта не было
# поведенческого теста вовсе — только греп исходника в repo-hygiene.test.ts, то есть
# утверждение о тексте, а не о поведении.
#
# ПРИЗНАК — НАЗНАЧЕНИЕ ССЫЛКИ, А НЕ ФОРМА ЕЁ ПУТИ.
#
# Прежняя редакция отбирала кандидатов по слову `crm_form` в пути (либо по пути
# заглушки) и затем требовала от отобранного пути опять-таки `crm_form_`. Отбор и
# признак совпадали, поэтому гейт подтверждал собственный выбор и покраснеть по
# построению не мог: ссылка на портал заказчика с любым другим путём в набор не
# попадала вовсе. Это ровно тот случай, о котором AGENTS.md говорит «не перечислять
# частные случаи того, что проверяешь» — список форм пути отстаёт от предмета молча.
#
# Что перечисление уже пропускало в прод-сборке на 2026-08-22 (сборка с `b9c2dda`, свои
# числа, не с чужого `dist`): из 34 различных адресов
# Bitrix24 четыре без `crm_form` — `/news/` (268 страниц, подписка в футере), `/umac1/`,
# `/fpnz/`, `/doshi/` (по 2 страницы, ссылки записи из данных расписания). Сегодня их
# переписывает `registrationHref`, то есть утечки нет; гейт не увидел бы её и тогда,
# когда она появится, — а он стоит именно ради этого случая.
#
# Отсюда: кандидатом считается ссылка, ведущая на портал Bitrix24 (по ХОСТУ, а не по
# подстроке — иначе адрес портала в query-параметре чужого домена давал бы ложный
# отказ), на заглушку, либо содержащая `crm_form` (кастомный демо-портал может жить и
# не на `bitrix24site.ru`). Требование к пути снято во всех режимах: `/news/` — такой
# же законный боевой адрес формы, как и `/crm_form_*`.
#
# Аргументы: <каталог сборки> <режим stand|prod> [<DEMO_FORMS>].
# Ноль найденных ссылок — «проверить не удалось», а не «всё верно».
form_links_match_mode() {
  local dist="${1:-}" mode="${2:-}" demo="${3:-}"
  local form_links grep_rc form_count wrong expect_re expect_human

  # Кандидат: хост на портале Bitrix24 (в том числе protocol-relative `//host/…`, без
  # поддомена, в любом регистре), либо `demo-zayavka` где угодно, либо `crm_form` В ПУТИ.
  #
  # Признак заглушки намеренно НЕ заякорен, хотя ожидания ниже заякорены. Отбор обязан
  # быть шире требования: заякоренный отбор сузил бы предмет и тихо разрешил бы то, что
  # прежний гейт отвергал. Найдено ревью (F5): при отборе `^…/demo-zayavka` адрес вида
  # `/podacha/demo-zayavka` в боевую сборку проходил бы молча.
  #
  # А вот `crm_form` заякорен «до `?` и `#`» — по находке ревью (F3) голая подстрока
  # давала обратную ошибку, ложный ОТКАЗ: `https://example.org/go?src=crm_form`
  # останавливал исправную выкладку. Тот же класс, от которого уже защищён Bitrix-хост
  # («по ХОСТУ, а не по подстроке»), просто в соседней строке он был не закрыт.
  #
  # Домены перечислены двумя, а не одним (находка ревью F9): публичные CRM-формы
  # Битрикс24 выдаются и на портальном домене `<портал>.bitrix24.ru/pub/form/<id>/`,
  # где нет ни `bitrix24site.ru`, ни `crm_form`. В сегодняшних данных таких адресов
  # ноль (проверено), поэтому расширение ложных отказов не создаёт, а перечисление
  # одного домена отставало бы от предмета молча.
  local bitrix_host='([^/?#]*\.)?bitrix24(site)?\.ru'
  local candidate_re="^(https?:)?//${bitrix_host}([/?#]|\$)|demo-zayavka|^[^?#]*crm_form"

  case "$mode" in
    prod)
      # Портал заказчика; конкретный поддомен не перечисляется — их несколько
      # (b24-cbqwqo и b24-kbo5ls в данных), и привязка к одному отвергала бы
      # законную боевую сборку. Заглушка сюда не попадает, чужой домен тоже.
      expect_re='^https://b24-[a-z0-9]+\.bitrix24(site)?\.ru([/?#]|$)'
      expect_human='https://b24-*.bitrix24site.ru/*'
      ;;
    stand)
      if [[ "$demo" == "stub" ]]; then
        expect_re='^(https?://[^/?#]+)?/demo-zayavka([/?#]|$)'
        expect_human='/demo-zayavka'
      else
        # Значение проверяется ДО подстановки в регулярку. Находка ревью (F1): оно
        # приходит из окружения и попадало в ERE как есть, поэтому
        # `DEMO_FORMS='b24-x(.bitrix24site.ru'` делал регулярку невалидной, `grep -vE`
        # выходил с кодом 2, `|| true` превращал это в успех — и стенд выкладывался с
        # живыми ссылками в CRM заказчика при зелёном гейте. Значение `.*` давало то же
        # молча, уже без ошибки grep. Заодно закрывается F8: завершающий слэш в значении
        # останавливал исправную выкладку.
        #
        # Допускается ровно имя хоста: буквы, цифры, точки, дефисы. Всё прочее —
        # «проверить не удалось», а не «сойдёт»: единственная ветвь функции, работающая
        # с внешним значением, обязана быть fail-closed, как и все остальные.
        if [[ ! "$demo" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
          echo "form_links_match_mode: DEMO_FORMS='${demo}' не является именем хоста —" >&2
          echo "проверка форм не выполнена (ожидалось 'stub' либо хост вида b24-xxxx.bitrix24site.ru)." >&2
          return 1
        fi
        # Точки экранируются: в имени хоста это единственный метасимвол ERE.
        local demo_re="${demo//./\\.}"
        expect_re="^https://${demo_re}([/?#]|$)"
        expect_human="https://${demo}/*"
      fi
      ;;
    *)
      # Без `${mode@Q}`: это bash 4.4+, а на macOS системный bash — 3.2, где ветка
      # умирала бы на `bad substitution`. Код выхода при этом тот же (1), поэтому
      # тест на неизвестный режим проходил бы, ни разу не выполнив саму ветку.
      echo "form_links_match_mode: неизвестный режим '${mode}' — проверка форм не выполнена" >&2
      return 1
      ;;
  esac

  # Ссылка ловится в ЛЮБОМ атрибуте ЛЮБОГО имени — разбором разметки, а не построчной
  # регуляркой по имени атрибута.
  #
  # ПЕРЕПИСАНО: прежнее извлечение искало атрибуты, чьё ИМЯ заканчивается на
  # href/src/action, и признак назначения уничтожался раньше отбора — имя атрибута
  # снималось до сравнения. Отсюда два тихих исхода: `data-form-link="…crm_form_ve1op/"`
  # (имя не оканчивается на href/src/action) не извлекался вовсе — живая ссылка формы
  # проходила мимо гейта; а `data-chat-loader`/`data-chat-src` на одном и том же
  # элементе-фасаде чата ловились или не ловились ИСКЛЮЧИТЕЛЬНО по имени атрибута —
  # переименование носителя меняло исход, хотя назначение не менялось. Регулярка,
  # уточнённая под один случай, портит другой: единственный способ различить оба —
  # разбор разметки (элемент, его атрибут, сосед-атрибут на том же теге), требуемый
  # спекой (openspec/changes/external-widgets/specs/external-widgets/spec.md:1020).
  #
  # Извлечение и нормализация (trim, тот же приём, что раньше делал sed) — в
  # `form-link-candidates.mjs` (parse5); элемент, несущий `data-chat-facade`, не отдаёт
  # НИ ОДНОГО своего атрибута — назначение носителя определяется соседним атрибутом на
  # том же теге, а не именем. Отбор по назначению (портал Bitrix24 / заглушка /
  # `crm_form`) остаётся здесь, регуляркой по УЖЕ извлечённому значению — это отбор
  # кандидатов, а не признак назначения, и парсер тут не нужен.
  local self_dir err_file attr_values node_rc
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  err_file="$(mktemp)"
  set +e
  attr_values=$(node "${self_dir}/form-link-candidates.mjs" "$dist" 2>"$err_file")
  node_rc=$?
  set -e
  if (( node_rc != 0 )); then
    echo "не удалось прочитать $dist разбором разметки (node код $node_rc):" >&2
    cat "$err_file" >&2
    rm -f "$err_file"
    echo "проверка форм не выполнена" >&2
    return 1
  fi
  rm -f "$err_file"

  # Коды выхода разбираются у КАЖДОГО grep, а не только у первого (находка ревью F1):
  # `|| true` на отборе кандидатов превращал бы сбой чтения в «нарушений нет».
  # 0 — нашёл, 1 — не нашёл, 2+ — сбой самой проверки.
  set +e
  form_links=$(printf '%s\n' "$attr_values" | grep -iE "$candidate_re" | sort -u)
  grep_rc=$?
  set -e
  if (( grep_rc > 1 )); then
    echo "отбор кандидатов не выполнен (grep код $grep_rc) — проверка форм не выполнена" >&2
    return 1
  fi

  form_count=$(printf '%s\n' "$form_links" | grep -c . || true)
  if (( form_count == 0 )); then
    echo "В сборке нет ни одной ссылки на форму заявки — проверять нечего, загрузка отменена." >&2
    echo "Ожидался набор вида ${expect_human}." >&2
    return 1
  fi

  set +e
  wrong=$(printf '%s\n' "$form_links" | grep -ivE "$expect_re")
  grep_rc=$?
  set -e
  if (( grep_rc > 1 )); then
    echo "сверка с ожиданием не выполнена (grep код $grep_rc, признак ${expect_human})" >&2
    return 1
  fi
  if [[ -n "$wrong" ]]; then
    echo "Ссылки форм не соответствуют режиму ${mode} (ожидалось ${expect_human}):" >&2
    printf '%s\n' "$wrong" | head -5 >&2
    echo "Загрузка отменена: в режиме stand это увело бы заявки в CRM заказчика," >&2
    echo "в режиме prod — потеряло бы обращения клиентов." >&2
    return 1
  fi
  echo "[deploy] Проверка форм: ${form_count} различных адресов, все соответствуют ${expect_human}"
}
