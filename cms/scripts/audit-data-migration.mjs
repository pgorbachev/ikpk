#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const HASH = /^[a-f0-9]{64}$/;
const RUNNER_TABLES = new Set(['ikpk_migration_lineage', 'ikpk_migration_operations', 'ikpk_data_migration_history']);
const KNOWN_RENAMES = new Map([
  ['seminars', ['status', 'seminar_status']],
  ['schedule_entries', ['status', 'entry_status']],
]);
const CURRENT_CONTENT_ADDITIONS = {
  promotions: { name: 'type', type: 'varchar(255)' },
  schedule_entries: { name: 'is_event_collection', type: 'boolean' },
};
const RUNNER_SCHEMAS = {
  ikpk_migration_lineage: ['singleton', 'lineage_id', 'source_snapshot_sha256', 'source_schema_sha256', 'created_at'],
  ikpk_migration_operations: ['operation_id', 'lineage_id', 'source_snapshot_sha256', 'source_schema_sha256', 'created_at'],
  ikpk_data_migration_history: ['lineage_id', 'operation_id', 'step_id', 'payload_sha256', 'result_json', 'completed_at'],
};

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function json(value) { return JSON.stringify(value); }
function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => name);
}
function quote(identifier) { return `"${identifier.replaceAll('"', '""')}"`; }
function sourceFileFingerprint(path) {
  const parts = [path, `${path}-wal`].map((file) => {
    try { return { file: basename(file), sha256: sha(readFileSync(file)) }; }
    catch (error) { if (error.code === 'ENOENT' && file !== path) return { file: basename(file), absent: true }; throw error; }
  });
  return sha(Buffer.from(json(parts)));
}
function dbOpen(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
  db.defaultSafeIntegers(true);
  db.pragma('query_only = ON');
  return db;
}
function integrity(db) {
  const integrityCheck = db.pragma('integrity_check').map((row) => Object.values(row)[0]);
  const foreignKeyViolations = db.pragma('foreign_key_check');
  return { integrityCheck, foreignKeyViolations: foreignKeyViolations.length };
}
function schema(db) {
  const tables = {};
  for (const table of tableNames(db)) {
    tables[table] = db.prepare(`PRAGMA table_info(${quote(table)})`).all()
      .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull: Number(notnull), defaultValue: dflt_value, pk: Number(pk) }));
  }
  return tables;
}
function relationalSchema(db, table) {
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all().map((row) => ({
    table: row.table, from: row.from, to: row.to, onUpdate: row.on_update, onDelete: row.on_delete, match: row.match,
  })).sort((a, b) => json(a).localeCompare(json(b)));
  const indexes = db.prepare(`PRAGMA index_list(${quote(table)})`).all().map((row) => ({
    unique: Number(row.unique), origin: row.origin, partial: Number(row.partial),
    columns: db.prepare(`PRAGMA index_info(${quote(row.name)})`).all().map(({ name }) => name),
  })).sort((a, b) => json(a).localeCompare(json(b)));
  const definitions = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type, name`).all(table)
    .map(({ type, name, sql }) => ({ type, name, sql }));
  return { foreignKeys, indexes, definitions };
}
function normalizeRelationalSchema(value, table, transforms) {
  const rename = KNOWN_RENAMES.get(table);
  if (!rename || !transforms.nativeRenameTables.has(table)) return value;
  const renameColumn = (name) => name === rename[0] ? rename[1] : name;
  return {
    foreignKeys: value.foreignKeys.map((fk) => ({ ...fk, from: renameColumn(fk.from), to: renameColumn(fk.to) }))
      .sort((a, b) => json(a).localeCompare(json(b))),
    indexes: value.indexes.map((index) => ({ ...index, columns: index.columns.map(renameColumn) }))
      .sort((a, b) => json(a).localeCompare(json(b))),
    definitions: value.definitions.map((item) => ({ ...item,
      sql: item.sql.replace(new RegExp(`(["'\x60\\[]?)${rename[0]}(["'\x60\\]]?)`, 'g'), (_match, before, after) => `${before}${rename[1]}${after}`),
    })),
  };
}
function valueKey(value) {
  if (Buffer.isBuffer(value)) return { blobSha256: sha(value), bytes: value.length };
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (Array.isArray(value)) return value.map(valueKey);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, valueKey(value[key])]));
  return value;
}
function objectDigest(row) {
  return sha(Buffer.from(json(Object.fromEntries(Object.keys(row).sort().map((key) => [key, valueKey(row[key])])))));
}
function primaryColumns(columns) { return columns.filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name }) => name); }
function collectRows(db, table, columns) {
  const names = columns.map(({ name }) => name);
  const rows = db.prepare(`SELECT ${names.map(quote).join(', ')} FROM ${quote(table)}`).all();
  return rows.map((raw) => {
    const values = names.map((name) => raw[name]);
    const keyed = Object.fromEntries(names.map((name, index) => [name, valueKey(values[index])]));
    return { keyed, values, digest: objectDigest(keyed) };
  });
}
function countByTable(db, tables) {
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get().n.toString()]));
}
function difference(differences, table, kind, key, before, after) {
  differences.push({ table, kind, keySha256: sha(Buffer.from(json(key))), ...(before ? { sourceSha256: before.digest } : {}), ...(after ? { candidateSha256: after.digest } : {}) });
}
function compareRows(sourceDb, candidateDb, sourceTable, candidateTable, columns, differences) {
  const sourceRows = collectRows(sourceDb, sourceTable, columns);
  const candidateRows = collectRows(candidateDb, candidateTable, columns);
  const keys = primaryColumns(columns);
  if (keys.length) {
    const keyOf = (row) => json(keys.map((key) => row.keyed[key]));
    const before = new Map(sourceRows.map((row) => [keyOf(row), row]));
    const after = new Map(candidateRows.map((row) => [keyOf(row), row]));
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key); const b = after.get(key);
      if (!a) difference(differences, candidateTable, 'row-added', keys.map((name) => b.keyed[name]), null, b);
      else if (!b) difference(differences, candidateTable, 'row-removed', keys.map((name) => a.keyed[name]), a, null);
      else if (a.digest !== b.digest) difference(differences, candidateTable, 'row-content', keys.map((name) => a.keyed[name]), a, b);
    }
  } else {
    const before = new Map(); const after = new Map();
    for (const row of sourceRows) before.set(row.digest, (before.get(row.digest) ?? 0) + 1);
    for (const row of candidateRows) after.set(row.digest, (after.get(row.digest) ?? 0) + 1);
    for (const digest of new Set([...before.keys(), ...after.keys()])) {
      const delta = (after.get(digest) ?? 0) - (before.get(digest) ?? 0);
      for (let i = 0; i < Math.abs(delta); i += 1) {
        differences.push({ table: candidateTable, kind: delta > 0 ? 'row-added' : 'row-removed', keySha256: digest, rowSha256: digest });
      }
    }
  }
}
function expectedColumns(sourceColumns, table, knownTransforms) {
  const rename = KNOWN_RENAMES.get(table);
  return sourceColumns.map((column) => {
    if (rename && knownTransforms.nativeRenameTables.has(table) && column.name === rename[0]) return { ...column, name: rename[1] };
    return column;
  });
}
function normalizeAddedTableDefinition(definition, table, column) {
  if (definition.type !== 'table') return definition;
  const quoted = `(?:"${column.name}"|\`${column.name}\`|\[${column.name}\]|${column.name})`;
  const columnType = column.type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = definition.sql.replace(new RegExp(`,\\s*${quoted}\\s+${columnType}(?=\\s*\\)$)`, 'i'), '');
  return { ...definition, sql: normalized };
}
function deriveKnownTransforms(sourceDb, plan) {
  const transforms = { nativeRename: false, nativeRenameTables: new Set(), classification: null, documentsState: null, nativeSteps: [] };
  for (const step of plan.steps) {
    if (step.kind === 'strapi-native' && step.id === '2026.09.21T00.00.00.rename-status-columns'
      && step.path === '2026.09.21T00.00.00.rename-status-columns.js'
      && step.sha256 === '5f7ea6cb13aee8385d68901c42b73113cb3513bd45e802f79bc8def11c0ed215') {
      transforms.nativeRename = true;
      for (const [table, [from]] of KNOWN_RENAMES) {
        const columns = new Set(sourceDb.prepare(`PRAGMA table_info(${quote(table)})`).all().map(({ name }) => name));
        if (columns.has(from)) transforms.nativeRenameTables.add(table);
      }
      const alreadyApplied = tableNames(sourceDb).includes('strapi_migrations')
        && sourceDb.prepare('SELECT name FROM strapi_migrations').all().some(({ name }) => basename(name) === basename(step.path));
      if (!alreadyApplied) transforms.nativeSteps.push(basename(step.path));
    } else if (step.kind === 'data' && step.handler === 'classification'
      && step.id === 'institute-method-author-classification-v1'
      && step.path === 'data-steps/classification.mjs'
      && step.sha256 === '5a824938c8075287c33925f00b4c22f168459031ed6336a4c75812790bcc2059') {
      const { planClassification } = require('../scripts/institute-method-author-classification.mjs');
      const derived = planClassification(sourceDb);
      if (derived.logicalPeople !== 12 || derived.physicalRows < 12) throw new Error('classification plan did not identify the exact supported 12-person set');
      transforms.classification = derived;
    } else if (step.kind === 'data' && step.handler === 'normalize-documents-state'
      && step.id === 'normalize-null-documents-state-v1'
      && step.path === 'data-steps/normalize-documents-state.mjs'
      && step.sha256 === '4be74fe36c1117035344f35fb76d5426062e4a78ada0f3002740d70e214403d0') {
      const tables = new Set(tableNames(sourceDb));
      if (!tables.has('seminars') || !tables.has('seminars_cmps')) throw new Error('documents-state audit source schema is incomplete');
      const seminarColumns = sourceDb.prepare('PRAGMA table_info("seminars")').all().map(({ name }) => name);
      for (const column of ['id', 'document_id', 'published_at']) if (!seminarColumns.includes(column)) throw new Error(`documents-state audit source is missing seminars.${column}`);
      const stateExists = seminarColumns.includes('documents_state');
      const nullRows = sourceDb.prepare(`SELECT id AS rowId, document_id AS documentId, published_at AS publishedAt FROM seminars ${stateExists ? 'WHERE documents_state IS NULL' : ''} ORDER BY id`).all();
      const badIdentity = nullRows.some(({ documentId }) => typeof documentId !== 'string' || documentId.trim() === '');
      const ids = [...new Set(nullRows.map(({ documentId }) => documentId).filter((id) => typeof id === 'string' && id.trim() !== ''))];
      let contradictions = [];
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(', ');
        contradictions = sourceDb.prepare(`SELECT DISTINCT s.id AS rowId FROM seminars s JOIN seminars_cmps c ON c.entity_id=s.id WHERE s.document_id IN (${placeholders}) AND c.field='documents'`).all(...ids);
      }
      const blocked = badIdentity || contradictions.length > 0;
      const candidateRows = blocked ? [] : nullRows.map(({ rowId, documentId, publishedAt }) => ({ rowId, documentId, published: publishedAt !== null }));
      const derived = { blocked, candidateRows, logicalDocuments: blocked ? 0 : ids.length };
      if (derived.blocked) throw new Error('documents-state normalization source has contradictory component or identity evidence');
      transforms.documentsState = derived;
    } else {
      throw new Error(`unsupported or changed migration step in audit plan: ${step.id}`);
    }
  }
  return transforms;
}
function expectedTableRows(sourceDb, sourceTable, columns, transforms) {
  const rows = collectRows(sourceDb, sourceTable, columns).map(({ keyed }) => ({ ...keyed }));
  if (sourceTable === 'teachers' && transforms.classification) {
    const ids = new Set(transforms.classification.changes.flatMap(({ rows: changed }) => changed.map(({ rowId }) => String(rowId))));
    for (const row of rows) if (ids.has(String(row.id?.integer ?? row.id))) row.trait = 'method-author';
  }
  if (sourceTable === 'seminars' && transforms.documentsState) {
    if (!columns.some(({ name }) => name === 'documents_state')) {
      for (const row of rows) row.documents_state = null;
    }
    const ids = new Set(transforms.documentsState.candidateRows.map(({ rowId }) => String(rowId)));
    for (const row of rows) if (ids.has(String(row.id?.integer ?? row.id))) row.documents_state = 'unconfirmed';
  }
  const rename = KNOWN_RENAMES.get(sourceTable);
  if (rename && transforms.nativeRenameTables.has(sourceTable)) {
    for (const row of rows) { row[rename[1]] = row[rename[0]]; delete row[rename[0]]; }
  }
  return rows;
}
function compareExpectedRows(sourceDb, candidateDb, table, sourceColumns, candidateColumns, transforms, differences) {
  const expected = expectedTableRows(sourceDb, table, sourceColumns, transforms);
  const candidate = collectRows(candidateDb, table, candidateColumns);
  const keys = primaryColumns(sourceColumns).map((name) => {
    const rename = KNOWN_RENAMES.get(table);
    return rename && transforms.nativeRename && name === rename[0] ? rename[1] : name;
  });
  const digest = objectDigest;
  if (keys.length) {
    const mapByKey = (rows, pick) => new Map(rows.map((row) => {
      const value = pick(row);
      return [json(keys.map((key) => value[key])), { value, digest: digest(value) }];
    }));
    const before = mapByKey(expected, (row) => row); const after = mapByKey(candidate, (row) => row.keyed);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key); const b = after.get(key);
      if (!a) difference(differences, table, 'row-added', JSON.parse(key), null, b);
      else if (!b) difference(differences, table, 'row-removed', JSON.parse(key), a, null);
      else if (a.digest !== b.digest) {
        const changedFields = Object.keys(a.value).filter((field) => json(a.value[field]) !== json(b.value[field]));
        differences.push({ table, kind: 'row-content', keySha256: sha(Buffer.from(key)), changedFields, sourceSha256: a.digest, candidateSha256: b.digest });
      }
    }
  } else {
    const normalize = (rows) => { const map = new Map(); for (const row of rows) { const d = digest(row); map.set(d, (map.get(d) ?? 0) + 1); } return map; };
    const before = normalize(expected); const after = normalize(candidate.map(({ keyed }) => keyed));
    for (const d of new Set([...before.keys(), ...after.keys()])) {
      const delta = (after.get(d) ?? 0) - (before.get(d) ?? 0);
      for (let index = 0; index < Math.abs(delta); index += 1) differences.push({ table, kind: delta > 0 ? 'row-added' : 'row-removed', keySha256: d, rowSha256: d });
    }
  }
}
function compareInheritedRows(table, sourceRows, candidateRows, keyOf, allowedNew, differences) {
  const candidateByKey = new Map(candidateRows.map((row) => [keyOf(row), row]));
  const sourceKeys = new Set();
  for (const row of sourceRows) {
    const key = keyOf(row); sourceKeys.add(key);
    const copied = candidateByKey.get(key);
    if (!copied || json(valueKey(row)) !== json(valueKey(copied))) {
      differences.push({ table, kind: 'inherited-history-changed', keySha256: sha(Buffer.from(key)) });
    }
  }
  for (const row of candidateRows) {
    const key = keyOf(row);
    if (!sourceKeys.has(key) && !allowedNew(row)) differences.push({ table, kind: 'unexpected-history-added', keySha256: sha(Buffer.from(key)) });
  }
}
function allowRunnerRows(sourceDb, candidateDb, plan, receipt, transforms, differences) {
  const candidateTables = new Set(tableNames(candidateDb));
  let missingRunnerTable = false;
  for (const [table, expected] of Object.entries(RUNNER_SCHEMAS)) {
    if (!candidateTables.has(table)) { differences.push({ table, kind: 'required-runner-table-missing' }); missingRunnerTable = true; continue; }
    const columns = candidateDb.prepare(`PRAGMA table_info(${quote(table)})`).all().map(({ name }) => name);
    if (json(columns) !== json(expected)) differences.push({ table, kind: 'unexpected-runner-schema', schemaSha256: sha(Buffer.from(json(columns))) });
  }
  if (missingRunnerTable) return { lineageCount: 0, operationCount: 0, ledgerCount: 0 };
  const lineage = candidateDb.prepare('SELECT * FROM ikpk_migration_lineage ORDER BY singleton').all();
  const operations = candidateDb.prepare('SELECT * FROM ikpk_migration_operations ORDER BY operation_id').all();
  const ledger = candidateDb.prepare('SELECT * FROM ikpk_data_migration_history ORDER BY step_id').all();
  const sourceHas = (table) => tableNames(sourceDb).includes(table);
  const sourceLineage = sourceHas('ikpk_migration_lineage') ? sourceDb.prepare('SELECT * FROM ikpk_migration_lineage ORDER BY singleton').all() : [];
  const sourceOperations = sourceHas('ikpk_migration_operations') ? sourceDb.prepare('SELECT * FROM ikpk_migration_operations ORDER BY operation_id').all() : [];
  const sourceLedger = sourceHas('ikpk_data_migration_history') ? sourceDb.prepare('SELECT * FROM ikpk_data_migration_history ORDER BY step_id').all() : [];
  const currentOperation = operations.find((row) => row.operation_id === receipt.operationId);
  compareInheritedRows('ikpk_migration_lineage', sourceLineage, lineage, (row) => String(row.singleton),
    (row) => sourceLineage.length === 0 && Number(row.singleton) === 1 && row.lineage_id === currentOperation?.lineage_id
      && HASH.test(row.lineage_id ?? '') && HASH.test(row.source_snapshot_sha256 ?? '') && HASH.test(row.source_schema_sha256 ?? ''), differences);
  compareInheritedRows('ikpk_migration_operations', sourceOperations, operations, (row) => row.operation_id,
    (row) => row.operation_id === receipt.operationId
      && row.lineage_id === lineage[0]?.lineage_id
      && row.source_snapshot_sha256 === receipt.source.snapshotSha256
      && row.source_schema_sha256 === receipt.source.schemaFingerprint, differences);
  const expectedStepIds = new Set(plan.steps.filter(({ kind }) => kind === 'data').map(({ id }) => id));
  compareInheritedRows('ikpk_data_migration_history', sourceLedger, ledger, (row) => `${row.lineage_id}\0${row.step_id}`,
    (row) => expectedStepIds.has(row.step_id) && row.operation_id === receipt.operationId
      && plan.steps.some(({ id, sha256, kind }) => kind === 'data' && id === row.step_id && sha256 === row.payload_sha256), differences);
  if (lineage.length !== 1 || Number(lineage[0]?.singleton) !== 1 || !HASH.test(lineage[0]?.lineage_id ?? '')
    || !HASH.test(lineage[0]?.source_snapshot_sha256 ?? '')
    || !HASH.test(lineage[0]?.source_schema_sha256 ?? '')) differences.push({ table: 'ikpk_migration_lineage', kind: 'lineage-binding-mismatch' });
  if (!operations.some((row) => row.operation_id === receipt.operationId
    && row.lineage_id === lineage[0]?.lineage_id
    && row.source_snapshot_sha256 === receipt.source.snapshotSha256
    && row.source_schema_sha256 === receipt.source.schemaFingerprint)) differences.push({ table: 'ikpk_migration_operations', kind: 'operation-binding-mismatch' });
  const expectedDataSteps = plan.steps.filter(({ kind }) => kind === 'data');
  if (ledger.length !== expectedDataSteps.length) differences.push({ table: 'ikpk_data_migration_history', kind: 'ledger-step-set-mismatch' });
  for (const step of expectedDataSteps) {
    const row = ledger.find(({ step_id }) => step_id === step.id);
    if (!row || row.payload_sha256 !== step.sha256 || !operations.some(({ operation_id }) => operation_id === row.operation_id)) {
      differences.push({ table: 'ikpk_data_migration_history', kind: 'ledger-step-mismatch', stepId: step.id });
      continue;
    }
    let result;
    try { result = JSON.parse(row.result_json); } catch { result = null; }
    const expectedResult = step.handler === 'classification' && transforms.classification
      ? { updatedRows: transforms.classification.changes.reduce((sum, person) => sum + person.rows.length, 0), noops: transforms.classification.noops.length }
      : step.handler === 'normalize-documents-state' && transforms.documentsState
        ? { updatedRows: transforms.documentsState.candidateRows.length, logicalDocuments: transforms.documentsState.logicalDocuments }
        : null;
    const validHistoricalResult = step.handler === 'classification'
      ? Number.isSafeInteger(result?.updatedRows) && result.updatedRows >= 0 && Number.isSafeInteger(result?.noops) && result.noops >= 0
        && result.updatedRows + result.noops <= 24
      : step.handler === 'normalize-documents-state'
        ? Number.isSafeInteger(result?.updatedRows) && result.updatedRows >= 0 && Number.isSafeInteger(result?.logicalDocuments) && result.logicalDocuments >= 0
        : false;
    if (!expectedResult || (row.operation_id === receipt.operationId ? json(result) !== json(expectedResult) : !validHistoricalResult)) {
      differences.push({ table: 'ikpk_data_migration_history', kind: 'ledger-result-mismatch', stepId: step.id });
    }
  }
  const sourceTables = new Set(tableNames(sourceDb));
  const candidateNames = tableNames(candidateDb);
  for (const table of candidateNames) {
    if (RUNNER_TABLES.has(table) || sourceTables.has(table)) continue;
    if (table === 'strapi_migrations') continue;
    differences.push({ table, kind: 'unknown-table-added' });
  }
  for (const table of sourceTables) {
    if (RUNNER_TABLES.has(table) && !candidateTables.has(table)) differences.push({ table, kind: 'unknown-table-removed' });
  }
  return { lineageCount: lineage.length, operationCount: operations.length, ledgerCount: ledger.length };
}
function compareNativeHistory(sourceDb, candidateDb, nativeSteps, differences) {
  if (!tableNames(candidateDb).includes('strapi_migrations')) {
    if (nativeSteps.length) differences.push({ table: 'strapi_migrations', kind: 'native-history-missing' });
    return;
  }
  const nativeColumns = (db) => db.prepare('PRAGMA table_info("strapi_migrations")').all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull: Number(notnull), defaultValue: dflt_value, pk: Number(pk) }));
  const expectedColumns = [
    { name: 'id', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'name', type: 'varchar(255)', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'time', type: 'datetime', notnull: 0, defaultValue: null, pk: 0 },
  ];
  const sourceHasHistory = tableNames(sourceDb).includes('strapi_migrations');
  if (json(nativeColumns(candidateDb)) !== json(expectedColumns)
    || (sourceHasHistory && json(nativeColumns(sourceDb)) !== json(expectedColumns))) {
    differences.push({ table: 'strapi_migrations', kind: 'unsupported-native-history-schema', schemaSha256: sha(Buffer.from(json(nativeColumns(candidateDb)))) }); return;
  }
  const sourceRows = sourceHasHistory ? sourceDb.prepare('SELECT id, name, time FROM strapi_migrations ORDER BY id').all() : [];
  const candidateRows = candidateDb.prepare('SELECT id, name, time FROM strapi_migrations ORDER BY id').all();
  const sourceIds = new Set(sourceRows.map(({ id }) => String(id)));
  const additions = candidateRows.filter(({ id }) => !sourceIds.has(String(id)));
  if (json(additions.map(({ name }) => name).sort()) !== json([...nativeSteps].sort())) {
    differences.push({ table: 'strapi_migrations', kind: 'native-history-addition-mismatch', addedCount: additions.length });
  }
  const candidateById = new Map(candidateRows.map((row) => [String(row.id), row]));
  for (const row of sourceRows) if (json(valueKey(row)) !== json(valueKey(candidateById.get(String(row.id))))) {
    differences.push({ table: 'strapi_migrations', kind: 'existing-history-changed', keySha256: sha(Buffer.from(String(row.id))) });
  }
}

