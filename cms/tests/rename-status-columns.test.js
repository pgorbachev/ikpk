import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import knexLib from 'knex';

const require_ = createRequire(import.meta.url);
// Миграции Strapi — CommonJS по требованию самого загрузчика: он подключает их через
// `require` (`@strapi/database/dist/migrations/users.js`), а `.ts` не поддерживает вовсе.
const migration = require_(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'database',
    'migrations',
    '2026.09.21T00.00.00.rename-status-columns.js',
  ),
);

/**
 * Миграция переименования `status` → `seminar_status` / `entry_status`.
 *
 * Предмет проверки — СОХРАНЕНИЕ ЗНАЧЕНИЙ, а не факт переименования. Без миграции Strapi
 * приводит базу к схеме сам: сверяет колонки по имени, не распознаёт переименование и
 * делает `dropColumn` + `createColumn`. Новая колонка остаётся пустой — значение по
 * умолчанию у скалярного поля живёт на уровне сущности, а не колонки. Потеря молчаливая:
 * сайт фильтрует `status === 'active'` в семи местах, и при null расписание исчезает
 * целиком, не уронив ни одной проверки.
 *
 * Без sqlite-файла на диске проверять нечего, поэтому база создаётся во временном
 * каталоге, а не в памяти: `renameColumn` у sqlite пересоздаёт таблицу, и поведение на
 * файле и в памяти стоит мерить там же, где оно работает в жизни.
 */

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-mig-'));
  const knex = knexLib({
    client: 'better-sqlite3',
    connection: { filename: join(dir, 'test.db') },
    useNullAsDefault: true,
  });
  return (async () => {
    try {
      await fn(knex);
    } finally {
      await knex.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

/** База до переименования: старая колонка со значениями. */
async function seedPreRename(knex) {
  await knex.schema.createTable('schedule_entries', (t) => {
    t.increments('id');
    t.string('name');
    t.string('status');
  });
  await knex.schema.createTable('seminars', (t) => {
    t.increments('id');
    t.string('name');
    t.string('status');
  });
  await knex('schedule_entries').insert([
    { name: 'Отменённое', status: 'cancelled' },
    { name: 'Идущее', status: 'active' },
  ]);
  await knex('seminars').insert([
    { name: 'Без дат', status: 'not_planned' },
    { name: 'С датами', status: 'planned' },
  ]);
}

test('значения переезжают в новую колонку, а не теряются', async () => {
  await withDb(async (knex) => {
    await seedPreRename(knex);
    await migration.up(knex);

    assert.deepEqual(await knex('schedule_entries').orderBy('id').pluck('entry_status'), [
      'cancelled',
      'active',
    ]);
    assert.deepEqual(await knex('seminars').orderBy('id').pluck('seminar_status'), [
      'not_planned',
      'planned',
    ]);
    assert.equal(await knex.schema.hasColumn('schedule_entries', 'status'), false);
  });
});

test('повторный прогон ничего не ломает: на стенде колонки уже переименованы', async () => {
  await withDb(async (knex) => {
    await seedPreRename(knex);
    await migration.up(knex);
    await migration.up(knex);

    assert.deepEqual(await knex('schedule_entries').orderBy('id').pluck('entry_status'), [
      'cancelled',
      'active',
    ]);
  });
});

test('если sync успел создать пустую колонку рядом со старой, значения переносятся в неё', async () => {
  await withDb(async (knex) => {
    // Ровно то, что сделает Strapi, если схема доедет до машины раньше миграции.
    await knex.schema.createTable('seminars', (t) => {
      t.increments('id');
      t.string('status');
      t.string('seminar_status');
    });
    await knex('seminars').insert([{ status: 'not_planned', seminar_status: null }]);

    await migration.up(knex);

    assert.deepEqual(await knex('seminars').pluck('seminar_status'), ['not_planned']);
    assert.equal(await knex.schema.hasColumn('seminars', 'status'), false);
  });
});

test('обратная миграция возвращает и имя, и значения', async () => {
  await withDb(async (knex) => {
    await seedPreRename(knex);
    await migration.up(knex);
    await migration.down(knex);

    assert.deepEqual(await knex('schedule_entries').orderBy('id').pluck('status'), [
      'cancelled',
      'active',
    ]);
  });
});

test('таблицы нет — миграция молчит, а не падает', async () => {
  await withDb(async (knex) => {
    await migration.up(knex);
    assert.equal(await knex.schema.hasTable('seminars'), false);
  });
});
