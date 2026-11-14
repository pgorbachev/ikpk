import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

function installFakeStrapi(f, { failOnLoad = false, noisy = false } = {}) {
  const dependencyRoot = addExternalDependencies(f);
  const packageDir = join(dependencyRoot, '@strapi/strapi');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@strapi/strapi', version: '5.51.2', main: 'index.js' }));
  writeFileSync(join(packageDir, 'index.js'), `
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const Database = require(${JSON.stringify(cmsRequire.resolve('better-sqlite3'))});
${noisy ? `const logger = require(${JSON.stringify(cmsRequire.resolve('@strapi/logger'))}).createLogger({ level: 'http' });
const Strapi = require(${JSON.stringify(join(dirname(cmsRequire.resolve('@strapi/core')), 'Strapi.js'))});` : ''}
exports.createStrapi = ({ appDir }) => {
 assert.equal(process.env.IKPK_MIGRATION_CLOSED_LOAD, 'true', 'migration flag must be set before Strapi construction');
 return {
  config: { get(name) { return name === 'database.connection' ? { client: process.env.DATABASE_CLIENT, connection: { filename: process.env.DATABASE_FILENAME } } : undefined; } },
  async load() {
    ${noisy ? "process.stdout.write('Strapi load diagnostic\\n');" : ''}
    assert.equal(process.cwd(), appDir);
    assert.equal(process.env.TZ, 'UTC', 'closed Strapi must use UTC for date-sensitive bootstrap work');
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
    ${noisy ? "process.stdout.write('Strapi destroy diagnostic\\n');" : ''}
    ${noisy ? `await Strapi.prototype.destroy.call({
      log: logger, runPluginsLifecycles: async () => {}, runUserLifecycles: async () => {},
      get: (name) => name === 'admin' ? null : { destroy() {} },
      ai: { mcp: { isRunning: () => false } },
      server: { async destroy() {} }, eventHub: { destroy() {} }, db: null,
    });` : ''}
    assert.equal(process.cwd(), appDir);
    assert.equal(process.env.TZ, 'UTC', 'destroy must remain inside the isolated UTC environment');
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
}; };
`);
}

test('CLI emits one JSON document while closed lifecycle diagnostics go to stderr', (t) => {
  const f = fixture(t, { operationId: 'op-cli-json' });
  installFakeStrapi(f, { noisy: true });
  // Resolve this isolated fake via NODE_PATH; a node_modules link in the
  // artifact would require a real host-issued root-sealed v3 attestation.
  unlinkSync(join(f.artifactDir, 'node_modules'));
  const snapshots = join(f.root, 'snapshots');
  mkdirSync(snapshots, { mode: 0o700 });
  const args = [runnerPath, 'prepare', '--operation-id', f.operationId,
    '--source-db', f.sourceDbPath, '--source-cms-root', f.sourceCmsRoot,
    '--candidate-db', f.candidateDbPath, '--artifact-dir', f.artifactDir,
    '--receipt', f.receiptPath, '--stage-snapshot-dir', snapshots, '--stop-after-stage', 'schema'];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NODE_PATH: join(f.root, 'immutable-deps', 'node_modules') } });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const result = JSON.parse(child.stdout);
  assert.equal(result.operationId, f.operationId);
  assert.equal(result.pausedAfterStage, 'schema');
  assert.match(child.stderr, /Strapi load diagnostic/);
  assert.match(child.stderr, /Strapi destroy diagnostic/);
  assert.match(child.stderr, /Shutting down Strapi/);
  assert.match(child.stderr, /Strapi has been shut down/);
});

test('CLI failure reports diagnostics only on stderr', () => {
  const child = spawnSync(process.execPath, [runnerPath, 'status'], { encoding: 'utf8', timeout: 120000 });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /candidateDbPath must be an absolute path/);
});

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
  const packagedScripts = ['run-data-migrations.mjs', 'seminar-migration-snapshot.mjs', 'audit-seminar-migration-composition.mjs', 'audit-migration-stage-ledger.mjs', 'audit-seminar-schema-sync.mjs', 'audit-schedule-business-rules.mjs', 'audit-schedule-migration.mjs', 'audit-documents-migration.mjs', 'audit-content-migration.mjs', 'verify-seminar-proof-artifact.py', 'audit-data-migration.mjs', 'audit-schema-snapshot.mjs', 'institute-method-author-classification.mjs', 'normalize-null-documents-state.mjs'];
  for (const name of packagedScripts) {
    const source = join(repoRoot, 'cms/scripts', name);
    const destination = join(artifactScripts, name);
    copyFileSync(source, destination);
  }
  for (const name of ['classification.mjs', 'normalize-documents-state.mjs']) copyFileSync(join(sourceMigrations, 'data-steps', name), join(artifactDir, 'database/migrations/data-steps', name));
  writeFileSync(join(artifactDir, 'package.json'), JSON.stringify({ dependencies: { '@strapi/strapi': '5.51.2' } }));
  const plan = JSON.parse(readFileSync(join(sourceMigrations, 'plan.json'), 'utf8'));
  plan.steps = plan.steps.filter(({ kind, handler }) => kind === 'strapi-native' || handler === 'classification');
  plan.integrity.files = packagedScripts.map((name) => ({ path: `scripts/${name}`, sha256: hash(readFileSync(join(artifactScripts, name))) }));
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