/**
 * Compare a pristine source with its fully prepared candidate. The returned report
 * is private operator evidence: it contains only hashes, counts, and table names.
 */
export function auditMigration({ sourceDbPath, candidateDbPath, plan, receipt }) {
  if (!plan || !Array.isArray(plan.steps) || !HASH.test(plan.planSha256 ?? '')) throw new Error('audit requires a resolved migration plan with planSha256 and steps');
  if (typeof plan.manifestPath !== 'string' || sha(readFileSync(plan.manifestPath)) !== plan.planSha256) throw new Error('migration plan bytes do not match the resolved plan hash');
  const manifest = JSON.parse(readFileSync(plan.manifestPath, 'utf8'));
  const identity = ({ id, phase, kind, handler, path, sha256 }) => [id, phase, kind, handler ?? null, path, sha256];
  if (!Array.isArray(manifest.steps) || json(plan.steps.map(identity)) !== json(manifest.steps.map(identity))) throw new Error('resolved plan steps differ from the hash-bound manifest');
  if (json(receipt?.steps?.map(identity)) !== json(plan.steps.map(identity))) throw new Error('receipt steps differ from the hash-bound plan');
  if (!receipt || receipt.sourceDbPath !== sourceDbPath || receipt.candidateDbPath !== candidateDbPath) throw new Error('audit paths do not match the durable operation receipt');
  if (receipt.planSha256 !== plan.planSha256) throw new Error('audit plan hash does not match the durable operation receipt');
  if (!HASH.test(receipt.source?.sourceFileFingerprint ?? '') || !HASH.test(receipt.candidatePostMigrationFileFingerprint ?? '')) throw new Error('audit receipt is missing source or candidate file fingerprint');
  const sourceFingerprint = sourceFileFingerprint(sourceDbPath);
  const candidateFingerprint = sourceFileFingerprint(candidateDbPath);
  const sourceSha256 = sha(readFileSync(sourceDbPath));
  const candidateSha256 = sha(readFileSync(candidateDbPath));
  if (sourceFingerprint !== receipt.source.sourceFileFingerprint) throw new Error('source SQLite files differ from the receipt binding');
  if (candidateFingerprint !== receipt.candidatePostMigrationFileFingerprint) throw new Error('candidate SQLite files differ from the receipt binding');
  if (receipt.candidatePostMigrationSha256 !== candidateSha256) throw new Error('candidate main-file hash differs from the receipt binding');

  const source = dbOpen(sourceDbPath); const candidate = dbOpen(candidateDbPath);
  try {
    const sourceSchema = schema(source); const candidateSchema = schema(candidate);
    const transforms = deriveKnownTransforms(source, plan);
    const differences = [];
    const sourceIntegrity = integrity(source); const candidateIntegrity = integrity(candidate);
    if (sourceIntegrity.integrityCheck.length !== 1 || sourceIntegrity.integrityCheck[0] !== 'ok' || sourceIntegrity.foreignKeyViolations) differences.push({ table: '*', kind: 'source-integrity-failed' });
    if (candidateIntegrity.integrityCheck.length !== 1 || candidateIntegrity.integrityCheck[0] !== 'ok' || candidateIntegrity.foreignKeyViolations) differences.push({ table: '*', kind: 'candidate-integrity-failed' });
    const tableSet = new Set([...Object.keys(sourceSchema), ...Object.keys(candidateSchema)]);
    for (const table of tableSet) {
      if (RUNNER_TABLES.has(table) || table === 'strapi_migrations') continue;
      const before = sourceSchema[table]; const after = candidateSchema[table];
      if (!before || !after) { differences.push({ table, kind: before ? 'table-removed' : 'table-added' }); continue; }
      const expected = expectedColumns(before, table, transforms);
      const addition = CURRENT_CONTENT_ADDITIONS[table];
      const sourceHasAddition = addition && before.some(({ name }) => name === addition.name);
      const candidateHasAddition = addition && after.some(({ name }) => name === addition.name);
      const acceptedAddition = Boolean(addition && !sourceHasAddition && candidateHasAddition);
      if (acceptedAddition) expected.push({ name: addition.name, type: addition.type, notnull: 0, defaultValue: null, pk: 0 });
      const hasDocumentsState = table === 'seminars' && transforms.documentsState && !expected.some(({ name }) => name === 'documents_state');
      if (hasDocumentsState) expected.push({ name: 'documents_state', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 });
      const expectedNames = expected.map(({ name }) => name).sort(); const actualNames = after.map(({ name }) => name).sort();
      if (json(expectedNames) !== json(actualNames)) {
        differences.push({ table, kind: 'column-set-mismatch', sourceColumns: expectedNames, candidateColumns: actualNames });
        continue;
      }
      for (const column of expected) {
        const found = after.find(({ name }) => name === column.name);
        if (!found || found.type !== column.type || found.pk !== column.pk || found.notnull !== column.notnull || found.defaultValue !== column.defaultValue) {
          differences.push({ table, kind: 'column-definition-mismatch', column: column.name });
        }
      }
      const beforeRelations = normalizeRelationalSchema(relationalSchema(source, table), table, transforms);
      let afterRelations = relationalSchema(candidate, table);
      if (acceptedAddition) afterRelations = {
        ...afterRelations,
        definitions: afterRelations.definitions.map((item) => normalizeAddedTableDefinition(item, table, addition)),
      };
      if (json(beforeRelations) !== json(afterRelations)) differences.push({ table, kind: 'relation-schema-mismatch', sourceSha256: sha(Buffer.from(json(beforeRelations))), candidateSha256: sha(Buffer.from(json(afterRelations))) });
      if (acceptedAddition) {
        const nonNull = candidate.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)} WHERE ${quote(addition.name)} IS NOT NULL`).get().count;
        if (nonNull !== 0n) differences.push({ table, kind: 'added-column-value-mismatch', column: addition.name, nonNullCount: nonNull.toString() });
      }
      if (table === 'seminars' && hasDocumentsState) {
        // This single native schema-sync addition is accepted only as the known nullable text field.
        const state = after.find(({ name }) => name === 'documents_state');
        if (state?.type.toUpperCase() !== 'TEXT' || state.notnull !== 0 || state.pk !== 0) differences.push({ table, kind: 'documents-state-column-mismatch' });
      }
    }
    for (const table of Object.keys(sourceSchema)) {
      if (RUNNER_TABLES.has(table) || table === 'strapi_migrations' || !candidateSchema[table]) continue;
      const before = sourceSchema[table]; const after = candidateSchema[table];
      const expectedNames = new Set(expectedColumns(before, table, transforms).map(({ name }) => name));
      const rename = KNOWN_RENAMES.get(table);
      const changed = (transforms.classification && table === 'teachers')
        || (transforms.documentsState && table === 'seminars')
        || (transforms.nativeRenameTables.has(table) && rename);
      if (changed) compareExpectedRows(source, candidate, table, before, after, transforms, differences);
      else {
        const common = before.filter(({ name }) => expectedNames.has(name));
        compareRows(source, candidate, table, table, common, differences);
      }
    }
    const runnerCounts = allowRunnerRows(source, candidate, plan, receipt, transforms, differences);
    compareNativeHistory(source, candidate, transforms.nativeSteps, differences);
    const sourceCounts = countByTable(source, Object.keys(sourceSchema));
    const candidateCounts = countByTable(candidate, Object.keys(candidateSchema));
    const report = {
      private: true,
      passed: differences.length === 0,
      bindings: {
        sourceDbPath, candidateDbPath, operationId: receipt.operationId,
        sourceFileFingerprint: sourceFingerprint, sourceSha256,
        candidateFileFingerprint: candidateFingerprint, candidateSha256,
        planSha256: plan.planSha256,
      },
      source: { schemaFingerprint: sha(Buffer.from(json(sourceSchema))), tableCount: Object.keys(sourceSchema).length, rowCounts: sourceCounts, integrity: sourceIntegrity },
      candidate: { schemaFingerprint: sha(Buffer.from(json(candidateSchema))), tableCount: Object.keys(candidateSchema).length, rowCounts: candidateCounts, integrity: candidateIntegrity },
      transformations: {
        nativeStatusRename: transforms.nativeRename,
        nativeHistoryRows: transforms.nativeSteps.length,
        classifiedPeople: transforms.classification?.logicalPeople ?? 0,
        classifiedPhysicalRows: transforms.classification?.physicalRows ?? 0,
        documentsStateRows: transforms.documentsState?.candidateRows.length ?? 0,
        runnerTables: runnerCounts,
      },
      differences,
    };
    if (sourceFileFingerprint(sourceDbPath) !== sourceFingerprint || sourceFileFingerprint(candidateDbPath) !== candidateFingerprint) {
      throw new Error('source or candidate SQLite files changed while preservation audit was running');
    }
    return report;
  } finally { source.close(); candidate.close(); }
}
