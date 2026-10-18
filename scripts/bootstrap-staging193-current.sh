#!/usr/bin/env bash
set -euo pipefail
umask 077

UNIT=ikpk-cms-prototype193.service
OLD_ROOT=/opt/ikpk-cms-prototype193/releases/279c522d15a7da114158945eff6010f4f12c84ec-candidate
CURRENT=/opt/ikpk-cms-prototype193/current
DROPIN_DIR=/etc/systemd/system/ikpk-cms-prototype193.service.d
DROPIN=$DROPIN_DIR/90-staging193-current.conf
BACKUP_DIR=/var/lib/ikpk-rehearsal/bootstrap/staging193

fail() { printf 'staging193 bootstrap: %s\n' "$*" >&2; exit 2; }
(( EUID == 0 )) || fail 'must run as root after review and CI approval'
[[ ${1:-install} == install || ${1:-} == restore ]] || fail 'usage: bash scripts/bootstrap-staging193-current.sh [install|restore]'
ACTION=${1:-install}

expected_dropin=$(cat <<'EOF'
[Service]
WorkingDirectory=/opt/ikpk-cms-prototype193/current
ExecStart=
ExecStart=/usr/bin/node node_modules/@strapi/strapi/bin/strapi.js start
EOF
)

if [[ $ACTION == install ]]; then
  [[ $(systemctl show --property=User --value "$UNIT") == ikpk-cms ]] || fail 'unexpected CMS service user'
  [[ $(systemctl show --property=Group --value "$UNIT") == ikpk-cms ]] || fail 'unexpected CMS service group'
  [[ $(systemctl show --property=WorkingDirectory --value "$UNIT") == "$OLD_ROOT" ]] || fail 'CMS working directory changed since read-only preflight'
  exec_start=$(systemctl show --property=ExecStart --value "$UNIT")
  [[ $exec_start == *'/usr/bin/node node_modules/@strapi/strapi/bin/strapi.js start'* ]] || fail 'CMS ExecStart changed since read-only preflight'
  [[ -d $OLD_ROOT && ! -L $OLD_ROOT ]] || fail 'recorded old CMS release is not a real directory'
  if [[ -e $CURRENT || -L $CURRENT ]]; then
    [[ -L $CURRENT && $(readlink -f -- "$CURRENT") == "$OLD_ROOT" ]] || fail 'current path already selects another object'
    if [[ -f $DROPIN ]] && [[ $(cat -- "$DROPIN") == "$expected_dropin" ]]; then
      exit 0
    fi
    fail 'current already exists without the reviewed systemd drop-in'
  fi
  [[ ! -e $DROPIN && ! -L $DROPIN ]] || fail 'reviewed drop-in path is already occupied'
  install -d -o root -g root -m 0700 "$BACKUP_DIR"
  systemctl cat "$UNIT" >"$BACKUP_DIR/unit.before.txt"
  systemctl show --property=User,Group,WorkingDirectory,ExecStart,EnvironmentFiles "$UNIT" >"$BACKUP_DIR/effective.before.txt"
  chmod 0600 "$BACKUP_DIR/unit.before.txt" "$BACKUP_DIR/effective.before.txt"
  install -d -o root -g root -m 0755 "$DROPIN_DIR"
  temporary_link="${CURRENT}.new.$$"
  temporary_dropin="${DROPIN}.new.$$"
  cleanup() {
    result=$?
    trap - EXIT
    rm -f -- "$temporary_link" "$temporary_dropin"
    if (( result != 0 )); then
      rm -f -- "$DROPIN"
      systemctl daemon-reload || true
      if [[ -L $CURRENT && $(readlink -f -- "$CURRENT") == "$OLD_ROOT" ]]; then
        rm -f -- "$CURRENT"
      fi
    fi
    return "$result"
  }
  trap cleanup EXIT
  ln -s -- "$OLD_ROOT" "$temporary_link"
  mv -T -- "$temporary_link" "$CURRENT"
  printf '%s\n' "$expected_dropin" >"$temporary_dropin"
  chown root:root "$temporary_dropin"
  chmod 0644 "$temporary_dropin"
  mv -T -- "$temporary_dropin" "$DROPIN"
  systemctl daemon-reload
  [[ $(systemctl show --property=WorkingDirectory --value "$UNIT") == "$CURRENT" ]] || fail 'systemd did not apply the reviewed working directory'
  exec_start=$(systemctl show --property=ExecStart --value "$UNIT")
  [[ $exec_start == *'/usr/bin/node node_modules/@strapi/strapi/bin/strapi.js start'* ]] || fail 'systemd ExecStart changed unexpectedly'
  trap - EXIT
  printf 'staging193 current path and unit override prepared; service was not restarted\n'
else
  [[ -f $BACKUP_DIR/unit.before.txt && -f $BACKUP_DIR/effective.before.txt ]] || fail 'saved original systemd configuration is missing'
  [[ -f $DROPIN && $(cat -- "$DROPIN") == "$expected_dropin" ]] || fail 'current unit drop-in differs from this installer'
  [[ -L $CURRENT && $(readlink -f -- "$CURRENT") == "$OLD_ROOT" ]] || fail 'current symlink differs from the recorded old release'
  rm -f -- "$DROPIN" "$CURRENT"
  systemctl daemon-reload
  [[ $(systemctl show --property=WorkingDirectory --value "$UNIT") == "$OLD_ROOT" ]] || fail 'original CMS working directory was not restored'
  printf 'staging193 current path and unit override removed; service was not restarted\n'
fi
