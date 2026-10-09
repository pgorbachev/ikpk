#!/usr/bin/env bash
# Локальная проверка серверных скриптов пробной машины в одноразовом контейнере Ubuntu 26.04
# (архитектура хозяина — быстро; x86_64 проверяется только на самой машине, этого здесь нет).
# Проверяются: prepare-host (отказ на чужой ОС), backup-exercise (копия, восстановление, отказ при
# расхождении), refresh-site (успех, отказ сборки, неверный вход), setup-https-ip (конфигурация nginx
# проходит `nginx -t`). НЕ проверяются: выпуск сертификата Let's Encrypt, swap, systemd, настоящая CMS.
#
#   bash deploy/trial/selftest.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker info >/dev/null 2>&1 || { echo "[selftest] docker не отвечает: проверка НЕ выполнена" >&2; exit 2; }

docker run --rm -i -v "${ROOT}/deploy/trial:/trial:ro" ubuntu:26.04 bash -s <<'CONTAINER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq nginx restic sqlite3 python3 python3-venv curl openssl >/dev/null 2>&1
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
expect_fail() { local name="$1"; shift; if "$@" >/tmp/out 2>&1; then bad "$name (ожидался отказ)"; else ok "$name"; fi; }
expect_ok() { local name="$1"; shift; if "$@" >/tmp/out 2>&1; then ok "$name"; else bad "$name"; sed 's/^/    | /' /tmp/out | tail -15; fi; }

echo "== prepare-host"
expect_msg() { local name="$1" re="$2"; shift 2; if "$@" >/tmp/out 2>&1; then bad "$name (ожидался отказ)"; elif grep -q "$re" /tmp/out; then ok "$name"; else bad "$name (отказ по другой причине)"; sed 's/^/    | /' /tmp/out | tail -5; fi; }
expect_msg "чужая архитектура отклоняется" 'ожидается ubuntu-26.04 x86_64' env ARCH=aarch64 bash /trial/prepare-host.sh
printf 'ID=debian\nVERSION_ID=13\n' >/tmp/os-debian
expect_msg "чужой дистрибутив отклоняется" 'ожидается ubuntu-26.04 x86_64' env OS_RELEASE=/tmp/os-debian ARCH=x86_64 bash /trial/prepare-host.sh
expect_msg "нехватка диска отклоняется до создания swap" 'свободно' env ARCH=x86_64 OS_RELEASE=/etc/os-release MIN_FREE_MB=99999999 bash /trial/prepare-host.sh

echo "== backup-exercise"
export WEB_ROOT=/var/www/ikpk CMS_DB=/var/lib/ikpk-cms/data.db CMS_UPLOADS=/opt/ikpk-cms/shared/uploads
export RESTIC_REPOSITORY=/var/backups/r RESTIC_PASSWORD_FILE=/etc/ikpk-backup/restic.pass STAGE=/var/backups/stage
mkdir -p "$WEB_ROOT/releases/r1" /var/lib/ikpk-cms "$CMS_UPLOADS"
echo '{"commit":"a","snapshotId":"s"}' >"$WEB_ROOT/releases/r1/release.json"; echo hi >"$WEB_ROOT/releases/r1/index.html"
live="${WEB_ROOT}/current"
ln -sfn releases/r1 "$live"
echo img >"$CMS_UPLOADS/a.jpg"
sqlite3 "$CMS_DB" "create table seminars(id integer primary key, title text); insert into seminars(title) values ('Тест');"
expect_ok "копия снимается" bash /trial/backup-exercise.sh backup
expect_ok "восстановление сверяется" bash /trial/backup-exercise.sh verify
sqlite3 "$CMS_DB" "create table extra(id integer);"
expect_fail "расхождение базы ловится (после копии добавлена таблица)" bash /trial/backup-exercise.sh verify
expect_fail "без режима — отказ" bash /trial/backup-exercise.sh

