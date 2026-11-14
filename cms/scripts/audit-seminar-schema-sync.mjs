import { createHash } from 'node:crypto';

const ADDED_COLUMNS = {
  schedule_entries: ['is_online'],
  seminars: ['audience','content_format','content_section_anchors','documents_owner_verified','duration'],
  components_seminar_document_records: ['completion_after_seminar_number','completion_cycle_name','completion_required','completion_scope','document_on_template','document_type_unspecified','hours_may_vary','hours_mode','includes_completed_level','issuer_unknown','other_seminar_href','other_seminar_label','qualification_topic','regulation_issuer','regulation_url','signed_by'],
};
const ADDED_TABLES = ['components_seminar_document_records_cmps','components_seminar_nmo_facts','components_seminar_registry_facts'];
const MANAGED_TABLES = ['admin_permissions','admin_permissions_role_lnk','strapi_core_store_settings','strapi_database_schema'];
const RUNNER_TABLES = ['ikpk_migration_lineage','ikpk_migration_operations','ikpk_data_migration_history'];
const json = JSON.stringify;
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const quote = value => `"${value.replaceAll('"','""')}"`;
function fail(message) { throw new Error(`seminar schema audit: ${message}`); }
function canonical(value) {
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function tables(db) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name); }
function columns(db, table) { return db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => ({name:row.name,type:row.type,notnull:Number(row.notnull),dflt_value:row.dflt_value,pk:Number(row.pk)})); }
function rows(db, table, cols) { return db.prepare(`SELECT ${cols.map(quote).join(', ')} FROM ${quote(table)}`).all().map(row => json(canonical(row))).sort(); }
function schema(db) { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name").all().map(canonical); }
function healthy(db) {
  const checks = db.prepare('PRAGMA integrity_check').all();
  return checks.length === 1 && Object.values(checks[0])[0] === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0;
}

/** Produce review evidence only. The schema and managed-row digests need a
 * separate substantive review; generating this object is not an approval.
 */
export function describeSeminarSchemaSync(source, candidate, { includeRunnerMetadata = false } = {}) {
  const managed = Object.fromEntries([...MANAGED_TABLES,...(includeRunnerMetadata?RUNNER_TABLES:[])].map(table => {
    const before = columns(source, table).map(x => x.name), after = columns(candidate, table).map(x => x.name);
    if (!before.length || !after.length) fail(`missing managed table ${table}`);
    return [table, {source:hash(rows(source,table,before)),candidate:hash(rows(candidate,table,after))}];
  }));
  return {version:1,sourceSchema:hash(schema(source)),candidateSchema:hash(schema(candidate)),managed};
}

/** Verify a separately reviewed schema contract against both DBs. Run on
 * stable read-only snapshots, before runner metadata or data migrations.
 * Expected digest MUST be supplied independently of the contract itself.
 */
export function auditSeminarSchemaSync(source, candidate, {contract, expectedContractDigest, includeRunnerMetadata = false}) {
  if (!/^[a-f0-9]{64}$/.test(expectedContractDigest ?? '') || hash(contract) !== expectedContractDigest || contract?.version !== 1) fail('reviewed contract digest mismatch');
  if (!healthy(source) || !healthy(candidate)) fail('integrity or foreign key check failed');
  if (json(describeSeminarSchemaSync(source,candidate,{includeRunnerMetadata})) !== json(contract)) fail('schema or reviewed managed rows changed');
  const before = tables(source), after = tables(candidate);
  const additions = after.filter(table => !before.includes(table));
  const removals = before.filter(table => !after.includes(table));
  if (json(additions) !== json([...ADDED_TABLES].sort()) || removals.length) fail('unexpected table set');
  for (const table of additions) {
    if (candidate.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n !== 0) fail(`new table ${table} is not empty`);
  }
  for (const table of before) {
    const beforeColumns = columns(source,table), afterColumns = columns(candidate,table);
    const beforeNames = beforeColumns.map(x=>x.name), afterNames = afterColumns.map(x=>x.name);
    const added = afterNames.filter(name=>!beforeNames.includes(name)).sort();
    if (json(added) !== json([...(ADDED_COLUMNS[table] ?? [])].sort()) || beforeNames.some(name=>!afterNames.includes(name))) fail(`unexpected columns in ${table}`);
    for (const col of beforeColumns) {
      if (json(col) !== json(afterColumns.find(x=>x.name===col.name))) fail(`existing column changed: ${table}.${col.name}`);
    }
    if (added.length && candidate.prepare(`SELECT count(*) AS n FROM ${quote(table)} WHERE ${added.map(name=>`${quote(name)} IS NOT NULL`).join(' OR ')}`).get().n !== 0) fail(`new column already populated in ${table}`);
    if (!MANAGED_TABLES.includes(table) && !(includeRunnerMetadata&&RUNNER_TABLES.includes(table)) && json(rows(source,table,beforeNames)) !== json(rows(candidate,table,beforeNames))) fail(`data changed in ${table}`);
  }
  return {passed:true,commonTables:before.length,addedTables:additions.length,addedColumns:Object.values(ADDED_COLUMNS).flat().length};
}
