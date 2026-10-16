import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, cpSync, realpathSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readPublishedSqlite, loadCaptureSchemas } from '../lib/server-capture-sqlite.mjs';
import { captureBundle, recoverWriters, verifyBundle } from '../lib/server-capture-bundle.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'server-capture-')));
  t.after(() => { const unlock = (p) => { if (lstatSync(p).isDirectory()) { chmodSync(p, 0o700); readdirSync(p).forEach((n) => unlock(join(p, n))); } }; unlock(root); rmSync(root, { recursive: true, force: true }); });
  const database = join(root, 'source.db');
  const db = new DatabaseSync(database);
  const schemas = loadCaptureSchemas(join(repoRoot, 'cms/src'));
  for (const [uid, schema] of Object.entries(schemas)) {
    const scalar = Object.entries(schema.attributes).filter(([, a]) => !['relation', 'media', 'component'].includes(a.type));
    const columns = scalar.map(([name, a]) => `"${snake(name)}" ${['integer', 'boolean', 'decimal'].includes(a.type) ? 'NUMERIC' : 'TEXT'}`);
    const system = uid.startsWith('api::') ? ', document_id TEXT, created_at TEXT, updated_at TEXT, published_at TEXT, created_by_id INTEGER, updated_by_id INTEGER, locale TEXT' : '';
    db.exec(`CREATE TABLE ${schema.collectionName} (id INTEGER PRIMARY KEY${system}, ${columns.join(',')})`);
    if (Object.values(schema.attributes).some((a) => a.type === 'component')) db.exec(`CREATE TABLE ${schema.collectionName}_cmps (id INTEGER PRIMARY KEY, entity_id INTEGER, cmp_id INTEGER, component_type TEXT, field TEXT, "order" REAL)`);
  }
  // Current Strapi join names and directional order columns, independently enumerated.
  for (const [table, left, right, order] of [
    ['course_groups_institute_lnk', 'course_group', 'institute', 'course_group'],
    ['seminars_course_group_lnk', 'seminar', 'course_group', 'seminar'],
    ['seminars_teachers_lnk', 'seminar', 'teacher', 'teacher'],
    ['teachers_institute_lnk', 'teacher', 'institute', null],
    ['schedule_entries_seminar_lnk', 'schedule_entry', 'seminar', 'schedule_entry'],
    ['schedule_entries_teachers_lnk', 'schedule_entry', 'teacher', 'teacher'],
    ['articles_categories_lnk', 'article', 'course_group', 'course_group'],
  ]) db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, ${left}_id INTEGER, ${right}_id INTEGER${order ? `, ${order}_ord REAL` : ''}${table === 'seminars_teachers_lnk' ? ', seminar_ord REAL' : ''})`);
  db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, document_id TEXT, url TEXT);
    CREATE TABLE files_related_mph (id INTEGER PRIMARY KEY, file_id INTEGER, related_id INTEGER, related_type TEXT, field TEXT, "order" REAL);
    INSERT INTO institutes (id, document_id, name, slug, published_at) VALUES (1,'inst','Institute','inst','2026-10-01');
    INSERT INTO course_groups (id, document_id, name, slug, legacy_id, published_at) VALUES (2,'group','Group','group','group','2026-10-01');
    INSERT INTO teachers (id, document_id, name, slug, trait, published_at) VALUES (3,'teacher','Teacher','teacher','teacher','2026-10-01'), (4,'teacher','Draft teacher','draft','teacher',NULL);
    INSERT INTO seminars (id, document_id, name, slug, description, published_at) VALUES (5,'seminar','Published','seminar','<a href="/uploads/form.pdf">PDF</a>','2026-10-01'), (6,'seminar','Draft','draft','draft bytes',NULL);
    INSERT INTO articles (id, document_id, title, slug, published_at) VALUES (7,'article','Article','article','2026-10-01');
    INSERT INTO course_groups_institute_lnk VALUES (1,2,1,1);
    INSERT INTO seminars_course_group_lnk VALUES (1,5,2,1);
    INSERT INTO seminars_teachers_lnk VALUES (1,5,3,1,1), (2,5,4,2,2);
    INSERT INTO components_shared_seos (id, seo_title) VALUES (10,'Published SEO'), (11,'Draft SEO');
    INSERT INTO seminars_cmps VALUES (1,5,10,'shared.seo','seo',1), (2,6,11,'shared.seo','seo',1);
    INSERT INTO components_seminar_document_records (id, document, issuer) VALUES (12,'Certificate','Issuer');
    INSERT INTO seminars_cmps VALUES (3,5,12,'seminar.document-record','documents',1);
    INSERT INTO files VALUES (20,'photo','/uploads/photo.jpg');
    INSERT INTO files_related_mph VALUES (1,20,5,'api::seminar.seminar','image',1);
  `);
  db.close();
  mkdirSync(join(root, 'uploads'));
  mkdirSync(join(root, 'documents'));
  mkdirSync(join(root, 'bundles'));
  mkdirSync(join(root, 'leases'));
  writeFileSync(join(root, 'uploads/photo.jpg'), 'photo bytes');
  writeFileSync(join(root, 'uploads/form.pdf'), '%PDF bytes');
  writeFileSync(join(root, 'documents/info.pdf'), '%PDF static bytes');
  const config = { sourcePolicy: 'demo-publication-only', sourceId: 'demo193-cms', host: '193.124.115.99', siteUrl: 'https://staging.ikpk.su', deployMode: 'stand', paymentRole: 'ci', database, schemaRoot: join(repoRoot, 'cms/src'), uploadsRoot: join(root, 'uploads'), staticDocumentsRoot: join(root, 'documents'), staticDocumentsPrefix: '/media/', bundleRoot: join(root, 'bundles'), leaseRoot: join(root, 'leases'), writerUnits: ['ikpk-cms.service'] };
  const calls = [];
  let active = true;
  const services = { isActive: () => active, stop: (unit) => { calls.push(`stop:${unit}`); active = false; }, start: (unit) => { calls.push(`start:${unit}`); active = true; } };
  return { root, database, config, calls, services };
}

