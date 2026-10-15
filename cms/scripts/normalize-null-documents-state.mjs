import { createRequire } from 'node:module';
import { chmodSync, linkSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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

function normalizeOutputDatabase(db) {
  const transaction = db.transaction(() => {
    const plan = planDocumentsStateNormalization(db);
    if (plan.blocked) {
      throw new Error(`normalization refused: structured documents or missing identity conflicts (${plan.contradictions.length})`);
    }
    const update = db.prepare("UPDATE seminars SET documents_state = 'unconfirmed' WHERE id = ? AND documents_state IS NULL");
    let updatedRows = 0;
    for (const { rowId } of plan.candidateRows) {
      const result = update.run(rowId);
      if (result.changes !== 1) throw new Error(`unexpected change while normalizing seminar row ${rowId}`);
      updatedRows += result.changes;
    }
    for (const { rowId } of plan.candidateRows) {
      const row = db.prepare('SELECT documents_state FROM seminars WHERE id = ?').get(rowId);
      if (row?.documents_state !== 'unconfirmed') {
        throw new Error(`post-write readback failed for seminar row ${rowId}`);
      }
    }
    return { updatedRows, logicalDocuments: plan.logicalDocuments };
  });
  return transaction.immediate();
}

function assertNewOutputPath(sourcePath, outputPath) {
  if (outputPath !== outputPath.trim()) throw new Error('--output must not have leading or trailing whitespace');
  let sourceRealPath;
  try {
    sourceRealPath = realpathSync(sourcePath);
  } catch (error) {
    throw new Error(`cannot resolve source SQLite file: ${error.message}`);
  }
  const outputParent = realpathSync(dirname(outputPath));
  const canonicalOutputPath = join(outputParent, basename(outputPath));
  if (canonicalOutputPath === sourceRealPath) throw new Error('output path resolves to the source SQLite file');
  try {
    lstatSync(outputPath);
    throw new Error(`output already exists (files, symlinks, and hardlinks are never overwritten): ${outputPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return outputPath;
}

function removeOwnedStage(stageDirectory, identity) {
  try {
    const current = lstatSync(stageDirectory);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino
        || realpathSync(stageDirectory) !== stageDirectory) return false;
    rmSync(stageDirectory, { recursive: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

/** Hard-link publication is atomic and refuses to replace any target that appeared meanwhile. */
export function publishOutputExclusively(stagedDatabasePath, outputPath) {
  linkSync(stagedDatabasePath, outputPath);
}

/** Dry-run never creates output; apply backs up a read-only source into a new exclusive file. */
export async function prepareNormalizedBackup({ sourcePath: rawSourcePath, outputPath: rawOutputPath, apply = false }) {
  if (rawSourcePath !== rawSourcePath.trim()) throw new Error('--source must not have leading or trailing whitespace');
  if (!isAbsolute(rawSourcePath) || !isAbsolute(rawOutputPath)) {
    throw new Error('--source and --output must be absolute paths');
  }
  const sourcePath = resolve(rawSourcePath);
  const requestedOutputPath = resolve(rawOutputPath);
  const outputPath = assertNewOutputPath(sourcePath, requestedOutputPath);
  const cmsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(`${cmsRoot}/package.json`);
  const Database = require('better-sqlite3');
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const sourcePlan = planDocumentsStateNormalization(source);
    if (!apply) return { mode: 'dry-run', sourcePath, outputPath, ...sourcePlan };
    if (sourcePlan.blocked) {
      throw new Error(`normalization refused: structured documents or missing identity conflicts (${sourcePlan.contradictions.length})`);
    }

    const outputParent = realpathSync(dirname(outputPath));
    const stageDirectory = mkdtempSync(join(outputParent, '.ikpk-documents-state-'));
    chmodSync(stageDirectory, 0o700);
    const stageIdentity = lstatSync(stageDirectory);
    const stagedDatabasePath = join(stageDirectory, 'prepared.db');
    let result;
    let operationError;
    try {
      await source.backup(stagedDatabasePath);
      const output = new Database(stagedDatabasePath, { fileMustExist: true, timeout: 5000 });
      try {
        result = normalizeOutputDatabase(output);
      } finally {
        output.close();
      }
      chmodSync(stagedDatabasePath, 0o600);
      publishOutputExclusively(stagedDatabasePath, outputPath);
    } catch (error) {
      operationError = error;
    }
    const cleaned = removeOwnedStage(stageDirectory, stageIdentity);
    if (operationError) {
      if (!cleaned) operationError.message += `; owned staging directory could not be safely removed: ${stageDirectory}`;
      throw operationError;
    }
    return {
      mode: 'apply', sourcePath, outputPath, ...result,
      ...(!cleaned ? { stagingCleanupWarning: stageDirectory } : {}),
    };
  } finally {
    source.close();
  }
}

function parseArgs(argv) {
  const result = { sourcePath: undefined, outputPath: undefined, apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') result.sourcePath = argv[++index];
    else if (arg === '--output') result.outputPath = argv[++index];
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--help') result.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.help && (!result.sourcePath || !result.outputPath)) throw new Error('--source and --output are required');
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node cms/scripts/normalize-null-documents-state.mjs --source /absolute/path/to/source.db --output /absolute/path/to/new-copy.db [--apply]\n');
    return;
  }
  const result = await prepareNormalizedBackup(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
