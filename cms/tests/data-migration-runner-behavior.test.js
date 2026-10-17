import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TARGET_PEOPLE } from '../scripts/institute-method-author-classification.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runnerPath = join(repoRoot, 'cms/scripts/run-data-migrations.mjs');
const migrationPlanPath = join(repoRoot, 'cms/database/migrations/plan.json');
const cmsRequire = createRequire(join(repoRoot, 'cms/package.json'));
const Database = cmsRequire('better-sqlite3');
const hash = (value) => createHash('sha256').update(value).digest('hex');
function artifactDigest(root) {
  const entries = [];
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = join(directory, entry.name);
      const info = lstatSync(file);
      if (info.isDirectory()) visit(file, relativePath);
      else entries.push({ path: relativePath, type: 'file', sha256: hash(readFileSync(file)) });
    }
  }
  visit(root);
  return hash(JSON.stringify(entries));
}
function databaseDigest(path) {
  return hash(JSON.stringify([
    { file: basename(path), sha256: hash(readFileSync(path)) },
    { file: `${basename(path)}-wal`, absent: true },
  ]));
}

function addExternalDependencies(f) {
  const dependencyRoot = join(f.root, 'immutable-deps', 'node_modules');
  const strapiRoot = join(dependencyRoot, '@strapi', 'strapi');
  mkdirSync(join(strapiRoot, 'bin'), { recursive: true });
  mkdirSync(join(dependencyRoot, '.bin'), { recursive: true });
  writeFileSync(join(strapiRoot, 'package.json'), JSON.stringify({ name: '@strapi/strapi', version: '5.51.2' }));
  writeFileSync(join(strapiRoot, 'bin', 'cli.js'), 'export default true;\n');
  symlinkSync('../@strapi/strapi/bin/cli.js', join(dependencyRoot, '.bin', 'strapi'));
  symlinkSync(dependencyRoot, join(f.artifactDir, 'node_modules'));
  writeFileSync(join(f.artifactDir, 'package-lock.json'), JSON.stringify({
    name: 'ikpk-cms', lockfileVersion: 3,
    packages: { 'node_modules/@strapi/strapi': { version: '5.51.2' } },
  }));
  return dependencyRoot;
}

