#!/usr/bin/env bash
# Сборка артефакта CMS для выкатки на сервер.
#
# Артефакт собирался руками, и это стоило двух отказов на живой машине:
#
# 1. без `tsconfig.json` Strapi считает проект НЕ-TypeScript и ищет конфигурацию в
#    `<корень>/config`, а не в `dist/config`. Конфигурация не находится, и служба падает с
#    «Cannot destructure property 'client' of 'db.config.connection'» — сообщение, по
#    которому причина не видна вовсе;
# 2. `path.join` в `config/database.ts` не уважал абсолютный `DATABASE_FILENAME`, и база
#    оказывалась внутри каталога релиза — то есть удалялась следующей выкаткой;
# 3. миграции базы не попадали в артефакт вовсе. `strapi build` их в `dist` не кладёт, а
#    копировался только `dist`, поэтому на сервере каталог `database/migrations` оказывался
#    ПУСТЫМ — Strapi создаёт его сам и видит ноль миграций. Переименование колонки при этом
#    отрабатывало обычной сверкой схемы, то есть `dropColumn` + `createColumn`, и значения
#    молча обнулялись. Дефект тем опаснее, что в репозитории миграция есть и тесты её
#    проходят: «миграция написана» и «миграция доехала» — разные утверждения.
#
# Поэтому здесь не только сборка, но и проверка обоих условий на СОБРАННОМ выводе.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?укажите каталог для артефакта}"

cd "$REPO_ROOT/cms"
npm run build

rm -rf "$OUT"
mkdir -p "$OUT"
# tsconfig.json обязателен: по нему Strapi опознаёт TS-проект и берёт конфигурацию из dist.
cp -R dist package.json package-lock.json tsconfig.json "$OUT/"
[[ -d public ]] && cp -R public "$OUT/"
# Миграции базы: Strapi ищет их в `<корень релиза>/database/migrations`, а не в `dist`.
[[ -d database ]] && cp -R database "$OUT/"

# --- Проверки собранного вывода (не текста исходника) ---
node -e '
const path = require("path");
const out = process.argv[1];
const fail = (m) => { console.error("[artifact] " + m); process.exit(1); };

if (!require("fs").existsSync(path.join(out, "tsconfig.json"))) fail("нет tsconfig.json: Strapi будет искать config/ в корне");
if (!require("fs").existsSync(path.join(out, "dist", "config", "database.js"))) fail("нет dist/config/database.js");

const factory = require(path.join(out, "dist", "config", "database.js")).default;
const ABS = "/var/lib/ikpk-cms/stand/data/data.db";
const env = Object.assign(
  (k, d) => (k === "DATABASE_CLIENT" ? "sqlite" : k === "DATABASE_FILENAME" ? ABS : d),
  { int: (k, d) => d, bool: (k, d) => d },
);
const cfg = factory({ env });
if (!cfg || !cfg.connection) fail("конфигурация базы пуста");
// knex-параметры лежат на уровень глубже: strapi ждёт database.connection.connection
const got = cfg.connection.connection && cfg.connection.connection.filename;
if (got !== ABS) fail(`абсолютный DATABASE_FILENAME искажён: ${got}`);
const migDir = path.join(out, "database", "migrations");
const migrations = require("fs").existsSync(migDir)
  ? require("fs").readdirSync(migDir).filter((f) => /\.(js|sql)$/.test(f))
  : [];
const repoMigDir = path.join(process.argv[2], "cms", "database", "migrations");
// Отсутствие каталога в репозитории — это «проверить не удалось», а не «миграций нет»:
// без него readdirSync выбросил бы сырой ENOENT вместо внятного отказа.
if (!require("fs").existsSync(repoMigDir)) fail(`в репозитории нет ${repoMigDir}: сверять число миграций не с чем`);
const inRepo = require("fs").readdirSync(repoMigDir).filter((f) => /\.(js|sql)$/.test(f));
if (migrations.length !== inRepo.length) {
  fail(`миграций в артефакте ${migrations.length}, в репозитории ${inRepo.length}: на сервере они не выполнятся, и переименование колонки обнулит значения`);
}
console.log(`[artifact] проверки собранного вывода пройдены (миграций: ${migrations.length})`);
' "$OUT" "$REPO_ROOT"

echo "[artifact] готов: $OUT"
