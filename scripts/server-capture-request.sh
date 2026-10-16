#!/bin/sh
# Install root-owned as /usr/local/sbin/ikpk-demo-capture-request.
# The sudo rule permits this wrapper only, never an unrestricted systemctl.
set -eu
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL
unset CDPATH ENV BASH_ENV

[ "$#" -eq 1 ] || exit 64
case "$1" in ''|*[!a-f0-9-]*) exit 64 ;; esac
[ "${#1}" -eq 36 ] || exit 64
printf '%s\n' "$1" | /usr/bin/grep -Eq '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' || exit 64

# System manager, fixed action, one validated instance, no inherited environment.
exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/systemctl start -- "ikpk-demo-capture@$1.service"
