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

function fixture(t, { operationId = 'op-fixture-1', payload = 'effect-v1', activationReady = false } = {}) {
  const root = sandbox(t);
  const sourceDbPath = join(root, 'source.db');
  const candidateDbPath = join(root, 'private', 'candidate.db');
  const sourceCmsRoot = join(root, 'source-cms');
  const artifactDir = join(root, 'artifact');
  const stepsDir = join(artifactDir, 'database', 'migrations', 'steps');
  const artifactScripts = join(artifactDir, 'scripts');
  const receiptPath = join(root, 'receipt.json');
  mkdirSync(dirname(candidateDbPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(candidateDbPath), 0o700);
  mkdirSync(sourceCmsRoot, { recursive: true });
  mkdirSync(stepsDir, { recursive: true });
  mkdirSync(artifactScripts, { recursive: true });
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
  const sourceMigrations = join(repoRoot, 'cms/database/migrations');
  cpSync(sourceMigrations, join(artifactDir, 'database/migrations'), { recursive: true });
  mkdirSync(join(artifactDir, 'scripts'), { recursive: true });
  mkdirSync(join(artifactDir, 'database/migrations/data-steps'), { recursive: true });
  for (const name of ['run-data-migrations.mjs', 'audit-data-migration.mjs', 'institute-method-author-classification.mjs', 'normalize-null-documents-state.mjs']) {
    const source = join(repoRoot, 'cms/scripts', name);
    const destination = join(artifactScripts, name);
    copyFileSync(source, destination);
  }
  for (const name of ['classification.mjs', 'normalize-documents-state.mjs']) copyFileSync(join(sourceMigrations, 'data-steps', name), join(artifactDir, 'database/migrations/data-steps', name));
  writeFileSync(join(artifactDir, 'package.json'), JSON.stringify({ dependencies: { '@strapi/strapi': '5.51.2' } }));
  const plan = JSON.parse(readFileSync(join(sourceMigrations, 'plan.json'), 'utf8'));
  plan.steps = plan.steps.filter(({ id }) => id !== 'normalize-null-documents-state-v1');
  plan.integrity.files = ['run-data-migrations.mjs', 'audit-data-migration.mjs', 'institute-method-author-classification.mjs', 'normalize-null-documents-state.mjs'].map((name) => ({ path: `scripts/${name}`, sha256: hash(readFileSync(join(artifactScripts, name))) }));
  const payloadPath = join(artifactDir, 'database/migrations/data-steps/classification.mjs');
  writeFileSync(join(artifactDir, 'database', 'migrations', 'plan.json'), JSON.stringify(plan, null, 2));
  const lifecycleAdapter = {
    async loadClosed({ candidateDbPath, onCheckpoint }) {
      const db = new Database(candidateDbPath);
      try {
        if (!db.prepare('PRAGMA table_info("seminars")').all().some(({ name }) => name === 'seminar_status')) db.exec('ALTER TABLE seminars RENAME COLUMN status TO seminar_status');
        if (!db.prepare('PRAGMA table_info("schedule_entries")').all().some(({ name }) => name === 'entry_status')) db.exec('ALTER TABLE schedule_entries RENAME COLUMN status TO entry_status');
        db.exec('CREATE TABLE IF NOT EXISTS strapi_migrations (name TEXT PRIMARY KEY, time INTEGER NOT NULL)');
        db.prepare('INSERT OR IGNORE INTO strapi_migrations(name,time) VALUES (?,?)').run('2026.09.21T00.00.00.rename-status-columns.js', Date.now());
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
test('default data-step loader imports the verified packaged helper path', async (t) => {
  const f = fixture(t);
  const helper = join(repoRoot, 'cms/database/migrations/data-steps/classification.mjs');
  const runner = await loadRunner();
  const { runDataStep: _fixtureStep, ...defaultAdapter } = f.lifecycleAdapter;
  await runner.prepareMigration({ ...prepareArgs(f), lifecycleAdapter: defaultAdapter });
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
      async loadClosed() { return {}; }, async destroy() {},
      async runDataStep({ candidateDbPath, recordCompletion, onCheckpoint }) {
        const db = new Database(candidateDbPath);
        const { applyClassification } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'cms/scripts/institute-method-author-classification.mjs')).href)});
        try { db.transaction(() => { const result = applyClassification(db); recordCompletion(db, result); })(); }
        finally { db.close(); }
        await onCheckpoint('data-step-committed');
        process.stdout.write('CHECKPOINT\\n');
        await new Promise(() => {});
      },
    };
    await runner.prepareMigration({ ...args, lifecycleAdapter: adapter });
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

test('activation switches to a paired code+DB cohort and rollback restores the verified prior pair', async (t) => {
  const f = await makePrepared(t, { activationReady: true });
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
  writeFileSync(join(priorCohort, 'cohort.json'), JSON.stringify({ schemaVersion: 1, planSha256: hash(readFileSync(join(oldCode, 'database/migrations/plan.json'))), artifactSha256: artifactDigest(oldCode), databaseSha256: databaseDigest(oldDb), codeRelease: realpathSync(oldCode), databasePath: realpathSync(oldDb), staticRelease: 'old-static', configRef: 'old-config', mediaRef: 'old-media' }));
  symlinkSync(priorCohort, activePairPath);
  await f.runner.activateMigration({ candidateDbPath: f.candidateDbPath, codeRelease: newCode, activePairPath, sandboxRoot, receiptPath: f.receiptPath, operationId: f.operationId, lifecycleAdapter: f.lifecycleAdapter });
  const activated = realpathSync(activePairPath);
  assert.equal(realpathSync(join(activated, 'code')), realpathSync(newCode));
  assert.equal(realpathSync(join(activated, 'data.db')), realpathSync(f.candidateDbPath));
  await f.runner.rollbackMigration({ operationId: f.operationId, receiptPath: f.receiptPath, activePairPath, sandboxRoot });
  const restored = realpathSync(activePairPath);
  assert.equal(realpathSync(join(restored, 'code')), realpathSync(oldCode));
  assert.equal(realpathSync(join(restored, 'data.db')), realpathSync(oldDb));
});

test('rollback refuses after candidate database changes even if the writer has closed', async (t) => {
  const f = await makePrepared(t, { activationReady: true });
  const sandboxRoot = f.root; writeFileSync(join(sandboxRoot, '.ikpk-rehearsal-target'), 'fixture\n');
  const releases = join(sandboxRoot, 'releases'); const cohorts = join(sandboxRoot, 'cohorts');
  const oldCode = join(releases, 'old'); const newCode = f.artifactDir; const oldDb = join(sandboxRoot, 'old.db');
  const activePairPath = join(sandboxRoot, 'active');
  mkdirSync(oldCode, { recursive: true }); mkdirSync(cohorts, { recursive: true, mode: 0o700 }); chmodSync(cohorts, 0o700); seedDb(oldDb);
  const prior = join(cohorts, 'prior'); mkdirSync(prior); symlinkSync(oldCode, join(prior, 'code')); symlinkSync(oldDb, join(prior, 'data.db'));
  cpSync(newCode, oldCode, { recursive: true });
  writeFileSync(join(prior, 'cohort.json'), JSON.stringify({ schemaVersion: 1, planSha256: hash(readFileSync(join(oldCode, 'database/migrations/plan.json'))), artifactSha256: artifactDigest(oldCode), databaseSha256: databaseDigest(oldDb), codeRelease: realpathSync(oldCode), databasePath: realpathSync(oldDb), staticRelease: 'old-static', configRef: 'old-config', mediaRef: 'old-media' })); symlinkSync(prior, activePairPath);
  await f.runner.activateMigration({ candidateDbPath: f.candidateDbPath, codeRelease: newCode, activePairPath, sandboxRoot, receiptPath: f.receiptPath, operationId: f.operationId, lifecycleAdapter: f.lifecycleAdapter });
  const db = new Database(f.candidateDbPath); db.prepare('UPDATE source_items SET value = ? WHERE id = 1').run('editor-write'); db.close();
  await assert.rejects(() => f.runner.rollbackMigration({ operationId: f.operationId, receiptPath: f.receiptPath, activePairPath, sandboxRoot }), /changed|fingerprint|rollback|restore|refus|cohort|identity|измен/i);
  assert.equal(realpathSync(join(realpathSync(activePairPath), 'code')), realpathSync(newCode), 'refused rollback must keep the active code+DB pair intact');
});
