#!/usr/bin/env bash
set -euo pipefail

(( EUID == 0 )) || { echo 'run this fixed initial-prod preparation as root' >&2; exit 2; }
BACKUP=/var/lib/ikpk-rehearsal/initial-prod/nginx-before-gate
TLS_LINK=/etc/nginx/sites-enabled/ikpk-tls.conf
IP_LINK=/etc/nginx/sites-enabled/ikpk.conf
TLS=/etc/nginx/sites-available/ikpk-tls.conf
IP=/etc/nginx/sites-available/ikpk.conf
MAP=/etc/nginx/conf.d/ikpk-initial-prod-writer-map.conf
GATE=/etc/nginx/snippets/ikpk-initial-prod-writer-gate.conf

[[ ! -e "$BACKUP" && ! -L "$BACKUP" ]] || { echo 'refusing existing pre-gate backup directory' >&2; exit 2; }
[[ ! -e "$MAP" && ! -L "$MAP" && ! -e "$GATE" && ! -L "$GATE" ]] || {
  echo 'refusing existing initial-prod nginx gate files' >&2; exit 2;
}
[[ -L "$TLS_LINK" && "$(readlink "$TLS_LINK")" == "$TLS" ]] || {
  echo 'refusing unexpected TLS vhost symlink' >&2; exit 2;
}
[[ -L "$IP_LINK" && "$(readlink "$IP_LINK")" == "$IP" ]] || {
  echo 'refusing unexpected IP vhost symlink' >&2; exit 2;
}
for file in "$TLS" "$IP"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "refusing non-regular nginx vhost: $file" >&2; exit 2; }
done

install -d -o root -g root -m 0700 "$BACKUP"
cp -a "$TLS" "$IP" "$BACKUP/"
sha256sum "$TLS" "$IP" "$BACKUP/ikpk-tls.conf" "$BACKUP/ikpk.conf"
verify_originals() {
  cmp -s "$TLS" "$BACKUP/ikpk-tls.conf" && cmp -s "$IP" "$BACKUP/ikpk.conf" || {
    echo 'nginx vhost bytes changed after the fixed backup; refusing setup' >&2
    return 1
  }
}
verify_originals

setup_started=0
restore() {
  cp -a "$BACKUP/ikpk-tls.conf" "$TLS"
  cp -a "$BACKUP/ikpk.conf" "$IP"
  rm -f -- "$MAP" "$GATE"
  if /usr/sbin/nginx -t; then
    /usr/bin/systemctl reload nginx.service || echo 'restored nginx reload failed; inspect service before proceeding' >&2
  else
    echo 'restored nginx configuration test failed; inspect service before proceeding' >&2
  fi
  setup_started=0
}
cleanup() {
  status=$?
  if (( status != 0 && setup_started )); then
    restore || echo 'automatic restore failed; use the retained exact vhost copies' >&2
  fi
  exit "$status"
}
trap cleanup EXIT

setup_started=1
verify_originals
install -o root -g root -m 0644 /dev/null "$MAP"
cat >"$MAP" <<'EOF'
# managed by ikpk-rehearsal; included from nginx http context
map "$request_method:$uri" $ikpk_rehearsal_write_block {
    default 0;
    ~*^(POST|PUT|PATCH|DELETE):/uploads(?:/|$) 0;
    ~*^(POST|PUT|PATCH|DELETE):/api/payments(?:/|$) 0;
}
EOF
install -o root -g root -m 0644 /dev/null "$GATE"
cat >"$GATE" <<'EOF'
# managed by ikpk-rehearsal; included from each configured CMS-proxy vhost
if ($ikpk_rehearsal_write_block) { return 503; }
EOF

if ! python3 - "$TLS" "$IP" "$GATE" <<'PY'
import os, stat, sys, tempfile

tls, ip, gate = sys.argv[1:]
marker = b"include /etc/nginx/snippets/ikpk-cms-trial.conf;"
addition = f"\ninclude {gate};".encode()
changed = []
try:
    for name in (tls, ip):
        info = os.lstat(name)
        if not stat.S_ISREG(info.st_mode) or os.path.islink(name):
            raise SystemExit(f"refusing non-regular nginx vhost: {name}")
        original = open(name, "rb").read()
        if original.count(marker) != 1 or f"include {gate};".encode() in original:
            raise SystemExit(f"expected one CMS include and no gate include: {name}")
        updated = original.replace(marker, marker + addition, 1)
        fd, temp = tempfile.mkstemp(prefix=".ikpk-gate.", dir=os.path.dirname(name))
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
            os.chown(temp, info.st_uid, info.st_gid)
            os.chmod(temp, stat.S_IMODE(info.st_mode))
            os.replace(temp, name)
            changed.append(name)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
except BaseException:
    # Shell restores the exact recorded copies before returning to the operator.
    raise
PY
then
  restore
  echo 'vhost insertion failed; original vhosts restored and gate files removed' >&2
  exit 1
fi

if ! /usr/sbin/nginx -t; then
  restore
  echo 'nginx test failed; original vhosts restored and gate files removed' >&2
  exit 1
fi
if ! /usr/bin/systemctl reload nginx.service; then
  restore
  echo 'nginx reload failed; original vhosts restored and gate files removed' >&2
  exit 1
fi
effective=$(/usr/sbin/nginx -T 2>&1)
if [[ "$effective" != *"$MAP"* || "$effective" != *"$GATE"* || "$effective" != *ikpk_rehearsal_write_block* ]]; then
  restore
  echo 'effective nginx config omitted a fixed writer-gate path; original vhosts restored' >&2
  exit 1
fi
setup_started=0
echo 'initial-prod nginx writer gate installed in open state'
