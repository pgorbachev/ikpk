import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_COLUMNS = {
  seminars: ['id', 'document_id', 'documents_state', 'published_at'],
  seminars_cmps: ['entity_id', 'field'],
};

function validateSchema(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) throw new Error(`foreign or unsupported SQLite DB: required Strapi table ${table} is missing`);
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name));
    for (const column of required) {
      if (!columns.has(column)) throw new Error(`unsupported Strapi schema: ${table}.${column} is missing`);
    }
  }
}

/**
 * A NULL state means the source has no confirmation. Normalize it only when no
 * physical draft or published version of that logical seminar carries a
 * structured documents component. Relations are inspected by field name so a
 * stale or unexpected component type also blocks the write.
 */
export function planDocumentsStateNormalization(db) {
  validateSchema(db);
  const nullRows = db.prepare(`
    SELECT id AS rowId, document_id AS documentId, published_at AS publishedAt
    FROM seminars
    WHERE documents_state IS NULL
    ORDER BY id
  `).all();
  const contradictions = [];
  const nullDocumentIds = new Set();

  for (const row of nullRows) {
    if (typeof row.documentId !== 'string' || row.documentId.trim() === '') {
      contradictions.push({ documentId: row.documentId, seminarRowId: row.rowId, reason: 'missing document_id' });
    } else {
      nullDocumentIds.add(row.documentId);
    }
  }

  if (nullDocumentIds.size > 0) {
    const placeholders = [...nullDocumentIds].map(() => '?').join(', ');
    const componentLinks = db.prepare(`
      SELECT DISTINCT s.document_id AS documentId, s.id AS seminarRowId
      FROM seminars AS s
      JOIN seminars_cmps AS component_link ON component_link.entity_id = s.id
      WHERE s.document_id IN (${placeholders})
        AND component_link.field = 'documents'
      ORDER BY s.document_id, s.id
    `).all(...nullDocumentIds);
    contradictions.push(...componentLinks.map(({ documentId, seminarRowId }) => ({
      documentId,
      seminarRowId,
      reason: 'structured documents are attached to a physical version',
    })));
  }

  const blocked = contradictions.length > 0;
  return {
    blocked,
    nullStateRows: nullRows.map(({ rowId, documentId, publishedAt }) => ({
      rowId,
      documentId,
      published: publishedAt !== null,
    })),
    candidateRows: blocked ? [] : nullRows.map(({ rowId, documentId, publishedAt }) => ({
      rowId,
      documentId,
      published: publishedAt !== null,
    })),
    contradictions,
    logicalDocuments: blocked ? 0 : nullDocumentIds.size,
  };
}

export function applyDocumentsStateNormalization(db) {
  const transaction = db.transaction(() => {
    const plan = planDocumentsStateNormalization(db);
    if (plan.blocked) {
      throw new Error(`normalization refused: structured documents or missing identity conflicts (${plan.contradictions.length})`);
    }
    const update = db.prepare("UPDATE seminars SET documents_state = 'unconfirmed' WHERE id = ? AND documents_state IS NULL");
    let updatedRows = 0;
    for (const { rowId } of plan.candidateRows) {
      const result = update.run(rowId);
      if (result.changes !== 1) throw new Error(`concurrent or unexpected change while normalizing seminar row ${rowId}`);
      updatedRows += result.changes;
    }

    const wrongReadback = plan.candidateRows.filter(({ rowId }) => {
      const row = db.prepare('SELECT documents_state FROM seminars WHERE id = ?').get(rowId);
      return row?.documents_state !== 'unconfirmed';
    });
    if (wrongReadback.length > 0) {
      throw new Error(`post-write readback failed for seminar rows: ${wrongReadback.map(({ rowId }) => rowId).join(', ')}`);
    }
    return { updatedRows, logicalDocuments: plan.logicalDocuments };
  });
  return transaction.immediate();
}

function parseArgs(argv) {
  const result = { dbPath: undefined, apply: false, preparedCopy: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') result.dbPath = argv[++index];
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--prepared-copy') result.preparedCopy = true;
    else if (arg === '--help') result.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.help && (!result.dbPath || !isAbsolute(result.dbPath))) {
    throw new Error('--db must name an absolute SQLite file path');
  }
  if (result.apply !== result.preparedCopy) {
    throw new Error('--apply requires --prepared-copy, and --prepared-copy is valid only with --apply');
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node cms/scripts/normalize-null-documents-state.mjs --db /absolute/path/to/private-copy/data.db [--apply --prepared-copy]\n');
    return;
  }
  const cmsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(`${cmsRoot}/package.json`);
  const Database = require('better-sqlite3');
  const dbPath = resolve(args.dbPath);
  const db = new Database(dbPath, { readonly: !args.apply, fileMustExist: true, timeout: 5000 });
  try {
    const plan = planDocumentsStateNormalization(db);
    if (!args.apply) {
      process.stdout.write(`${JSON.stringify({ mode: 'dry-run', dbPath, ...plan }, null, 2)}\n`);
      return;
    }
    if (plan.blocked) {
      process.stdout.write(`${JSON.stringify({ mode: 'apply', dbPath, ...plan }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    const result = applyDocumentsStateNormalization(db);
    process.stdout.write(`${JSON.stringify({ mode: 'apply', dbPath, ...result }, null, 2)}\n`);
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
