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
CMS_ROOT="$REPO_ROOT/cms"
PREBUILT=0
if [[ "${1:-}" == "--prebuilt" ]]; then
  PREBUILT=1
  shift
fi
OUT="${1:?укажите каталог для артефакта}"
if [[ "$OUT" != /* ]]; then OUT="$PWD/$OUT"; fi
if [[ "$OUT" == / || "$OUT" == "$REPO_ROOT" || "$OUT" == "$CMS_ROOT" ]]; then
  echo "[artifact] небезопасный каталог вывода: $OUT" >&2
  exit 1
fi

if (( PREBUILT )); then
  if [[ ! "${CMS_SOURCE_SHA:-}" =~ ^[a-f0-9]{40}$ ||
        ! "${CMS_SOURCE_REF:-}" =~ ^refs/heads/(dev|main)$ ||
        ! "${CMS_RUN_ID:-}" =~ ^[1-9][0-9]*$ ||
        ! "${CMS_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]]; then
    echo "[artifact] нужны точные CMS_SOURCE_SHA/REF/RUN_ID/RUN_ATTEMPT" >&2
    exit 1
  fi
  node - "$CMS_RUN_ID" "$CMS_RUN_ATTEMPT" <<'NODE'
for (const value of process.argv.slice(2)) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    console.error('[artifact] некорректный run ID/attempt');
    process.exit(1);
  }
}
NODE
  if [[ ! -f "$CMS_ROOT/dist/build/index.html" ]]; then
    echo "[artifact] нет обязательного cms/dist/build/index.html" >&2
    exit 1
  fi
  if [[ ! -f "$CMS_ROOT/dist/src/index.js" ]]; then
    echo "[artifact] нет обязательного cms/dist/src/index.js" >&2
    exit 1
  fi
  if [[ -e "$OUT" ]]; then
    echo "[artifact] каталог вывода уже существует: $OUT" >&2
    exit 1
  fi
fi

if (( ! PREBUILT )); then
  cd "$CMS_ROOT"
  npm run build
fi

if (( ! PREBUILT )); then rm -rf "$OUT"; fi
mkdir -p "$OUT"
# Copy only the runtime payload and reject links/special files. Nested node_modules are
# intentionally omitted from every copied tree; the server assembles against its own runtime.
node - "$CMS_ROOT" "$OUT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [cmsRoot, out] = process.argv.slice(2).map((value) => path.resolve(value));
const fail = (message) => { throw new Error(`[artifact] ${message}`); };

function copyPayload(sourceName, destinationName = sourceName) {
  const source = path.join(cmsRoot, sourceName), destination = path.join(out, destinationName);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.cpSync(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter(candidate) {
      const relative = path.relative(cmsRoot, candidate).split(path.sep);
      if (relative.includes('node_modules')) return false;
      let info;
      try { info = fs.lstatSync(candidate); } catch { fail(`нет обязательного файла ${path.relative(cmsRoot, candidate)}`); }
      if (info.isSymbolicLink()) fail(`symlink запрещён: ${path.relative(cmsRoot, candidate)}`);
      if (!info.isDirectory() && !info.isFile()) fail(`специальный файл запрещён: ${path.relative(cmsRoot, candidate)}`);
      return true;
    },
  });
}

for (const name of ['dist', 'package.json', 'package-lock.json', 'tsconfig.json']) {
  copyPayload(name);
}
for (const name of ['public', 'database']) {
  if (fs.existsSync(path.join(cmsRoot, name))) copyPayload(name);
}
copyPayload('src/api/seminar/content-types/seminar/schema.json', 'database/migrations/target-schema/seminar.json');
copyPayload('src/lib/demo193-source-empty-fields.json');
for (const name of ['run-data-migrations.mjs', 'audit-data-migration.mjs', 'audit-schema-snapshot.mjs',
  'institute-method-author-classification.mjs', 'normalize-null-documents-state.mjs']) {
  copyPayload(`scripts/${name}`);
}
fs.mkdirSync(path.join(out, 'database/migrations'), { recursive: true, mode: 0o755 });
NODE
# The migration preflight uses this exact compiled-target schema as evidence when
# the recorded native rename predates retirement of the seminar status attribute.
# Compiled publication lifecycle loads this runtime data file via the release-root cwd.

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
// Сколько миграций в артефакте ДОЛЖНО быть — записывается сюда, потому что на сервере
// репозитория нет и сверять не с чем. Без этого числа серверная проверка вынуждена
// требовать «хотя бы одну» вечно, и в день, когда последнюю миграцию законно уберут,
// она начнёт отказывать на каждой выкатке, объясняя это неверной причиной.
require("fs").writeFileSync(
  path.join(out, "database", ".migrations-expected"),
  String(migrations.length) + "\n",
);
console.log(`[artifact] проверки собранного вывода пройдены (миграций: ${migrations.length})`);
' "$OUT" "$REPO_ROOT"

# Тот же release gate проверяется над готовым артефактом: точные пути и байты каждого
# payload должны совпадать с versioned plan, включая запускаемый runner и его helpers.
source "$REPO_ROOT/scripts/lib/release-migrations.sh"
check_release_migrations "$OUT"

if (( PREBUILT )); then
  NPM_VERSION="$(npm --version)"
  node - "$OUT" "$CMS_SOURCE_SHA" "$CMS_SOURCE_REF" "$CMS_RUN_ID" "$CMS_RUN_ATTEMPT" "$NPM_VERSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const [root, sha, ref, runIdText, attemptText, npmVersion] = process.argv.slice(2);
const fail = (message) => { console.error(`[artifact] ${message}`); process.exit(1); };
const positiveInteger = (value) => {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number)) fail('некорректный run ID/attempt');
  return number;
};
if (!/^[a-f0-9]{40}$/.test(sha) || !/^refs\/heads\/(dev|main)$/.test(ref) ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion)) fail('некорректная source/runtime identity');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function inventory(directory, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(directory, relative)).sort()) {
    const name = relative ? `${relative}/${entry}` : entry;
    if (name === 'cms-artifact-manifest.json') continue;
    if (entry === 'node_modules') fail('node_modules запрещён в CMS artifact');
    const full = path.join(directory, name);
    const info = fs.lstatSync(full);
    if (info.isSymbolicLink()) fail(`symlink запрещён: ${name}`);
    if (info.isDirectory()) result.push(...inventory(directory, name));
    else if (info.isFile()) result.push(name);
    else fail(`специальный файл запрещён: ${name}`);
  }
  return result;
}
(async () => {
  const files = [];
  for (const name of inventory(root).sort()) files.push({ path: name, sha256: await digest(path.join(root, name)) });
  const manifest = {
    schemaVersion: 1,
    source: { sha, ref, runId: positiveInteger(runIdText), runAttempt: positiveInteger(attemptText) },
    packageLockSha256: await digest(path.join(root, 'package-lock.json')),
    runtime: { nodeVersion: process.version, nodeMajor: Number(process.versions.node.split('.')[0]),
      nodeAbi: process.versions.modules, npmVersion },
    files,
  };
  fs.writeFileSync(path.join(root, 'cms-artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
})().catch((error) => fail(error.message));
NODE
fi

echo "[artifact] готов: $OUT"
