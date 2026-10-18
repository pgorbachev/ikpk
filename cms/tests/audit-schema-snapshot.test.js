import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { validateSchemaSnapshot } from '../scripts/audit-schema-snapshot.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function table(name, columns, extra = {}) { return { name, columns, indexes: [], foreignKeys: [], ...extra }; }
function snapshot(tables, marker = 'kept') {
  const schema = { version: 1, marker, tables };
  const ordered = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  return { id: 2, time: 100, schema: JSON.stringify({ ...schema, tables: ordered }), hash: sha256(JSON.stringify({ ...schema, tables: ordered })) };
}
const sourceTables = () => [
  table('promotions', [{ name: 'id', type: 'increments', unsigned: true }, { name: 'name', type: 'string', nullable: false }], { indexes: [{ name: 'promotions_name_idx', columns: ['name'] }] }),
  table('schedule_entries', [{ name: 'id', type: 'increments', unsigned: true }, { name: 'name', type: 'string' }], { foreignKeys: [{ name: 'schedule_fk', columns: ['id'], referencedTable: 'entries' }] }),
];
const actualColumns = {
  promotions: [
    { name: 'id', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'name', type: 'varchar(255)', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'type', type: 'varchar(255)', notnull: 0, defaultValue: null, pk: 0 },
  ],
  schedule_entries: [
    { name: 'id', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'name', type: 'varchar(255)', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'is_event_collection', type: 'boolean', notnull: 0, defaultValue: null, pk: 0 },
  ],
};
function candidateTables() {
  return [
    table('promotions', [...sourceTables()[0].columns, { name: 'type', type: 'string', args: [], defaultTo: null, notNullable: false, unsigned: false }], { indexes: [{ name: 'promotions_name_idx', columns: ['name'] }] }),
    table('schedule_entries', [...sourceTables()[1].columns, { name: 'is_event_collection', type: 'boolean', args: [], defaultTo: null, notNullable: false, unsigned: false }], { foreignKeys: [{ name: 'schedule_fk', columns: ['id'], referencedTable: 'entries' }] }),
  ];
}
const expectedColumns = {
  'promotions.type': { name: 'type', type: 'string', args: [], defaultTo: null, notNullable: false, unsigned: false },
  'schedule_entries.is_event_collection': { name: 'is_event_collection', type: 'boolean', args: [], defaultTo: null, notNullable: false, unsigned: false },
};

test('accepts only the two approved Strapi 5 additive columns and verifies stored hashes', () => {
  const sourceRows = [snapshot(sourceTables())];
  const candidateRows = [snapshot(candidateTables())];
  assert.deepEqual(validateSchemaSnapshot({ sourceRows, candidateRows, actualColumns, expectedColumns }), {
    valid: true,
    addedColumns: ['promotions.type', 'schedule_entries.is_event_collection'],
  });
});

test('rejects a change to an existing column, index, or foreign key', () => {
  for (const mutate of [
    (tables) => { tables[0].columns[1].nullable = true; },
    (tables) => { tables[0].indexes[0].columns = ['id']; },
    (tables) => { tables[1].foreignKeys[0].referencedTable = 'other'; },
  ]) {
    const changed = candidateTables();
    mutate(changed);
    assert.throws(() => validateSchemaSnapshot({ sourceRows: [snapshot(sourceTables())], candidateRows: [snapshot(changed)], actualColumns, expectedColumns }), /schema|column|index|foreign/i);
  }
});

test('rejects unexpected additions, incorrect physical metadata, and invalid stored hashes', () => {
  const unexpected = candidateTables();
  unexpected[0].columns.push({ name: 'extra', type: 'string' });
  assert.throws(() => validateSchemaSnapshot({ sourceRows: [snapshot(sourceTables())], candidateRows: [snapshot(unexpected)], actualColumns, expectedColumns }), /addition|column|schema/i);

  const wrongPhysical = structuredClone(actualColumns);
  wrongPhysical.promotions.find(({ name }) => name === 'type').notnull = 1;
  assert.throws(() => validateSchemaSnapshot({ sourceRows: [snapshot(sourceTables())], candidateRows: [snapshot(candidateTables())], actualColumns: wrongPhysical, expectedColumns }), /physical|PRAGMA|column/i);

  const invalidHash = { ...snapshot(candidateTables()), hash: '0'.repeat(64) };
  assert.throws(() => validateSchemaSnapshot({ sourceRows: [snapshot(sourceTables())], candidateRows: [invalidHash], actualColumns, expectedColumns }), /hash/i);
});
