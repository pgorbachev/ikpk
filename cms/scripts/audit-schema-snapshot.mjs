import { createHash } from 'node:crypto';

const ALLOWED = new Map([
  ['promotions.type', {
    table: 'promotions', name: 'type', sqlType: /^varchar\s*\(\s*255\s*\)$/i,
    expected: { name: 'type', type: 'string', args: [], defaultTo: null, notNullable: false, unsigned: false },
  }],
  ['schedule_entries.is_event_collection', {
    table: 'schedule_entries', name: 'is_event_collection', sqlType: /^boolean$/i,
    expected: { name: 'is_event_collection', type: 'boolean', args: [], defaultTo: null, notNullable: false, unsigned: false },
  }],
]);

const json = (value) => JSON.stringify(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(`schema snapshot ${message}`); };

function parseRow(row, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`${label} row is invalid`);
  if (typeof row.schema !== 'string') fail(`${label} schema is not serialized JSON`);
  let schema;
  try { schema = JSON.parse(row.schema); } catch { fail(`${label} schema JSON is invalid`); }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !Array.isArray(schema.tables)) {
    fail(`${label} schema does not contain a tables array`);
  }
  if (typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)) fail(`${label} stored hash is invalid`);
  const sortedSchema = { ...schema, tables: [...schema.tables].sort((a, b) => String(a?.name).localeCompare(String(b?.name))) };
  const computed = sha256(json(sortedSchema));
  if (computed !== row.hash) fail(`${label} stored hash does not match its schema JSON`);
  return { row, schema, sortedSchema };
}

function columnEntries(table) {
  if (Array.isArray(table.columns)) return table.columns.map((column) => [column?.name, column]);
  if (table.columns && typeof table.columns === 'object') return Object.entries(table.columns);
  fail(`table ${String(table.name)} has no columns collection`);
}

function tablesByName(schema, label) {
  const map = new Map();
  for (const table of schema.tables) {
    if (!table || typeof table.name !== 'string' || map.has(table.name)) fail(`${label} table names are invalid or duplicated`);
    map.set(table.name, table);
  }
  return map;
}

function columnsByName(table, label) {
  const map = new Map();
  for (const [key, column] of columnEntries(table)) {
    const name = column?.name ?? key;
    if (typeof name !== 'string' || map.has(name)) fail(`${label} column names are invalid or duplicated`);
    map.set(name, column);
  }
  return map;
}

function withoutAllowedColumns(schema) {
  const copy = structuredClone(schema);
  for (const table of copy.tables) {
    if (Array.isArray(table.columns)) {
      table.columns = table.columns.filter((column) => !ALLOWED.has(`${table.name}.${column?.name}`));
    } else if (table.columns && typeof table.columns === 'object') {
      for (const columnName of Object.keys(table.columns)) {
        if (ALLOWED.has(`${table.name}.${columnName}`)) delete table.columns[columnName];
      }
    }
  }
  return { ...copy, tables: [...copy.tables].sort((a, b) => String(a?.name).localeCompare(String(b?.name))) };
}

function validateDefinition(key, definition, physicalColumns, expectedColumns) {
  const meta = ALLOWED.get(key);
  if (!meta || !expectedColumns || !Object.hasOwn(expectedColumns, key)) fail(`target expected column definition is missing for ${key}`);
  if (json(expectedColumns[key]) !== json(meta.expected) || json(definition) !== json(meta.expected)) {
    fail(`addition ${key} does not match the approved compiled target definition`);
  }

  const physical = physicalColumns?.[meta.table];
  if (!Array.isArray(physical)) fail(`physical PRAGMA metadata is missing for ${meta.table}`);
  const column = physical.find((item) => item?.name === meta.name);
  if (!column) fail(`physical PRAGMA metadata is missing ${key}`);
  if (!meta.sqlType.test(String(column.type ?? '').trim())) fail(`physical PRAGMA type does not match ${key}`);
  if (Number(column.notnull) !== 0 || Number(column.pk) !== 0 || column.defaultValue !== null) {
    fail(`physical PRAGMA null/default/key metadata does not match ${key}`);
  }
}

/**
 * Verifies that Strapi's current snapshot differs from its source only by the
 * two approved additive fields, with valid Strapi storage hashes and matching
 * SQLite PRAGMA facts. It is deliberately synchronous and has no DB access.
 */
export function validateSchemaSnapshot({ sourceRows, candidateRows, actualColumns, expectedColumns }) {
  if (!Array.isArray(sourceRows) || sourceRows.length !== 1 || !Array.isArray(candidateRows) || candidateRows.length !== 1) {
    fail('must contain exactly one source row and one candidate row');
  }
  const source = parseRow(sourceRows[0], 'source');
  const candidate = parseRow(candidateRows[0], 'candidate');
  const sourceTables = tablesByName(source.schema, 'source');
  const candidateTables = tablesByName(candidate.schema, 'candidate');
  if (sourceTables.size !== candidateTables.size || [...sourceTables.keys()].some((name) => !candidateTables.has(name))) {
    fail('table set changed');
  }

  const additions = [];
  for (const [tableName, candidateTable] of candidateTables) {
    const sourceTable = sourceTables.get(tableName);
    const before = columnsByName(sourceTable, `source ${tableName}`);
    const after = columnsByName(candidateTable, `candidate ${tableName}`);
    for (const [name, definition] of before) {
      if (!after.has(name)) fail(`existing column ${tableName}.${name} was removed`);
      if (json(definition) !== json(after.get(name))) fail(`existing column ${tableName}.${name} changed`);
    }
    for (const [name, definition] of after) {
      if (before.has(name)) continue;
      const key = `${tableName}.${name}`;
      if (!ALLOWED.has(key)) fail(`unexpected column addition ${key}`);
      validateDefinition(key, definition, actualColumns, expectedColumns);
      additions.push(key);
    }
  }
  const expected = [...ALLOWED.keys()].sort();
  if (json(additions.sort()) !== json(expected)) fail('does not contain exactly the two approved column additions');
  if (json(withoutAllowedColumns(candidate.schema)) !== json(withoutAllowedColumns(source.schema))) {
    fail('non-column schema metadata changed, including indexes or foreign keys');
  }

  return { valid: true, addedColumns: additions };
}
