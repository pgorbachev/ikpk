import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTITUTES = [
  { legacyId: 'institut-apledzhera', slug: 'institut-apledzhera', name: 'Институт Апледжера' },
  { legacyId: 'institut-barralya', slug: 'institut-barralya', name: 'Институт Барраля' },
];

/** Stable legacy identities from the pinned capture; CMS numeric IDs are deliberately not used. */
export const TARGET_PEOPLE = [
  { legacyId: '63', name: 'Шрайнер Валерий Эдуардович, MD, CST-D', institute: 'institut-apledzhera', initialTrait: 'teacher' },
  { legacyId: '64', name: 'Радзинская Елена Викторовна', institute: 'institut-apledzhera', initialTrait: 'teacher' },
  { legacyId: '65', name: 'Diego Maggio', institute: 'institut-apledzhera', initialTrait: 'method-author' },
  { legacyId: '66', name: 'Thomas Rasmussen', institute: 'institut-apledzhera', initialTrait: 'method-author' },
  { legacyId: '67', name: 'George Michael Morgan', institute: 'institut-apledzhera', initialTrait: 'method-author' },
  { legacyId: '68', name: 'Kenneth Koles Richard', institute: 'institut-apledzhera', initialTrait: 'method-author' },
  { legacyId: '74', name: 'Patricia Quirini', institute: 'institut-apledzhera', initialTrait: 'method-author' },
  { legacyId: '77', name: 'Chas Perry', institute: 'institut-apledzhera', initialTrait: 'method-author' },
  { legacyId: '79', name: 'Carol J. McLellan', institute: 'institut-apledzhera', initialTrait: 'method-author' },
  { legacyId: '69', name: 'Roberto Bonanzinga', institute: 'institut-barralya', initialTrait: 'method-author' },
  { legacyId: '70', name: 'Matteo Ghiretti', institute: 'institut-barralya', initialTrait: 'method-author' },
  { legacyId: '71', name: 'Paolo Ricci', institute: 'institut-barralya', initialTrait: 'method-author' },
];

const TARGET_BY_LEGACY_ID = new Map(TARGET_PEOPLE.map((person) => [person.legacyId, person]));

function tablesAndColumns(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
  for (const table of ['teachers', 'institutes', 'teachers_institute_lnk', 'strapi_database_schema']) {
    if (!tables.has(table)) throw new Error(`foreign or unsupported SQLite DB: required Strapi table ${table} is missing`);
  }
  for (const [table, required] of Object.entries({
    teachers: ['id', 'document_id', 'legacy_id', 'name', 'trait', 'published_at'],
    institutes: ['id', 'document_id', 'legacy_id', 'name', 'slug'],
    teachers_institute_lnk: ['teacher_id', 'institute_id'],
  })) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name));
    for (const column of required) {
      if (!columns.has(column)) throw new Error(`unsupported Strapi schema: ${table}.${column} is missing`);
    }
  }
}

function assertInstituteIdentity(db, expected) {
  const rows = db.prepare(`
    SELECT legacy_id AS legacyId, slug, name, document_id AS documentId
    FROM institutes
    WHERE slug = ? OR legacy_id = ?
    ORDER BY id
  `).all(expected.slug, expected.legacyId);
  if (rows.length === 0) throw new Error(`institute identity missing: ${expected.legacyId}`);
  if (rows.some((row) => row.legacyId !== expected.legacyId || row.slug !== expected.slug || row.name !== expected.name)) {
    throw new Error(`institute identity mismatch: ${expected.legacyId}`);
  }
  if (new Set(rows.map((row) => row.documentId)).size !== 1) {
    throw new Error(`institute has ambiguous logical documents: ${expected.legacyId}`);
  }
}

function peopleLinkedToTargetInstitutes(db) {
  return db.prepare(`
    SELECT DISTINCT t.document_id AS documentId, t.legacy_id AS legacyId
    FROM teachers AS t
    JOIN teachers_institute_lnk AS link ON link.teacher_id = t.id
    JOIN institutes AS i ON i.id = link.institute_id
    WHERE i.slug IN (?, ?)
  `).all(...INSTITUTES.map(({ slug }) => slug));
}