function sandbox(t, label = 'ikpk-migration-runner-') {
  const root = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function seedDb(path, { value = 'original' } = {}) {
  const db = new Database(path);
  db.exec('CREATE TABLE source_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE effects (id INTEGER PRIMARY KEY, runs INTEGER NOT NULL);');
  db.prepare('INSERT INTO source_items(value) VALUES (?)').run(value);
  db.close();
}

function dbBytes(path) {
  return readFileSync(path);
}

function installFakeStrapi(f, { failOnLoad = false } = {}) {
  const dependencyRoot = addExternalDependencies(f);
  const packageDir = join(dependencyRoot, '@strapi/strapi');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@strapi/strapi', version: '5.51.2', main: 'index.js' }));
  writeFileSync(join(packageDir, 'index.js'), `
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const Database = require(${JSON.stringify(cmsRequire.resolve('better-sqlite3'))});
exports.createStrapi = ({ appDir }) => ({
  config: { get(name) { return name === 'database.connection' ? { client: process.env.DATABASE_CLIENT, connection: { filename: process.env.DATABASE_FILENAME } } : undefined; } },
  async load() {
    assert.equal(process.cwd(), appDir);
    assert.equal(process.env.DATABASE_CLIENT, 'sqlite');
    assert.equal(process.env.DATABASE_URL, undefined);
    for (const key of ['JWT_SECRET', 'APP_KEYS', 'ADMIN_JWT_SECRET', 'API_TOKEN_SALT', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY']) {
      assert.equal(typeof process.env[key], 'string', 'closed Strapi must receive an isolated ' + key);
      assert.ok(process.env[key].length >= 32, 'closed Strapi ' + key + ' must be generated locally');
      assert.notEqual(process.env[key], 'inherited-value-that-must-not-be-used', 'closed Strapi must not reuse inherited ' + key);
    }
    assert.equal(process.env.HOST, '127.0.0.1');
    assert.equal(process.env.PORT, '0');
    assert.equal(process.env.STRAPI_TELEMETRY_DISABLED, 'true');
    assert.equal(process.env.IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP, '0');
    assert.equal(process.env.CONTENT_ADMIN_EMAIL, undefined);
    assert.equal(process.env.CONTENT_ADMIN_PASSWORD, undefined);
    assert.equal(process.env.CMS_TOKEN, undefined);
    process.env.CMS_TOKEN = 'closed-load-temporary-token';
    assert.equal(createRequire(path.join(appDir, 'src/lifecycles/publication.ts'))('../lib/demo193-source-empty-fields.json').entries instanceof Array, true);
    ${failOnLoad ? "throw new Error('simulated closed-load failure');" : `
    const db = new Database(process.env.DATABASE_FILENAME);
    try {
      const history = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='strapi_migrations'").get()
        && db.prepare('SELECT 1 FROM strapi_migrations WHERE name = ?').get('2026.09.21T00.00.00.rename-status-columns.js');
      if (!history) {
        for (const [table, oldName, newName] of [['seminars', 'status', 'seminar_status'], ['schedule_entries', 'status', 'entry_status']]) {
          const names = db.prepare('PRAGMA table_info("' + table + '")').all().map(({ name }) => name);
          if (names.includes(oldName) && !names.includes(newName)) db.exec('ALTER TABLE "' + table + '" RENAME COLUMN "' + oldName + '" TO "' + newName + '"');
        }
      }
      db.exec('CREATE TABLE IF NOT EXISTS strapi_migrations (id INTEGER NOT NULL PRIMARY KEY, name varchar(255), time datetime)');
      db.prepare('INSERT OR IGNORE INTO strapi_migrations(id,name,time) VALUES (1,?,?)').run('2026.09.21T00.00.00.rename-status-columns.js', Date.now());
    } finally { db.close(); }
    `}
  },
  async destroy() {
    assert.equal(process.cwd(), appDir);
    assert.equal(process.env.DATABASE_CLIENT, 'sqlite');
    assert.equal(process.env.DATABASE_URL, undefined);
    for (const key of ['JWT_SECRET', 'APP_KEYS', 'ADMIN_JWT_SECRET', 'API_TOKEN_SALT', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY']) {
      assert.notEqual(process.env[key], 'inherited-value-that-must-not-be-used', 'destroy must run inside the isolated ' + key + ' environment');
    }
    assert.equal(process.env.HOST, '127.0.0.1');
    assert.equal(process.env.PORT, '0');
    assert.equal(process.env.STRAPI_TELEMETRY_DISABLED, 'true');
    assert.equal(process.env.CMS_TOKEN, 'closed-load-temporary-token');
  },
});
`);
}

function fixture(t, { operationId = 'op-fixture-1', statusShape = 'old' } = {}) {
  const root = sandbox(t);
  const sourceDbPath = join(root, 'source.db');
  const candidateDbPath = join(root, 'private', 'candidate.db');
  const sourceCmsRoot = join(root, 'source-cms');
  const artifactDir = join(root, 'artifact');
  const stepsDir = join(artifactDir, 'database', 'migrations', 'steps');
  const artifactScripts = join(artifactDir, 'scripts');
  const targetSchemaPath = join(artifactDir, 'database/migrations/target-schema/seminar.json');
  const sourceEmptyFieldsPath = join(artifactDir, 'src/lib/demo193-source-empty-fields.json');
  const receiptPath = join(root, 'receipt.json');
  mkdirSync(dirname(candidateDbPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(candidateDbPath), 0o700);
  mkdirSync(sourceCmsRoot, { recursive: true });
  mkdirSync(stepsDir, { recursive: true });
  mkdirSync(artifactScripts, { recursive: true });
  mkdirSync(dirname(targetSchemaPath), { recursive: true });
  copyFileSync(join(repoRoot, 'cms/src/api/seminar/content-types/seminar/schema.json'), targetSchemaPath);
  mkdirSync(dirname(sourceEmptyFieldsPath), { recursive: true });
  copyFileSync(join(repoRoot, 'cms/src/lib/demo193-source-empty-fields.json'), sourceEmptyFieldsPath);
  writeFileSync(join(sourceCmsRoot, 'package.json'), JSON.stringify({ dependencies: { '@strapi/strapi': '5.51.2' } }));
  seedDb(sourceDbPath);
  {
    const db = new Database(sourceDbPath);
    db.exec(`CREATE TABLE strapi_database_schema (id INTEGER PRIMARY KEY, schema TEXT, time TEXT, hash TEXT);
      CREATE TABLE institutes (id INTEGER PRIMARY KEY, document_id TEXT, legacy_id TEXT, name TEXT, slug TEXT);
      CREATE TABLE teachers (id INTEGER PRIMARY KEY, document_id TEXT, legacy_id TEXT, name TEXT, trait TEXT, slug TEXT, bio TEXT, published_at TEXT, locale TEXT);
      CREATE TABLE teachers_institute_lnk (id INTEGER PRIMARY KEY, teacher_id INTEGER, institute_id INTEGER);
      CREATE TABLE seminars (id INTEGER PRIMARY KEY, status TEXT);
      CREATE TABLE schedule_entries (id INTEGER PRIMARY KEY, status TEXT);
      INSERT INTO seminars VALUES (1, 'active'); INSERT INTO schedule_entries VALUES (1, 'cancelled');`);
    const addInstitute = db.prepare('INSERT INTO institutes VALUES (?, ?, ?, ?, ?)');
    addInstitute.run(1, 'ikpk-doc', 'institut-klinicheskoy-prikladnoy-kineziologii', 'Институт клинической прикладной кинезиологии', 'institut-klinicheskoy-prikladnoy-kineziologii');
    addInstitute.run(2, 'ap-doc', 'institut-apledzhera', 'Институт Апледжера', 'institut-apledzhera');
    addInstitute.run(3, 'bar-doc', 'institut-barralya', 'Институт Барраля', 'institut-barralya');
    const person = db.prepare('INSERT INTO teachers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const link = db.prepare('INSERT INTO teachers_institute_lnk (teacher_id, institute_id) VALUES (?, ?)');
    let id = 1;
    for (const entry of TARGET_PEOPLE) {
      const instituteId = entry.institute === 'institut-apledzhera' ? 2 : 3;
      for (const publishedAt of [null, '2026-10-13T18:00:00.000Z']) {
        person.run(id, `doc-${entry.legacyId}`, entry.legacyId, entry.name, entry.initialTrait, `slug-${entry.legacyId}`, `bio-${entry.legacyId}`, publishedAt, 'ru');
        link.run(id, instituteId); id += 1;
      }
    }
    db.close();
  }
  if (statusShape !== 'old') {
    const db = new Database(sourceDbPath);
    try {
      for (const [table, oldName, newName] of [['seminars', 'status', 'seminar_status'], ['schedule_entries', 'status', 'entry_status']]) {
        if (statusShape === 'new') db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${oldName}" TO "${newName}"`);
        else if (statusShape === 'neither' || (statusShape === 'applied-retired' && table === 'seminars')) db.exec(`ALTER TABLE "${table}" DROP COLUMN "${oldName}"`);
      }
      if (statusShape === 'applied-retired') {
        db.exec('ALTER TABLE schedule_entries RENAME COLUMN status TO entry_status');
        db.exec('CREATE TABLE strapi_migrations (id INTEGER NOT NULL PRIMARY KEY, name varchar(255), time datetime)');
        db.prepare('INSERT INTO strapi_migrations(id,name,time) VALUES (1,?,?)').run('2026.09.21T00.00.00.rename-status-columns.js', Date.now());
      }
    } finally { db.close(); }
  }
  const sourceMigrations = join(repoRoot, 'cms/database/migrations');
  cpSync(sourceMigrations, join(artifactDir, 'database/migrations'), { recursive: true });
  mkdirSync(join(artifactDir, 'scripts'), { recursive: true });
  mkdirSync(join(artifactDir, 'database/migrations/data-steps'), { recursive: true });
  for (const name of ['run-data-migrations.mjs', 'audit-data-migration.mjs', 'audit-schema-snapshot.mjs', 'institute-method-author-classification.mjs', 'normalize-null-documents-state.mjs']) {
    const source = join(repoRoot, 'cms/scripts', name);
    const destination = join(artifactScripts, name);
    copyFileSync(source, destination);
  }
  for (const name of ['classification.mjs', 'normalize-documents-state.mjs']) copyFileSync(join(sourceMigrations, 'data-steps', name), join(artifactDir, 'database/migrations/data-steps', name));
  writeFileSync(join(artifactDir, 'package.json'), JSON.stringify({ dependencies: { '@strapi/strapi': '5.51.2' } }));
  const plan = JSON.parse(readFileSync(join(sourceMigrations, 'plan.json'), 'utf8'));
  plan.steps = plan.steps.filter(({ id }) => id !== 'normalize-null-documents-state-v1');
  plan.integrity.files = ['run-data-migrations.mjs', 'audit-data-migration.mjs', 'audit-schema-snapshot.mjs', 'institute-method-author-classification.mjs', 'normalize-null-documents-state.mjs'].map((name) => ({ path: `scripts/${name}`, sha256: hash(readFileSync(join(artifactScripts, name))) }));
  plan.integrity.files.push({ path: 'database/migrations/target-schema/seminar.json', sha256: hash(readFileSync(targetSchemaPath)) });
  plan.integrity.files.push({ path: 'src/lib/demo193-source-empty-fields.json', sha256: hash(readFileSync(sourceEmptyFieldsPath)) });
  const payloadPath = join(artifactDir, 'database/migrations/data-steps/classification.mjs');
  writeFileSync(join(artifactDir, 'database', 'migrations', 'plan.json'), JSON.stringify(plan, null, 2));
  const lifecycleAdapter = {
    async loadClosed({ candidateDbPath, onCheckpoint }) {
      const db = new Database(candidateDbPath);
      try {
        const recorded = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='strapi_migrations'").get()
          && db.prepare('SELECT 1 FROM strapi_migrations WHERE name = ?').get('2026.09.21T00.00.00.rename-status-columns.js');
        if (!recorded) {
          if (!db.prepare('PRAGMA table_info("seminars")').all().some(({ name }) => name === 'seminar_status')) db.exec('ALTER TABLE seminars RENAME COLUMN status TO seminar_status');
          if (!db.prepare('PRAGMA table_info("schedule_entries")').all().some(({ name }) => name === 'entry_status')) db.exec('ALTER TABLE schedule_entries RENAME COLUMN status TO entry_status');
        }
        db.exec('CREATE TABLE IF NOT EXISTS strapi_migrations (id INTEGER NOT NULL PRIMARY KEY, name varchar(255), time datetime)');
        db.prepare('INSERT OR IGNORE INTO strapi_migrations(id,name,time) VALUES (1,?,?)').run('2026.09.21T00.00.00.rename-status-columns.js', Date.now());
      } finally { db.close(); }
      await onCheckpoint?.('after-native-migrations');
      await onCheckpoint?.('after-schema-sync');
      await onCheckpoint?.('after-bootstrap');
      return { closed: true };
    },
    async destroy(instance) { assert.equal(instance.closed, true); },
    async runDataStep({ candidateDbPath: dbPath, recordCompletion, onCheckpoint }) {
      const db = new Database(dbPath);
      const { applyClassification } = await import('../scripts/institute-method-author-classification.mjs');
      try {
        db.transaction(() => {
          const result = applyClassification(db);
          recordCompletion(db, result);
        })();
      } finally {
        db.close();
      }
      await onCheckpoint?.('data-step-committed');
    },
  };
  return { root, operationId, sourceDbPath, candidateDbPath, sourceCmsRoot, artifactDir, receiptPath, lifecycleAdapter, payloadPath, plan };
}

async function loadRunner() {
  assert.ok(existsSync(runnerPath), 'runner module must exist before behavioral migration tests execute');
  return import(pathToFileURL(runnerPath).href);
}

function prepareArgs(f) {
  return {
    sourceDbPath: f.sourceDbPath, sourceCmsRoot: f.sourceCmsRoot, candidateDbPath: f.candidateDbPath,
    artifactDir: f.artifactDir, receiptPath: f.receiptPath, operationId: f.operationId,
    lifecycleAdapter: f.lifecycleAdapter,
  };
}

async function makePrepared(t, opts) {
  const f = fixture(t, opts);
  const runner = await loadRunner();
  await runner.prepareMigration(prepareArgs(f));
  return { ...f, runner };
}

test('file-backed prepare leaves source database and committed WAL bytes unchanged', async (t) => {
  const f = fixture(t);
  const before = dbBytes(f.sourceDbPath);
  const runner = await loadRunner();
  await runner.prepareMigration(prepareArgs(f));
  assert.deepEqual(dbBytes(f.sourceDbPath), before, 'prepare mutated the source SQLite database');
  assert.equal(existsSync(`${f.sourceDbPath}-wal`), false, 'fixture source should have no uncheckpointed WAL');
  const candidate = new Database(f.candidateDbPath);
  assert.equal(candidate.prepare('SELECT seminar_status FROM seminars WHERE id = 1').get().seminar_status, 'active');
  assert.equal(candidate.prepare('SELECT entry_status FROM schedule_entries WHERE id = 1').get().entry_status, 'cancelled');
  candidate.close();
});

test('already-renamed source columns without native history pass preflight, retain data, and are recorded', async (t) => {
  const prepared = await makePrepared(t, { operationId: 'op-pre-renamed-source', statusShape: 'new' });
  const db = new Database(prepared.candidateDbPath);
  assert.equal(db.prepare('SELECT seminar_status FROM seminars WHERE id = 1').get().seminar_status, 'active');
  assert.equal(db.prepare('SELECT entry_status FROM schedule_entries WHERE id = 1').get().entry_status, 'cancelled');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM strapi_migrations WHERE name = ?').get('2026.09.21T00.00.00.rename-status-columns.js').count, 1);
  db.close();
  assert.equal(JSON.parse(readFileSync(prepared.receiptPath, 'utf8')).preservation.passed, true);
});

test('recorded native migration accepts the retired seminar status and current schedule entry status', async (t) => {
  const prepared = await makePrepared(t, { operationId: 'op-applied-retired-shape', statusShape: 'applied-retired' });
  const db = new Database(prepared.candidateDbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM strapi_migrations WHERE name = ?').get('2026.09.21T00.00.00.rename-status-columns.js').count, 1);
  assert.equal(db.prepare('SELECT entry_status FROM schedule_entries WHERE id = 1').get().entry_status, 'cancelled');
  assert.equal(db.prepare('PRAGMA table_info("seminars")').all().some(({ name }) => ['status', 'seminar_status'].includes(name)), false);
  db.close();
  assert.equal(JSON.parse(readFileSync(prepared.receiptPath, 'utf8')).preservation.passed, true);
});

test('source missing both supported names for either status column refuses before candidate creation', async (t) => {
  const f = fixture(t, { operationId: 'op-missing-status-columns', statusShape: 'neither' });
  const runner = await loadRunner();
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /expected one of seminars\.status, seminars\.seminar_status/i);
  assert.equal(existsSync(f.candidateDbPath), false);
});

test('snapshot staging cleanup failure is recorded and prevents unsafe candidate resume', async (t) => {
  const f = fixture(t);
  const runner = await loadRunner();
  const fs = createRequire(join(repoRoot, 'cms/package.json'))('node:fs');
  const originalRmSync = fs.rmSync;
  let injected = false;
  fs.rmSync = (path, options) => {
    if (!injected && String(path).includes(`.ikpk-migration-${f.operationId}-`)) {
      injected = true;
      const error = new Error('fixture cleanup failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalRmSync(path, options);
  };
  try {
    await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /staging cleanup failed/i);
  } finally {
    fs.rmSync = originalRmSync;
  }
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  assert.equal(receipt.phase, 'snapshot-cleanup-failed');
  assert.equal(receipt.errors[0].message, 'fixture cleanup failure');
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /interrupted or incomplete operation|snapshot-cleanup-failed|discard/i);
});

test('data migration ID and payload hash are recorded transactionally and applied only once', async (t) => {
  const f = await makePrepared(t);
  const status = await f.runner.getMigrationStatus({ candidateDbPath: f.candidateDbPath, operationId: f.operationId, receiptPath: f.receiptPath });
  assert.equal(status.steps.find((step) => step.id === 'institute-method-author-classification-v1')?.status, 'completed');
  assert.equal(status.steps.find((step) => step.id === 'institute-method-author-classification-v1')?.payloadSha256, hash(readFileSync(f.payloadPath)));
  const before = new Database(f.candidateDbPath);
  const runs = before.prepare("SELECT COUNT(*) AS count FROM teachers WHERE legacy_id = '63' AND trait = 'method-author'").get().count;
  before.close();
  assert.equal(runs, 2, 'real classification helper should update both physical versions exactly once');
});
test('a following release reuses the stable lineage and prior step ledger without replay', async (t) => {
  const first = await makePrepared(t, { operationId: 'op-release-n' });
  const secondDirectory = join(first.root, 'release-n-plus-one');
  mkdirSync(secondDirectory, { mode: 0o700 }); chmodSync(secondDirectory, 0o700);
  const secondCandidate = join(secondDirectory, 'candidate.db');
  const secondReceipt = join(secondDirectory, 'receipt.json');
  const second = await first.runner.prepareMigration({
    sourceDbPath: first.candidateDbPath,
    sourceCmsRoot: first.sourceCmsRoot,
    candidateDbPath: secondCandidate,
    artifactDir: first.artifactDir,
    receiptPath: secondReceipt,
    operationId: 'op-release-n-plus-one',
    lifecycleAdapter: first.lifecycleAdapter,
  });
  const firstStatus = await first.runner.getMigrationStatus({ candidateDbPath: first.candidateDbPath, operationId: first.operationId, receiptPath: first.receiptPath });
  const nextStatus = await first.runner.getMigrationStatus({ candidateDbPath: secondCandidate, operationId: 'op-release-n-plus-one', receiptPath: secondReceipt });
  assert.equal(nextStatus.lineageId, firstStatus.lineageId);
  assert.equal(second.steps.find(({ id }) => id === 'institute-method-author-classification-v1').status, 'completed');
  const db = new Database(secondCandidate);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ikpk_data_migration_history').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM teachers WHERE legacy_id = '63' AND trait = 'method-author'").get().count, 2);
  db.close();
});
test('a following release blocks mutation of inherited migration result metadata', async (t) => {
  const first = await makePrepared(t, { operationId: 'op-ledger-history-n' });
  const secondDirectory = join(first.root, 'tampered-release-n-plus-one');
  mkdirSync(secondDirectory, { mode: 0o700 }); chmodSync(secondDirectory, 0o700);
  const secondCandidate = join(secondDirectory, 'candidate.db');
  const secondReceipt = join(secondDirectory, 'receipt.json');
  const tamperingAdapter = {
    ...first.lifecycleAdapter,
    async loadClosed(args) {
      await first.lifecycleAdapter.loadClosed(args);
      const db = new Database(args.candidateDbPath);
      try { db.prepare('UPDATE ikpk_data_migration_history SET result_json = ? WHERE step_id = ?').run('{"updatedRows":0,"noops":12}', 'institute-method-author-classification-v1'); }
      finally { db.close(); }
    },
  };
  await assert.rejects(() => first.runner.prepareMigration({
    sourceDbPath: first.candidateDbPath,
    sourceCmsRoot: first.sourceCmsRoot,
    candidateDbPath: secondCandidate,
    artifactDir: first.artifactDir,
    receiptPath: secondReceipt,
    operationId: 'op-ledger-history-n-plus-one',
    lifecycleAdapter: tamperingAdapter,
  }), /inherited|history|preservation|audit/i);
  const source = new Database(first.candidateDbPath);
  assert.equal(source.prepare('SELECT result_json FROM ikpk_data_migration_history WHERE step_id = ?').get('institute-method-author-classification-v1').result_json, '{"updatedRows":4,"noops":10}');
  source.close();
});
test('default data-step loader imports the verified packaged helper path', async (t) => {
  const f = fixture(t);
  const runner = await loadRunner();
  const defaultAdapter = { loadClosed: f.lifecycleAdapter.loadClosed, destroy: f.lifecycleAdapter.destroy };
  await runner.prepareMigration({ ...prepareArgs(f), lifecycleAdapter: defaultAdapter });
});

test('source structure errors are reported before full external dependency fingerprinting', async (t) => {
  const f = fixture(t, { operationId: 'op-preflight-source-shape' });
  addExternalDependencies(f);
  symlinkSync(f.root, join(f.artifactDir, 'unexpected-external-link'));
  const source = new Database(f.sourceDbPath);
  source.exec('DROP TABLE seminars');
  source.close();
  const before = hash(readFileSync(f.sourceDbPath));
  const runner = await loadRunner();
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /source schema precondition failed.*table seminars is missing/i);
  assert.equal(hash(readFileSync(f.sourceDbPath)), before, 'preflight must leave the source database byte-identical');
  assert.equal(existsSync(f.candidateDbPath), false, 'preflight must refuse before creating a candidate');
  assert.equal(existsSync(f.receiptPath), false, 'preflight must refuse before writing a receipt');
});

test('default closed Strapi lifecycle uses artifact cwd through destroy and restores process state', async (t) => {
  const f = fixture(t, { operationId: 'op-default-lifecycle-context', statusShape: 'applied-retired' });
  installFakeStrapi(f);
  const previousCwd = process.cwd();
  const secretKeys = ['JWT_SECRET', 'APP_KEYS', 'ADMIN_JWT_SECRET', 'API_TOKEN_SALT', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY'];
  const runtimeKeys = [...secretKeys, 'HOST', 'PORT', 'STRAPI_TELEMETRY_DISABLED', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP', 'CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN'];
  const previousEnvironment = Object.fromEntries(['DATABASE_CLIENT', 'DATABASE_URL', 'DATABASE_FILENAME', ...runtimeKeys].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_CLIENT: 'mysql', DATABASE_URL: 'restore-me', DATABASE_FILENAME: 'restore.db', ...Object.fromEntries(runtimeKeys.map((key) => [key, 'inherited-value-that-must-not-be-used'])) });
  try {
    const args = prepareArgs(f);
    delete args.lifecycleAdapter;
    await (await loadRunner()).prepareMigration(args);
    assert.equal(process.cwd(), previousCwd);
    assert.equal(process.env.DATABASE_CLIENT, 'mysql');
    assert.equal(process.env.DATABASE_URL, 'restore-me');
    assert.equal(process.env.DATABASE_FILENAME, 'restore.db');
    for (const key of runtimeKeys) assert.equal(process.env[key], 'inherited-value-that-must-not-be-used');
    assert.equal(readFileSync(args.receiptPath, 'utf8').includes('inherited-value-that-must-not-be-used'), false, 'receipt must not persist inherited environment values');
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('default closed Strapi lifecycle restores cwd and database environment after load failure', async (t) => {
  const f = fixture(t, { operationId: 'op-default-lifecycle-failure' });
  installFakeStrapi(f, { failOnLoad: true });
  const previousCwd = process.cwd();
  const secretKeys = ['JWT_SECRET', 'APP_KEYS', 'ADMIN_JWT_SECRET', 'API_TOKEN_SALT', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY'];
  const runtimeKeys = [...secretKeys, 'HOST', 'PORT', 'STRAPI_TELEMETRY_DISABLED', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP', 'CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN'];
  const previousEnvironment = Object.fromEntries(['DATABASE_CLIENT', 'DATABASE_URL', 'DATABASE_FILENAME', ...runtimeKeys].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_CLIENT: 'mysql', DATABASE_URL: 'restore-me', DATABASE_FILENAME: 'restore.db', ...Object.fromEntries(runtimeKeys.map((key) => [key, 'inherited-value-that-must-not-be-used'])) });
  try {
    const runner = await loadRunner();
    const args = prepareArgs(f);
    delete args.lifecycleAdapter;
    await assert.rejects(() => runner.prepareMigration(args), /simulated closed-load failure/);
    assert.equal(process.cwd(), previousCwd);
    assert.equal(process.env.DATABASE_CLIENT, 'mysql');
    assert.equal(process.env.DATABASE_URL, 'restore-me');
    assert.equal(process.env.DATABASE_FILENAME, 'restore.db');
    for (const key of runtimeKeys) assert.equal(process.env[key], 'inherited-value-that-must-not-be-used');
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('external immutable dependency bytes are included in the selected cohort identity', async (t) => {
  const f = fixture(t);
  const dependencyRoot = addExternalDependencies(f);
  writeFileSync(join(f.root, '.ikpk-rehearsal-target'), 'fixture\n');
  const runner = await loadRunner();
  await runner.prepareMigration(prepareArgs(f));
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  writeFileSync(join(dependencyRoot, '@strapi', 'strapi', 'bin', 'cli.js'), 'export default false;\n');

  const activePairPath = join(f.root, 'active');
  const cohorts = join(f.root, 'cohorts');
  const prior = join(cohorts, 'prior');
  const oldDb = join(f.root, 'old.db');
  mkdirSync(prior, { recursive: true, mode: 0o700 });
  seedDb(oldDb, { value: 'prior' });
  symlinkSync(f.artifactDir, join(prior, 'code'));
  symlinkSync(oldDb, join(prior, 'data.db'));
  writeFileSync(join(prior, 'cohort.json'), JSON.stringify({
    schemaVersion: 1, planSha256: receipt.planSha256, artifactSha256: receipt.artifactSha256, artifactIdentityKind: receipt.artifactIdentityKind,
    databaseSha256: databaseDigest(oldDb), codeRelease: realpathSync(f.artifactDir), databasePath: realpathSync(oldDb),
    staticRelease: 'old-static', configRef: 'old-config', mediaRef: 'old-media',
  }));
  symlinkSync(prior, activePairPath);

  await assert.rejects(() => runner.activateMigration({
    candidateDbPath: f.candidateDbPath, codeRelease: f.artifactDir, activePairPath,
    sandboxRoot: f.root, receiptPath: f.receiptPath, operationId: f.operationId,
    lifecycleAdapter: f.lifecycleAdapter,
  }), /artifact identity changed|cohort code artifact identity/i);
  assert.equal(realpathSync(activePairPath), realpathSync(prior), 'changed dependency bytes must not switch the active pair');
});

test('external dependency tree accepts npm .bin links contained by its root', async (t) => {
  const f = fixture(t);
  addExternalDependencies(f);
  const runner = await loadRunner();
  await runner.prepareMigration(prepareArgs(f));
  assert.equal(existsSync(join(f.candidateDbPath)), true);
});

test('present but invalid sealed-install receipt fails closed instead of falling back to vendor hashing', async (t) => {
  const f = fixture(t);
  addExternalDependencies(f);
  writeFileSync(join(f.artifactDir, '.install-provenance.json'), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  const runner = await loadRunner();
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /sealed install provenance|root-owned and private/i);
  assert.equal(existsSync(f.candidateDbPath), false, 'an invalid seal must not create a candidate through the full-hash fallback');
});

test('external dependency tree rejects symlinks escaping its root', async (t) => {
  const f = fixture(t);
  const dependencyRoot = addExternalDependencies(f);
  writeFileSync(join(f.root, 'escaped-dependency.js'), 'must not be hashed as trusted dependency');
  symlinkSync(join(f.root, 'escaped-dependency.js'), join(dependencyRoot, 'escape.js'));
  const runner = await loadRunner();
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /dependency symlink escapes/i);
  assert.equal(existsSync(f.candidateDbPath), false, 'unsafe dependency tree must fail before candidate creation');
});

test('sealed dependency provenance binds exact install, lock, Strapi and Node ABI', async () => {
  const runner = await loadRunner();
  const expectedStrapiVersion = JSON.parse(readFileSync(migrationPlanPath, 'utf8')).steps[0].source.strapiVersion;
  const dependencyRoot = '/var/lib/private/deps/node_modules';
  const packageLockSha256 = 'a'.repeat(64);
  const receipt = {
    schemaVersion: 1,
    dependencyRoot,
    packageLockSha256,
    npmVersion: '10.9.8',
    nodeAbi: process.versions.modules,
    strapiVersion: expectedStrapiVersion,
    installCommand: 'npm ci --omit=dev --no-audit --no-fund',
    exitCode: 0,
    completionObservedAt: '2026-10-16T10:00:00.000Z',
  };
  assert.doesNotThrow(() => runner.validateSealedInstallMetadata({ receipt, dependencyRoot, expectedStrapiVersion, packageLockSha256 }));
  for (const [field, value, reason] of [
    ['packageLockSha256', 'b'.repeat(64), /package-lock SHA-256 mismatch/i],
    ['nodeAbi', 'not-current-abi', /Node ABI differs/i],
    ['strapiVersion', '0.0.0', /Strapi version differs/i],
    ['installCommand', 'npm install', /exact successful npm ci command/i],
  ]) {
    assert.throws(() => runner.validateSealedInstallMetadata({ receipt: { ...receipt, [field]: value }, dependencyRoot, expectedStrapiVersion, packageLockSha256 }), reason);
  }
});

test('sealed dependency verification recognizes only an exact read-only mountpoint', async () => {
  const runner = await loadRunner();
  const target = '/var/lib/private/deps/node_modules';
  const line = `42 25 8:1 / ${target} ro,relatime - ext4 /dev/sda1 ro\n`;
  assert.equal(runner.hasExactReadOnlyMount(line, target), true);
  assert.equal(runner.hasExactReadOnlyMount(line.replace('ro,relatime', 'rw,relatime'), target), false);
  assert.equal(runner.hasExactReadOnlyMount(line, `${target}/child`), false);
  assert.equal(runner.hasExactReadOnlyMount(`42 25 8:1 / /var/lib/private/deps\\040with\\040space/node_modules ro,relatime - ext4 /dev/sda1 ro\n`, '/var/lib/private/deps with space/node_modules'), true);
});
test('same migration ID with changed payload hash is refused without a second data effect', async (t) => {
  const f = await makePrepared(t);
  writeFileSync(f.payloadPath, 'changed-payload-v2');
  f.plan.steps.find(({ kind }) => kind === 'data').sha256 = hash(readFileSync(f.payloadPath));
  writeFileSync(join(f.artifactDir, 'database', 'migrations', 'plan.json'), JSON.stringify(f.plan, null, 2));
  await assert.rejects(() => f.runner.prepareMigration(prepareArgs(f)), /hash|payload|identity|already|plan|измен|хеш/i);
  const db = new Database(f.candidateDbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM teachers WHERE legacy_id = '63' AND trait = 'method-author'").get().count, 2);
  db.close();
});

test('a ledger row with the same migration ID and a different stored hash is refused before replay', async (t) => {
  const f = await makePrepared(t);
  const db = new Database(f.candidateDbPath);
  db.prepare('UPDATE ikpk_data_migration_history SET payload_sha256 = ? WHERE step_id = ?')
    .run('0'.repeat(64), 'institute-method-author-classification-v1');
  const beforeEffects = db.prepare("SELECT COUNT(*) AS count FROM teachers WHERE legacy_id = '63' AND trait = 'method-author'").get().count;
  db.close();
  await assert.rejects(() => f.runner.prepareMigration(prepareArgs(f)), /already recorded with a different SHA-256/i);
  const after = new Database(f.candidateDbPath);
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM teachers WHERE legacy_id = '63' AND trait = 'method-author'").get().count, beforeEffects);
  after.close();
});

test('prepare refuses source overwrite, non-private candidate, and symlink candidate', async (t) => {
  const f = fixture(t);
  const runner = await loadRunner();
  await assert.rejects(() => runner.prepareMigration({ ...prepareArgs(f), candidateDbPath: f.sourceDbPath }), /source|candidate|same|refus|нельзя/i);
  const nonPrivate = join(f.root, 'not-private'); mkdirSync(nonPrivate, { mode: 0o755 }); chmodSync(nonPrivate, 0o755);
  await assert.rejects(() => runner.prepareMigration({ ...prepareArgs(f), candidateDbPath: join(nonPrivate, 'outside.db') }), /sandbox|private|ownership|path|outside|permissions|путь/i);
  const linkPath = join(f.root, 'private', 'linked.db');
  symlinkSync(f.sourceDbPath, linkPath);
  await assert.rejects(() => runner.prepareMigration({ ...prepareArgs(f), candidateDbPath: linkPath }), /symlink|symbolic|link|candidate|ссылка/i);
});

test('prepare refuses SQLite sidecar and receipt aliases before creating a candidate', async (t) => {
  const f = fixture(t);
  const runner = await loadRunner();
  writeFileSync(`${f.sourceDbPath}-wal`, 'do not overwrite');
  const sourceBytes = readFileSync(f.sourceDbPath);
  await assert.rejects(() => runner.prepareMigration({ ...prepareArgs(f), candidateDbPath: `${f.sourceDbPath}-wal` }), /alias|distinct|source/i);
  assert.deepEqual(readFileSync(f.sourceDbPath), sourceBytes);
  assert.equal(readFileSync(`${f.sourceDbPath}-wal`, 'utf8'), 'do not overwrite');
  await assert.rejects(() => runner.prepareMigration({ ...prepareArgs(f), receiptPath: `${f.candidateDbPath}-shm` }), /alias|distinct|receipt/i);
  assert.equal(existsSync(f.candidateDbPath), false);
});

test('a competing prepare for the same destination fails while the owner holds its lock', async (t) => {
  const f = fixture(t);
  const runner = await loadRunner();
  let entered;
  let release;
  const waiting = new Promise((resolvePromise) => { entered = resolvePromise; });
  const hold = new Promise((resolvePromise) => { release = resolvePromise; });
  const firstAdapter = {
    ...f.lifecycleAdapter,
    async loadClosed(args) { await waiting; await hold; return f.lifecycleAdapter.loadClosed(args); },
  };
  const first = runner.prepareMigration({ ...prepareArgs(f), lifecycleAdapter: firstAdapter });
  entered();
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /lock|busy|in.progress|owned|занят/i);
  release();
  await first;
});

test('SIGKILL at committed checkpoint is recovered from the DB ledger without replay', async (t) => {
  const f = fixture(t);
  const script = `
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(join(repoRoot, 'cms/package.json'))});
    const Database = require('better-sqlite3');
    const runner = await import(${JSON.stringify(pathToFileURL(runnerPath).href)});
    const args = JSON.parse(process.env.IKPK_FIXTURE_ARGS);
    const adapter = {
      async loadClosed({ candidateDbPath }) {
        const db = new Database(candidateDbPath);
        try {
          if (!db.prepare('PRAGMA table_info("seminars")').all().some(({ name }) => name === 'seminar_status')) db.exec('ALTER TABLE seminars RENAME COLUMN status TO seminar_status');
          if (!db.prepare('PRAGMA table_info("schedule_entries")').all().some(({ name }) => name === 'entry_status')) db.exec('ALTER TABLE schedule_entries RENAME COLUMN status TO entry_status');
          db.exec('CREATE TABLE IF NOT EXISTS strapi_migrations (id INTEGER NOT NULL PRIMARY KEY, name varchar(255), time datetime)');
          db.prepare('INSERT OR IGNORE INTO strapi_migrations(id,name,time) VALUES (1,?,?)').run('2026.09.21T00.00.00.rename-status-columns.js', Date.now());
        } finally { db.close(); }
        return {};
      }, async destroy() {},
      async runDataStep({ candidateDbPath, recordCompletion }) {
        const db = new Database(candidateDbPath);
        const { applyClassification } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'cms/scripts/institute-method-author-classification.mjs')).href)});
        try { db.transaction(() => { const result = applyClassification(db); recordCompletion(db, result); })(); }
        finally { db.close(); }
      },
    };
    await runner.prepareMigration({ ...args, lifecycleAdapter: adapter, onCheckpoint: async (name) => {
      if (name !== 'data-step-transaction-committed') return;
      process.stdout.write('CHECKPOINT\\n');
      await new Promise(() => {});
    } });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, IKPK_FIXTURE_ARGS: JSON.stringify(prepareArgs(f)) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const checkpoint = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`child missed observable checkpoint: ${output}`)), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('CHECKPOINT')) { clearTimeout(timer); resolvePromise(); }
    });
    child.once('error', rejectPromise);
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await checkpoint;
  child.kill('SIGKILL');
  await new Promise((resolvePromise) => child.once('exit', resolvePromise));
  const runner = await loadRunner();
  await runner.prepareMigration({ ...prepareArgs(f), lifecycleAdapter: f.lifecycleAdapter });
  const db = new Database(f.candidateDbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM teachers WHERE legacy_id = '63' AND trait = 'method-author'").get().count, 2, 'recovery replayed an already committed data effect');
  db.close();
});

test('interruption with uncommitted native/sync lifecycle state refuses blind resume', async (t) => {
  const f = fixture(t);
  const runner = await loadRunner();
  const interruptedAdapter = {
    ...f.lifecycleAdapter,
    async loadClosed({ onCheckpoint }) { await onCheckpoint('after-schema-sync'); throw new Error('fixture interruption before lifecycle completion'); },
  };
  await assert.rejects(() => runner.prepareMigration({ ...prepareArgs(f), lifecycleAdapter: interruptedAdapter }), /interruption/);
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /candidate|interrupted|source|restart|refus|неопредел/i);
});

test('prepare exposes a post-commit checkpoint before reopening the candidate database', async (t) => {
  const f = fixture(t);
  const runner = await loadRunner();
  let dataStepRuns = 0;
  const adapter = {
    ...f.lifecycleAdapter,
    async runDataStep(args) {
      dataStepRuns += 1;
      return f.lifecycleAdapter.runDataStep({ ...args, onCheckpoint: undefined });
    },
  };
  const checkpoints = [];
  await assert.rejects(() => runner.prepareMigration({
    ...prepareArgs(f),
    lifecycleAdapter: adapter,
    onCheckpoint: async (name, details) => {
      checkpoints.push({ name, details });
      if (name === 'data-step-transaction-committed') throw new Error('intentional process-stop checkpoint');
    },
  }), /intentional process-stop checkpoint/);
  assert.deepEqual(checkpoints.map(({ name }) => name), ['closed-load-destroyed', 'data-step-transaction-committed']);
  assert.equal(checkpoints[1].details.stepId, 'institute-method-author-classification-v1');
  const db = new Database(f.candidateDbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ikpk_data_migration_history').get().count, 1, 'the runner callback must be after the committed ledger row');
  db.close();
  const interruptedReceipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  assert.equal(interruptedReceipt.phase, 'schema-ready', 'the receipt must still precede data-step completion at this gap');
  assert.equal(interruptedReceipt.lifecycle.some(({ event }) => event === 'data-step-committed'), false);
  await runner.prepareMigration({ ...prepareArgs(f), lifecycleAdapter: adapter });
  assert.equal(dataStepRuns, 1, 'retry must skip the step already committed in the candidate ledger');
});

test('activation switches to a paired code+DB cohort and rollback restores the verified prior pair', async (t) => {
  const f = await makePrepared(t);
  const sandboxRoot = f.root;
  writeFileSync(join(sandboxRoot, '.ikpk-rehearsal-target'), 'fixture\n');
  const releases = join(sandboxRoot, 'releases');
  const cohorts = join(sandboxRoot, 'cohorts');
  const oldCode = join(releases, 'old-code');
  const newCode = f.artifactDir;
  const oldDb = join(sandboxRoot, 'old.db');
  const activePairPath = join(sandboxRoot, 'active');
  mkdirSync(oldCode, { recursive: true }); mkdirSync(cohorts, { recursive: true, mode: 0o700 }); chmodSync(cohorts, 0o700);
  cpSync(newCode, oldCode, { recursive: true });
  seedDb(oldDb, { value: 'old' });
  const priorCohort = join(cohorts, 'prior'); mkdirSync(priorCohort);
  symlinkSync(oldCode, join(priorCohort, 'code'));
  symlinkSync(oldDb, join(priorCohort, 'data.db'));
  writeFileSync(join(priorCohort, 'cohort.json'), JSON.stringify({ schemaVersion: 1, planSha256: hash(readFileSync(join(oldCode, 'database/migrations/plan.json'))), artifactSha256: artifactDigest(oldCode), artifactIdentityKind: 'content-tree-sha256', databaseSha256: databaseDigest(oldDb), codeRelease: realpathSync(oldCode), databasePath: realpathSync(oldDb), staticRelease: 'old-static', configRef: 'old-config', mediaRef: 'old-media' }));
  symlinkSync(priorCohort, activePairPath);
  await f.runner.activateMigration({ candidateDbPath: f.candidateDbPath, codeRelease: newCode, activePairPath, sandboxRoot, receiptPath: f.receiptPath, operationId: f.operationId, lifecycleAdapter: f.lifecycleAdapter });
  const activated = realpathSync(activePairPath);
  assert.equal(realpathSync(join(activated, 'code')), realpathSync(newCode));
  assert.equal(realpathSync(join(activated, 'data.db')), realpathSync(f.candidateDbPath));
  const activeDbDigest = databaseDigest(f.candidateDbPath);
  const activatedReceipt = readFileSync(f.receiptPath);
  const selectedPairBeforeReactivation = realpathSync(activePairPath);
  await assert.rejects(() => f.runner.activateMigration({ candidateDbPath: f.candidateDbPath, codeRelease: newCode, activePairPath, sandboxRoot, receiptPath: f.receiptPath, operationId: f.operationId, lifecycleAdapter: f.lifecycleAdapter }), /not ready|phase activated|operation cohort directory/i);
  assert.deepEqual(readFileSync(f.receiptPath), activatedReceipt, 'repeated activation must preserve the rollback-ready receipt');
  assert.equal(databaseDigest(f.candidateDbPath), activeDbDigest, 'repeated activation must not mutate the candidate database');
  assert.equal(realpathSync(activePairPath), selectedPairBeforeReactivation, 'repeated activation must not change the selected pair');
  for (const phase of ['activation-intent', 'activated']) {
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
    receipt.phase = phase;
    receipt.activation.phase = phase === 'activation-intent' ? 'activation-intent' : 'pair-selected-editors-closed';
    writeFileSync(f.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const receiptBefore = readFileSync(f.receiptPath);
    const selectedPairBefore = realpathSync(activePairPath);
    await assert.rejects(() => f.runner.prepareMigration(prepareArgs(f)), /activation|not resumable|phase|rollback/i);
    assert.deepEqual(readFileSync(f.receiptPath), receiptBefore, `prepare must not mutate a ${phase} receipt`);
    assert.equal(databaseDigest(f.candidateDbPath), activeDbDigest, `prepare must not mutate candidate DB in ${phase}`);
    assert.equal(realpathSync(activePairPath), selectedPairBefore, `prepare must not move the selected pair in ${phase}`);
  }
  await f.runner.rollbackMigration({ operationId: f.operationId, receiptPath: f.receiptPath, activePairPath, sandboxRoot });
  const restored = realpathSync(activePairPath);
  assert.equal(realpathSync(join(restored, 'code')), realpathSync(oldCode));
  assert.equal(realpathSync(join(restored, 'data.db')), realpathSync(oldDb));
  const rolledBackReceipt = readFileSync(f.receiptPath);
  const restoredDbDigest = databaseDigest(f.candidateDbPath);
  await assert.rejects(() => f.runner.prepareMigration(prepareArgs(f)), /rollback|not resumable|phase/i);
  assert.deepEqual(readFileSync(f.receiptPath), rolledBackReceipt, 'prepare must preserve a rolled-back receipt');
  assert.equal(databaseDigest(f.candidateDbPath), restoredDbDigest, 'prepare must not mutate candidate DB after rollback');
  assert.equal(realpathSync(activePairPath), realpathSync(priorCohort), 'prepare must preserve the restored prior pair');
});

test('rollback refuses after candidate database changes even if the writer has closed', async (t) => {
  const f = await makePrepared(t);
  const sandboxRoot = f.root; writeFileSync(join(sandboxRoot, '.ikpk-rehearsal-target'), 'fixture\n');
  const releases = join(sandboxRoot, 'releases'); const cohorts = join(sandboxRoot, 'cohorts');
  const oldCode = join(releases, 'old'); const newCode = f.artifactDir; const oldDb = join(sandboxRoot, 'old.db');
  const activePairPath = join(sandboxRoot, 'active');
  mkdirSync(oldCode, { recursive: true }); mkdirSync(cohorts, { recursive: true, mode: 0o700 }); chmodSync(cohorts, 0o700); seedDb(oldDb);
  const prior = join(cohorts, 'prior'); mkdirSync(prior); symlinkSync(oldCode, join(prior, 'code')); symlinkSync(oldDb, join(prior, 'data.db'));
  cpSync(newCode, oldCode, { recursive: true });
  writeFileSync(join(prior, 'cohort.json'), JSON.stringify({ schemaVersion: 1, planSha256: hash(readFileSync(join(oldCode, 'database/migrations/plan.json'))), artifactSha256: artifactDigest(oldCode), artifactIdentityKind: 'content-tree-sha256', databaseSha256: databaseDigest(oldDb), codeRelease: realpathSync(oldCode), databasePath: realpathSync(oldDb), staticRelease: 'old-static', configRef: 'old-config', mediaRef: 'old-media' })); symlinkSync(prior, activePairPath);
  await f.runner.activateMigration({ candidateDbPath: f.candidateDbPath, codeRelease: newCode, activePairPath, sandboxRoot, receiptPath: f.receiptPath, operationId: f.operationId, lifecycleAdapter: f.lifecycleAdapter });
  const db = new Database(f.candidateDbPath); db.prepare('UPDATE source_items SET value = ? WHERE id = 1').run('editor-write'); db.close();
  assert.throws(() => f.runner.rollbackMigration({ operationId: f.operationId, receiptPath: f.receiptPath, activePairPath, sandboxRoot }), /changed|fingerprint|rollback|restore|refus|cohort|identity|измен/i);
  assert.equal(realpathSync(join(realpathSync(activePairPath), 'code')), realpathSync(newCode), 'refused rollback must keep the active code+DB pair intact');
});