test('stage checkpoints persist schema and committed steps across a crash', async (t) => {
  const f=fixture(t,{operationId:'op-stage-snapshots'}),runner=await loadRunner();
  const dir=join(f.root,'stage-snapshots');mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
  const args={...prepareArgs(f),stageSnapshotDir:realpathSync(dir)};let injected=false;
  await assert.rejects(runner.prepareMigration({...args,onCheckpoint(name){if(name==='data-step-transaction-committed'&&!injected){injected=true;throw new Error('injected crash');}}}),/injected crash/);
  let receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));assert.equal(receipt.pendingSnapshotStep,'institute-method-author-classification-v1');assert.ok(receipt.stageSnapshots.schema);
  await runner.prepareMigration(args);receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));
  assert.equal(receipt.pendingSnapshotStep,null);assert.ok(receipt.stageSnapshots['institute-method-author-classification-v1']);
  for(const snapshot of Object.values(receipt.stageSnapshots)){assert.equal(lstatSync(snapshot.path).mode&0o777,0o400);assert.ok(snapshot.snapshotFingerprint);}
  await assert.rejects(runner.prepareMigration({...args,stageSnapshotDir:undefined}),/snapshot directory differs/);
});

test('stage checkpoint tampering refuses resume', async (t) => {
  const f=fixture(t,{operationId:'op-stage-tamper'}),runner=await loadRunner();
  const dir=join(f.root,'stage-snapshots');mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
  const args={...prepareArgs(f),stageSnapshotDir:realpathSync(dir)};await runner.prepareMigration(args);
  const receipt=JSON.parse(readFileSync(f.receiptPath,'utf8')),path=receipt.stageSnapshots.schema.path;
  chmodSync(path,0o600);writeFileSync(path,'tampered');
  await assert.rejects(runner.prepareMigration(args),/stage snapshot changed/);
});

test('operator may pause at schema or data snapshot then resume without repeating the step', async (t) => {
  const f=fixture(t,{operationId:'op-stage-pause'}),runner=await loadRunner();
  const dir=join(f.root,'stage-snapshots');mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
  const args={...prepareArgs(f),stageSnapshotDir:realpathSync(dir)};
  let result=await runner.prepareMigration({...args,stopAfterStage:'schema'});assert.equal(result.pausedAfterStage,'schema');
  let receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));assert.ok(receipt.stageSnapshots.schema);assert.equal(Object.keys(receipt.stageSnapshots).length,1);
  result=await runner.prepareMigration({...args,stopAfterStage:'institute-method-author-classification-v1'});assert.equal(result.pausedAfterStage,'institute-method-author-classification-v1');
  receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));assert.equal(receipt.pendingSnapshotStep,null);assert.ok(receipt.stageSnapshots['institute-method-author-classification-v1']);
  result=await runner.prepareMigration(args);assert.equal(result.phase,'prepared');
});

test('reviewed step waits for external hashes and durably binds them on resume', async (t) => {
  const f=fixture(t,{operationId:'op-reviewed-step'}),runner=await loadRunner();
  const dir=join(f.root,'stage-snapshots');mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
  const helper=join(f.artifactDir,'database/migrations/data-steps/test-reviewed-schedule.mjs');writeFileSync(helper,'export const apply = () => {};\n');
  const base=f.plan.steps.find(step=>step.kind==='data');f.plan.steps.push({...structuredClone(base),id:'test-reviewed-schedule',handler:'reviewed-schedule',path:'data-steps/test-reviewed-schedule.mjs',sha256:hash(readFileSync(helper))});
  writeFileSync(join(f.artifactDir,'database/migrations/plan.json'),JSON.stringify(f.plan));
  const args={...prepareArgs(f),stageSnapshotDir:realpathSync(dir),sourceCommitSha:'a'.repeat(40)};
  const first=await runner.prepareMigration(args);assert.equal(first.waitingForReview,'test-reviewed-schedule');
  let receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));assert.equal(receipt.reviewedSteps['test-reviewed-schedule'],undefined);assert.ok(receipt.stageSnapshots['institute-method-author-classification-v1']);
  const planDigest='b'.repeat(64),bytes=Buffer.from(JSON.stringify({plan:{planDigest},decisions:{}}));
  const reviewedStep={id:'test-reviewed-schedule',reviewFilePath:join(realpathSync(f.root),'review.json'),expectedReviewFileSha256:hash(bytes),expectedPlanDigest:planDigest};writeFileSync(reviewedStep.reviewFilePath,bytes,{mode:0o600});
  writeFileSync(reviewedStep.reviewFilePath,'changed');await assert.rejects(runner.prepareMigration({...args,reviewedStep}),/review file changed/);receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));assert.equal(receipt.reviewedSteps[reviewedStep.id],undefined);writeFileSync(reviewedStep.reviewFilePath,bytes);
  const original=f.lifecycleAdapter.runDataStep;f.lifecycleAdapter.runDataStep=async options=>{if(options.step.id===reviewedStep.id)assert.deepEqual(options.reviewedStepBinding,{reviewFilePath:reviewedStep.reviewFilePath,expectedReviewFileSha256:reviewedStep.expectedReviewFileSha256,expectedPlanDigest:reviewedStep.expectedPlanDigest});return original(options);};
  const second=await runner.prepareMigration({...args,reviewedStep,stopAfterStage:reviewedStep.id});assert.equal(second.pausedAfterStage,reviewedStep.id);
  receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));assert.equal(receipt.reviewedSteps[reviewedStep.id].expectedPlanDigest,reviewedStep.expectedPlanDigest);assert.ok(receipt.stageSnapshots[reviewedStep.id]);
  await assert.rejects(runner.prepareMigration({...args,sourceCommitSha:'c'.repeat(40)}),/source commit SHA differs/);
  await assert.rejects(runner.prepareMigration({...args,reviewedStep:{...reviewedStep,expectedPlanDigest:'c'.repeat(64)}}),/binding differs/);
  writeFileSync(reviewedStep.reviewFilePath,'changed again');await assert.rejects(runner.prepareMigration(args),/review file changed/);
});

