#!/usr/bin/env bash
# Пробная машина: «Обновить сайт» БЕЗ браузера — тот же маршрут POST /admin/site-refresh под
# учётной записью администратора контента, что и кнопка. Запуск НА СЕРВЕРЕ от root.
#
#   bash refresh-site.sh            # собрать сайт из опубликованного снимка и переключить
#   bash refresh-site.sh restore    # кнопка «Вернуть предыдущий релиз»
#
# Это операторский шаг после выпуска кода: bootstrap-vps.sh обновляет код CMS и дерево
# сборки, а сайт на новом коде появляется только этим запуском (или кнопкой). Пока идёт
# сборка, каждые 5 с снимается память — в конце печатаются длительность и минимум свободной
# памяти (замер для TD-74). Пароль и токен в вывод не попадают.
set -euo pipefail

ACTION="${1:-refresh}"
SECRET_FILE="${SECRET_FILE:-/etc/ikpk-cms/trial.env}"
BASE="${CMS_BASE:-http://127.0.0.1:1337}"
STATE="${STATE_FILE:-/var/www/ikpk/shared/site-refresh/state.json}"
LIMIT_S="${LIMIT_S:-3600}"

[[ "$(id -u)" == 0 ]] || { echo "[refresh] нужен root" >&2; exit 2; }
[[ "$ACTION" == refresh || "$ACTION" == restore ]] || { echo "[refresh] действие: refresh|restore" >&2; exit 2; }

# Учётные данные и токен НЕ попадают в argv и окружение дочерних процессов: HTTP делает один
# python3, который сам читает файл секретов (в argv — только его путь) и держит токен в памяти.
# curl с -d/-H здесь запрещён: аргументы видны в списке процессов.
#
# Вход выполняется ОДИН раз на весь запуск, опрос идёт тем же токеном. Прежняя редакция входила
# заново на каждый опрос (раз в 5 с) и на первом реальном выпуске упёрлась в ограничитель частоты
# входа Strapi (429): сборка на сервере продолжалась, а клиент считал вход несостоявшимся.
# Здесь же снимается память (MemAvailable) — отдельного опроса из bash нет.
# Выход: в stdout одна строка JSON итогового состояния + "min_avail_mb"; коды 4 (вход/запуск), 5 (запрос).
drive() { # json-тело
  SECRET_FILE="$SECRET_FILE" CMS_BASE="$BASE" LIMIT_S="$LIMIT_S" python3 -c '
import json, os, sys, time, urllib.error, urllib.request
body = sys.argv[1]
limit = int(os.environ["LIMIT_S"])
secrets = {}
for line in open(os.environ["SECRET_FILE"]):
    k, _, v = line.rstrip("\n").partition("=")
    secrets[k] = v
base = os.environ["CMS_BASE"]
def call(path, data, token=None, m="POST"):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, headers=h, method=m)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)
def login():
    d = call("/admin/login", json.dumps({"email": secrets["CONTENT_ADMIN_EMAIL"], "password": secrets["CONTENT_ADMIN_PASSWORD"]}).encode()).get("data", {})
    t = d.get("accessToken") or d.get("token")
    if not t:
        raise RuntimeError("no token")
    return t
def avail():
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable"):
            return int(line.split()[1]) // 1024
    return 999999
low = avail()
try:
    token = login()
except Exception:
    sys.stderr.write("вход администратора контента не удался\n")
    sys.exit(4)
try:
    first = call("/admin/site-refresh", body.encode(), token, "POST")
except Exception as e:
    sys.stderr.write("запрос site-refresh не удался: %s\n" % type(e).__name__)
    sys.exit(5)
sys.stderr.write("[refresh] запуск: %s %s\n" % (first.get("status", ""), first.get("message", "")))
start = time.time()
cur = first
while True:
    time.sleep(5)
    low = min(low, avail())
    try:
        cur = call("/admin/site-refresh", None, token, "GET")
    except urllib.error.HTTPError as e:
        if e.code == 401:  # токен истёк: один новый вход, а не вход на каждый опрос
            try:
                token = login()
            except Exception:
                pass
    except Exception:
        pass  # служба могла перезапускаться: следующий опрос
    if cur.get("status") != "running":
        break
    if time.time() - start > limit:
        sys.stderr.write("[refresh] за %d с операция не завершилась — не жду дольше\n" % limit)
        break
cur["min_avail_mb"] = low
print(json.dumps(cur))
' "$1"
}

json_get() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1],""))' "$1"; }

[[ -r "$SECRET_FILE" ]] && grep -q '^CONTENT_ADMIN_PASSWORD=.' "$SECRET_FILE" || { echo "[refresh] в ${SECRET_FILE} нет CONTENT_ADMIN_*" >&2; exit 3; }

body='{}'
[[ "$ACTION" == restore ]] && body='{"action":"restore"}'

start="$(date +%s)"
cur="$(drive "$body")" || { rc=$?; echo "[refresh] запуск не удался (код ${rc})" >&2; exit 4; }
status="$(printf '%s' "$cur" | json_get status)"
min_avail="$(printf '%s' "$cur" | json_get min_avail_mb)"
end="$(date +%s)"
echo "[refresh] итог: status=${status} phase=$(printf '%s' "$cur" | json_get phase) message=$(printf '%s' "$cur" | json_get message)"
echo "[refresh] длительность: $((end - start)) с; минимум MemAvailable за время операции: ${min_avail} МБ"
free -m | sed -n '1,3p'
echo "[refresh] release.json на раздаче: $(curl -sS -m 10 http://127.0.0.1/release.json || echo недоступен)"
[[ "$status" == succeeded ]] || {
  echo "[refresh] состояние (${STATE}):" >&2
  cat "$STATE" >&2 2>/dev/null || true
  exit 5
}
