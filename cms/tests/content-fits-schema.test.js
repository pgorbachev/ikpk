// РЕГРЕСС: импорт терял 27 записей на `seo.seo_title must be at most 120 characters`.
// Ограничение придумано нами, а содержимое сайта его не выполняет: настоящий максимум 223.
// CMS, которая не может хранить контент собственного сайта, настроена неверно — и узнавать
// об этом из середины импорта дорого.
//
// Признак общий: собираются ВСЕ ограничения длины из схем и компонентов по имени атрибута,
// и по ним проверяются данные discovery. Список полей сюда не переписывается — он отстал бы
// от предмета молча.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CMS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(CMS_ROOT, '..');
const ENTITIES = join(REPO_ROOT, 'discovery', 'entities');
// Strapi хранит `type: "string"` как varchar(255) — предел есть, даже когда его не написали.
const IMPLICIT_STRING_LIMIT = 255;

function jsonFilesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** имя атрибута → минимальный объявленный предел длины по всем схемам и компонентам */
function declaredLimits() {
  const limits = new Map();
  const sources = [
    ...jsonFilesUnder(join(CMS_ROOT, 'src', 'api')),
    ...jsonFilesUnder(join(CMS_ROOT, 'src', 'components')),
  ];
  for (const file of sources) {
    let schema;
    try {
      schema = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    for (const [name, def] of Object.entries(schema.attributes ?? {})) {
      // Предел бывает ОБЪЯВЛЕННЫМ и НЕЯВНЫМ. `type: "string"` в Strapi — это varchar(255),
      // и запись длиннее отвергается точно так же, хотя `maxLength` в схеме нет. Гейт,
      // читающий только объявленное, пропустил бы её — и пропустил: ссылка акции в 260
      // символов дожила до середины импорта.
      const max = typeof def?.maxLength === 'number' ? def.maxLength : def?.type === 'string' ? IMPLICIT_STRING_LIMIT : undefined;
      if (typeof max !== 'number') continue;
      const prev = limits.get(name);
      limits.set(name, prev === undefined ? max : Math.min(prev, max));
    }
  }
  return limits;
}

test('контент сайта помещается в объявленные схемой пределы длины', () => {
  const limits = declaredLimits();
  assert.ok(limits.size > 0, 'ни одного ограничения длины в схемах — проверка вакуумна');

  const files = readdirSync(ENTITIES).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'нет данных discovery — проверка вакуумна');

  const violations = [];
  let checked = 0;
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(ENTITIES, file), 'utf-8'));
    } catch {
      violations.push(`${file}: не разобрался — измерение неполное`);
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const record of parsed) {
      if (record === null || typeof record !== 'object') continue;
      for (const [field, limit] of limits) {
        const value = record[field];
        if (typeof value !== 'string') continue;
        checked += 1;
        if (value.length > limit) {
          violations.push(
            `${file}: поле «${field}» длиной ${value.length} при пределе ${limit} — ${value.slice(0, 40)}…`,
          );
        }
      }
    }
  }
  assert.ok(checked > 0, 'ни одно поле с ограничением не встретилось в данных — проверка вакуумна');
  assert.deepEqual(violations, [], `${violations.length} записей не помещаются:\n${violations.slice(0, 5).join('\n')}`);
});