test('real reviewed schedule and documents steps execute and snapshot in the runner', async (t) => {
  const f=fixture(t,{operationId:'op-real-reviewed-schedule'}),runner=await loadRunner();
  const source=new Database(f.sourceDbPath);source.exec(`
    ALTER TABLE seminars ADD COLUMN document_id TEXT;ALTER TABLE seminars ADD COLUMN published_at TEXT;ALTER TABLE seminars ADD COLUMN duration TEXT;
    UPDATE seminars SET document_id='s';INSERT INTO seminars(id,status,document_id,published_at) VALUES(2,'active','s','2026-01-01');
    ALTER TABLE schedule_entries ADD COLUMN document_id TEXT;ALTER TABLE schedule_entries ADD COLUMN published_at TEXT;ALTER TABLE schedule_entries ADD COLUMN legacy_id TEXT;ALTER TABLE schedule_entries ADD COLUMN is_free INTEGER;ALTER TABLE schedule_entries ADD COLUMN price REAL;ALTER TABLE schedule_entries ADD COLUMN city TEXT;ALTER TABLE schedule_entries ADD COLUMN is_online INTEGER;ALTER TABLE schedule_entries ADD COLUMN duration TEXT;
    UPDATE schedule_entries SET document_id='e',is_free=0,price=100,city='Москва',duration='24';
    INSERT INTO schedule_entries(id,status,document_id,published_at,is_free,price,city,duration) VALUES(2,'active','e','2026-01-01',0,100,'Москва','24');
    CREATE TABLE schedule_entries_seminar_lnk(seminar_id INTEGER,schedule_entry_id INTEGER);INSERT INTO schedule_entries_seminar_lnk VALUES(1,1),(2,2);CREATE TABLE files_related_mph(id INTEGER PRIMARY KEY);
    ALTER TABLE seminars ADD COLUMN slug TEXT;ALTER TABLE seminars ADD COLUMN legacy_id TEXT;ALTER TABLE seminars ADD COLUMN documents_state TEXT;ALTER TABLE seminars ADD COLUMN documents_confirmation_date TEXT;ALTER TABLE seminars ADD COLUMN documents_confirmation_source TEXT;ALTER TABLE seminars ADD COLUMN documents_confirmation_author TEXT;ALTER TABLE seminars ADD COLUMN documents_owner_verified BOOLEAN;
    UPDATE seminars SET slug='example',legacy_id='/institut-klinicheskoy-prikladnoy-kineziologii/group/example',documents_state='unconfirmed';
    CREATE TABLE course_groups(id INTEGER PRIMARY KEY,slug TEXT);INSERT INTO course_groups VALUES(1,'group');CREATE TABLE seminars_course_group_lnk(id INTEGER PRIMARY KEY,seminar_id INTEGER,course_group_id INTEGER);INSERT INTO seminars_course_group_lnk VALUES(1,1,1),(2,2,1);CREATE TABLE course_groups_institute_lnk(id INTEGER PRIMARY KEY,course_group_id INTEGER,institute_id INTEGER);INSERT INTO course_groups_institute_lnk VALUES(1,1,1);
    CREATE TABLE seminars_cmps(id INTEGER PRIMARY KEY,entity_id INTEGER,cmp_id INTEGER,component_type TEXT,field TEXT,"order" REAL);
    CREATE TABLE components_seminar_document_records(id INTEGER PRIMARY KEY,document TEXT,issuer TEXT,issuer_unknown BOOLEAN,prior_education TEXT,prior_education_note TEXT,outcome TEXT,basis TEXT,completion_scope TEXT,other_seminar_href TEXT,other_seminar_label TEXT,signed_by TEXT,qualification_topic TEXT,hours_mode TEXT,includes_completed_level BOOLEAN,completion_required BOOLEAN,completion_after_seminar_number INTEGER,completion_cycle_name TEXT,hours_may_vary BOOLEAN,regulation_url TEXT,document_type_unspecified BOOLEAN,regulation_issuer TEXT,document_on_template BOOLEAN);
    CREATE TABLE components_seminar_document_records_cmps(id INTEGER PRIMARY KEY,entity_id INTEGER,cmp_id INTEGER,component_type TEXT,field TEXT,"order" REAL);CREATE TABLE components_seminar_registry_facts(id INTEGER PRIMARY KEY,name TEXT,international BOOLEAN,subject TEXT,url TEXT,basis TEXT);CREATE TABLE components_seminar_nmo_facts(id INTEGER PRIMARY KEY,status TEXT,audience TEXT,awarded_for TEXT,url TEXT,completion_required BOOLEAN,purpose TEXT);
  `);source.close();
  const dir=join(f.root,'stage-snapshots');mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
  const names=['migrate-schedule-data.mjs','documents-migration-writer.mjs'];for(const name of names){const src=join(repoRoot,'cms/scripts',name),dst=join(f.artifactDir,'scripts',name);copyFileSync(src,dst);f.plan.integrity.files.push({path:`scripts/${name}`,sha256:hash(readFileSync(dst))});}
  const helper=join(f.artifactDir,'database/migrations/data-steps/reviewed-schedule.mjs');copyFileSync(join(repoRoot,'cms/database/migrations/data-steps/reviewed-schedule.mjs'),helper);
  const base=f.plan.steps.find(step=>step.kind==='data');f.plan.steps.push({...structuredClone(base),id:'reviewed-schedule-real',handler:'reviewed-schedule',path:'data-steps/reviewed-schedule.mjs',sha256:hash(readFileSync(helper))});
  const docHelper=join(f.artifactDir,'database/migrations/data-steps/reviewed-documents.mjs');copyFileSync(join(repoRoot,'cms/database/migrations/data-steps/reviewed-documents.mjs'),docHelper);f.plan.steps.push({...structuredClone(base),id:'reviewed-documents-real',handler:'reviewed-documents',path:'data-steps/reviewed-documents.mjs',sha256:hash(readFileSync(docHelper))});
  writeFileSync(join(f.artifactDir,'database/migrations/plan.json'),JSON.stringify(f.plan));delete f.lifecycleAdapter.runDataStep;
  const args={...prepareArgs(f),stageSnapshotDir:realpathSync(dir),sourceCommitSha:'a'.repeat(40)};const initial=await runner.prepareMigration(args);assert.equal(initial.waitingForReview,'reviewed-schedule-real');
  const {planScheduleDataMigration}=await import('../scripts/migrate-schedule-data.mjs');const db=new Database(f.candidateDbPath,{readonly:true});const decisions={paid:[],free:[],online:[],acceptedExceptions:[]},plan=planScheduleDataMigration(db,{decisions});db.close();
  const reviewed=Buffer.from(JSON.stringify({decisions,plan})),reviewFilePath=join(realpathSync(f.root),'schedule-review.json');writeFileSync(reviewFilePath,reviewed,{mode:0o600});
  const reviewedStep={id:'reviewed-schedule-real',reviewFilePath,expectedReviewFileSha256:hash(reviewed),expectedPlanDigest:plan.planDigest};
  const result=await runner.prepareMigration({...args,reviewedStep,stopAfterStage:reviewedStep.id});assert.equal(result.pausedAfterStage,reviewedStep.id);
  const candidate=new Database(f.candidateDbPath,{readonly:true});try{assert.deepEqual(candidate.prepare('SELECT duration FROM seminars ORDER BY id').all().map(x=>x.duration),['24 часа','24 часа']);assert.deepEqual(candidate.prepare('SELECT duration FROM schedule_entries ORDER BY id').all().map(x=>x.duration),[null,null]);assert.equal(candidate.prepare('SELECT count(*) n FROM ikpk_data_migration_history WHERE step_id=?').get(reviewedStep.id).n,1);}finally{candidate.close();}
  const waiting=await runner.prepareMigration(args);assert.equal(waiting.waitingForReview,'reviewed-documents-real');
  const {inspectVersions,capturePlan}=await import('../scripts/documents-migration-writer.mjs');const read=new Database(f.candidateDbPath,{readonly:true});const html='<p>certificate</p>';const item={documentId:'s',route:'/institut-klinicheskoy-prikladnoy-kineziologii/group/example',sourceHtml:html,sourceSha256:hash(html),snapshotSha256:'a'.repeat(64),sourceLinks:[],rulesVersion:'v1',approved:true,eligibleForAutomaticWrite:true,readyForReviewOnly:false,migrationDate:'2026-11-14',migrationAuthor:'editor',proposal:{documents_state:'issued',documents:[{document:'Certificate'}],training_registries:[],nmo:null}};item.reviewedPreimages=inspectVersions(read,'s');const documentPlan=capturePlan(read,[item]);read.close();
  const documentBytes=Buffer.from(JSON.stringify(documentPlan)),documentFile=join(realpathSync(f.root),'documents-review.json');writeFileSync(documentFile,documentBytes,{mode:0o600});
  const documentBinding={id:'reviewed-documents-real',reviewFilePath:documentFile,expectedReviewFileSha256:hash(documentBytes),expectedPlanDigest:documentPlan.digest};
  const done=await runner.prepareMigration({...args,reviewedStep:documentBinding,stopAfterStage:documentBinding.id});assert.equal(done.pausedAfterStage,documentBinding.id);
  const afterDocs=new Database(f.candidateDbPath,{readonly:true});try{assert.deepEqual(afterDocs.prepare('SELECT documents_state FROM seminars ORDER BY id').all().map(x=>x.documents_state),['issued','issued']);assert.equal(afterDocs.prepare('SELECT count(*) n FROM ikpk_data_migration_history WHERE step_id=?').get(documentBinding.id).n,1);}finally{afterDocs.close();}
});

