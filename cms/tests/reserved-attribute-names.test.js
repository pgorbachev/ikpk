// РЕГРЕСС: `article` объявлял атрибут `published_at`, который Strapi 5 создаёт сам при
// включённом `draftAndPublish`. На ЧИСТОЙ базе это давало `duplicate column name: published_at`
// при создании таблицы — то есть CMS не поднималась вовсе. На уже существующей базе дефект спит:
// таблица создана раньше, миграция не выполняется, и запуск проходит. Отсюда и то, что дефект
// дожил до первого запуска с нуля.
//
// Признак берётся у самого Strapi (`isReservedAttributeName`), а не переписывается сюда списком:
// список в тесте отстаёт от предмета молча, и следующий зарезервированный атрибут гейт пропустит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentTypes } from '@strapi/utils';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api');
const DRAFT_PUBLISH_RESERVED = new Set(contentTypes.RESERVED_ATTRIBUTE_NAMES_DRAFT_PUBLISH);

function schemas() {
  const found = [];
  for (const api of readdirSync(API_DIR)) {
    const ctDir = join(API_DIR, api, 'content-types');
    let entries;
    try {
      entries = readdirSync(ctDir);
    } catch {
      continue;
    }
    for (const ct of entries) {
      const file = join(ctDir, ct, 'schema.json');
      try {
        found.push({ api, ct, file, json: JSON.parse(readFileSync(file, 'utf-8')) });
      } catch {
        // читаем строго: нечитаемая схема — это «проверить не удалось», см. проверку ниже
        found.push({ api, ct, file, json: null });
      }
    }
  }
  return found;
}

// Разделение на два теста не косметическое: `published_at` роняет СОЗДАНИЕ ТАБЛИЦЫ, а `status`
// Strapi лишь предупреждает — он ломает query-параметр `status` в REST. Сваливать их в один
// вердикт значило бы либо пропускать фатальный, либо требовать переименования `status` на
// семинарах и расписании прямо здесь, вместе с импортом и сайтом.
test('ни одна схема не объявляет атрибут, ломающий создание таблицы', () => {
  const all = schemas();
  assert.ok(all.length > 0, 'схем контента не найдено — проверка вакуумна');
  const unreadable = all.filter((s) => s.json === null).map((s) => s.file);
  assert.deepEqual(unreadable, [], `схемы не разобрались, измерение неполное: ${unreadable}`);

  const offenders = [];
  let inspected = 0;
  for (const { api, ct, json } of all) {
    for (const name of Object.keys(json.attributes ?? {})) {
      inspected += 1;
      if (contentTypes.isReservedAttributeName(name) && !DRAFT_PUBLISH_RESERVED.has(name)) {
        offenders.push(`${api}/${ct}: атрибут «${name}» зарезервирован Strapi`);
      }
    }
  }
  assert.ok(inspected > 0, 'ни одного атрибута не осмотрено — проверка вакуумна');
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

// `status` Strapi лишь предупреждает: он ломает не создание таблицы, а query-параметр `status`
// в REST. Поэтому здесь не отказ, а храповик: известные носители перечислены поимённо, и любой
// новый уронит тест. Снятие строки отсюда требует переименования атрибута, а не правки списка.
const KNOWN_DRAFT_PUBLISH_RESERVED = ['schedule-entry/schedule-entry', 'seminar/seminar'];

test('носителей зарезервированного при draftAndPublish атрибута не прибавилось', () => {
  const all = schemas();
  assert.ok(all.length > 0, 'схем контента не найдено — проверка вакуумна');
  assert.ok(
    DRAFT_PUBLISH_RESERVED.size > 0,
    'перечень зарезервированных при draftAndPublish пуст — проверка вакуумна',
  );

  const carriers = [];
  for (const { api, ct, json } of all) {
    if (json?.options?.draftAndPublish !== true) continue;
    for (const name of Object.keys(json.attributes ?? {})) {
      if (DRAFT_PUBLISH_RESERVED.has(name)) carriers.push(`${api}/${ct}`);
    }
  }
  assert.deepEqual(
    carriers.sort(),
    [...KNOWN_DRAFT_PUBLISH_RESERVED].sort(),
    'состав носителей изменился: добавленный — дефект, исчезнувший — снимите его из списка',
  );
});
