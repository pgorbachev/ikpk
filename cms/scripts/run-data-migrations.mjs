#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { auditMigration } from './audit-data-migration.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const CMS_ROOT = resolve(dirname(MODULE_PATH), '..');
const require = createRequire(join(CMS_ROOT, 'package.json'));
const LEDGER_TABLE = 'ikpk_data_migration_history';
const LINEAGE_TABLE = 'ikpk_migration_lineage';
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]+$/;
const HASH = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error(message); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function jsonHash(value) { return hash(Buffer.from(JSON.stringify(value))); }
function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function abs(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value !== value.trim()) fail(`${label} must be an absolute path without surrounding whitespace`);
  const normalized = resolve(value);
  return join(realpathSync(dirname(normalized)), basename(normalized));
}
function canonicalPath(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return resolve(realpathSync(dirname(path)), basename(path));
  }
}
function assertDistinctPaths(paths) {
  const seen = new Map();
  const inodes = new Map();
  for (const [label, path] of paths) {
    const canonical = canonicalPath(path);
    if (seen.has(canonical)) fail(`${label} aliases ${seen.get(canonical)}; source, candidate, receipt and target paths must be distinct`);
    seen.set(canonical, label);
    try {
      const info = lstatSync(path);
      const identity = `${info.dev}:${info.ino}`;
      if (inodes.has(identity)) fail(`${label} is a hard-link alias of ${inodes.get(identity)}; paths must be distinct files`);
      inodes.set(identity, label);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function databasePathSet(label, path) {
  return [
    [label, path],
    [`${label} WAL`, `${path}-wal`],
    [`${label} shared-memory sidecar`, `${path}-shm`],
    [`${label} migration lock`, `${path}.migration-lock`],
  ];
}
function privateDirectory(path, label) {
  const requested = resolve(path);
  const requestedInfo = lstatSync(requested);
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) fail(`${label} must not be a symlink`);
  const real = realpathSync(path);
  if (real !== requested) fail(`${label} path traverses a symlink`);
  const info = lstatSync(real);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a real directory`);
  if ((info.mode & 0o077) !== 0) fail(`${label} must have owner-only permissions (0700)`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail(`${label} is not owned by the current user`);
  return real;
}
function assertNewPath(path, label) {
  try { lstatSync(path); fail(`${label} already exists; files, symlinks, and hardlinks are never overwritten: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function readJson(path, label) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`${label} cannot be read as JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label} must contain a JSON object`);
  return parsed;
}
function atomicJson(path, value) {
  const parent = dirname(path);
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function acquireTargetLock(candidatePath) {
  const lockPath = `${candidatePath}.migration-lock`;
  const token = `${process.pid}:${randomUUID()}`;
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, `${token}\n`, 'utf8');
    closeSync(fd);
    return () => {
      try {
        if (readFileSync(lockPath, 'utf8') === `${token}\n`) unlinkSync(lockPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  } catch (error) {
    if (error.code === 'EEXIST') {
      let content;
      let identity;
      try { content = readFileSync(lockPath, 'utf8'); identity = lstatSync(lockPath); }
      catch (readError) { if (readError.code === 'ENOENT') return acquireTargetLock(candidatePath); throw readError; }
      const pid = Number(content.split(':', 1)[0]);
      if (!Number.isInteger(pid) || pid < 1) fail(`target lock ${lockPath} has no verifiable owner; inspect it before removal`);
      let alive = true;
      try { process.kill(pid, 0); }
      catch (probeError) { if (probeError.code === 'ESRCH') alive = false; else if (probeError.code !== 'EPERM') throw probeError; }
      if (alive) fail(`another migration operation holds target lock ${lockPath} (pid ${pid})`);
      try {
        const current = lstatSync(lockPath);
        if (current.dev !== identity.dev || current.ino !== identity.ino || readFileSync(lockPath, 'utf8') !== content) {
          fail(`target lock ${lockPath} changed while stale-owner recovery was checked`);
        }
        unlinkSync(lockPath);
      } catch (removeError) { if (removeError.code !== 'ENOENT') throw removeError; }
      return acquireTargetLock(candidatePath);
    }
    throw error;
  }
}
function acquireTargetLocks(paths) {
  const releases = [];
  try {
    for (const path of [...new Set(paths)].sort()) releases.push(acquireTargetLock(path));
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  return () => { for (const release of releases.reverse()) release(); };
}

function databaseClass() { return require('better-sqlite3'); }
function openDatabase(path, { readonly = false } = {}) {
  const Database = databaseClass();
  return new Database(path, { readonly, fileMustExist: true, timeout: 5000 });
}
function sqliteSchemaFingerprint(db) {
  const schema = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name
  `).all();
  return hash(Buffer.from(JSON.stringify(schema)));
}
function sqliteSnapshot(db) {
  const version = db.prepare('SELECT sqlite_version() AS version').get().version;
  const userVersion = db.pragma('user_version', { simple: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  const columns = Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all().map(({ name }) => name),
  ]));
  return { engine: 'sqlite', sqliteVersion: version, userVersion, tables, columns, schemaFingerprint: sqliteSchemaFingerprint(db) };
}
function validateSourceSchema(snapshot, plan, db) {
  for (const step of plan.steps) {
    if (step.source?.schema?.engine !== snapshot.engine) fail(`unsupported source engine for ${step.id}: expected ${step.source?.schema?.engine}, found ${snapshot.engine}`);
    for (const table of step.source.schema.requiredTables ?? []) {
      if (!snapshot.tables.includes(table)) fail(`source schema precondition failed for ${step.id}: table ${table} is missing`);
    }
    const alreadyNative = step.kind === 'strapi-native'
      && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='strapi_migrations'").get()
      && db.prepare('SELECT 1 FROM strapi_migrations WHERE name = ? OR name LIKE ? LIMIT 1').get(basename(step.path), `%${basename(step.path)}`)
      && (step.postconditions?.columns ?? []).every((qualified) => {
        const [table, column] = qualified.split('.', 2);
        return Boolean(column) && snapshot.tables.includes(table) && snapshot.columns[table]?.includes(column);
      });
    if (alreadyNative) continue;
    for (const [table, columns] of Object.entries(step.source.schema.requiredColumns ?? {})) {
      if (!snapshot.tables.includes(table)) fail(`source schema precondition failed for ${step.id}: table ${table} is missing`);
      for (const column of columns) {
        if (!snapshot.columns[table]?.includes(column)) fail(`source schema precondition failed for ${step.id}: column ${table}.${column} is missing`);
      }
    }
  }
}
function sourceFileFingerprint(path) {
  const files = [path, `${path}-wal`];
  const digests = [];
  for (const file of files) {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) fail(`SQLite source component is not a regular file: ${file}`);
      digests.push({ file: basename(file), sha256: hash(readFileSync(file)) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (file === path) throw error;
      digests.push({ file: basename(file), absent: true });
    }
  }
  return jsonHash(digests);
}
function artifactFingerprint(root) {
  const entries = [];
  function visit(directory, prefix = '') {
    for (const entry of require('node:fs').readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      const info = lstatSync(fullPath);
      if (info.isSymbolicLink()) {
        const target = require('node:fs').readlinkSync(fullPath);
        const resolved = realpathSync(fullPath);
        if (!isWithin(root, resolved)) {
          const dependencyRoot = resolve(root, '../../deps');
          const uploadsRoot = resolve(root, '../../shared/uploads');
          const allowed = (relativePath === 'node_modules' && isWithin(dependencyRoot, resolved))
            || (relativePath === 'public/uploads' && isWithin(uploadsRoot, resolved));
          if (!allowed) fail(`artifact has an undeclared external symlink: ${relativePath}`);
        }
        entries.push({ path: relativePath, type: 'symlink', target, resolved });
      } else if (info.isDirectory()) visit(fullPath, relativePath);
      else if (info.isFile()) entries.push({ path: relativePath, type: 'file', sha256: hash(readFileSync(fullPath)) });
      else fail(`unsupported special file in CMS artifact: ${relativePath}`);
    }
  }
  visit(root);
  return jsonHash(entries);
}
function assertNoOpenHandles(paths) {
  const probes = [];
  if (process.platform === 'linux' || process.platform === 'darwin') {
    probes.push(['lsof', ['-t', '--']]);
    if (process.platform === 'linux') probes.push(['fuser', ['-f']]);
  }
  let available = false;
  for (const [command, args] of probes) {
    const version = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3000 });
    if (version.error?.code === 'ENOENT') continue;
    available = true;
    for (const path of paths) {
      const result = spawnSync(command, [...args, path], { encoding: 'utf8', timeout: 5000 });
      if (result.error) fail(`cannot check whether SQLite file is open (${command}): ${result.error.message}`);
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      if (result.status === 0 && output) fail(`SQLite file has an open process handle (${path}): ${output}`);
      if (![0, 1].includes(result.status)) fail(`cannot determine whether SQLite file is open (${command} exit ${result.status}): ${(result.stderr ?? '').trim()}`);
    }
    return;
  }
  if (!available) fail('writer quiescence cannot be verified: neither lsof nor fuser is available');
}

function resolvePlan(artifactDir) {
  const root = realpathSync(artifactDir);
  const migrationsRoot = realpathSync(join(root, 'database', 'migrations'));
  const manifestPath = join(migrationsRoot, 'plan.json');
  const manifest = readJson(manifestPath, 'migration plan');
  if (manifest.version !== 1 || !Array.isArray(manifest.steps) || manifest.steps.length === 0) fail('migration plan must have version 1 and at least one ordered step');
  const ids = new Set();
  const paths = new Set();
  let seenAfterSync = false;
  const steps = manifest.steps.map((step) => {
    if (!step || !STEP_ID.test(step.id ?? '') || ids.has(step.id)) fail(`invalid or duplicate migration step ID: ${step?.id ?? '<missing>'}`);
    ids.add(step.id);
    if (!['before-sync', 'after-sync'].includes(step.phase)) fail(`unsupported migration phase for ${step.id}`);
    if (step.phase === 'after-sync') seenAfterSync = true;
    if (step.phase === 'before-sync' && seenAfterSync) fail(`before-sync step appears after an after-sync step: ${step.id}`);
    if (!['strapi-native', 'data'].includes(step.kind)) fail(`unsupported migration step kind for ${step.id}`);
    if (step.kind === 'strapi-native' && step.phase !== 'before-sync') fail(`native Strapi migration must be before-sync: ${step.id}`);
    if (step.kind === 'data' && step.phase !== 'after-sync') fail(`explicit data migration must be after-sync: ${step.id}`);
    if (step.kind === 'data' && !['classification', 'normalize-documents-state'].includes(step.handler)) fail(`unsupported data migration handler for ${step.id}`);
    if (typeof step.path !== 'string' || !step.path || isAbsolute(step.path) || step.path.split(/[\\/]/).includes('..')) fail(`invalid migration payload path for ${step.id}`);
    if (!HASH.test(step.sha256 ?? '')) fail(`missing SHA-256 for migration payload ${step.id}`);
    if (paths.has(step.path)) fail(`duplicate migration payload path: ${step.path}`);
    paths.add(step.path);
    const file = resolve(migrationsRoot, step.path);
    if (!isWithin(migrationsRoot, file)) fail(`migration payload escapes artifact: ${step.path}`);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) fail(`migration payload must be a regular file: ${step.path}`);
    const digest = hash(readFileSync(file));
    if (digest !== step.sha256) fail(`migration payload SHA-256 mismatch for ${step.path}: expected ${step.sha256}, found ${digest}`);
    if (!step.source || typeof step.source.strapiVersion !== 'string' || !step.source.schema || !step.preconditions || !step.postconditions || !step.readback) {
      fail(`incomplete provenance, preconditions, postconditions, or readback for ${step.id}`);
    }
    return { ...step, absolutePath: file };
  });
  const nativeFiles = new Set(steps.filter(({ kind }) => kind === 'strapi-native').map(({ path }) => path));
  for (const entry of (awaitlessReadDir(migrationsRoot))) {
    if (entry.isFile() && /\.(?:js|sql)$/.test(entry.name) && !nativeFiles.has(entry.name)) fail(`unplanned native migration payload: ${entry.name}`);
  }
  if (!manifest.integrity || !Array.isArray(manifest.integrity.files) || manifest.integrity.files.length === 0) fail('migration plan must hash the runner and packaged data helpers');
  const integrityPaths = new Set();
  for (const file of manifest.integrity.files) {
    if (typeof file.path !== 'string' || !file.path || isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..') || !HASH.test(file.sha256 ?? '')) fail(`invalid integrity file entry: ${file.path ?? '<missing>'}`);
    if (integrityPaths.has(file.path)) fail(`duplicate integrity path: ${file.path}`);
    integrityPaths.add(file.path);
    const fullPath = resolve(root, file.path);
    if (!isWithin(root, fullPath)) fail(`integrity file escapes artifact root: ${file.path}`);
    const info = lstatSync(fullPath);
    if (!info.isFile() || info.isSymbolicLink()) fail(`integrity file must be a regular file: ${file.path}`);
    const digest = hash(readFileSync(fullPath));
    if (digest !== file.sha256) fail(`integrity file SHA-256 mismatch for ${file.path}: expected ${file.sha256}, found ${digest}`);
  }
  return { root, migrationsRoot, manifestPath, manifest, steps, planSha256: hash(readFileSync(manifestPath)), artifactSha256: artifactFingerprint(root) };
}
function awaitlessReadDir(path) {
  // Kept synchronous because this is a short, local artifact integrity check.
  return require('node:fs').readdirSync(path, { withFileTypes: true });
}

function readSourceStrapiVersion(sourceCmsRoot, plan, fixtureVersion) {
  if (fixtureVersion) return fixtureVersion;
  const root = realpathSync(abs(sourceCmsRoot, 'sourceCmsRoot'));
  const packageJson = readJson(join(root, 'package.json'), 'source CMS package.json');
  const version = packageJson.dependencies?.['@strapi/strapi'] ?? packageJson.devDependencies?.['@strapi/strapi'];
  if (typeof version !== 'string' || version.startsWith('^') || version.startsWith('~')) fail('source CMS package.json must pin an exact @strapi/strapi version');
  const expected = new Set(plan.steps.map(({ source }) => source.strapiVersion));
  if (!expected.has(version)) fail(`source Strapi version ${version} is not supported by this migration plan (${[...expected].join(', ')})`);
  return version;
}

function ensureLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LINEAGE_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      lineage_id TEXT NOT NULL UNIQUE,
      source_snapshot_sha256 TEXT NOT NULL,
      source_schema_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ikpk_migration_operations (
      operation_id TEXT PRIMARY KEY,
      lineage_id TEXT NOT NULL,
      source_snapshot_sha256 TEXT NOT NULL,
      source_schema_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (lineage_id) REFERENCES ${LINEAGE_TABLE}(lineage_id)
    );
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      lineage_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      result_json TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (lineage_id, step_id)
    );
  `);
}
function getLineage(db) {
  return db.prepare(`SELECT * FROM ${LINEAGE_TABLE} WHERE singleton = 1`).get();
}
function initializeLineage(db, sourceSnapshotSha256, sourceSchemaSha256) {
  ensureLedger(db);
  const current = getLineage(db);
  if (current) return current.lineage_id;
  const lineageId = hash(Buffer.from(randomUUID()));
  db.prepare(`INSERT INTO ${LINEAGE_TABLE} (singleton,lineage_id,source_snapshot_sha256,source_schema_sha256,created_at) VALUES (1,?,?,?,?)`)
    .run(lineageId, sourceSnapshotSha256, sourceSchemaSha256, new Date().toISOString());
  return lineageId;
}
function bindOperationToSource(db, { operationId, lineageId, sourceSnapshotSha256, sourceSchemaSha256 }) {
  ensureLedger(db);
  const row = db.prepare('SELECT lineage_id,source_snapshot_sha256,source_schema_sha256 FROM ikpk_migration_operations WHERE operation_id=?').get(operationId);
  if (row) {
    if (row.lineage_id !== lineageId || row.source_snapshot_sha256 !== sourceSnapshotSha256 || row.source_schema_sha256 !== sourceSchemaSha256) {
      fail('operation ID is already bound to a different source snapshot or lineage');
    }
    return;
  }
  db.prepare('INSERT INTO ikpk_migration_operations (operation_id,lineage_id,source_snapshot_sha256,source_schema_sha256,created_at) VALUES (?,?,?,?,?)')
    .run(operationId, lineageId, sourceSnapshotSha256, sourceSchemaSha256, new Date().toISOString());
}
function completedStep(db, lineageId, step) {
  const row = db.prepare(`SELECT operation_id, payload_sha256, result_json, completed_at FROM ${LEDGER_TABLE} WHERE lineage_id = ? AND step_id = ?`).get(lineageId, step.id);
  if (!row) return null;
  if (row.payload_sha256 !== step.sha256) fail(`step ID ${step.id} is already recorded with a different SHA-256; refusing to reuse it`);
  return row;
}
function recordStep(db, { operationId, lineageId, step, result }) {
  const existing = completedStep(db, lineageId, step);
  if (existing) {
    if (existing.operation_id !== operationId) return existing;
    return existing;
  }
  db.prepare(`INSERT INTO ${LEDGER_TABLE} (lineage_id,operation_id,step_id,payload_sha256,result_json,completed_at) VALUES (?,?,?,?,?,?)`)
    .run(lineageId, operationId, step.id, step.sha256, JSON.stringify(result ?? {}), new Date().toISOString());
  return db.prepare(`SELECT operation_id,payload_sha256,result_json,completed_at FROM ${LEDGER_TABLE} WHERE lineage_id=? AND step_id=?`).get(lineageId, step.id);
}

let defaultLifecycleQueue = Promise.resolve();
async function withDatabaseFilename(candidateDbPath, callback) {
  const previous = process.env.DATABASE_FILENAME;
  process.env.DATABASE_FILENAME = candidateDbPath;
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.DATABASE_FILENAME;
    else process.env.DATABASE_FILENAME = previous;
  }
}
function productionLifecycle(artifactDir) {
  return {
    loadClosed({ candidateDbPath, onCheckpoint }) {
      const task = defaultLifecycleQueue.then(() => withDatabaseFilename(candidateDbPath, async () => {
        const artifactRequire = createRequire(join(artifactDir, 'package.json'));
        const { createStrapi } = artifactRequire('@strapi/strapi');
        const previousClient = process.env.DATABASE_CLIENT;
        const previousUrl = process.env.DATABASE_URL;
        process.env.DATABASE_CLIENT = 'sqlite';
        delete process.env.DATABASE_URL;
        let instance;
        try {
          instance = createStrapi({ appDir: artifactDir, distDir: join(artifactDir, 'dist') });
          const connection = instance.config?.get?.('database.connection');
          const actualClient = connection?.client;
          const actualFilename = connection?.connection?.filename;
          if (actualClient !== 'sqlite' || typeof actualFilename !== 'string' || resolve(actualFilename) !== candidateDbPath) {
            fail(`closed Strapi resolved an unsafe database target before load (client=${actualClient ?? '<unknown>'}, filename=${actualFilename ?? '<unknown>'})`);
          }
          await instance.load();
          await onCheckpoint?.('strapi-load-complete');
          return instance;
        } catch (error) {
          try { await instance?.destroy(); } catch { /* preserve original load error */ }
          throw error;
        } finally {
          if (previousClient === undefined) delete process.env.DATABASE_CLIENT;
          else process.env.DATABASE_CLIENT = previousClient;
          if (previousUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = previousUrl;
        }
      }));
      defaultLifecycleQueue = task.then(() => undefined, () => undefined);
      return task;
    },
    destroy(instance) { return instance.destroy(); },
  };
}

function receiptFrom(path, operationId) {
  const receipt = readJson(path, 'operation receipt');
  if (receipt.operationId !== operationId) fail(`receipt belongs to a different operation (${receipt.operationId})`);
  return receipt;
}
function readCandidateState(candidateDbPath) {
  const db = openDatabase(candidateDbPath);
  try {
    const lineage = getLineage(db);
    if (!lineage) fail('candidate has no migration lineage record');
    const history = db.prepare(`SELECT operation_id,step_id,payload_sha256,result_json,completed_at FROM ${LEDGER_TABLE} WHERE lineage_id=? ORDER BY completed_at,step_id`).all(lineage.lineage_id);
    return { lineage, history, schema: sqliteSnapshot(db) };
  } finally { db.close(); }
}
function publicStatus(receipt, state) {
  const byId = new Map(state.history.map((row) => [row.step_id, row]));
  return {
    operationId: receipt.operationId,
    lineageId: state.lineage.lineage_id,
    phase: receipt.phase,
    planSha256: receipt.planSha256,
    source: receipt.source,
    steps: receipt.steps.map((step) => {
      const row = byId.get(step.id);
      return {
        id: step.id,
        phase: step.phase,
        status: row ? (row.payload_sha256 === step.sha256 ? 'completed' : 'hash-mismatch') : (step.kind === 'strapi-native' ? 'strapi-managed' : 'pending'),
        payloadSha256: step.sha256,
        ...(row ? { result: JSON.parse(row.result_json), completedAt: row.completed_at } : {}),
      };
    }),
    ...(receipt.activation ? { activation: receipt.activation } : {}),
  };
}

function validateNativeHistory(db, plan) {
  const expected = plan.steps.filter(({ kind }) => kind === 'strapi-native').map(({ path }) => basename(path)).sort();
  if (expected.length === 0) return;
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='strapi_migrations'").get();
  if (!table) fail('Strapi migration history is missing after closed startup; candidate state is unknown, discard and reprepare');
  const columns = db.prepare('PRAGMA table_info(strapi_migrations)').all().map(({ name }) => name);
  if (!columns.includes('name')) fail('Strapi migration history has an unsupported schema; candidate state is unknown, discard and reprepare');
  const applied = db.prepare('SELECT name FROM strapi_migrations ORDER BY name').all().map(({ name }) => basename(name));
  for (const migration of expected) {
    if (!applied.includes(migration)) fail(`native migration history is incomplete for ${migration}; candidate may have crossed Strapi's commit/history gap, discard and reprepare from pristine source`);
  }
}

function verifyPlanAndReceipt(plan, receipt) {
  if (receipt.planSha256 !== plan.planSha256) fail('candidate receipt and migration plan differ; discard and reprepare');
  if (receipt.artifactSha256 && receipt.artifactSha256 !== plan.artifactSha256) fail('CMS artifact bytes changed after preparation; discard and reprepare');
  if (JSON.stringify(receipt.steps.map(({ id, sha256 }) => [id, sha256])) !== JSON.stringify(plan.steps.map(({ id, sha256 }) => [id, sha256]))) {
    fail('candidate receipt step identities differ from the packaged plan; discard and reprepare');
  }
}

function preservationAudit(receipt, plan) {
  receipt.candidatePostMigrationSha256 = hash(readFileSync(receipt.candidateDbPath));
  receipt.candidatePostMigrationFileFingerprint = sourceFileFingerprint(receipt.candidateDbPath);
  const result = auditMigration({
    sourceDbPath: receipt.sourceDbPath,
    candidateDbPath: receipt.candidateDbPath,
    plan: { ...plan, manifestPath: plan.manifestPath },
    receipt,
  });
  receipt.preservation = {
    private: true,
    passed: result.passed,
    sourceSchemaFingerprint: result.source?.schemaFingerprint,
    candidateSchemaFingerprint: result.candidate?.schemaFingerprint,
    transformationCounts: result.transformations,
    differenceCount: result.differences?.length,
    auditedAt: new Date().toISOString(),
  };
  if (!result.passed) fail(`migration preservation audit did not pass (${result.differences.map(({ table, kind, changedFields }) => `${table}:${kind}${changedFields ? `(${changedFields.join(',')})` : ''}`).join(', ')}); candidate remains private and cannot be activated`);
  return result;
}

/** Prepare a private, consistent SQLite candidate and execute its versioned migration plan. */
export async function prepareMigration({ sourceDbPath: rawSourceDbPath, candidateDbPath: rawCandidateDbPath, artifactDir: rawArtifactDir, receiptPath: rawReceiptPath, operationId, sourceCmsRoot, sourceStrapiVersion, lifecycleAdapter }) {
  const sourceDbPath = abs(rawSourceDbPath, 'sourceDbPath');
  const candidateDbPath = abs(rawCandidateDbPath, 'candidateDbPath');
  const artifactDir = abs(rawArtifactDir, 'artifactDir');
  const receiptPath = abs(rawReceiptPath, 'receiptPath');
  if (!STEP_ID.test(operationId ?? '')) fail('operationId must be a stable non-empty identifier');
  const artifactReal = realpathSync(artifactDir);
  const candidateParent = privateDirectory(dirname(candidateDbPath), 'candidate parent directory');
  const receiptParent = privateDirectory(dirname(receiptPath), 'receipt parent directory');
  if (candidateParent !== dirname(candidateDbPath) || receiptParent !== dirname(receiptPath)) fail('candidate or receipt path traverses a symlinked parent');
  assertDistinctPaths([
    ...databasePathSet('source database', sourceDbPath),
    ...databasePathSet('candidate database', candidateDbPath),
    ['operation receipt', receiptPath],
  ]);
  if (isWithin(artifactReal, receiptPath) || isWithin(artifactReal, candidateDbPath)) fail('candidate database and operation receipt must be outside the CMS artifact/Git tree');
  if (candidateDbPath === sourceDbPath) fail('candidate database must not be the source database');
  const release = resolvePlan(artifactReal);
  const strapiVersion = sourceStrapiVersion ?? readSourceStrapiVersion(sourceCmsRoot, release);
  const releaseVersions = new Set(release.steps.map(({ source }) => source.strapiVersion));
  if (!releaseVersions.has(strapiVersion)) fail(`source Strapi version ${strapiVersion} is not supported by this migration plan`);
  const unlock = acquireTargetLock(candidateDbPath);
  try {
    try {
      const candidateInfo = lstatSync(candidateDbPath);
      if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) fail('existing candidate database must be a regular non-symlink file');
      if (candidateInfo.nlink !== 1) fail('existing candidate database has additional hard links; refusing ambiguous ownership');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const candidateExists = (() => { try { lstatSync(candidateDbPath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } })();
    let receipt;
    let sourceSnapshotSha256;
    let sourceSnapshot;
    let lineageId;
    if (candidateExists) {
      receipt = receiptFrom(receiptPath, operationId);
      verifyPlanAndReceipt(release, receipt);
      if (resolve(receipt.candidateDbPath) !== candidateDbPath || resolve(receipt.sourceDbPath) !== sourceDbPath) fail('candidate or source path differs from the durable operation receipt');
      if (receipt.source.strapiVersion !== strapiVersion) fail('source Strapi version differs from the original operation receipt');
      assertNoOpenHandles([sourceDbPath, `${sourceDbPath}-wal`]);
      if (sourceFileFingerprint(sourceDbPath) !== receipt.source.sourceFileFingerprint) fail('original SQLite source changed after preparation; refusing to resume this candidate');
      if (receipt.phase === 'strapi-load-in-progress' || receipt.phase === 'activation-load-in-progress') {
        fail(`candidate crossed an interrupted closed Strapi load (${receipt.phase}); its state is unknown, discard and reprepare from a pristine source`);
      }
      sourceSnapshotSha256 = receipt.source.snapshotSha256;
      sourceSnapshot = receipt.source;
      const state = readCandidateState(candidateDbPath);
      lineageId = state.lineage.lineage_id;
      const resumedDb = openDatabase(candidateDbPath);
      try { bindOperationToSource(resumedDb, { operationId, lineageId, sourceSnapshotSha256, sourceSchemaSha256: sourceSnapshot.schemaFingerprint }); }
      finally { resumedDb.close(); }
    } else {
      assertNewPath(candidateDbPath, 'candidate database');
      assertNewPath(receiptPath, 'operation receipt');
      assertNoOpenHandles([sourceDbPath, `${sourceDbPath}-wal`, `${sourceDbPath}-shm`]);
      const beforeSourceFiles = sourceFileFingerprint(sourceDbPath);
      const source = openDatabase(sourceDbPath, { readonly: true });
      try {
        source.pragma('query_only = ON');
        sourceSnapshot = sqliteSnapshot(source);
        validateSourceSchema(sourceSnapshot, release, source);
        const actualVersion = readSourceStrapiVersion(sourceCmsRoot, release, sourceStrapiVersion);
        if (actualVersion !== strapiVersion) fail(`source version evidence differs: ${actualVersion} vs ${strapiVersion}`);
        const stageDir = join(candidateParent, `.ikpk-migration-${operationId}-${randomUUID()}`);
        mkdirSync(stageDir, { mode: 0o700 });
        chmodSync(stageDir, 0o700);
        const staged = join(stageDir, 'candidate.db');
        let copied = false;
        try {
          await source.backup(staged);
          const afterSourceFiles = sourceFileFingerprint(sourceDbPath);
          if (beforeSourceFiles !== afterSourceFiles) fail('SQLite source or WAL changed during snapshot; writer quiescence was not stable, discard candidate and retry after writes stop');
          const stagedDb = openDatabase(staged);
          try {
            sourceSnapshotSha256 = hash(readFileSync(staged));
            lineageId = initializeLineage(stagedDb, sourceSnapshotSha256, sourceSnapshot.schemaFingerprint);
            bindOperationToSource(stagedDb, { operationId, lineageId, sourceSnapshotSha256, sourceSchemaSha256: sourceSnapshot.schemaFingerprint });
          } finally { stagedDb.close(); }
          chmodSync(staged, 0o600);
          linkExclusive(staged, candidateDbPath);
          copied = true;
        } finally {
          try { require('node:fs').rmSync(stageDir, { recursive: true, force: true }); } catch (error) { if (!copied) throw error; }
        }
      } finally { source.close(); }
      const sourceAfterBackup = sourceFileFingerprint(sourceDbPath);
      if (sourceAfterBackup !== beforeSourceFiles) fail('SQLite source changed after snapshot publication; candidate is unsafe and must be discarded');
      receipt = {
        schemaVersion: 1,
        operationId,
        phase: 'candidate-created',
        createdAt: new Date().toISOString(),
        sourceDbPath,
        candidateDbPath,
        artifactDir: artifactReal,
        artifactSha256: release.artifactSha256,
        planSha256: release.planSha256,
        steps: release.steps.map(({ id, phase, kind, handler, path, sha256 }) => ({ id, phase, kind, handler, path, sha256 })),
        source: { strapiVersion, engine: sourceSnapshot.engine, sqliteVersion: sourceSnapshot.sqliteVersion, userVersion: sourceSnapshot.userVersion, schemaFingerprint: sourceSnapshot.schemaFingerprint, snapshotSha256: sourceSnapshotSha256, sourceFileFingerprint: beforeSourceFiles },
        lifecycle: [],
        recovery: 'candidate may be resumed only when this receipt, source lineage, and Strapi native history all agree; otherwise discard and reprepare from a pristine source',
      };
      atomicJson(receiptPath, receipt);
    }

    const adapter = lifecycleAdapter ?? productionLifecycle(artifactReal);
    if (typeof adapter.loadClosed !== 'function' || typeof adapter.destroy !== 'function') fail('lifecycleAdapter must implement loadClosed and destroy');
    if (receipt.phase === 'strapi-load-in-progress') {
      const db = openDatabase(candidateDbPath);
      try { validateNativeHistory(db, release); } finally { db.close(); }
    }
    if (receipt.phase === 'candidate-created') {
      receipt.phase = 'strapi-load-in-progress';
      receipt.lifecycle.push({ event: 'closed-load-started', at: new Date().toISOString() });
      atomicJson(receiptPath, receipt);
      let instance;
      try {
        instance = await adapter.loadClosed({ candidateDbPath, onCheckpoint: async (name) => {
          receipt.lifecycle.push({ event: name, at: new Date().toISOString() });
          atomicJson(receiptPath, receipt);
        } });
      } finally {
        if (instance !== undefined) await adapter.destroy(instance);
      }
      const db = openDatabase(candidateDbPath);
      try { validateNativeHistory(db, release); } finally { db.close(); }
      receipt.phase = 'schema-ready';
      receipt.lifecycle.push({ event: 'closed-load-destroyed', at: new Date().toISOString() });
      atomicJson(receiptPath, receipt);
    }

    const dataSteps = release.steps.filter(({ kind }) => kind === 'data');
    for (const step of dataSteps) {
      const candidate = openDatabase(candidateDbPath);
      let existing;
      try {
        ensureLedger(candidate);
        existing = completedStep(candidate, lineageId, step);
      } finally { candidate.close(); }
      if (existing) continue;
      const runDataStep = adapter.runDataStep ?? defaultRunDataStep;
      await runDataStep({
        step, candidateDbPath, operationId,
        onCheckpoint: async (name) => {
          receipt.lifecycle.push({ event: name, stepId: step.id, at: new Date().toISOString() });
          atomicJson(receiptPath, receipt);
        },
        recordCompletion: (dbForTransaction, result) => recordStep(dbForTransaction, { operationId, lineageId, step, result }),
      });
      const after = openDatabase(candidateDbPath);
      try {
        const row = completedStep(after, lineageId, step);
        if (!row) fail(`data step ${step.id} returned without committing its durable ID and SHA record`);
      } finally { after.close(); }
      receipt.lifecycle.push({ event: 'data-step-committed', stepId: step.id, at: new Date().toISOString() });
      receipt.phase = 'data-steps-in-progress';
      atomicJson(receiptPath, receipt);
    }
    const finalState = readCandidateState(candidateDbPath);
    const status = publicStatus(receipt, finalState);
    if (status.steps.some((step) => step.phase === 'after-sync' && step.status !== 'completed')) fail('not all planned data steps are recorded complete');
    receipt.phase = 'prepared';
    receipt.preparedAt = new Date().toISOString();
    preservationAudit(receipt, release);
    atomicJson(receiptPath, receipt);
    return publicStatus(receipt, finalState);
  } catch (error) {
    try {
      const current = readJson(receiptPath, 'operation receipt');
      if (current.operationId === operationId) {
        current.lastError = { message: error.message, at: new Date().toISOString() };
        atomicJson(receiptPath, current);
      }
    } catch { /* do not mask the migration error */ }
    throw error;
  } finally { unlock(); }
}

function linkExclusive(source, destination) {
  require('node:fs').linkSync(source, destination);
}
async function defaultRunDataStep({ step, candidateDbPath, recordCompletion }) {
  const helperPath = step.absolutePath ?? resolve(CMS_ROOT, 'database/migrations', step.path);
  const module = await import(pathToFileURL(helperPath).href);
  if (typeof module.apply !== 'function') fail(`data helper ${step.path} does not export apply(db,{onApplied})`);
  const db = openDatabase(candidateDbPath);
  try {
    module.apply(db, { onApplied: (sameDb, result) => recordCompletion(sameDb, result) });
  } finally { db.close(); }
}

/** Return the durable operation and DB-ledger state without changing either. */
export function getMigrationStatus({ candidateDbPath: rawCandidateDbPath, operationId, receiptPath: rawReceiptPath }) {
  const candidateDbPath = abs(rawCandidateDbPath, 'candidateDbPath');
  const receiptPath = abs(rawReceiptPath, 'receiptPath');
  const receipt = receiptFrom(receiptPath, operationId);
  if (resolve(receipt.candidateDbPath) !== candidateDbPath) fail('candidate path differs from the operation receipt');
  const state = readCandidateState(candidateDbPath);
  return publicStatus(receipt, state);
}

function verifySandbox(sandboxRoot, paths) {
  const root = privateDirectory(abs(sandboxRoot, 'sandboxRoot'), 'sandboxRoot');
  for (const [name, raw] of Object.entries(paths)) {
    const path = abs(raw, name);
    if (!isWithin(root, path)) fail(`${name} must stay inside sandboxRoot`);
    const parent = realpathSync(dirname(path));
    if (!isWithin(root, parent)) fail(`${name} parent directory escapes sandboxRoot through a symlink`);
  }
  if (!existsSync(join(root, '.ikpk-rehearsal-target'))) fail('sandboxRoot is not marked as an explicit rehearsal target');
  return root;
}
function readCohort(path, sandboxRoot) {
  const real = realpathSync(path);
  if (!isWithin(sandboxRoot, real)) fail('active pair target escapes sandboxRoot');
  const metadata = readJson(join(real, 'cohort.json'), 'cohort metadata');
  if (metadata.schemaVersion !== 1 || typeof metadata.planSha256 !== 'string' || !HASH.test(metadata.planSha256)) fail('active pair is not a verifiable migration cohort');
  const code = realpathSync(join(real, 'code'));
  const database = realpathSync(join(real, 'data.db'));
  if (!isWithin(sandboxRoot, code) || !isWithin(sandboxRoot, database)) fail('active pair code or database escapes sandboxRoot');
  if (resolve(metadata.codeRelease ?? '') !== code || resolve(metadata.databasePath ?? '') !== database) fail('cohort metadata does not identify its actual code and database targets');
  const codePlan = resolvePlan(code);
  if (codePlan.planSha256 !== metadata.planSha256) fail('cohort code plan does not match its recorded compatibility identity');
  if (metadata.artifactSha256 !== codePlan.artifactSha256) fail('cohort code artifact bytes differ from its recorded identity');
  if (metadata.databaseSha256 !== sourceFileFingerprint(database)) fail('cohort database bytes differ from its recorded identity');
  return { path: real, metadata, code, database };
}
function atomicSymlink(target, linkPath) {
  const temp = `${linkPath}.${process.pid}.${randomUUID()}.new`;
  symlinkSync(target, temp);
  try { renameSync(temp, linkPath); }
  catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}
function verifyCandidatePlan(receipt, codeRelease) {
  const release = resolvePlan(codeRelease);
  verifyPlanAndReceipt(release, receipt);
  return release;
}

/** Atomically select a compatible code+database cohort under a marked sandbox root. */
export async function activateMigration({ candidateDbPath: rawCandidateDbPath, codeRelease: rawCodeRelease, activePairPath: rawActivePairPath, sandboxRoot: rawSandboxRoot, receiptPath: rawReceiptPath, operationId, lifecycleAdapter }) {
  const candidateDbPath = abs(rawCandidateDbPath, 'candidateDbPath');
  const codeRelease = realpathSync(abs(rawCodeRelease, 'codeRelease'));
  const activePairPath = abs(rawActivePairPath, 'activePairPath');
  const receiptPath = abs(rawReceiptPath, 'receiptPath');
  const sandboxRoot = verifySandbox(rawSandboxRoot, { candidateDbPath, codeRelease, activePairPath, receiptPath });
  assertDistinctPaths([...databasePathSet('candidate database', candidateDbPath), ['operation receipt', receiptPath], ['active pair pointer', activePairPath]]);
  const unlock = acquireTargetLocks([candidateDbPath, activePairPath]);
  try {
    const receipt = receiptFrom(receiptPath, operationId);
    if (receipt.phase !== 'prepared' && receipt.phase !== 'activated') fail(`operation is not ready for activation (phase ${receipt.phase})`);
    if (resolve(receipt.candidateDbPath) !== candidateDbPath) fail('candidate path differs from receipt');
    const release = verifyCandidatePlan(receipt, codeRelease);
    const status = getMigrationStatus({ candidateDbPath, operationId, receiptPath });
    if (status.steps.some((step) => step.phase === 'after-sync' && step.status !== 'completed')) fail('activation refused: data steps are incomplete');
    preservationAudit(receipt, release);
    assertNoOpenHandles([candidateDbPath, `${candidateDbPath}-wal`, `${candidateDbPath}-shm`]);
    const existingPath = (() => { try { return realpathSync(activePairPath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } })();
    if (!existingPath) fail('activation requires an existing verified prior code+database cohort for safe rollback');
    const prior = readCohort(activePairPath, sandboxRoot);
    const adapter = lifecycleAdapter ?? productionLifecycle(codeRelease);
    let instance;
    try {
      receipt.phase = 'activation-load-in-progress';
      receipt.lifecycle.push({ event: 'activation-closed-load-started', at: new Date().toISOString() });
      atomicJson(receiptPath, receipt);
      instance = await adapter.loadClosed({ candidateDbPath, onCheckpoint: async (name) => {
        receipt.lifecycle.push({ event: name, at: new Date().toISOString() });
        atomicJson(receiptPath, receipt);
      } });
    } finally { if (instance !== undefined) await adapter.destroy(instance); }
    const afterClosedLoad = sourceFileFingerprint(candidateDbPath);
    preservationAudit(receipt, release);
    receipt.phase = 'prepared';
    const cohortRoot = join(sandboxRoot, 'cohorts');
    try { mkdirSync(cohortRoot, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    privateDirectory(cohortRoot, 'cohort directory');
    const operationCohort = join(cohortRoot, operationId);
    assertNewPath(operationCohort, 'operation cohort directory');
    mkdirSync(operationCohort, { mode: 0o700 });
    chmodSync(operationCohort, 0o700);
    symlinkSync(codeRelease, join(operationCohort, 'code'));
    symlinkSync(candidateDbPath, join(operationCohort, 'data.db'));
    receipt.activation = {
      activePairPath,
      cohortPath: operationCohort,
      codeRelease,
      databasePath: candidateDbPath,
      candidateDbPath,
      priorCohortPath: prior.path,
      priorCodeRelease: prior.code,
      priorDatabasePath: prior.database,
      priorPlanSha256: prior.metadata.planSha256,
      priorCohortMetadata: prior.metadata,
      priorCohortMetadata: prior.metadata,
      planSha256: release.planSha256,
      lineageId: status.lineageId,
      candidatePostClosedLoadSha256: afterClosedLoad,
      activatedAt: new Date().toISOString(),
      editorWritesObserved: false,
      phase: 'pair-selected-editors-closed',
    };
    writeFileSync(join(operationCohort, 'cohort.json'), `${JSON.stringify({
      schemaVersion: 1, operationId, planSha256: release.planSha256, lineageId: status.lineageId,
      codeRelease, artifactSha256: release.artifactSha256, databasePath: candidateDbPath, databaseSha256: afterClosedLoad,
      previousCohortPath: prior.path, selectedAt: receipt.activation.activatedAt,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    receipt.phase = 'activation-intent';
    receipt.activation.phase = 'activation-intent';
    atomicJson(receiptPath, receipt);
    atomicSymlink(operationCohort, activePairPath);
    receipt.phase = 'activated';
    receipt.activation.phase = 'pair-selected-editors-closed';
    atomicJson(receiptPath, receipt);
    return publicStatus(receipt, readCandidateState(candidateDbPath));
  } finally { unlock(); }
}

/** Restore the previously verified code+database cohort, while the new copy is untouched. */
export function rollbackMigration({ operationId, receiptPath: rawReceiptPath, activePairPath: rawActivePairPath, sandboxRoot: rawSandboxRoot }) {
  const receiptPath = abs(rawReceiptPath, 'receiptPath');
  const activePairPath = abs(rawActivePairPath, 'activePairPath');
  const receipt = receiptFrom(receiptPath, operationId);
  const unlock = acquireTargetLocks([receipt.candidateDbPath, activePairPath]);
  try {
  const currentReceipt = receiptFrom(receiptPath, operationId);
  if (currentReceipt.candidateDbPath !== receipt.candidateDbPath) fail('candidate path changed while waiting for the rollback lock');
  const sandboxRoot = verifySandbox(rawSandboxRoot, { activePairPath, candidateDbPath: receipt.candidateDbPath, receiptPath });
  assertDistinctPaths([...databasePathSet('candidate database', receipt.candidateDbPath), ['operation receipt', receiptPath], ['active pair pointer', activePairPath]]);
  if (!['activated', 'activation-intent'].includes(receipt.phase) || !receipt.activation) fail(`operation is not rollback-ready (phase ${receipt.phase})`);
  const activation = receipt.activation;
  const current = readCohort(activePairPath, sandboxRoot);
  const pairAlreadyPrior = current.path === resolve(activation.priorCohortPath);
  if (!pairAlreadyPrior && (current.metadata.operationId !== operationId || current.path !== resolve(activation.cohortPath))) fail('active pair is not this operation’s verified cohort; refusing to change it');
  assertNoOpenHandles([receipt.candidateDbPath, `${receipt.candidateDbPath}-wal`, `${receipt.candidateDbPath}-shm`]);
  const candidateHash = sourceFileFingerprint(receipt.candidateDbPath);
  if (candidateHash !== activation.candidatePostClosedLoadSha256) fail('candidate database changed after activation; old backup rollback would lose later writes and is refused');
  if (sourceFileFingerprint(receipt.sourceDbPath) !== receipt.source.sourceFileFingerprint) fail('original source database or WAL changed after preparation; prior pair cannot be proven lossless');
  const prior = readCohort(activation.priorCohortPath, sandboxRoot);
  if (prior.code !== activation.priorCodeRelease || prior.database !== activation.priorDatabasePath || prior.metadata.planSha256 !== activation.priorPlanSha256) {
    fail('prior code+database cohort metadata changed; refusing unverified rollback');
  }
  if (!pairAlreadyPrior) atomicSymlink(prior.path, activePairPath);
  receipt.phase = 'rolled-back';
  receipt.activation.phase = pairAlreadyPrior ? 'activation-intent-reconciled-before-switch' : 'rolled-back-before-reopen';
  receipt.rollback = { restoredCohortPath: prior.path, restoredCodeRelease: prior.code, restoredDatabasePath: prior.database, at: new Date().toISOString() };
  atomicJson(receiptPath, receipt);
  return receipt.rollback;
  } finally { unlock(); }
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.length === 0) return { command: 'help' };
  const [command, ...tokens] = argv;
  if (!['prepare', 'status', 'activate', 'rollback'].includes(command)) fail(`unknown command: ${command}`);
  const options = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (options[key] !== undefined) fail(`duplicate option: ${token}`);
    options[key] = tokens[++i];
    if (options[key] === undefined || options[key].startsWith('--')) fail(`missing value for ${token}`);
  }
  return { command, options };
}
function usage() {
  process.stdout.write([
    'Usage:',
    '  node cms/scripts/run-data-migrations.mjs prepare --source-db PATH --source-cms-root PATH --candidate-db PATH --artifact-dir PATH --receipt PATH --operation-id ID',
    '  node cms/scripts/run-data-migrations.mjs status --candidate-db PATH --receipt PATH --operation-id ID',
    '  node cms/scripts/run-data-migrations.mjs activate --candidate-db PATH --code-release PATH --active-pair PATH --sandbox-root PATH --receipt PATH --operation-id ID',
    '  node cms/scripts/run-data-migrations.mjs rollback --active-pair PATH --sandbox-root PATH --receipt PATH --operation-id ID',
    '',
    'Activation and rollback operate only inside a private directory containing .ikpk-rehearsal-target. The runner never starts a listener.',
  ].join('\n'));
}
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help') return usage();
  const { command, options } = parsed;
  const common = { operationId: options.operationId, receiptPath: options.receipt };
  let result;
  if (command === 'prepare') result = await prepareMigration({
    ...common, sourceDbPath: options.sourceDb, sourceCmsRoot: options.sourceCmsRoot,
    candidateDbPath: options.candidateDb, artifactDir: options.artifactDir,
  });
  else if (command === 'status') result = getMigrationStatus({ ...common, candidateDbPath: options.candidateDb });
  else if (command === 'activate') result = await activateMigration({
    ...common, candidateDbPath: options.candidateDb, codeRelease: options.codeRelease,
    activePairPath: options.activePair, sandboxRoot: options.sandboxRoot,
  });
  else result = rollbackMigration({ ...common, activePairPath: options.activePair, sandboxRoot: options.sandboxRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