for (const injectFailure of [false,true]) test(`permission step shares its ledger transaction${injectFailure ? ' and quarantines interrupted load' : ''}`, async (t) => {
  const f=fixture(t,{operationId:injectFailure?'op-permission-fail':'op-permission-ok'}),runner=await loadRunner();
  const source=new Database(f.sourceDbPath);source.exec("CREATE TABLE permission_probe(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO permission_probe VALUES(1,'before')");source.close();
  const dir=join(f.root,'stage-snapshots');mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
  const helper=join(f.artifactDir,'database/migrations/data-steps/test-permissions.mjs');writeFileSync(helper,'export async function apply(strapi, options) { return strapi.run(options.onApplied); }\n');
  const base=f.plan.steps.find(step=>step.kind==='data');f.plan.steps.push({...structuredClone(base),id:'test-content-admin-permissions',handler:'content-admin-permissions',path:'data-steps/test-permissions.mjs',sha256:hash(readFileSync(helper))});writeFileSync(join(f.artifactDir,'database/migrations/plan.json'),JSON.stringify(f.plan));
  const original=f.lifecycleAdapter.loadClosed;f.lifecycleAdapter.loadClosed=async options=>{
    const instance=await original(options);instance.strapi={run:async callback=>{const db=new Database(options.candidateDbPath);db.exec('BEGIN IMMEDIATE');try{
      db.prepare("UPDATE permission_probe SET value='after' WHERE id=1").run();
      const trx=table=>({where:criteria=>({first:async()=>db.prepare(`SELECT * FROM ${table} WHERE lineage_id=? AND step_id=?`).get(criteria.lineage_id,criteria.step_id)}),insert:async row=>{if(injectFailure)throw Error('ledger failure');db.prepare(`INSERT INTO ${table}(lineage_id,operation_id,step_id,payload_sha256,result_json,completed_at) VALUES(?,?,?,?,?,?)`).run(row.lineage_id,row.operation_id,row.step_id,row.payload_sha256,row.result_json,row.completed_at)}});
      await callback(trx,{updatedRows:1});db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error}finally{db.close()}}};return instance;
  };
  const args={...prepareArgs(f),stageSnapshotDir:realpathSync(dir),stopAfterStage:'test-content-admin-permissions'};
  if(injectFailure)await assert.rejects(runner.prepareMigration(args),/ledger failure/);else assert.equal((await runner.prepareMigration(args)).pausedAfterStage,'test-content-admin-permissions');
  const result=new Database(f.candidateDbPath,{readonly:true});try{assert.equal(result.prepare('SELECT value FROM permission_probe').get().value,injectFailure?'before':'after');assert.equal(result.prepare('SELECT count(*) n FROM ikpk_data_migration_history WHERE step_id=?').get('test-content-admin-permissions').n,injectFailure?0:1);}finally{result.close();}
  const receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));if(injectFailure){assert.equal(receipt.phase,'permission-load-in-progress');await assert.rejects(runner.prepareMigration(args),/unknown|discard|interrupted/);}else assert.ok(receipt.stageSnapshots['test-content-admin-permissions']);
});

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
  const runtimeKeys = [...secretKeys, 'HOST', 'PORT', 'STRAPI_TELEMETRY_DISABLED', 'IKPK_MIGRATION_CLOSED_LOAD', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP', 'CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN'];
  const previousEnvironment = Object.fromEntries(['DATABASE_CLIENT', 'DATABASE_URL', 'DATABASE_FILENAME', 'TZ', ...runtimeKeys].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_CLIENT: 'mysql', DATABASE_URL: 'restore-me', DATABASE_FILENAME: 'restore.db', ...Object.fromEntries(runtimeKeys.map((key) => [key, 'inherited-value-that-must-not-be-used'])) });
  process.env.TZ = 'Pacific/Honolulu';
  try {
    copyFileSync(f.sourceDbPath, f.candidateDbPath);
    const lifecycle = (await loadRunner()).productionLifecycle(realpathSync(f.artifactDir), Object.fromEntries(secretKeys.map(key => [key, 'isolated-fixture-secret-value-32chars'])));
    await lifecycle.destroy(await lifecycle.loadClosed({candidateDbPath:realpathSync(f.candidateDbPath)}));
    assert.equal(process.cwd(), previousCwd);
    assert.equal(process.env.DATABASE_CLIENT, 'mysql');
    assert.equal(process.env.DATABASE_URL, 'restore-me');
    assert.equal(process.env.DATABASE_FILENAME, 'restore.db');
    assert.equal(process.env.TZ, 'Pacific/Honolulu', 'ambient timezone must be restored after successful closed load');
    for (const key of runtimeKeys) assert.equal(process.env[key], 'inherited-value-that-must-not-be-used');
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
  const runtimeKeys = [...secretKeys, 'HOST', 'PORT', 'STRAPI_TELEMETRY_DISABLED', 'IKPK_MIGRATION_CLOSED_LOAD', 'IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP', 'CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD', 'CMS_TOKEN'];
  const previousEnvironment = Object.fromEntries(['DATABASE_CLIENT', 'DATABASE_URL', 'DATABASE_FILENAME', 'TZ', ...runtimeKeys].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_CLIENT: 'mysql', DATABASE_URL: 'restore-me', DATABASE_FILENAME: 'restore.db', ...Object.fromEntries(runtimeKeys.map((key) => [key, 'inherited-value-that-must-not-be-used'])) });
  process.env.TZ = 'Pacific/Honolulu';
  try {
    const runner = await loadRunner();
    copyFileSync(f.sourceDbPath, f.candidateDbPath);
    const lifecycle = runner.productionLifecycle(realpathSync(f.artifactDir), Object.fromEntries(secretKeys.map(key => [key, 'isolated-fixture-secret-value-32chars'])));
    await assert.rejects(() => lifecycle.loadClosed({candidateDbPath:realpathSync(f.candidateDbPath)}), /simulated closed-load failure/);
    assert.equal(process.cwd(), previousCwd);
    assert.equal(process.env.DATABASE_CLIENT, 'mysql');
    assert.equal(process.env.DATABASE_URL, 'restore-me');
    assert.equal(process.env.DATABASE_FILENAME, 'restore.db');
    assert.equal(process.env.TZ, 'Pacific/Honolulu', 'ambient timezone must be restored after failed closed load');
    for (const key of runtimeKeys) assert.equal(process.env[key], 'inherited-value-that-must-not-be-used');
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('v3 runner refuses unsealed dependencies instead of downgrading to full hashing', async (t) => {
  const f = fixture(t);
  addExternalDependencies(f);
  const runner = await loadRunner();
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /v3.*attestation|root-sealed.*required/i);
  assert.equal(existsSync(f.candidateDbPath), false);
});