test('published SQLite projection preserves relations/components/media and legal empty collections without changing source', (t) => {
  const f = fixture(t); const before = sha(f.database);
  const { collections } = readPublishedSqlite(f.database, f.config.schemaRoot);
  assert.equal(collections.seminars.length, 1);
  const s = collections.seminars[0];
  assert.equal(s.name, 'Published');
  assert.deepEqual(s.teachers.map((v) => v.name), ['Teacher']);
  assert.equal(s.course_group.slug, 'group');
  assert.equal(s.seo.seo_title, 'Published SEO');
  assert.equal(s.documents[0].document, 'Certificate');
  assert.equal(s.image[0].url, '/uploads/photo.jpg');
  assert.deepEqual(collections['schedule-entries'], []);
  assert.deepEqual(collections.promotions, []);
  assert.equal(sha(f.database), before);
});

test('schema mismatch, including empty tables, is refused before projection', (t) => {
  const f = fixture(t); const db = new DatabaseSync(f.database);
  db.exec('ALTER TABLE promotions DROP COLUMN priority'); db.close();
  assert.throws(() => readPublishedSqlite(f.database, f.config.schemaRoot), /schema.*promotions.*priority/i);
});

test('WAL-aware backup seals DB/media/readback and resumes CMS before returning', async (t) => {
  const f = fixture(t); const db = new DatabaseSync(f.database);
  db.exec("PRAGMA journal_mode=WAL; UPDATE seminars SET name='WAL published' WHERE id=5");
  const result = await captureBundle(f.config, 'pub-test-1', { services: f.services });
  db.close();
  assert.deepEqual(f.calls, ['stop:ikpk-cms.service', 'start:ikpk-cms.service']);
  const b = verifyBundle(result.bundleDirectory, { requireProtected: false });
  assert.equal(b.readback.collections.seminars[0].name, 'WAL published');
  assert.equal(b.proof.captureId, 'pub-test-1');
  assert.match(b.proof.bundleDigest, /^[a-f0-9]{64}$/);
  assert.ok(b.readback.media.some((m) => m.url === '/uploads/form.pdf'));
  assert.ok(b.readback.media.some((m) => m.url === '/media/info.pdf'));
  writeFileSync(join(f.root, 'uploads/photo.jpg'), 'later state');
  assert.equal(verifyBundle(result.bundleDirectory, { requireProtected: false }).proof.bundleDigest, b.proof.bundleDigest);
});