function allPhysicalTargetPeople(db) {
  const ids = TARGET_PEOPLE.map(({ legacyId }) => legacyId);
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    SELECT DISTINCT
      t.id AS rowId,
      t.document_id AS documentId,
      t.legacy_id AS legacyId,
      t.name,
      t.trait,
      i.legacy_id AS instituteLegacyId,
      i.slug AS instituteSlug,
      i.name AS instituteName,
      i.id AS instituteRowId,
      t.published_at AS publishedAt
    FROM teachers AS t
    LEFT JOIN teachers_institute_lnk AS link ON link.teacher_id = t.id
    LEFT JOIN institutes AS i ON i.id = link.institute_id
    WHERE t.legacy_id IN (${placeholders})
    ORDER BY t.legacy_id, t.id
  `).all(...ids);
}

function physicalRowsForDocuments(db, documentIds) {
  const placeholders = documentIds.map(() => '?').join(', ');
  return db.prepare(`SELECT id AS rowId, document_id AS documentId FROM teachers WHERE document_id IN (${placeholders})`)
    .all(...documentIds);
}

function buildPlan(db) {
  tablesAndColumns(db);
  INSTITUTES.forEach((institute) => assertInstituteIdentity(db, institute));
  const institutePeople = peopleLinkedToTargetInstitutes(db);
  const instituteLegacyIds = new Set(institutePeople.map(({ legacyId }) => legacyId));
  for (const legacyId of instituteLegacyIds) {
    if (!TARGET_BY_LEGACY_ID.has(legacyId)) throw new Error(`unexpected person in target institutes: legacy_id=${legacyId}`);
  }
  const rows = allPhysicalTargetPeople(db);
  const logical = new Map();
  const seenPhysicalRowIds = new Set();
  for (const row of rows) {
    const target = TARGET_BY_LEGACY_ID.get(row.legacyId);
    if (!target) throw new Error(`unexpected target identity row: legacy_id=${row.legacyId} name=${row.name}`);
    if (seenPhysicalRowIds.has(row.rowId)) throw new Error(`ambiguous institute relations for physical row ${row.rowId}`);
    seenPhysicalRowIds.add(row.rowId);
    if (row.name !== target.name) throw new Error(`person identity name mismatch for legacy_id=${row.legacyId}`);
    if (row.instituteLegacyId !== target.institute || row.instituteSlug !== target.institute) {
      throw new Error(`person identity institute mismatch for legacy_id=${row.legacyId}`);
    }
    if (!row.documentId) throw new Error(`missing documentId for legacy_id=${row.legacyId}`);
    if (row.trait !== target.initialTrait && !(target.initialTrait === 'teacher' && row.trait === 'method-author')) {
      throw new Error(`unexpected classification trait ${JSON.stringify(row.trait)} for legacy_id=${row.legacyId}`);
    }
    const existing = logical.get(row.legacyId) ?? { ...target, documentId: row.documentId, rows: [] };
    if (existing.documentId !== row.documentId) throw new Error(`ambiguous logical documents for legacy_id=${row.legacyId}`);
    existing.rows.push(row);
    logical.set(row.legacyId, existing);
  }

  for (const target of TARGET_PEOPLE) {
    const person = logical.get(target.legacyId);
    if (!person) throw new Error(`missing target person legacy_id=${target.legacyId} name=${target.name}`);
    if (person.rows.length === 0) throw new Error(`missing physical rows for legacy_id=${target.legacyId}`);
    if (!instituteLegacyIds.has(target.legacyId)) throw new Error(`target person is not linked to its institute: legacy_id=${target.legacyId}`);
  }
  if (logical.size !== TARGET_PEOPLE.length) throw new Error(`target person set is incomplete: expected ${TARGET_PEOPLE.length}, found ${logical.size}`);
  const targetDocumentIds = [...new Set([...logical.values()].map(({ documentId }) => documentId))];
  const everyDocumentRow = physicalRowsForDocuments(db, targetDocumentIds);
  const everyDocumentRowIds = new Set(everyDocumentRow.map(({ rowId }) => rowId));
  if (everyDocumentRowIds.size !== seenPhysicalRowIds.size
      || [...everyDocumentRowIds].some((rowId) => !seenPhysicalRowIds.has(rowId))) {
    throw new Error('target logical document has physical versions outside the exact identity set');
  }

  const people = [...logical.values()];
  const changes = people.filter((person) => person.rows.some((row) => row.trait === 'teacher'));
  const noops = people.filter((person) => person.rows.every((row) => row.trait === 'method-author'));
  return {
    logicalPeople: people.length,
    physicalRows: rows.length,
    changes: changes.map(({ legacyId, name, institute, rows: personRows }) => ({
      legacyId,
      name,
      institute,
      rows: personRows.filter((row) => row.trait === 'teacher').map(({ rowId, publishedAt }) => ({ rowId, published: publishedAt != null })),
    })),
    noops: noops.map(({ legacyId, name, institute }) => ({ legacyId, name, institute })),
    rows,
  };
}

export function planClassification(db) {
  const plan = buildPlan(db);
  const report = { ...plan };
  delete report.rows;
  return report;
}

export function applyClassification(db, { onApplied } = {}) {
  const transaction = db.transaction(() => {
    const plan = buildPlan(db);
    const update = db.prepare("UPDATE teachers SET trait = 'method-author' WHERE id = ? AND trait = 'teacher'");
    let updatedRows = 0;
    for (const { rowId } of plan.changes.flatMap((person) => person.rows)) {
      const result = update.run(rowId);
      if (result.changes !== 1) throw new Error(`concurrent or unexpected write while updating teacher row ${rowId}`);
      updatedRows += result.changes;
    }
    const after = buildPlan(db);
    if (after.changes.length !== 0 || after.noops.length !== TARGET_PEOPLE.length) {
      throw new Error('post-write readback failed; rolling back transaction');
    }
    const result = { updatedRows, noops: plan.noops.length };
    onApplied?.(db, result);
    return result;
  });
  return transaction.immediate();
}

function parseArgs(argv) {
  const result = { dbPath: undefined, apply: false, cmsStopped: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') result.dbPath = argv[++index];
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--cms-stopped') result.cmsStopped = true;
    else if (arg === '--help') result.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.help && (!result.dbPath || !isAbsolute(result.dbPath))) {
    throw new Error('--db must name an absolute SQLite file path');
  }
  if (result.apply && !result.cmsStopped) {
    throw new Error('--apply requires --cms-stopped (operator confirms CMS is stopped)');
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node cms/scripts/institute-method-author-classification.mjs --db /absolute/path/to/data.db [--apply --cms-stopped]\n');
    return;
  }
  const cmsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(`${cmsRoot}/package.json`);
  const Database = require('better-sqlite3');
  const dbPath = resolve(args.dbPath);
  const db = new Database(dbPath, { readonly: !args.apply, fileMustExist: true, timeout: 5000 });
  try {
    const report = args.apply ? applyClassification(db) : planClassification(db);
    process.stdout.write(`${JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', dbPath, ...report }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
