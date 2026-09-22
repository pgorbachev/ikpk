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
 * Предмет проверки — СОХРАНЕНИЕ ЗНАЧЕНИЙ, а не факт переименования; почему без миграции
 * они теряются, разобрано в заголовке самой миграции.
 *
 * Без sqlite-файла на диске проверять нечего, поэтому база создаётся во временном
 * каталоге, а не в памяти: `renameColumn` у sqlite пересоздаёт таблицу, и поведение на
 * файле и в памяти стоит мерить там же, где оно работает в жизни.
 */

async function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-mig-'));
  const knex = knexLib({
    client: 'better-sqlite3',
    connection: { filename: join(dir, 'test.db') },
    useNullAsDefault: true,
  });
  try {
    // Внешние ключи включены, как их включает Strapi на каждом соединении пула
    // (`@strapi/database/dist/dialects/sqlite/index.js`). Без этого ветка с пересборкой
    // таблицы выглядит безобидной: каскад срабатывает только при включённых ключах.
    await knex.raw('pragma foreign_keys = on');
    // Через транзакцию, потому что ТАК зовёт production: загрузчик оборачивает `up` в
    // `wrapTransaction` (`@strapi/database/dist/migrations/common.js:3`, подключено в
    // `users.js:34`), и внутрь приходит `trx`, а не сам knex. Прогон на голом knex был бы
    // зелёным на форме вызова, которой в жизни не бывает: у sqlite `dropColumn` может
    // идти пересборкой таблицы, а пересборка внутри транзакции — ровно то место, где
    // ломается `PRAGMA foreign_keys`.
    await knex.transaction((trx) => Promise.resolve(fn(trx)));
  } finally {
    await knex.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
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

  // Связь с каскадом — обязательная часть обстановки, а не украшение. У `seminars` в
  // настоящей схеме Strapi четыре каскадных потребителя (преподаватели, программа,
  // компоненты SEO, расписание); без единого из них ветка `renameColumn` исполняется
  // без того ограничения, которое и уничтожает данные при пересборке таблицы.
  await knex.schema.createTable('seminars_teachers_lnk', (t) => {
    t.increments('id');
    t.integer('seminar_id').references('id').inTable('seminars').onDelete('CASCADE');
    t.integer('teacher_id');
  });
  await knex('seminars_teachers_lnk').insert([
    { seminar_id: 1, teacher_id: 10 },
    { seminar_id: 2, teacher_id: 11 },
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
    // Ветка `renameColumn` — обычный путь выкатки, и до этой строки её каскад не стерёг
    // НИЧТО: замена переименования на пересборку таблицы оставляла все восемь тестов
    // зелёными, уничтожая при этом все связи на настоящей схеме Strapi.
    assert.equal(
      (await knex('seminars_teachers_lnk').select()).length,
      2,
      'связи семинаров унесло каскадом при переименовании колонки',
    );
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

test('перенос НЕ затирает то, что админка уже записала в новое поле', async () => {
  // РЕГРЕСС. Перенос был безусловным (`update({ [to]: knex.ref(from) })`) и проходил по всем
  // строкам, включая те, где старая колонка пуста. На машине с обеими колонками админка уже
  // могла записать в новое поле — и её значение затиралось пустым старым. Ветка срабатывает
  // ровно там, где правки руками наиболее вероятны, поэтому дефект был направлен в самое
  // ценное.
  await withDb(async (knex) => {
    await knex.schema.createTable('seminars', (t) => {
      t.increments('id');
      t.string('name');
      t.string('status');
      t.string('seminar_status');
    });
    await knex('seminars').insert([
      { name: 'не тронут админом', status: 'planned', seminar_status: null },
      { name: 'отредактирован в админке', status: null, seminar_status: 'not_planned' },
      { name: 'заведён после sync', status: null, seminar_status: 'planned' },
      // Строка, ради которой и стоит `.whereNull(to)`: ОБЕ колонки заполнены и РАЗНЫМИ
      // значениями. Так выглядит настоящая запись стенда — админка записала новое поле,
      // а старая колонка сохранила значение до переименования, потому что её никто не
      // чистит. Без такой строки в фикстуре `.whereNull(to)` можно снять, и все восемь
      // тестов останутся зелёными: у прочих строк непустая колонка только одна, и
      // `.whereNotNull(from)` даёт тот же результат без него. Проверено мутацией.
      { name: 'правлен в админке поверх старого значения', status: 'planned', seminar_status: 'not_planned' },
    ]);

    await migration.up(knex);

    assert.deepEqual(await knex('seminars').orderBy('id').pluck('seminar_status'), [
      'planned',
      'not_planned',
      'planned',
      'not_planned',
    ]);
  });
});

test('перенос НЕ уносит связи каскадом', async () => {
  // РЕГРЕСС, и найден он был только на форме production. На sqlite knex выполняет
  // `dropColumn` ПЕРЕСБОРКОЙ таблицы: create tmp → copy → DROP TABLE → rename. Внутри
  // транзакции при включённых внешних ключах (а Strapi включает их на каждом соединении)
  // `DROP TABLE seminars` срабатывает каскадом по всем `*_lnk`/`*_cmps`, которые Strapi
  // создаёт с `onDelete: 'CASCADE'`. Статусы сохранялись, а преподаватели, программа,
  // институт и компоненты SEO исчезали молча — без ошибки и без нарушения ключа после.
  //
  // Прежние тесты этого не видели, потому что создавали ОДИНОЧНЫЕ таблицы без внешних
  // ключей: ветка исполнялась без того самого ограничения, которое и уничтожало данные.
  await withDb(async (knex) => {
    await knex.schema.createTable('seminars', (t) => {
      t.increments('id');
      t.string('status');
      t.string('seminar_status');
    });
    await knex.schema.createTable('seminars_teacher_lnk', (t) => {
      t.increments('id');
      t.integer('seminar_id').references('id').inTable('seminars').onDelete('CASCADE');
      t.integer('teacher_id');
    });
    await knex('seminars').insert({ status: 'planned', seminar_status: null });
    await knex('seminars_teacher_lnk').insert({ seminar_id: 1, teacher_id: 10 });

    await migration.up(knex);

    assert.deepEqual(await knex('seminars').pluck('seminar_status'), ['planned']);
    assert.equal(
      (await knex('seminars_teacher_lnk').select()).length,
      1,
      'связь семинара с преподавателем унесло каскадом при пересборке таблицы',
    );
  });
});

test('таблицы нет — миграция молчит, а не падает', async () => {
  await withDb(async (knex) => {
    await migration.up(knex);
    assert.equal(await knex.schema.hasTable('seminars'), false);
  });
});