echo "== refresh-site (макет CMS)"
cat >/tmp/mock.py <<'PY'
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
MODE = os.environ.get("MOCK_MODE", "ok")
state = {"status": "idle", "message": "idle"}
logins = 0  # ограничитель частоты входа Strapi (429 на первом реальном выпуске): здесь допускается ОДИН вход за запуск
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body):
        b = json.dumps(body).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); raw = self.rfile.read(n) or b"{}"
        if self.path == "/admin/login":
            global logins
            logins += 1
            if logins > 1 and MODE != "badlogin": return self.send(429, {"error": {"message": "Too many requests"}})
            d = json.loads(raw)
            if d.get("password") == "PASS-SENTINEL-7f3a" and MODE != "badlogin": return self.send(200, {"data": {"accessToken": "TOKEN-SENTINEL-9c1e"}})
            return self.send(400, {"error": {"message": "Invalid credentials"}})
        if self.headers.get("Authorization") != "Bearer TOKEN-SENTINEL-9c1e": return self.send(401, {})
        state.update(status="running", message="running", t=time.time()); return self.send(200, dict(state))
    def do_GET(self):
        if self.path == "/admin/site-refresh":
            if state["status"] == "running" and time.time() - state["t"] > 7:
                state.update(status="failed" if MODE == "fail" else "succeeded", message="done", phase="verify")
            return self.send(200, {k: v for k, v in state.items() if k != "t"})
        self.send(404, {})
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
mkdir -p /etc/ikpk-cms /var/www/ikpk/shared/site-refresh
printf 'CONTENT_ADMIN_EMAIL=e@x.test\nCONTENT_ADMIN_PASSWORD=PASS-SENTINEL-7f3a\n' >/etc/ikpk-cms/trial.env
# Сэмплер argv: пока идёт прогон, раз в 50 мс снимает командные строки ВСЕХ процессов.
sample_argv() { # файл
  : >"$1"; while [[ -e /tmp/sampling ]]; do
    for f in /proc/[0-9]*/cmdline; do { tr '\0' ' ' <"$f"; echo; } 2>/dev/null || true; done >>"$1"; sleep 0.05; done
}
run_case() { # режим порт
  touch /tmp/sampling; sample_argv /tmp/argv.log & local sp=$!
  MOCK_MODE="$1" python3 /tmp/mock.py "$2" & local pid=$!; sleep 1
  CMS_BASE="http://127.0.0.1:$2" bash /trial/refresh-site.sh >/tmp/run.out 2>&1; local rc=$?
  rm -f /tmp/sampling; wait "$sp" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; cp /tmp/run.out /tmp/out; return "$rc"
}
expect_ok "успешная сборка → код 0, печатает длительность и память" run_case ok 18081
grep -q 'длительность: ' /tmp/out && grep -q 'минимум MemAvailable' /tmp/out && ok "замер длительности и памяти напечатан" || bad "замер не напечатан"
# Сэмплер сам проверяется: без этого «в argv ничего нет» могло бы значить «сэмплер слеп».
touch /tmp/sampling; sample_argv /tmp/decoy.log & sp=$!; bash -c 'sleep 3; :' PASS-SENTINEL-7f3a & dpid=$!; sleep 1
rm -f /tmp/sampling; wait "$sp" || true; kill "$dpid" 2>/dev/null || true
grep -q 'PASS-SENTINEL-7f3a' /tmp/decoy.log && ok "сэмплер argv видит контрольное значение (проверка не слепа)" || bad "сэмплер argv слеп"
[[ "$(wc -l </tmp/argv.log)" -gt 50 ]] && ok "сэмплер argv снял достаточно срезов ($(wc -l </tmp/argv.log))" || bad "сэмплер argv снял мало срезов"
grep -q 'SENTINEL' /tmp/argv.log && bad "пароль или токен найден в argv процессов" || ok "ни пароль, ни токен не появились в argv"
grep -q 'SENTINEL' /tmp/out && bad "пароль или токен найден в выводе" || ok "ни пароль, ни токен не появились в выводе"
expect_fail "сбой сборки → ненулевой код" run_case fail 18082
expect_fail "неверный вход → ненулевой код" run_case badlogin 18083
grep -q 'SENTINEL' /tmp/out && bad "пароль найден в выводе отказа" || ok "в выводе отказа секретов нет"

echo "== setup-https-ip (конфигурация nginx)"
mkdir -p /opt/certbot/bin /etc/letsencrypt/live/ikpk-trial /bin-stub
printf '#!/bin/sh\necho "certbot 5.8.0"\n' >/opt/certbot/bin/certbot; chmod +x /opt/certbot/bin/certbot
openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj "/CN=192.0.2.10" \
  -keyout /etc/letsencrypt/live/ikpk-trial/privkey.pem -out /etc/letsencrypt/live/ikpk-trial/fullchain.pem 2>/dev/null
printf '#!/bin/sh\ncase "$1" in is-active) exit 0;; *) exit 0;; esac\n' >/usr/local/bin/systemctl; chmod +x /usr/local/bin/systemctl
rm -f /etc/nginx/sites-enabled/default
expect_ok "конфигурация :443 принимается nginx -t" bash -s -- 192.0.2.10 </trial/setup-https-ip.sh
expect_ok "повторный запуск идемпотентен (unchanged)" bash -s -- 192.0.2.10 </trial/setup-https-ip.sh
grep -q 'unchanged: /etc/nginx/conf.d/ikpk-trial-tls.conf' /tmp/out && ok "конфигурация не переписана" || bad "конфигурация переписана повторно"
expect_fail "не-IPv4 отклоняется" bash -s -- not-an-ip </trial/setup-https-ip.sh

echo "итог: ok=${pass} fail=${fail}"
[[ "$fail" == 0 ]]
CONTAINER
