// РЕГРЕСС: `article` объявлял атрибут `published_at`, который Strapi 5 создаёт сам при
// включённом `draftAndPublish`. На ЧИСТОЙ базе это давало `duplicate column name: published_at`
// при создании таблицы — то есть CMS не поднималась вовсе. На уже существующей базе дефект спит:
// таблица создана раньше, миграция не выполняется, и запуск проходит. Отсюда и то, что дефект
// дожил до первого запуска с нуля.
//
// Второй случай того же класса — `status` у семинара и записи расписания. Он не ронял создание
// таблицы, а делал поле НЕРЕДАКТИРУЕМЫМ: Strapi 5 держит это имя под статус документа
// (draft/published), поэтому поле оказывалось зажато между двумя проверками и ни одно значение
// не проходило обе. Измерено на стенде тем же API, которым пользуется админка:
//
//   status=active     → 400 «Invalid status»                              (служебный)
//   status=draft      → 400 «must be one of: active, cancelled, completed» (свой enum)
//
// Прежде оба носителя были перечислены здесь храповиком, потому что переименование требовало
// правки схем, импорта и сайта разом. Теперь они переименованы в `seminar_status`/`entry_status`,
// носителей не осталось, и храповик снят — как и предписывал его собственный комментарий.
//
// Признак берётся у самого Strapi, а не переписывается сюда списком: список в тесте отстаёт от
// предмета молча, и следующий зарезервированный атрибут гейт пропустит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, '..', 'src', 'api');

// Раньше признак брался из `@strapi/utils` (`contentTypes.isReservedAttributeName`). Этого
// экспорта БОЛЬШЕ НЕТ — обновление Strapi его убрало, и обе проверки здесь падали с
// «перечень пуст — проверка вакуумна». Молча это прожило до сегодня только потому, что
// `npm test` пакета `cms` не запускался ни в одном джобе CI; теперь запускается.
//
// Действующий источник — конструктор типов содержимого, тот самый, что применяет это правило
// в админке. Путь глубокий и лежит вне `exports` пакета, поэтому подключается по файлу: при
// следующем обновлении Strapi он сломается ГРОМКО, на загрузке модуля, а не тихо, как список
// литералов или исчезнувший экспорт.
const { isReservedAttributeName, reservedAttributes } = createRequire(import.meta.url)(
  join(
    HERE,
    '..',
    'node_modules',
    '@strapi',
    'content-type-builder',
    'dist',
    'server',
    'services',
    'builder.js',
  ),
);

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

test('признак зарезервированного имени жив — иначе проверка вакуумна', () => {
  assert.equal(
    typeof isReservedAttributeName,
    'function',
    'Strapi больше не отдаёт признак по этому пути: проверка ниже ничего не измеряет',
  );
  assert.ok(
    Array.isArray(reservedAttributes) && reservedAttributes.length > 0,
    'перечень зарезервированных имён пуст — проверка ниже ничего не измеряет',
  );
  // Контроль на известном имени: признак должен отвечать «да» хотя бы на одном.
  assert.equal(isReservedAttributeName('status'), true);
  assert.equal(isReservedAttributeName('seminar_status'), false);
});

test('ни одна схема не объявляет зарезервированный Strapi атрибут', () => {
  const all = schemas();
  assert.ok(all.length > 0, 'схем контента не найдено — проверка вакуумна');

  const unreadable = all.filter((s) => s.json === null).map((s) => s.file);
  assert.deepEqual(unreadable, [], `схемы не разобрались, измерение неполное: ${unreadable}`);

  const offenders = [];
  let inspected = 0;
  for (const { api, ct, json } of all) {
    for (const name of Object.keys(json.attributes ?? {})) {
      inspected += 1;
      if (isReservedAttributeName(name)) {
        offenders.push(`${api}/${ct}: атрибут «${name}» зарезервирован Strapi`);
      }
    }
  }

  assert.ok(inspected > 0, 'ни одного атрибута не осмотрено — проверка вакуумна');
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join('\n')}\nТакой атрибут либо роняет создание таблицы, либо становится нередактируемым в админке.`,
  );
});
