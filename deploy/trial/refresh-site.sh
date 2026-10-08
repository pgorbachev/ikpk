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
api() { # метод [json-тело]
  SECRET_FILE="$SECRET_FILE" CMS_BASE="$BASE" python3 -c '
import json, os, sys, urllib.request
method, body = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ""
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
try:
    login = call("/admin/login", json.dumps({"email": secrets["CONTENT_ADMIN_EMAIL"], "password": secrets["CONTENT_ADMIN_PASSWORD"]}).encode())
    d = login.get("data", {})
    token = d.get("accessToken") or d.get("token")
    if not token:
        raise RuntimeError("no token")
except Exception:
    sys.stderr.write("вход администратора контента не удался\n")
    sys.exit(4)
try:
    out = call("/admin/site-refresh", body.encode() if method == "POST" else None, token, method)
except Exception as e:
    sys.stderr.write("запрос site-refresh не удался: %s\n" % type(e).__name__)
    sys.exit(5)
print(json.dumps(out))
' "$@"
}

json_get() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1],""))' "$1"; }

[[ -r "$SECRET_FILE" ]] && grep -q '^CONTENT_ADMIN_PASSWORD=.' "$SECRET_FILE" || { echo "[refresh] в ${SECRET_FILE} нет CONTENT_ADMIN_*" >&2; exit 3; }

body='{}'
[[ "$ACTION" == restore ]] && body='{"action":"restore"}'

min_avail=999999
sample() {
  local a
  a="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
  ((a < min_avail)) && min_avail="$a"
  return 0
}

start="$(date +%s)"
sample
first="$(api POST "$body")" || { echo "[refresh] запуск не удался" >&2; exit 4; }
echo "[refresh] запуск: $(printf '%s' "$first" | json_get status) $(printf '%s' "$first" | json_get message)"

status="running"
while :; do
  sleep 5
  sample
  cur="$(api GET || true)"
  status="$(printf '%s' "$cur" | json_get status 2>/dev/null || true)"
  [[ "$status" == running ]] || break
  if (($(date +%s) - start > LIMIT_S)); then
    echo "[refresh] за ${LIMIT_S} с операция не завершилась — не жду дольше" >&2
    break
  fi
done

end="$(date +%s)"
echo "[refresh] итог: status=${status} phase=$(printf '%s' "${cur:-}" | json_get phase 2>/dev/null) message=$(printf '%s' "${cur:-}" | json_get message 2>/dev/null)"
echo "[refresh] длительность: $((end - start)) с; минимум MemAvailable за время операции: ${min_avail} МБ"
free -m | sed -n '1,3p'
echo "[refresh] release.json на раздаче: $(curl -sS -m 10 http://127.0.0.1/release.json || echo недоступен)"
[[ "$status" == succeeded ]] || {
  echo "[refresh] состояние (${STATE}):" >&2
  cat "$STATE" >&2 2>/dev/null || true
  exit 5
}
