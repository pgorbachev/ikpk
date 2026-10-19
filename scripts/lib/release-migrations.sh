# shellcheck shell=bash
# Это подключаемый ФРАГМЕНТ, а не точка входа: он вливается в поток и отдельно не
# запускается — потому и без шебанга, и без бита исполнения (гейт гигиены стережёт обе
# стороны: точка входа обязана быть исполняемой, фрагмент — нет).
# Вливается в поток, уходящий на сервер по ssh, рядом с `scripts/lib/declared.sh`:
# на сервере репозитория нет, поэтому `source` там невозможен. Отдельным файлом — чтобы
# проверка была проверяемой и чтобы её ДОСТАВКА была видна в одном месте с доставкой
# остального. Прежде функция жила в `bootstrap-vps.sh` вне heredoc и на сервер не
# попадала вовсе: вызов давал `command not found`, код 127, и `if !` превращал это в
# отказ выкатки на каждом прогоне.

# Миграции обязаны ДОЕХАТЬ в релиз, а не только существовать в репозитории. Пустой каталог
# неотличим от «миграций нет»: Strapi молча выполняет ноль штук и приводит базу к схеме
# обычной сверкой — `dropColumn` + `createColumn` с потерей значений. Проверка нужна здесь,
# а не только в сборщике: источник артефакта задаёт оператор, и собрать его можно мимо
# `scripts/build-cms-artifact.sh`.
#
# Сверяется ЧИСЛО, а не «хотя бы одна»: последнее верно лишь пока миграции в репозитории
# есть, и в день, когда последнюю законно уберут, такая проверка отказывала бы на каждой
# выкатке, называя неверную причину. Ожидаемое число кладёт в артефакт сборщик — на сервере
# репозитория нет. Отсутствие файла с числом — «происхождение не подтверждено», тоже отказ.
#
# Оформлено функцией с маркерами, чтобы её можно было ПРОВЕРИТЬ: тест извлекает этот же
# текст и исполняет его, поэтому второй копии логики не заводится. Пока проверка жила
# строками внутри выкатки, её снятие не красило ничего.
check_release_migrations() {
  local release="$1"
  local expected_file="${release}/database/.migrations-expected"

  if [[ ! -f "$expected_file" ]]; then
    echo "[cms] в релизе нет ${expected_file}: артефакт собран мимо" >&2
    echo "[cms] scripts/build-cms-artifact.sh, и проверить состав миграций нечем." >&2
    return 1
  fi

  local expected actual
  expected="$(tr -dc '0-9' <"$expected_file")"
  actual=$(find "${release}/database/migrations" -maxdepth 1 \
    \( -name '*.js' -o -name '*.sql' \) -type f 2>/dev/null | wc -l | tr -d ' ')

  if [[ -z "$expected" || "$actual" != "$expected" ]]; then
    echo "[cms] миграций в релизе ${actual}, ожидалось ${expected:-<не число>}." >&2
    echo "[cms] Часть миграций не доехала: переименование колонки пройдёт сверкой схемы" >&2
    echo "[cms] и обнулит значения." >&2
    return 1
  fi

  echo "[cms] миграций в релизе ${actual}, как и ожидалось"

  node - "$release" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(process.argv[2]);
const migrationsRoot = path.join(root, 'database', 'migrations');
const fail = (message) => { console.error(`[cms] migration plan: ${message}`); process.exit(1); };
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let plan;
try { plan = JSON.parse(fs.readFileSync(path.join(migrationsRoot, 'plan.json'), 'utf8')); }
catch (error) { fail(`cannot read database/migrations/plan.json: ${error.message}`); }
if (!plan || plan.version !== 1 || !Array.isArray(plan.steps)) fail('version 1 plan with an ordered steps array is required');

// Verify listed bytes before coverage/schema diagnostics so substitution reports the
// concrete SHA mismatch even when the remainder of an artifact fixture is incomplete.
const seenIds = new Set();
const seenPaths = new Set();
for (const step of plan.steps) {
  if (!step || typeof step.id !== 'string' || seenIds.has(step.id)) fail(`invalid or duplicate step ID: ${step?.id ?? '<missing>'}`);
  seenIds.add(step.id);
  if (typeof step.path !== 'string' || !step.path || path.isAbsolute(step.path) || step.path.split(/[\\/]/).includes('..')) fail(`unsafe payload path for ${step.id}`);
  if (seenPaths.has(step.path)) fail(`duplicate payload path: ${step.path}`);
  seenPaths.add(step.path);
  if (!/^[a-f0-9]{64}$/.test(step.sha256 ?? '')) fail(`missing SHA-256 for ${step.id}`);
  const payload = path.resolve(migrationsRoot, step.path);
  const relative = path.relative(migrationsRoot, payload);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail(`payload escapes migrations directory: ${step.path}`);
  let info;
  try { info = fs.lstatSync(payload); } catch { fail(`planned payload is missing: ${step.path}`); }
  if (!info.isFile() || info.isSymbolicLink()) fail(`payload must be a regular file: ${step.path}`);
  const actualHash = hash(payload);
  if (actualHash !== step.sha256) fail(`SHA-256 mismatch for ${step.path}: expected ${step.sha256}, found ${actualHash}`);
}
const actualNative = fs.readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:js|sql)$/.test(entry.name))
  .map((entry) => entry.name).sort();
const plannedNative = plan.steps
  .filter((step) => step.kind === 'strapi-native' || (!step.kind && /\.(?:js|sql)$/.test(step.path)))
  .map((step) => step.path).sort();
if (JSON.stringify(actualNative) !== JSON.stringify(plannedNative)) fail(`native migration paths differ (artifact: ${actualNative.join(', ') || '<none>'}; plan: ${plannedNative.join(', ') || '<none>'})`);
if (!plan.integrity || !Array.isArray(plan.integrity.files) || plan.integrity.files.length === 0) fail('plan must include integrity hashes for the runner and packaged data helpers');
const integrity = new Set();
for (const entry of plan.integrity.files) {
  if (!entry || typeof entry.path !== 'string' || !entry.path || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) fail(`invalid integrity entry: ${entry?.path ?? '<missing>'}`);
  if (integrity.has(entry.path)) fail(`duplicate integrity path: ${entry.path}`);
  integrity.add(entry.path);
  const file = path.resolve(root, entry.path);
  const relative = path.relative(root, file);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail(`integrity path escapes artifact: ${entry.path}`);
  let info;
  try { info = fs.lstatSync(file); } catch { fail(`packaged integrity file is missing: ${entry.path}`); }
  if (!info.isFile() || info.isSymbolicLink()) fail(`integrity file must be regular: ${entry.path}`);
  const actualHash = hash(file);
  if (actualHash !== entry.sha256) fail(`integrity SHA-256 mismatch for ${entry.path}: expected ${entry.sha256}, found ${actualHash}`);
}
NODE

  return 0
}
