#!/usr/bin/env bash
# Пробная машина (docs/runbook-trial-vps.md, шаг 1): секреты на МАШИНЕ ВЛАДЕЛЬЦА.
# Файл создаётся с правами 0600 вне репозитория и не перезаписывается. Значения не
# печатаются; в чат и в Git их передавать нельзя. Имена совпадают с SECRET_NAMES в
# deploy/environments/trial.env.
#
#   bash deploy/trial/gen-secrets.sh [файл]     # по умолчанию ~/ikpk-trial/secrets.env
set -euo pipefail

OUT="${1:-$HOME/ikpk-trial/secrets.env}"
EMAIL="${CONTENT_ADMIN_EMAIL:-editor@trial.ikpk.local}"

if [[ -e "$OUT" ]]; then
  echo "[secrets] ${OUT} уже есть — не перезаписываю (смена секретов CMS ломает вход и шифрованные поля)"
  exit 0
fi

umask 077
mkdir -p "$(dirname "$OUT")"
r() { openssl rand -base64 32 | tr -d '\n'; }
{
  echo "APP_KEYS='$(r),$(r),$(r),$(r)'"
  echo "API_TOKEN_SALT='$(r)'"
  echo "ADMIN_JWT_SECRET='$(r)'"
  echo "TRANSFER_TOKEN_SALT='$(r)'"
  echo "JWT_SECRET='$(r)'"
  echo "ENCRYPTION_KEY='$(r)'"
  echo "CONTENT_ADMIN_EMAIL='${EMAIL}'"
  echo "CONTENT_ADMIN_PASSWORD='Tr1!$(openssl rand -hex 12)'"
} >"$OUT"
chmod 600 "$OUT"
echo "[secrets] создан ${OUT} (0600). Пароль администратора контента — внутри файла, на экран не выводится."
