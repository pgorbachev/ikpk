'use strict';

/**
 * Переименование `status` → `seminar_status` / `entry_status` с сохранением значений.
 *
 * Зачем миграция, если схема и так изменилась. Strapi сверяет объявленную схему с базой
 * ПО ИМЕНИ колонки и переименования не распознаёт: для него это «старый атрибут удалён,
 * новый добавлен». `@strapi/database/dist/schema/builder.js` в `alterTable` сначала зовёт
 * `dropColumn` для `columns.removed`, затем `createColumn` для `columns.added`, а
 * `@strapi/core/dist/Strapi.js:361` вызывает `db.schema.sync()` при КАЖДОМ старте, включая
 * `NODE_ENV=production`. Значение по умолчанию у скалярного поля живёт на уровне сущности,
 * а не колонки, поэтому новая колонка остаётся пустой — её никто не заполняет.
 *
 * Измерено на настоящем Strapi поверх sqlite (старт со старой схемой, вставка записи,
 * подмена схемы, повторный старт):
 *
 *   до:    { name: 'Существующее событие', status: 'cancelled' }
 *   после: { name: 'Существующее событие', entry_status: null }
 *
 * Потеря молчаливая: сайт фильтрует `status === 'active'` в семи местах, при null
 * расписание исчезает целиком, а контракт снимка (`REQUIRED_SNAPSHOT_FIELDS`) покрывает
 * только статьи и пустое значение пропускает.
 *
 * Почему это лечится именно миграцией: `db.migrations.up()` выполняется ДО `syncSchema()`
 * (`@strapi/database/dist/schema/index.js:69-73`). Переименовав колонку здесь, мы приводим
 * базу к объявленной схеме заранее — последующая сверка не видит ни удалённых, ни
 * добавленных колонок и ничего не делает.
 *
 * Идемпотентность обязательна: на стенде переименование уже произошло (схемы попали в
 * работающий `dist` до появления этой миграции), и там нужно тихо ничего не делать.
 */

/** Пары «таблица → старое и новое имя колонки». */
const RENAMES = [
  { table: 'seminars', from: 'status', to: 'seminar_status' },
  { table: 'schedule_entries', from: 'status', to: 'entry_status' },
];

async function rename(knex, { table, from, to }) {
  if (!(await knex.schema.hasTable(table))) return `${table}: таблицы нет — пропуск`;

  const hasFrom = await knex.schema.hasColumn(table, from);
  const hasTo = await knex.schema.hasColumn(table, to);

  if (hasTo && !hasFrom) return `${table}.${to}: уже переименована — пропуск`;
  if (!hasFrom) return `${table}.${from}: колонки нет — пропуск`;

  // Обе сразу означают, что sync уже создал пустую новую колонку рядом со старой:
  // переносим значения и убираем старую, иначе следующий sync удалит её вместе с данными.
  if (hasTo && hasFrom) {
    await knex(table).update({ [to]: knex.ref(from) });
    await knex.schema.alterTable(table, (t) => t.dropColumn(from));
    return `${table}: значения перенесены ${from} → ${to}, старая колонка убрана`;
  }

  await knex.schema.alterTable(table, (t) => t.renameColumn(from, to));
  return `${table}: ${from} → ${to}`;
}

module.exports = {
  async up(knex) {
    for (const spec of RENAMES) {
      console.log(`[rename-status-columns] ${await rename(knex, spec)}`);
    }
  },

  async down(knex) {
    for (const { table, from, to } of RENAMES) {
      await rename(knex, { table, from: to, to: from });
    }
  },
};
