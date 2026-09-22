'use strict';

/**
 * Переименование `status` → `seminar_status` / `entry_status` с сохранением значений.
 *
 * Зачем миграция, если схема и так изменилась. Strapi сверяет объявленную схему с базой
 * ПО ИМЕНИ колонки и переименования не распознаёт: для него это «старый атрибут удалён,
 * новый добавлен». `@strapi/database/dist/schema/builder.js` в `alterTable` сначала зовёт
 * `dropColumn` для `columns.removed`, затем `createColumn` для `columns.added`, а
 * `@strapi/core/dist/Strapi.js:360` вызывает `db.schema.sync()` при КАЖДОМ старте, включая
 * `NODE_ENV=production`. Значение по умолчанию у скалярного поля живёт на уровне сущности,
 * а не колонки, поэтому новая колонка остаётся пустой — её никто не заполняет.
 *
 * Измерено на настоящем Strapi поверх sqlite (старт со старой схемой, вставка записи,
 * подмена схемы, повторный старт):
 *
 *   до:    { name: 'Существующее событие', status: 'cancelled' }
 *   после: { name: 'Существующее событие', entry_status: null }
 *
 * Потеря молчаливая: сайт фильтрует `status === 'active'` в восьми местах (семь в `web/src`, восьмое —
 * на импорте, `web/scripts/lib/planned-seminars.ts`), при null
 * расписание исчезает целиком, а контракт снимка (`REQUIRED_SNAPSHOT_FIELDS`) покрывает
 * только статьи и пустое значение пропускает.
 *
 * Почему это лечится именно миграцией: `db.migrations.up()` выполняется ДО `syncSchema()`
 * (`@strapi/database/dist/schema/index.js:76`, `await db.migrations.up();` — внутри
 * `async sync ()` со строки 73). Переименовав колонку здесь, мы приводим
 * базу к объявленной схеме заранее — последующая сверка не видит ни удалённых, ни
 * добавленных колонок и ничего не делает.
 *
 * Идемпотентность обязательна: на стенде переименование уже произошло (схемы попали в
 * работающий `dist` до появления этой миграции), и там нужно тихо ничего не делать.
 *
 * Миграция обязана попасть в АРТЕФАКТ, а не только в репозиторий: Strapi ищет её в
 * `<корень релиза>/database/migrations`, `strapi build` её туда не кладёт, и пустой каталог
 * означает ноль миграций без единой жалобы. За этим следит `scripts/build-cms-artifact.sh`.
 */

/** Пары «таблица → старое и новое имя колонки». */
const RENAMES = [
  { table: 'seminars', from: 'status', to: 'seminar_status' },
  { table: 'schedule_entries', from: 'status', to: 'entry_status' },
];

async function rename(knex, { table, from, to }) {
  if (!(await knex.schema.hasTable(table))) return `${table}: таблицы нет — пропуск`;

  // Нет старой колонки — либо уже переименовано, либо свежая установка. Оба случая: молчим.
  if (!(await knex.schema.hasColumn(table, from))) return `${table}.${from}: нечего переносить`;

  // Обе колонки сразу. Состояние достижимо не потому, что sync «успел создать» новую рядом:
  // drop и create идут одним `alterTable`. Настоящий путь — устаревшая `strapi_database_schema`:
  // трёхсторонняя сверка прямо игнорирует то, чего нет в сохранённой схеме
  // (`@strapi/database/dist/schema/index.js:54`, «should be ignored»), поэтому старая колонка остаётся, а новая
  // создаётся.
  if (await knex.schema.hasColumn(table, to)) {
    // ТОЛЬКО пустые: на такой машине админка уже могла записать в новое поле, и безусловный
    // перенос затёр бы её значение старым (а у новых записей — вообще NULL). Проверено:
    // без `whereNull` запись со `seminar_status='not_planned'` и пустым `status` обнулялась.
    const moved = await knex(table)
      .whereNull(to)
      .whereNotNull(from)
      .update({ [to]: knex.ref(from) });

    // НЕ `knex.schema.alterTable(...).dropColumn()`: на sqlite knex выполняет это
    // ПЕРЕСБОРКОЙ таблицы (create tmp → copy → DROP TABLE → rename). Production зовёт
    // миграцию внутри транзакции, а Strapi держит `pragma foreign_keys = on` на каждом
    // соединении пула (`@strapi/database/dist/dialects/sqlite/index.js`). Отключить
    // внешние ключи внутри транзакции нельзя — это документированный no-op, — поэтому
    // `DROP TABLE seminars` срабатывает каскадом по всем `*_lnk`/`*_cmps`, которые
    // Strapi создаёт с `onDelete: 'CASCADE'`. Значения статуса при этом сохраняются, а
    // все связи (преподаватели, программа, институт, компоненты SEO) исчезают молча:
    // ошибки нет, нарушения внешнего ключа после тоже нет.
    //
    // Измерено на форме production (в транзакции, ключи включены): строк связи до 1,
    // после 0. Вне транзакции или с выключенными ключами — 1, то есть дефект виден
    // только в том сочетании, в котором миграция и работает.
    //
    // Нативный `ALTER TABLE ... DROP COLUMN` пересборки не делает: в sqlite он есть с
    // 3.35 (здесь 3.53), в postgres и mysql был всегда.
    await knex.raw(`ALTER TABLE ?? DROP COLUMN ??`, [table, from]);
    return `${table}: перенесено значений ${moved}, старая колонка ${from} убрана`;
  }

  await knex.schema.alterTable(table, (t) => t.renameColumn(from, to));
  return `${table}: ${from} → ${to}`;
}

module.exports = {
  // `down` намеренно нет: во всём Strapi `provider.down()` не зовёт ничто, команды миграций
  // в CLI тоже нет, — то есть откат недостижим никаким поддерживаемым способом. Метод,
  // который нельзя вызвать, — не страховка, а её видимость.
  async up(knex) {
    for (const spec of RENAMES) {
      console.log(`[rename-status-columns] ${await rename(knex, spec)}`);
    }
  },
};
