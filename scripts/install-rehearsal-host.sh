#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PREFIX=/usr/local
INSTALL_CONFIG_PROFILE=
INSTALL_DISABLED=0
while (($#)); do
  case "$1" in
    --prefix) PREFIX=${2:?missing prefix}; shift 2 ;;
    --install-disabled) INSTALL_DISABLED=1; shift ;;
    --staging193-config) INSTALL_CONFIG_PROFILE=staging193; shift ;;
    --initial-prod-config) INSTALL_CONFIG_PROFILE=initial-prod; shift ;;
    --production-static-config) INSTALL_CONFIG_PROFILE=production-static; shift ;;
    --production-paired-config) INSTALL_CONFIG_PROFILE=production-paired; shift ;;
    *) echo "usage: $0 [--prefix ABSOLUTE-PREFIX] [--install-disabled] [--staging193-config|--initial-prod-config|--production-static-config|--production-paired-config]" >&2; exit 2 ;;
  esac
done
[[ "$PREFIX" = /* && "$PREFIX" != / ]] || { echo 'prefix must be an absolute non-root path' >&2; exit 2; }
if [[ "$INSTALL_CONFIG_PROFILE" == staging193 || "$INSTALL_CONFIG_PROFILE" == production-paired || "$INSTALL_CONFIG_PROFILE" == production-static || "$INSTALL_CONFIG_PROFILE" == initial-prod ]]; then
  # The shared publication lock must be provisioned by its owner before
  # enabling cleanup. Never create or replace the transport's inode here.
  if [[ "$INSTALL_CONFIG_PROFILE" == production-paired ]]; then
    lock_template="$ROOT/scripts/production-paired-rehearsal.json"
  elif [[ "$INSTALL_CONFIG_PROFILE" == production-static ]]; then
    lock_template="$ROOT/scripts/production-static-rehearsal.json"
  elif [[ "$INSTALL_CONFIG_PROFILE" == staging193 ]]; then
    lock_template="$ROOT/scripts/staging193-rehearsal.json"
  else
    lock_template="$ROOT/scripts/initial-prod-rehearsal.json"
  fi
  python3 - "$lock_template" <<'PY'
import json, os, pwd, stat, sys
with open(sys.argv[1], encoding="utf-8") as source:
    config = json.load(source)
    lock = config["publicationLock"]
    expected_uid = pwd.getpwnam(config["cmsUser"]).pw_uid
try:
    before = os.lstat(lock)
except FileNotFoundError:
    raise SystemExit("shared publication lock must exist before cleanup is enabled")
try:
    if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_nlink != 1
            or before.st_uid != expected_uid or stat.S_IMODE(before.st_mode) != 0o600):
        raise SystemExit("shared publication lock must be a 0600 regular file owned by the configured CMS user")
    fd = os.open(lock, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
except OSError as error:
    raise SystemExit(f"production publication lock is unavailable; refusing host installation: {error}")
try:
    after = os.fstat(fd)
    if ((after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
            or after.st_uid != expected_uid or stat.S_IMODE(after.st_mode) != 0o600):
        raise SystemExit("shared publication lock changed during installer preflight")
finally:
    os.close(fd)
PY
fi

# Refuse an unexpected existing profile config before replacing the installed
# helper. In particular, an existing 194 config can require an operator-owned
# migration; a failed check must leave the working entrypoint untouched.
if [[ -n "$INSTALL_CONFIG_PROFILE" ]]; then
  (( EUID == 0 )) || { echo 'rehearsal config installation requires root' >&2; exit 2; }
  CONFIG_DIR=/etc/ikpk
  if [[ "$INSTALL_CONFIG_PROFILE" == initial-prod ]]; then
    CONFIG="$CONFIG_DIR/rehearsal-initial-prod.json"
    TEMPLATE="$ROOT/scripts/initial-prod-rehearsal.json"
  elif [[ "$INSTALL_CONFIG_PROFILE" == production-static ]]; then
    CONFIG="$CONFIG_DIR/rehearsal-production-static.json"
    TEMPLATE="$ROOT/scripts/production-static-rehearsal.json"
  elif [[ "$INSTALL_CONFIG_PROFILE" == production-paired ]]; then
    CONFIG="$CONFIG_DIR/rehearsal-production-paired.json"
    TEMPLATE="$ROOT/scripts/production-paired-rehearsal.json"
  else
    CONFIG="$CONFIG_DIR/rehearsal.json"
    TEMPLATE="$ROOT/scripts/staging193-rehearsal.json"
  fi
  if [[ -e "$CONFIG" || -L "$CONFIG" ]]; then
    PYTHONPATH="$ROOT/scripts/lib" python3 "$ROOT/scripts/lib/rehearsal_config.py" check "$CONFIG" "$TEMPLATE" || {
      echo 'existing rehearsal config is incompatible; refusing installation before helper writes' >&2; exit 2;
    }
  fi
fi

LIB="$PREFIX/lib/ikpk-rehearsal"
SBIN="$PREFIX/sbin"
install -d -m 0755 "$LIB" "$SBIN"
install -m 0644 "$ROOT/scripts/lib/rehearsal_state.py" "$LIB/rehearsal_state.py"
install -m 0644 "$ROOT/scripts/lib/housekeeping_journal.py" "$LIB/housekeeping_journal.py"
install -m 0644 "$ROOT/scripts/lib/rehearsal_host.py" "$LIB/rehearsal_host.py"
cat >"$SBIN/ikpk-rehearsal" <<EOF
#!/usr/bin/env python3
import fcntl, json, os, pwd, stat, sys
sys.path.insert(0, "$LIB")
publication_lock_fd = None
argv = sys.argv[1:]
if "cms-update" in argv and "--expected-host-helper-identity" in argv:
    lock_path = "/var/www/ikpk/.publication.lock"
    fd = None
    try:
        config_path = "/etc/ikpk/rehearsal.json"
        with open(config_path, encoding="utf-8") as source:
            config = json.load(source)
        if (config.get("profile", "staging194") != "staging194"
                or config.get("publicationLock") != lock_path):
            raise RuntimeError("paired helper lock profile is not staging194")
        expected_uid = pwd.getpwnam(config["cmsUser"]).pw_uid
        before = os.lstat(lock_path)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_uid != expected_uid or stat.S_IMODE(before.st_mode) != 0o600):
            raise RuntimeError("shared publication lock has unsafe type, owner, or mode")
        fd = os.open(lock_path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(fd)
        if ((opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or opened.st_uid != expected_uid or stat.S_IMODE(opened.st_mode) != 0o600):
            raise RuntimeError("shared publication lock changed while opening")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        named = os.lstat(lock_path)
        if ((opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)
                or not stat.S_ISREG(named.st_mode) or named.st_nlink != 1
                or named.st_uid != expected_uid or stat.S_IMODE(named.st_mode) != 0o600):
            raise RuntimeError("shared publication lock changed after acquisition")
        publication_lock_fd = fd
    except (OSError, KeyError, ValueError, RuntimeError) as error:
        if fd is not None:
            os.close(fd)
        raise SystemExit("could not lock staging194 before importing the paired helper") from error
from rehearsal_host import main
raise SystemExit(main(publication_lock_fd=publication_lock_fd))
EOF
chmod 0755 "$SBIN/ikpk-rehearsal"
PYTHONDONTWRITEBYTECODE=1 "$SBIN/ikpk-rehearsal" --help >/dev/null
if [[ -n "$INSTALL_CONFIG_PROFILE" ]]; then
  (( EUID == 0 )) || { echo 'rehearsal config installation requires root' >&2; exit 2; }
  CONFIG_DIR=/etc/ikpk
  if [[ "$INSTALL_CONFIG_PROFILE" == initial-prod ]]; then
    CONFIG="$CONFIG_DIR/rehearsal-initial-prod.json"
    TEMPLATE="$ROOT/scripts/initial-prod-rehearsal.json"
  elif [[ "$INSTALL_CONFIG_PROFILE" == production-static ]]; then
    CONFIG="$CONFIG_DIR/rehearsal-production-static.json"
    TEMPLATE="$ROOT/scripts/production-static-rehearsal.json"
  elif [[ "$INSTALL_CONFIG_PROFILE" == production-paired ]]; then
    CONFIG="$CONFIG_DIR/rehearsal-production-paired.json"
    TEMPLATE="$ROOT/scripts/production-paired-rehearsal.json"
  else
    CONFIG="$CONFIG_DIR/rehearsal.json"
    TEMPLATE="$ROOT/scripts/staging193-rehearsal.json"
  fi
  installed_config=0
  install -d -o root -g root -m 0755 "$CONFIG_DIR"
  if [[ -e "$CONFIG" || -L "$CONFIG" ]]; then
    [[ -f "$CONFIG" && ! -L "$CONFIG" ]] || { echo 'existing rehearsal config is not a regular file' >&2; exit 2; }
    if ! cmp -s "$CONFIG" "$TEMPLATE"; then
      PYTHONPATH="$ROOT/scripts/lib" python3 "$ROOT/scripts/lib/rehearsal_config.py" migrate "$CONFIG" "$TEMPLATE" || {
        echo 'existing rehearsal config migration failed; CMS/site data was not changed; inspect config/backup and rerun the installer after correcting the filesystem error' >&2; exit 2;
      }
    fi
  else
    temporary="$CONFIG.new.$$"
    install -o root -g root -m 0600 "$TEMPLATE" "$temporary"
    mv -T -- "$temporary" "$CONFIG"
    installed_config=1
  fi
  python3 - "$TEMPLATE" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    config = json.load(source)
import os, pwd, stat
account = pwd.getpwnam(config["cmsUser"])
profile = config.get("profile", "staging194")
if profile == "staging194":
    temp_parent = "/var/tmp"
    temp_root = config.get("temporaryRoot")
    if temp_root != "/var/tmp/ikpk-staging194":
        raise SystemExit("staging194 temporary root must use its fixed host path")
    parent_info = os.lstat(temp_parent)
    if (not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode)
            or parent_info.st_uid != 0 or not parent_info.st_mode & stat.S_ISVTX):
        raise SystemExit("staging194 temporary parent must be a sticky root-owned directory")
    temp_created = False
    try:
        os.mkdir(temp_root, 0o1770)
        temp_created = True
    except FileExistsError:
        pass
    if temp_created:
        os.chown(temp_root, 0, account.pw_gid)
        os.chmod(temp_root, 0o1770)
    temp_info = os.lstat(temp_root)
    if (not stat.S_ISDIR(temp_info.st_mode) or stat.S_ISLNK(temp_info.st_mode)
            or temp_info.st_uid != 0 or temp_info.st_gid != account.pw_gid
            or stat.S_IMODE(temp_info.st_mode) != 0o1770):
        raise SystemExit("staging194 temporary root must be a root-owned CMS-group directory with mode 1770")
home = account.pw_dir
if not os.path.isabs(home) or home == "/":
    raise SystemExit("CMS service account has no safe absolute HOME")
created = False
try:
    os.mkdir(home, 0o700)
    created = True
except FileExistsError:
    pass
if created:
    os.chown(home, account.pw_uid, account.pw_gid)
    os.chmod(home, 0o700)
info = os.lstat(home)
if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
    raise SystemExit("CMS service HOME must be a real directory")
if info.st_uid != account.pw_uid or info.st_gid != account.pw_gid or info.st_mode & 0o077 or info.st_mode & 0o700 != 0o700:
    raise SystemExit("existing CMS service HOME must be owned by the service account with private permissions")
for name in ("stateDir", "backupRoot"):
    os.makedirs(config[name], mode=0o700, exist_ok=True)
    os.chown(config[name], 0, 0)
    os.chmod(config[name], 0o700)
marker_path = config["sitePublicationMarker"]
marker_dir = os.path.dirname(marker_path)
if os.path.lexists(marker_dir):
    info = os.lstat(marker_dir)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise SystemExit("site-publication marker directory must be a real directory")
else:
    os.makedirs(marker_dir, mode=0o750, exist_ok=False)
os.chown(marker_dir, 0, account.pw_gid)
os.chmod(marker_dir, 0o750)
if os.path.lexists(marker_path):
    info = os.lstat(marker_path)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
            or info.st_uid != 0 or info.st_gid != account.pw_gid or stat.S_IMODE(info.st_mode) != 0o640):
        raise SystemExit("existing site-publication marker has unsafe owner or permissions")
if profile == "production-static":
    if os.path.lexists(config["releaseRoot"]):
        info = os.lstat(config["releaseRoot"])
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SystemExit("production-static source root must be a real directory")
    os.makedirs(config["releaseRoot"], mode=0o700, exist_ok=True)
    os.chown(config["releaseRoot"], 0, account.pw_gid)
    os.chmod(config["releaseRoot"], 0o750)
if profile == "production-paired":
    if os.path.lexists(config["releaseRoot"]):
        info = os.lstat(config["releaseRoot"])
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SystemExit("production-paired CMS release root must be a real directory")
    os.makedirs(config["releaseRoot"], mode=0o750, exist_ok=True)
    os.chown(config["releaseRoot"], 0, account.pw_gid)
    os.chmod(config["releaseRoot"], 0o750)
    lock = config["publicationLock"]
    if os.path.lexists(lock):
        fd = os.open(lock, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid == 0 or not info.st_mode & stat.S_IWUSR:
                raise SystemExit("production publication lock must remain publisher-owned and writable")
        finally:
            os.close(fd)
PY
  service_profile=$INSTALL_CONFIG_PROFILE
  [[ "$service_profile" == staging193 ]] && service_profile=staging194
  if ! PYTHONDONTWRITEBYTECODE=1 "$SBIN/ikpk-rehearsal" --profile "$service_profile" validate-config; then
    if (( installed_config )); then rm -f -- "$CONFIG"; fi
    echo 'rehearsal config validation failed; no operation is enabled' >&2
    exit 2
  fi
  state_dir=$(python3 - "$CONFIG" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    print(json.load(source)["stateDir"])
PY
)
  cleanup_backup_root=$(python3 - "$CONFIG" <<'PY'
import json, os, sys
with open(sys.argv[1], encoding="utf-8") as source:
    path = json.load(source)["backupRoot"]
if not os.path.isabs(path) or path == "/":
    raise SystemExit("CMS cleanup backup root must be an absolute non-root path")
print(path)
PY
)
  site_state_dir=$(python3 - "$CONFIG" <<'PY'
import json, os, sys
with open(sys.argv[1], encoding="utf-8") as source:
    print(os.path.dirname(json.load(source)["siteRefreshState"]))
PY
)
  site_cleanup_request="$site_state_dir/cleanup.request"
  cleanup_profile_state_dirs=
  cleanup_profile_artifact_roots=
  if [[ "$service_profile" == production-static || "$service_profile" == production-paired || \
        "$service_profile" == initial-prod ]]; then
    # A protected marker can belong to another installed production profile.
    # These exact directories let the helper read that profile's journal under
    # systemd; '-' means a profile never provisioned here may be absent.
    cleanup_profile_state_dirs="-/var/lib/ikpk-rehearsal/initial-prod -/var/lib/ikpk-rehearsal/production-static -/var/lib/ikpk-rehearsal/production-paired"
    # The shared housekeeping unit can be selected by any production marker,
    # even when it was installed from another production profile.
    cleanup_profile_artifact_roots="-/var/lib/ikpk-rehearsal/initial-prod/backups -/var/lib/ikpk-rehearsal/production-static/backups -/var/lib/ikpk-rehearsal/production-paired/backups"
  fi
  systemd_dir=/etc/systemd/system
  unit_tmp="$systemd_dir/ikpk-site-housekeeping.service.new.$$"
  timer_tmp="$systemd_dir/ikpk-site-housekeeping.timer.new.$$"
  path_tmp="$systemd_dir/ikpk-site-housekeeping.path.new.$$"
  cat >"$unit_tmp" <<EOF
[Unit]
Description=Clean expired IKPK static site releases
After=local-fs.target

[Service]
Type=oneshot
User=root
Group=root
ExecStart=$SBIN/ikpk-rehearsal --profile $service_profile cleanup-site
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
# The helper removes a validated stale .current-next-* symlink from this
# directory and fsyncs its parent. CMS and the 194 transport serialize through
# the shared site-refresh reservation; production transport also uses its
# configured .publication.lock. Do not require that prod-only inode on 194.
ReadWritePaths=/var/www/ikpk $site_state_dir $state_dir $cleanup_profile_state_dirs /var/lib/ikpk-rehearsal/site-publication $cleanup_backup_root $cleanup_profile_artifact_roots
EOF
  chmod 0644 "$unit_tmp"
  mv -f -- "$unit_tmp" "$systemd_dir/ikpk-site-housekeeping.service"
  cat >"$timer_tmp" <<'EOF'
[Unit]
Description=Retry pending IKPK release housekeeping

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
Unit=ikpk-site-housekeeping.service

[Install]
WantedBy=timers.target
EOF
  chmod 0644 "$timer_tmp"
  mv -f -- "$timer_tmp" "$systemd_dir/ikpk-site-housekeeping.timer"
  cat >"$path_tmp" <<EOF
[Unit]
Description=Start IKPK release housekeeping after CMS publication success

[Path]
PathExists=$site_cleanup_request
Unit=ikpk-site-housekeeping.service

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$path_tmp"
  mv -f -- "$path_tmp" "$systemd_dir/ikpk-site-housekeeping.path"
  systemctl daemon-reload
  if (( ! INSTALL_DISABLED )); then
    systemctl enable --now ikpk-site-housekeeping.path ikpk-site-housekeeping.timer
  fi
fi
echo "installed rehearsal host entrypoint: $SBIN/ikpk-rehearsal"
