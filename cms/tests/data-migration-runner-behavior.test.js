import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runnerPath = join(repoRoot, 'cms/scripts/run-data-migrations.mjs');
const cmsRequire = createRequire(join(repoRoot, 'cms/package.json'));
const Database = cmsRequire('better-sqlite3');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function sandbox(t, label = 'ikpk-migration-runner-') {
  const root = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function seedDb(path, { value = 'original' } = {}) {
  const db = new Database(path);
  db.exec('CREATE TABLE source_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE effects (id INTEGER PRIMARY KEY, runs INTEGER NOT NULL); INSERT INTO source_items(value) VALUES ("' + value + '");');
  db.close();
}

function dbBytes(path) {
  return readFileSync(path);
}

function fixture(t, { operationId = 'op-fixture-1', payload = 'effect-v1' } = {}) {
  const root = sandbox(t);
  const sourceDbPath = join(root, 'source.db');
  const candidateDbPath = join(root, 'private', 'candidate.db');
  const sourceCmsRoot = join(root, 'source-cms');
  const artifactDir = join(root, 'artifact');
  const stepsDir = join(artifactDir, 'database', 'migrations', 'steps');
  const receiptPath = join(root, 'receipt.json');
  mkdirSync(dirname(candidateDbPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(candidateDbPath), 0o700);
  mkdirSync(sourceCmsRoot, { recursive: true });
  mkdirSync(stepsDir, { recursive: true });
  writeFileSync(join(sourceCmsRoot, 'package.json'), JSON.stringify({ dependencies: { '@strapi/strapi': '5.51.2' } }));
  seedDb(sourceDbPath);
  const payloadPath = join(stepsDir, 'fixture.mjs');
  writeFileSync(payloadPath, payload);
  const plan = {
    version: 1,
    source: { strapiVersion: '5.51.2', schema: { engine: 'sqlite', requiredTables: ['source_items'] } },
    steps: [{
      id: 'fixture-data-v1', phase: 'after-sync', kind: 'data', handler: 'classification', path: 'steps/fixture.mjs',
      sha256: hash(readFileSync(payloadPath)), source: { strapiVersion: '5.51.2', schema: { engine: 'sqlite', requiredTables: ['source_items'] } },
      preconditions: { item: 'one source row exists' }, postconditions: { effect: 'one application recorded' },
      readback: { kind: 'effects-row-count' },
    }],
  };
  writeFileSync(join(artifactDir, 'database', 'migrations', 'plan.json'), JSON.stringify(plan, null, 2));
  const lifecycleAdapter = {
    async loadClosed({ onCheckpoint }) {
      await onCheckpoint?.('after-native-migrations');
      await onCheckpoint?.('after-schema-sync');
      await onCheckpoint?.('after-bootstrap');
      return { closed: true };
    },
    async destroy(instance) { assert.equal(instance.closed, true); },
    async runDataStep({ candidateDbPath: dbPath, recordCompletion, onCheckpoint }) {
      const db = new Database(dbPath);
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO effects(id, runs) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET runs = runs + 1').run();
          recordCompletion(db, { rows: 1 });
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
  assert.equal(status.steps.find((step) => step.id === 'fixture-data-v1')?.status, 'completed');
  assert.equal(status.steps.find((step) => step.id === 'fixture-data-v1')?.payloadSha256, hash(readFileSync(f.payloadPath)));
  const before = new Database(f.candidateDbPath);
  const runs = before.prepare('SELECT runs FROM effects WHERE id = 1').get()?.runs;
  before.close();
  assert.equal(runs, 1, 'data effect should be applied exactly once for one completed ledger identity');
});
test('same migration ID with changed payload hash is refused without a second data effect', async (t) => {
  const f = await makePrepared(t);
  writeFileSync(f.payloadPath, 'changed-payload-v2');
  f.plan.steps[0].sha256 = hash(readFileSync(f.payloadPath));
  writeFileSync(join(f.artifactDir, 'database', 'migrations', 'plan.json'), JSON.stringify(f.plan, null, 2));
  await assert.rejects(() => f.runner.prepareMigration(prepareArgs(f)), /hash|payload|identity|already|измен|хеш/i);
  const db = new Database(f.candidateDbPath);
  assert.equal(db.prepare('SELECT runs FROM effects WHERE id = 1').get()?.runs, 1);
  db.close();
});

test('prepare refuses source overwrite, non-private candidate, and symlink candidate', async (t) => {
  const f = fixture(t);
  const runner = await loadRunner();
  await assert.rejects(() => runner.prepareMigration({ ...prepareArgs(f), candidateDbPath: f.sourceDbPath }), /source|candidate|same|refus|нельзя/i);
  await assert.rejects(() => runner.prepareMigration({ ...prepareArgs(f), candidateDbPath: join(f.root, '..', 'outside.db') }), /sandbox|private|ownership|path|outside|путь/i);
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
        try { db.transaction(() => { db.prepare('INSERT INTO effects(id,runs) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET runs=runs+1').run(); recordCompletion(db, { rows: 1 }); })(); }
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
  assert.equal(db.prepare('SELECT runs FROM effects WHERE id = 1').get()?.runs, 1, 'recovery replayed an already committed data effect');
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
  const f = await makePrepared(t);
  const sandboxRoot = f.root;
  writeFileSync(join(sandboxRoot, '.ikpk-rehearsal-target'), 'fixture\n');
  const releases = join(sandboxRoot, 'releases');
  const cohorts = join(sandboxRoot, 'cohorts');
  const oldCode = join(releases, 'old-code');
  const newCode = f.artifactDir;
  const oldDb = join(sandboxRoot, 'old.db');
  const activePairPath = join(sandboxRoot, 'active');
  mkdirSync(oldCode, { recursive: true }); mkdirSync(cohorts, { recursive: true });
  seedDb(oldDb, { value: 'old' });
  const priorCohort = join(cohorts, 'prior'); mkdirSync(priorCohort);
  symlinkSync(oldCode, join(priorCohort, 'code'));
  symlinkSync(oldDb, join(priorCohort, 'data.db'));
  writeFileSync(join(priorCohort, 'cohort.json'), JSON.stringify({ schemaVersion: 1, planSha256: 'a'.repeat(64), codeRelease: oldCode, databasePath: oldDb }));
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
  const f = await makePrepared(t);
  const sandboxRoot = f.root; writeFileSync(join(sandboxRoot, '.ikpk-rehearsal-target'), 'fixture\n');
  const releases = join(sandboxRoot, 'releases'); const cohorts = join(sandboxRoot, 'cohorts');
  const oldCode = join(releases, 'old'); const newCode = f.artifactDir; const oldDb = join(sandboxRoot, 'old.db');
  const activePairPath = join(sandboxRoot, 'active');
  mkdirSync(oldCode, { recursive: true }); mkdirSync(cohorts, { recursive: true }); seedDb(oldDb);
  const prior = join(cohorts, 'prior'); mkdirSync(prior); symlinkSync(oldCode, join(prior, 'code')); symlinkSync(oldDb, join(prior, 'data.db'));
  writeFileSync(join(prior, 'cohort.json'), JSON.stringify({ schemaVersion: 1, planSha256: 'a'.repeat(64), codeRelease: oldCode, databasePath: oldDb })); symlinkSync(prior, activePairPath);
  await f.runner.activateMigration({ candidateDbPath: f.candidateDbPath, codeRelease: newCode, activePairPath, sandboxRoot, receiptPath: f.receiptPath, operationId: f.operationId, lifecycleAdapter: f.lifecycleAdapter });
  const db = new Database(f.candidateDbPath); db.prepare('UPDATE source_items SET value = ? WHERE id = 1').run('editor-write'); db.close();
  await assert.rejects(() => f.runner.rollbackMigration({ operationId: f.operationId, receiptPath: f.receiptPath, activePairPath, sandboxRoot }), /changed|fingerprint|rollback|restore|refus|измен/i);
  assert.equal(realpathSync(join(realpathSync(activePairPath), 'code')), realpathSync(newCode), 'refused rollback must keep the active code+DB pair intact');
});