test('v3 runner refuses an old receipt instead of falling back to vendor hashing', async (t) => {
  const f = fixture(t);
  addExternalDependencies(f);
  writeFileSync(join(f.artifactDir, '.install-provenance.json'), JSON.stringify({schemaVersion:1}), {mode:0o600});
  const runner = await loadRunner();
  await assert.rejects(() => runner.prepareMigration(prepareArgs(f)), /v3.*attestation|root-sealed.*required/i);
  assert.equal(existsSync(f.candidateDbPath), false);
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

test('rejected unchanged reviewed transaction permits a corrected review while committed approval stays immutable', async t => {
  const f=fixture(t,{operationId:'correct-review'}), runner=await loadRunner();
  const dir=join(f.root,'snapshots');mkdirSync(dir,{mode:0o700});
  const helper=join(f.artifactDir,'database/migrations/data-steps/retry-review.mjs');writeFileSync(helper,'export const apply=()=>{};');
  const base=f.plan.steps.find(step=>step.kind==='data'), step={...base,id:'retry-review',handler:'reviewed-schedule',path:'data-steps/retry-review.mjs',sha256:hash(readFileSync(helper))};f.plan.steps.push(step);writeFileSync(join(f.artifactDir,'database/migrations/plan.json'),JSON.stringify(f.plan));
  const args={...prepareArgs(f),stageSnapshotDir:realpathSync(dir),sourceCommitSha:'a'.repeat(40)};
  await runner.prepareMigration(args);
  const review=n=>{const bytes=JSON.stringify({plan:{planDigest:n.repeat(64)}}),reviewFilePath=join(realpathSync(f.root),`review-${n}.json`);writeFileSync(reviewFilePath,bytes,{mode:0o600});return {id:step.id,reviewFilePath,expectedReviewFileSha256:hash(bytes),expectedPlanDigest:n.repeat(64)};};
  const bad=review('b'), good=review('c'), original=f.lifecycleAdapter.runDataStep;
  f.lifecycleAdapter.runDataStep=async options=>{if(options.step.id===step.id&&options.reviewedStepBinding.expectedPlanDigest===bad.expectedPlanDigest)throw Error('semantic review rejected');return original(options);};
  await assert.rejects(runner.prepareMigration({...args,reviewedStep:bad}),/semantic review rejected/);
  assert.equal(JSON.parse(readFileSync(f.receiptPath)).reviewedSteps[step.id],undefined);
  const result=await runner.prepareMigration({...args,reviewedStep:good,stopAfterStage:step.id});assert.equal(result.pausedAfterStage,step.id);
  await assert.rejects(runner.prepareMigration({...args,reviewedStep:bad}),/binding differs/);
});

async function inheritedFixture(t) {
  const first=await makePrepared(t,{operationId:'sealed-original'}),next=fixture(t,{operationId:'next-release'});
  const db=new Database(first.candidateDbPath),sealedLineage=db.prepare('SELECT * FROM ikpk_migration_lineage').get(),lineageId=sealedLineage.lineage_id;
  const base=next.plan.steps.find(step=>step.kind==='data');
  for(const handler of ['content-admin-permissions','reviewed-schedule','reviewed-documents','reviewed-content']) {
    const id=`sealed-${handler}`, path=`data-steps/${id}.mjs`, bytes='export const apply=()=>{throw Error("must never replay")};';writeFileSync(join(next.artifactDir,'database/migrations',path),bytes);
    const step={...structuredClone(base),id,handler,path,sha256:hash(bytes)};next.plan.steps.push(step);
    db.prepare('INSERT INTO ikpk_data_migration_history VALUES(?,?,?,?,?,?)').run(lineageId,first.operationId,id,step.sha256,'{"approved":true}','2026-11-14');
  }
  const ids=new Set(next.plan.steps.filter(x=>x.id.startsWith('sealed-')).map(x=>x.id));
  const history=db.prepare('SELECT operation_id,step_id,payload_sha256,result_json,completed_at FROM ikpk_data_migration_history WHERE lineage_id=? ORDER BY completed_at,step_id').all(lineageId).filter(x=>ids.has(x.step_id));
  // A legitimate editor change after the sealed migration must survive the next deployment.
  db.prepare('UPDATE teachers SET bio=? WHERE id=1').run('editor update after migration');db.close();
  writeFileSync(join(next.artifactDir,'database/migrations/plan.json'),JSON.stringify(next.plan));
  const registryPath=join(realpathSync(first.root),'registry.json');writeFileSync(registryPath,'[]');
  const old={...JSON.parse(readFileSync(first.receiptPath)),sourceCommitSha:'a'.repeat(40),steps:next.plan.steps,seminarLineageId:lineageId,seminarLineage:sealedLineage,seminarStepHistory:history,registryBinding:{registrySha256:hash('[]')}};
  writeFileSync(first.receiptPath,JSON.stringify(old));
  const manifest={version:2,operationId:first.operationId,sourceCommit:old.sourceCommitSha,receiptSha256:hash(readFileSync(first.receiptPath)),database:{path:realpathSync(first.candidateDbPath)},cmsArtifactSha256:old.artifactSha256,migrationPlanDigest:old.planSha256,registrySha256:hash('[]')};
  const manifestPath=join(realpathSync(first.root),'current.json');writeFileSync(manifestPath,JSON.stringify(manifest));
  const inheritedCohort={manifestPath,expectedManifestSha256:hash(readFileSync(manifestPath)),receiptPath:realpathSync(first.receiptPath),expectedReceiptSha256:manifest.receiptSha256,registryPath};
  const snapshots=join(next.root,'snapshots');mkdirSync(snapshots,{mode:0o700});
  next.lifecycleAdapter.runDataStep=async()=>{throw Error('no data step may replay');};
  const args={...prepareArgs(next),sourceDbPath:realpathSync(first.candidateDbPath),stageSnapshotDir:realpathSync(snapshots),sourceCommitSha:'b'.repeat(40),proofArtifactSha256:'c'.repeat(64),inheritedCohort};
  return {first,next,args,history,runner:first.runner};
}
test('next paired deployment inherits sealed seminar ledger and registry without review or replay',async t=>{
 const f=await inheritedFixture(t),result=await f.runner.prepareMigration(f.args);assert.equal(result.phase,'prepared');assert.equal(result.waitingForReview,undefined);
 const receipt=JSON.parse(readFileSync(f.next.receiptPath));assert.deepEqual(receipt.seminarStepHistory,f.history);assert.equal(receipt.compositionAudit.mode,'inherited-cohort');assert.equal(result.inheritedCohortResult.receiptSha256,hash(readFileSync(f.next.receiptPath)));
 const db=new Database(f.next.candidateDbPath,{readonly:true});assert.equal(db.prepare('SELECT bio FROM teachers WHERE id=1').get().bio,'editor update after migration');db.close();
 assert.equal((await f.runner.prepareMigration(f.args)).phase,'prepared');
});
for(const mutation of ['receipt','ledger','step','lineage'])test(`inherited cohort rejects changed ${mutation} before candidate creation`,async t=>{
 const f=await inheritedFixture(t);
 if(mutation==='receipt')writeFileSync(f.first.receiptPath,'{}');
 if(mutation==='ledger'||mutation==='lineage'){const db=new Database(f.args.sourceDbPath);db.pragma('foreign_keys=OFF');db.exec(mutation==='ledger'?"UPDATE ikpk_data_migration_history SET result_json='{}' WHERE step_id LIKE 'sealed-%'":"UPDATE ikpk_migration_lineage SET created_at='changed'");db.close();}
 if(mutation==='step'){const step=f.next.plan.steps.find(x=>x.id==='sealed-reviewed-content');writeFileSync(join(f.next.artifactDir,'database/migrations',step.path),'changed code');step.sha256=hash('changed code');writeFileSync(join(f.next.artifactDir,'database/migrations/plan.json'),JSON.stringify(f.next.plan));}
 await assert.rejects(f.runner.prepareMigration(f.args),/inherited|sealed|cohort/);assert.equal(existsSync(f.next.candidateDbPath),false);
});

test('failed reviewed step with unledgered data changes stays bound and cannot accept replacement', async t=>{
 const f=fixture(t,{operationId:'dirty-review-failure'}),runner=await loadRunner(),dir=join(f.root,'snapshots');mkdirSync(dir,{mode:0o700});
 const helper=join(f.artifactDir,'database/migrations/data-steps/dirty-review.mjs');writeFileSync(helper,'export const apply=()=>{};');
 const base=f.plan.steps.find(step=>step.kind==='data'),step={...base,id:'dirty-review',handler:'reviewed-schedule',path:'data-steps/dirty-review.mjs',sha256:hash(readFileSync(helper))};f.plan.steps.push(step);writeFileSync(join(f.artifactDir,'database/migrations/plan.json'),JSON.stringify(f.plan));
 const args={...prepareArgs(f),stageSnapshotDir:realpathSync(dir),sourceCommitSha:'a'.repeat(40)};await runner.prepareMigration(args);
 const reviewFilePath=join(realpathSync(f.root),'review.json'),raw=JSON.stringify({plan:{planDigest:'b'.repeat(64)}});writeFileSync(reviewFilePath,raw,{mode:0o600});
 const reviewedStep={id:step.id,reviewFilePath,expectedReviewFileSha256:hash(raw),expectedPlanDigest:'b'.repeat(64)};
 f.lifecycleAdapter.runDataStep=async({candidateDbPath})=>{const db=new Database(candidateDbPath);db.exec("UPDATE teachers SET bio='uncommitted-contract-violation' WHERE id=1");db.close();throw Error('non-atomic writer failure');};
 await assert.rejects(runner.prepareMigration({...args,reviewedStep}),/non-atomic writer failure/);
 assert.equal(JSON.parse(readFileSync(f.receiptPath)).reviewedSteps[step.id].expectedPlanDigest,reviewedStep.expectedPlanDigest);
 await assert.rejects(runner.prepareMigration({...args,reviewedStep:{...reviewedStep,expectedPlanDigest:'c'.repeat(64)}}),/binding differs/);
});

test('inherited preservation audit still rejects changed user data without ledger changes',async t=>{
 const f=await inheritedFixture(t),original=f.next.lifecycleAdapter.loadClosed;
 f.next.lifecycleAdapter.loadClosed=async options=>{const instance=await original(options),db=new Database(options.candidateDbPath);db.exec("UPDATE teachers SET bio='unauthorized candidate rewrite' WHERE id=1");db.close();return instance;};
 await assert.rejects(f.runner.prepareMigration(f.args),/preservation audit did not pass/);
});

test('direct sandbox activation refuses a registry-bound seminar cohort', async (t) => {
  const f = await makePrepared(t);
  writeFileSync(join(f.root, '.ikpk-rehearsal-target'), 'fixture\n');
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  receipt.registryBinding = { version: 1 };
  writeFileSync(f.receiptPath, JSON.stringify(receipt));
  await assert.rejects(() => f.runner.activateMigration({ candidateDbPath: f.candidateDbPath,
    codeRelease: f.artifactDir, activePairPath: join(f.root, 'active'), sandboxRoot: f.root,
    receiptPath: f.receiptPath, operationId: f.operationId, lifecycleAdapter: f.lifecycleAdapter }),
    /host.*capture|capture.*host/i);
});