test('missing media and symlinked source refuse capture and restore writers', async (t) => {
  const f = fixture(t); rmSync(join(f.root, 'uploads/form.pdf'));
  await assert.rejects(captureBundle(f.config, 'pub-missing', { services: f.services }), /media.*missing/i);
  assert.deepEqual(f.calls, ['stop:ikpk-cms.service', 'start:ikpk-cms.service']);
  symlinkSync('/etc/hosts', join(f.root, 'uploads/photo.jpg.link'));
  await assert.rejects(captureBundle(f.config, 'pub-link', { services: f.services }), /symlink/i);
});

test('independent recovery uses durable pre-stop lease after process loss; inactive writers stay stopped', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.config.leaseRoot, 'pub-crash.json'), JSON.stringify({ version: 1, captureId: 'pub-crash', activeUnits: ['ikpk-cms.service'] }));
  recoverWriters(f.config, 'pub-crash', { services: f.services });
  recoverWriters(f.config, 'pub-crash', { services: f.services });
  assert.deepEqual(f.calls, ['start:ikpk-cms.service']);
  f.calls.length = 0;
  await captureBundle(f.config, 'pub-inactive', { services: { ...f.services, isActive: () => false } });
  assert.deepEqual(f.calls, []);
});

test('DEMO source binding is fixed and existing bundle cannot be overwritten', async (t) => {
  const f = fixture(t);
  await assert.rejects(captureBundle({ ...f.config, deployMode: 'production' }, 'pub-prod', { services: f.services }), /binding/i);
  await captureBundle(f.config, 'pub-once', { services: f.services });
  await assert.rejects(captureBundle(f.config, 'pub-once', { services: f.services }), /exist/i);
  assert.throws(() => verifyBundle(join(f.config.bundleRoot, 'pub-once')), /protected/i);
});

test('changed media while the WAL backup is pending refuses a mixed bundle', async (t) => {
  const f = fixture(t);
  const pending = captureBundle(f.config, 'pub-change', { services: f.services });
  writeFileSync(join(f.root, 'uploads/photo.jpg'), 'concurrent edit');
  await assert.rejects(pending, /media changed|source changed/i);
  assert.deepEqual(f.calls, ['stop:ikpk-cms.service', 'start:ikpk-cms.service']);
  assert.throws(() => verifyBundle(join(f.config.bundleRoot, 'pub-change'), { requireProtected: false }), /ENOENT/);
});

