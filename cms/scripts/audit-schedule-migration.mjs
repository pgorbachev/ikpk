import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const Database = createRequire(import.meta.url)('better-sqlite3');
const json = JSON.stringify;
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(json(value));
const quote = name => `"${name.replaceAll('"', '""')}"`;
const plannedTables = ['seminars', 'schedule_entries', 'schedule_entries_seminar_lnk', 'files_related_mph'];
const runnerTables = new Set(['ikpk_migration_lineage','ikpk_migration_operations','ikpk_data_migration_history']);
const entryFields = new Set(['price', 'is_free', 'city', 'is_online', 'duration']);
function fail(message) { throw new Error(`schedule audit: ${message}`); }
function fingerprint(path) {
  return digest([path, `${path}-wal`].map(file => {
    try { return hash(readFileSync(file)); } catch (error) {
      if (file !== path && error.code === 'ENOENT') return null;
      throw error;
    }
  }));
}
function rows(db, table) { return db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all(); }
function tables(db) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name); }
function schema(db) { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); }
function integrity(db) { return db.pragma('integrity_check').map(Object.values).flat().join(',') === 'ok' && db.pragma('foreign_key_check').length === 0; }
function key(row) { return json(row, (_k, value) => Buffer.isBuffer(value) ? { blob: value.toString('base64') } : value); }
function bag(values) { return values.map(key).sort(); }
function same(a,b) { return json(a) === json(b); }
function ids(items, label) {
  const result = new Map();
  for (const item of items) {
    if (!Number.isSafeInteger(item?.rowId) || result.has(item.rowId)) fail(`duplicate or invalid ${label} row identity`);
    result.set(item.rowId, item);
  }
  return result;
}
/** Read-only, closed-world audit of one reviewed schedule plan on an otherwise unchanged database.
 * The caller must obtain expectedPlanDigest and acceptedExceptions from independent approval.
 * It does not audit document-component migrations, schema sync, runner metadata, or receipts.
 */
export function auditScheduleMigration({ sourceDbPath, candidateDbPath, plan, expectedPlanDigest, acceptedExceptions, includeRunnerMetadata = false }) {
  if (!plan || !Array.isArray(plan.entries) || !Array.isArray(plan.seminars) || !Array.isArray(plan.exceptions) || !Array.isArray(acceptedExceptions)) fail('invalid plan or exception approvals');
  const { planDigest, ...payload } = plan;
  if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest ?? '') || planDigest !== expectedPlanDigest || digest(payload) !== expectedPlanDigest) fail('reviewed plan digest mismatch');
  const beforeFingerprint = fingerprint(sourceDbPath), afterFingerprint = fingerprint(candidateDbPath);
  const open = path => new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
  const source = open(sourceDbPath); let candidate;
  try {
    candidate = open(candidateDbPath); source.pragma('query_only=ON'); candidate.pragma('query_only=ON');
    source.exec('BEGIN'); candidate.exec('BEGIN');
    const differences = [];
    if (!integrity(source)) differences.push({kind:'source-integrity'});
    if (!integrity(candidate)) differences.push({kind:'candidate-integrity'});
    const sourceTables = tables(source), candidateTables = tables(candidate);
    for (const table of plannedTables) if (!sourceTables.includes(table)) fail(`missing source table ${table}`);
    const snapshot = Object.fromEntries(plannedTables.map(table => [table, rows(source, table)]));
    if (digest(snapshot) !== plan.sourceDigest) fail('source differs from reviewed plan');
    const accepted = new Set(acceptedExceptions.map(x => json([x.documentId,x.rowId,x.error])));
    for (const ex of plan.exceptions) {
      if (!Array.isArray(ex.errors) || !ex.errors.length || ex.errors.some(error => !accepted.has(json([ex.documentId,ex.rowId,error])))) fail('unaccepted exception');
    }
    const entries = ids(plan.entries,'entry'), seminars = ids(plan.seminars,'seminar');
    if (entries.size !== snapshot.schedule_entries.length) fail('plan must cover every entry version');
    const expected = new Map();
    for (const row of snapshot.schedule_entries) {
      const entry = entries.get(row.id);
      if (!entry || entry.documentId !== row.document_id || entry.published !== (row.published_at != null) || !entry.changes || typeof entry.changes !== 'object' || Array.isArray(entry.changes)) fail('entry identity or version mismatch');
      for (const [field,value] of Object.entries(entry.changes)) {
        if (!entryFields.has(field) || (field === 'price' && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) || (['is_free','is_online'].includes(field) && value !== 0 && value !== 1) || (field === 'city' && value !== null && typeof value !== 'string') || (field === 'duration' && value !== null)) fail('invalid planned entry change');
      }
      expected.set(row.id, {...row, ...entry.changes});
    }
    const bySeminar = new Map(snapshot.seminars.map(row => [row.id,row]));
    for (const [id, item] of seminars) {
      const row = bySeminar.get(id);
      if (!row || item.documentId !== row.document_id || typeof item.duration !== 'string' || !item.duration.trim()) fail('seminar identity or duration mismatch');
    }
    // Every physical version of any selected document must be explicitly present.
    const selectedDocuments = new Set(plan.seminars.map(item => item.documentId));
    for (const row of snapshot.seminars) if (selectedDocuments.has(row.document_id) && !seminars.has(row.id)) fail('plan omits a seminar version');
    if (!same(sourceTables,candidateTables) || !same(schema(source),schema(candidate))) differences.push({kind:'schema-changed'});
    for (const table of sourceTables) {
      if (!candidateTables.includes(table)) { differences.push({kind:'table-removed',table}); continue; }
      if (includeRunnerMetadata && runnerTables.has(table)) continue; // Must be checked by auditMigrationStageLedger.
      let expectedRows = rows(source,table);
      if (table === 'schedule_entries') expectedRows = expectedRows.map(row => expected.get(row.id));
      if (table === 'seminars') expectedRows = expectedRows.map(row => seminars.has(row.id) ? {...row,duration:seminars.get(row.id).duration} : row);
      if (!same(bag(expectedRows),bag(rows(candidate,table)))) differences.push({kind:'rows-changed',table});
    }
    if (fingerprint(sourceDbPath) !== beforeFingerprint || fingerprint(candidateDbPath) !== afterFingerprint) fail('database changed during audit');
    return {private:true, passed:differences.length === 0, planDigest, sourceFingerprint:beforeFingerprint, candidateFingerprint:afterFingerprint, differences};
  } finally { if (candidate) candidate.close(); source.close(); }
}