test('SIGKILL after stopping writer leaves recoverable lease for independent ExecStopPost', async (t) => {
  const f = fixture(t);
  const { spawnSync } = await import('node:child_process');
  const helper = new URL('../lib/server-capture-bundle.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { captureBundle } from ${JSON.stringify(helper)};
    const config = JSON.parse(process.env.CAPTURE_TEST_CONFIG);
    await captureBundle(config, 'pub-killed', { services: {
      isActive: () => true,
      stop: () => process.kill(process.pid, 'SIGKILL'),
      start: () => { throw new Error('unreachable recovery'); },
    }});
  `], { env: { ...process.env, CAPTURE_TEST_CONFIG: JSON.stringify(f.config) }, encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  // Recovery does not depend on source DB/media still existing after a crash.
  rmSync(f.database);
  recoverWriters(f.config, 'pub-killed', { services: f.services });
  assert.deepEqual(f.calls, ['start:ikpk-cms.service']);
});

test('ordinary prepare supplies historical static PDFs and uploads to the derivative input', async (t) => {
  const f = fixture(t);
  const { spawnSync } = await import('node:child_process');
  const bundle = await captureBundle(f.config, 'pub-static', { services: f.services });
  const verified = verifyBundle(bundle.bundleDirectory, { requireProtected: false });
  const media = verified.readback.media.map((m) => ({ ref: m.url.startsWith('/media/') ? m.url : `/media${m.url}`, contentId: `sha256:${m.verifiedStoredSha256}` }));
  const web = join(f.root, 'candidate/web'); mkdirSync(join(web, 'scripts/lib'), { recursive: true });
  for (const path of ['prepare-snapshot.ts', 'lib/content-media-store.ts', 'lib/content-snapshot.ts']) cpSync(join(repoRoot, 'web/scripts', path), join(web, 'scripts', path));
  const snapshot = join(f.root, 'snapshot'); mkdirSync(snapshot); cpSync(verified.mediaDirectory, join(snapshot, 'media'), { recursive: true });
  writeFileSync(join(snapshot, 'snapshot.json'), JSON.stringify({ sourcePolicy: 'demo-publication-only', origin: { kind: 'server-db' }, referenceDate: '2026-10-16', fingerprint: 'fixture', snapshotId: 'fixture', content: { types: {}, media } }));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', join(web, 'scripts/prepare-snapshot.ts')], { env: { ...process.env, CONTENT_SNAPSHOT_DIR: snapshot }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(join(web, '.snapshot/media-originals/info.pdf'), 'utf8'), '%PDF static bytes');
  assert.equal(readFileSync(join(web, '.snapshot/media-originals/uploads/form.pdf'), 'utf8'), '%PDF bytes');
});

test('changing records before sealing refuses a mixed publication input', async (t) => {
  const f = fixture(t);
  let probes = 0;
  const services = { ...f.services, isActive: (unit) => {
    probes += 1;
    if (probes === 3) { const writer = new DatabaseSync(f.database); writer.exec("UPDATE seminars SET name='concurrent record' WHERE id=5"); writer.close(); }
    return f.services.isActive(unit);
  } };
  await assert.rejects(captureBundle(f.config, 'pub-dbchange', { services }), /source changed/i);
  assert.deepEqual(f.calls, ['stop:ikpk-cms.service', 'start:ikpk-cms.service']);
});

test('CLI refuses an untrusted caller bundle and cannot reuse the legacy readback option without its pins', async (t) => {
  const f = fixture(t); const { spawnSync } = await import('node:child_process');
  const bundle = await captureBundle(f.config, 'pub-untrusted', { services: f.services });
  for (const args of [['--server-capture', bundle.bundleDirectory], ['--demo193-saved-readback', join(bundle.bundleDirectory, 'readback.json'), join(bundle.bundleDirectory, 'media')]]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', join(repoRoot, 'web/scripts/capture-content-snapshot.ts'), ...args], { env: { ...process.env, CMS_URL: 'http://127.0.0.1:19341', CONTENT_SNAPSHOT_DIR: join(f.root, 'out') }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, args[0] === '--server-capture' ? /protected root-owned/ : /SHA-256 mismatch/);
  }
});

test('system locale column is allowed but populated localization cannot silently enter the public projection', (t) => {
  const f = fixture(t); const db = new DatabaseSync(f.database);
  db.exec("UPDATE seminars SET locale='en' WHERE id=5"); db.close();
  assert.throws(() => readPublishedSqlite(f.database, f.config.schemaRoot), /localized published record/);
});

test('resume failure retains the lease for independent retry and never seals a successful bundle', async (t) => {
  const f = fixture(t);
  await assert.rejects(captureBundle(f.config, 'pub-resume-failure', { services: { ...f.services, start: () => { throw new Error('start failed'); } } }), /recovery failed/);
  assert.match(readFileSync(join(f.config.leaseRoot, 'pub-resume-failure.json'), 'utf8'), /ikpk-cms/);
  assert.throws(() => verifyBundle(join(f.config.bundleRoot, 'pub-resume-failure'), { requireProtected: false }), /ENOENT/);
  recoverWriters(f.config, 'pub-resume-failure', { services: f.services });
  assert.throws(() => readFileSync(join(f.config.leaseRoot, 'pub-resume-failure.json')), /ENOENT/);
});

test('sealed manifest binds readback identities and detects later byte replacement', async (t) => {
  const f = fixture(t); const result = await captureBundle(f.config, 'pub-corrupt', { services: f.services });
  const readback = join(result.bundleDirectory, 'readback.json');
  chmodSync(readback, 0o600); writeFileSync(readback, '{}'); chmodSync(readback, 0o440);
  assert.throws(() => verifyBundle(result.bundleDirectory, { requireProtected: false }), /readback digest mismatch/);
});

test('new capture automatically recovers a reboot orphan before deciding which writers were active', async (t) => {
  const f = fixture(t); f.services.stop('ikpk-cms.service'); f.calls.length = 0;
  writeFileSync(join(f.config.leaseRoot, 'pub-before-reboot.json'), JSON.stringify({ version: 1, captureId: 'pub-before-reboot', activeUnits: ['ikpk-cms.service'] }));
  const { runCaptureOperation } = await import('../server-capture.mjs');
  await runCaptureOperation(f.config, 'capture', 'pub-after-reboot', { services: f.services });
  assert.deepEqual(f.calls, ['start:ikpk-cms.service', 'stop:ikpk-cms.service', 'start:ikpk-cms.service']);
  assert.throws(() => readFileSync(join(f.config.leaseRoot, 'pub-before-reboot.json')), /ENOENT/);
});

test('boot recover-leases restores disabled writers from durable leases without source DB availability', async (t) => {
  const f = fixture(t); f.services.stop('ikpk-cms.service'); f.calls.length = 0;
  writeFileSync(join(f.config.leaseRoot, 'pub-reboot.json'), JSON.stringify({ version: 1, captureId: 'pub-reboot', activeUnits: ['ikpk-cms.service'] }));
  // A partial pre-stop write must not poison future recovery or claim a writer was stopped.
  writeFileSync(join(f.config.leaseRoot, 'pub-never-stopped.pending'), '{');
  rmSync(f.database);
  const { runCaptureOperation } = await import('../server-capture.mjs');
  await runCaptureOperation(f.config, 'recover-leases', undefined, { services: f.services });
  assert.deepEqual(f.calls, ['start:ikpk-cms.service']);
  assert.equal(f.services.isActive('ikpk-cms.service'), true);
});

test('pre-capture orphan recovery failure blocks any new writer stop and capture lease', async (t) => {
  const f = fixture(t); f.services.stop('ikpk-cms.service'); f.calls.length = 0;
  writeFileSync(join(f.config.leaseRoot, 'pub-orphan.json'), JSON.stringify({ version: 1, captureId: 'pub-orphan', activeUnits: ['ikpk-cms.service'] }));
  const { runCaptureOperation } = await import('../server-capture.mjs');
  await assert.rejects(runCaptureOperation(f.config, 'capture', 'pub-blocked', { services: { ...f.services, start: () => { throw new Error('cannot restart'); } } }), /lease recovery failed/);
  assert.deepEqual(f.calls, []);
  assert.throws(() => readFileSync(join(f.config.leaseRoot, 'pub-blocked.json')), /ENOENT/);
});

test('root lock invocation uses a separate fixed lock and rejects argument expansion', async (t) => {
  const f = fixture(t); const { captureLockInvocation } = await import('../server-capture.mjs');
  const invocation = captureLockInvocation(f.config, ['recover-leases']);
  assert.equal(invocation.command, '/usr/bin/flock');
  assert.deepEqual(invocation.args.slice(0, 5), ['--exclusive', '--wait', '300', '--no-fork', join(f.config.leaseRoot, '.operation.lock')]);
  assert.deepEqual(invocation.args.slice(-2), ['--under-lock', 'recover-leases']);
  assert.throws(() => captureLockInvocation(f.config, ['recover-leases', 'extra']), /usage/);
  assert.throws(() => captureLockInvocation(f.config, ['capture', '../escape']), /invalid capture ID/);
  assert.throws(() => captureLockInvocation(f.config, ['--under-lock', 'recover-leases']), /cannot nest/);
});

test('a partial pre-stop lease does not block retry, and stop sees only a complete published lease', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.config.leaseRoot, 'pub-pending.pending'), '{');
  const { runCaptureOperation } = await import('../server-capture.mjs');
  await runCaptureOperation(f.config, 'capture', 'pub-pending', { services: { ...f.services, stop: (unit) => {
    const lease = JSON.parse(readFileSync(join(f.config.leaseRoot, 'pub-pending.json'), 'utf8'));
    assert.deepEqual(lease.activeUnits, ['ikpk-cms.service']);
    assert.throws(() => readFileSync(join(f.config.leaseRoot, 'pub-pending.pending')), /ENOENT/);
    f.services.stop(unit);
  } } });
});

test('Linux root-operation flock survives launcher loss and excludes recovery until live capture exits', { skip: process.platform !== 'linux', timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { captureLockInvocation } = await import('../server-capture.mjs');
  const helper = join(f.root, 'mutex-operation.mjs');
  writeFileSync(helper, `
    import { writeFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout } from 'node:timers/promises';
    const action = process.argv[3], root = process.env.CAPTURE_MUTEX_TEST_ROOT;
    writeFileSync(join(root, action + '.entered'), String(process.pid));
    if (action === 'capture') while (!existsSync(join(root, 'release'))) await setTimeout(10);
  `);
  const invocation = (args) => { const result = captureLockInvocation(f.config, args); result.args[6] = helper; return result; };
  const capture = invocation(['capture', 'pub-mutex']);
  const env = { ...process.env, CAPTURE_MUTEX_TEST_ROOT: f.root };
  // Only the operation implementation is replaced; production flock flags, path and launch shape are real.
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', `import { execFileSync } from 'node:child_process'; execFileSync(${JSON.stringify(capture.command)}, ${JSON.stringify(capture.args)}, {stdio:'inherit'});`], { env, stdio: 'ignore' });
  const launcherExited = once(launcher, 'exit');
  let operationPid; let recovery;
  t.after(() => { launcher.kill('SIGKILL'); recovery?.kill('SIGKILL'); if (operationPid) { try { process.kill(operationPid, 'SIGKILL'); } catch { /* The child may already have exited before teardown. */ } } });
  const waitFor = async (path) => { for (let i = 0; i < 500; i++) { try { return readFileSync(path, 'utf8'); } catch { /* The fixture writes this marker asynchronously. */ } await delay(10); } throw new Error(`mutex fixture timeout: ${path}`); };
  operationPid = Number(await waitFor(join(f.root, 'capture.entered')));
  launcher.kill('SIGKILL'); await launcherExited;
  const next = invocation(['recover-leases']);
  recovery = spawn(next.command, next.args, { env, stdio: 'ignore' });
  const recovered = once(recovery, 'exit');
  await delay(150);
  assert.throws(() => readFileSync(join(f.root, 'recover-leases.entered')), /ENOENT/);
  writeFileSync(join(f.root, 'release'), 'release');
  const [code] = await recovered;
  assert.equal(code, 0);
  assert.ok(Number(await waitFor(join(f.root, 'recover-leases.entered'))) > 0);
  operationPid = undefined;
});
