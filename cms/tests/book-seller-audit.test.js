import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { auditMigration } from '../scripts/audit-data-migration.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'ikpk-book-audit-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fingerprint(path) {
  const fs = require('node:fs');
  const parts = [path, `${path}-wal`].map((file) => {
    try { return { file: file.split('/').at(-1), sha256: sha(fs.readFileSync(file)) }; }
    catch (error) { if (error.code === 'ENOENT' && file !== path) return { file: file.split('/').at(-1), absent: true }; throw error; }
  });
  return sha(Buffer.from(JSON.stringify(parts)));
}
function fixture(path) {
  const db = new Database(path);
  db.exec(`CREATE TABLE pages (
      id INTEGER PRIMARY KEY, document_id varchar(255), title varchar(255), slug varchar(255), body TEXT,
      legacy_id varchar(255), created_at datetime, updated_at datetime, published_at datetime,
      created_by_id integer, updated_by_id integer, locale varchar(255), center_phone varchar(255), manager_phone varchar(255));
    CREATE TABLE components_shared_seos (id INTEGER PRIMARY KEY, seo_title varchar(255), seo_description TEXT, noindex boolean);
    CREATE TABLE pages_cmps (id INTEGER PRIMARY KEY, entity_id integer, cmp_id integer, component_type varchar(255), field varchar(255), "order" float);
    INSERT INTO pages VALUES (7,'other','Other','elsewhere','Untouched','elsewhere',1,1,1,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO components_shared_seos VALUES (9,'Other SEO','Other description',0);
    INSERT INTO pages_cmps VALUES (11,7,9,'shared.seo','seo',NULL);`);
  db.close();
}
function legacyFixtureWithoutPhones(path) {
  const db = new Database(path);
  db.exec(`CREATE TABLE pages (
      id INTEGER PRIMARY KEY, document_id varchar(255), title varchar(255), slug varchar(255), body TEXT,
      legacy_id varchar(255), created_at datetime, updated_at datetime, published_at datetime,
      created_by_id integer, updated_by_id integer, locale varchar(255));
    CREATE TABLE components_shared_seos (id INTEGER PRIMARY KEY, seo_title varchar(255), seo_description TEXT, noindex boolean);
    CREATE TABLE pages_cmps (id INTEGER PRIMARY KEY, entity_id integer, cmp_id integer, component_type varchar(255), field varchar(255), "order" float);
    INSERT INTO pages VALUES (7,'contacts-doc','Контакты','kontakty','Контакты','kontakty',100,100,100,NULL,NULL,NULL);
    INSERT INTO pages VALUES (8,'contacts-doc','Контакты','kontakty','Контакты','kontakty',100,200,NULL,NULL,NULL,NULL);
    INSERT INTO components_shared_seos VALUES (9,'Контакты','Описание контактов',0);
    INSERT INTO components_shared_seos VALUES (10,'Контакты','Черновое описание',0);
    INSERT INTO pages_cmps VALUES (11,7,9,'shared.seo','seo',NULL);
    INSERT INTO pages_cmps VALUES (12,8,10,'shared.seo','seo',NULL);`);
  db.close();
}
function addLedger(db) {
  const lineage = 'a'.repeat(64), snapshot = 'b'.repeat(64), schema = 'c'.repeat(64), operation = 'book-seller-audit';
  db.exec(`CREATE TABLE ikpk_migration_lineage (singleton, lineage_id, source_snapshot_sha256, source_schema_sha256, created_at);
    CREATE TABLE ikpk_migration_operations (operation_id, lineage_id, source_snapshot_sha256, source_schema_sha256, created_at);
    CREATE TABLE ikpk_data_migration_history (lineage_id, operation_id, step_id, payload_sha256, result_json, completed_at);`);
  db.prepare('INSERT INTO ikpk_migration_lineage VALUES (1,?,?,?,1)').run(lineage, snapshot, schema);
  db.prepare('INSERT INTO ikpk_migration_operations VALUES (?,?,?,?,1)').run(operation, lineage, snapshot, schema);
  return { lineage, snapshot, schema, operation };
}

test('independent preservation audit permits only seeded Page, SEO component, link, and ledger rows', async () => {
  const sourceDbPath = join(dir, 'source.db'), candidateDbPath = join(dir, 'candidate.db');
  fixture(sourceDbPath); copyFileSync(sourceDbPath, candidateDbPath);
  const step = JSON.parse(readFileSync(new URL('../database/migrations/plan.json', import.meta.url), 'utf8')).steps.find(({ id }) => id === 'book-seller-page-v1');
  const manifestPath = join(dir, 'book-plan.json');
  writeFileSync(manifestPath, JSON.stringify({ version: 1, steps: [step] }) + '\n');
  const plan = { manifestPath, planSha256: sha(readFileSync(manifestPath)), steps: [step] };
  const candidate = new Database(candidateDbPath);
  const binding = addLedger(candidate);
  const { apply } = await import('../database/migrations/data-steps/book-seller.mjs');
  const result = apply(candidate, { onApplied(db, row) {
    db.prepare('INSERT INTO ikpk_data_migration_history VALUES (?,?,?,?,?,1)').run(binding.lineage, binding.operation, step.id, step.sha256, JSON.stringify(row));
  } });
  candidate.close();

  const audit = () => {
    const receipt = {
      sourceDbPath, candidateDbPath, planSha256: plan.planSha256, steps: [step], operationId: binding.operation,
      source: { sourceFileFingerprint: fingerprint(sourceDbPath), snapshotSha256: binding.snapshot, schemaFingerprint: binding.schema },
      lifecycle: [
        { event: 'closed-load-started', at: '2026-11-27T09:00:00.000Z' },
        { event: 'strapi-load-complete', at: '2026-11-27T09:01:00.000Z' },
      ],
      candidatePostMigrationSha256: sha(require('node:fs').readFileSync(candidateDbPath)),
      candidatePostMigrationFileFingerprint: fingerprint(candidateDbPath),
    };
    return auditMigration({ sourceDbPath, candidateDbPath, plan, receipt });
  };
  assert.deepEqual(result, { createdPages: 2, createdSeoComponents: 2, createdPageLinks: 2 });
  const passed = audit();
  assert.equal(passed.passed, true, JSON.stringify(passed.differences));

  const db = new Database(candidateDbPath);
  db.prepare('UPDATE pages SET body=? WHERE slug=? AND published_at IS NOT NULL').run('Unapproved change', 'knigi-i-uchebnye-materialy');
  db.close();
  const rejected = audit();
  assert.equal(rejected.passed, false);
  assert.ok(rejected.differences.some(({ table, kind }) => table === 'pages' && kind === 'row-content'));
});

test('a valid inherited book ledger preserves editorial text and SEO independently of documentId', async () => {
  const sourceDbPath = join(dir, 'inherited-source.db'), candidateDbPath = join(dir, 'inherited-candidate.db');
  fixture(sourceDbPath);
  const step = JSON.parse(readFileSync(new URL('../database/migrations/plan.json', import.meta.url), 'utf8')).steps.find(({ id }) => id === 'book-seller-page-v1');
  const manifestPath = join(dir, 'inherited-book-plan.json');
  writeFileSync(manifestPath, JSON.stringify({ version: 1, steps: [step] }) + '\n');
  const plan = { manifestPath, planSha256: sha(readFileSync(manifestPath)), steps: [step] };
  const source = new Database(sourceDbPath);
  const binding = addLedger(source);
  source.exec(`INSERT INTO pages VALUES (72,'editorial-doc','Книги и учебные материалы','knigi-i-uchebnye-materialy','Опубликовано редактором','knigi-i-uchebnye-materialy',100,200,200,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO pages VALUES (73,'editorial-doc','Книги и учебные материалы','knigi-i-uchebnye-materialy','Редакторский черновик','knigi-i-uchebnye-materialy',100,300,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO components_shared_seos VALUES (92,'Изменённый SEO','Описание опубликованной страницы',0);
    INSERT INTO components_shared_seos VALUES (93,'Черновой SEO','Описание черновика',0);
    INSERT INTO pages_cmps VALUES (112,72,92,'shared.seo','seo',NULL);
    INSERT INTO pages_cmps VALUES (113,73,93,'shared.seo','seo',NULL);`);
  source.prepare('INSERT INTO ikpk_data_migration_history VALUES (?,?,?,?,?,1)')
    .run(binding.lineage, binding.operation, step.id, step.sha256,
      JSON.stringify({ createdPages: 2, createdSeoComponents: 2, createdPageLinks: 2 }));
  source.close();
  copyFileSync(sourceDbPath, candidateDbPath);
  const currentOperation = `${binding.operation}-current`;
  const currentSnapshot = 'd'.repeat(64), currentSchema = 'e'.repeat(64);
  const candidateDb = new Database(candidateDbPath);
  candidateDb.prepare('INSERT INTO ikpk_migration_operations VALUES (?,?,?,?,2)')
    .run(currentOperation, binding.lineage, currentSnapshot, currentSchema);
  candidateDb.close();
  const audit = () => {
    const receipt = {
      sourceDbPath, candidateDbPath, planSha256: plan.planSha256, steps: [step], operationId: currentOperation,
      source: { sourceFileFingerprint: fingerprint(sourceDbPath), snapshotSha256: currentSnapshot, schemaFingerprint: currentSchema },
      lifecycle: [
        { event: 'closed-load-started', at: '2026-11-27T09:00:00.000Z' },
        { event: 'strapi-load-complete', at: '2026-11-27T09:01:00.000Z' },
      ],
      candidatePostMigrationSha256: sha(require('node:fs').readFileSync(candidateDbPath)),
      candidatePostMigrationFileFingerprint: fingerprint(candidateDbPath),
    };
    return auditMigration({ sourceDbPath, candidateDbPath, plan, receipt });
  };
  const passed = audit();
  assert.equal(passed.passed, true, JSON.stringify(passed.differences));
  const candidate = new Database(candidateDbPath);
  candidate.prepare('UPDATE pages SET body=? WHERE id=72').run('Unauthorized text');
  candidate.close();
  const rejected = audit();
  assert.equal(rejected.passed, false);
  assert.ok(rejected.differences.some(({ table, kind }) => table === 'pages' && kind === 'row-content'));
});

test('independent audit rejects extra or missing Page columns even when both databases match', async () => {
  const step = JSON.parse(readFileSync(new URL('../database/migrations/plan.json', import.meta.url), 'utf8')).steps.find(({ id }) => id === 'book-seller-page-v1');
  const { apply } = await import('../database/migrations/data-steps/book-seller.mjs');
  for (const [name, mutation] of [['extra', 'ALTER TABLE pages ADD COLUMN unexpected TEXT'],
    ['missing', 'ALTER TABLE pages DROP COLUMN manager_phone'],
    ['generated', 'ALTER TABLE pages ADD COLUMN generated_extra TEXT GENERATED ALWAYS AS (id + 1) VIRTUAL']]) {
    const sourceDbPath = join(dir, `${name}-schema-source.db`), candidateDbPath = join(dir, `${name}-schema-candidate.db`);
    fixture(sourceDbPath); copyFileSync(sourceDbPath, candidateDbPath);
    const manifestPath = join(dir, `${name}-schema-plan.json`);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, steps: [step] }) + '\n');
    const plan = { manifestPath, planSha256: sha(readFileSync(manifestPath)), steps: [step] };
    const candidate = new Database(candidateDbPath), binding = addLedger(candidate);
    apply(candidate, { onApplied(db, row) {
      db.prepare('INSERT INTO ikpk_data_migration_history VALUES (?,?,?,?,?,1)').run(binding.lineage, binding.operation, step.id, step.sha256, JSON.stringify(row));
    } });
    candidate.close();
    for (const path of [sourceDbPath, candidateDbPath]) {
      const db = new Database(path); db.exec(mutation); db.close();
    }
    const audit = () => {
      const receipt = {
        sourceDbPath, candidateDbPath, planSha256: plan.planSha256, steps: [step], operationId: binding.operation,
        source: { sourceFileFingerprint: fingerprint(sourceDbPath), snapshotSha256: binding.snapshot, schemaFingerprint: binding.schema },
        lifecycle: [
          { event: 'closed-load-started', at: '2026-11-27T09:00:00.000Z' },
          { event: 'strapi-load-complete', at: '2026-11-27T09:01:00.000Z' },
        ],
        candidatePostMigrationSha256: sha(require('node:fs').readFileSync(candidateDbPath)),
        candidatePostMigrationFileFingerprint: fingerprint(candidateDbPath),
      };
      return auditMigration({ sourceDbPath, candidateDbPath, plan, receipt });
    };
    const result = audit();
    assert.equal(result.passed, false, `${name} pages schema was accepted`);
    assert.ok(result.differences.some(({ table, kind }) => table === 'pages' && kind === 'book-page-schema-mismatch'), JSON.stringify(result.differences));
  }
});

test('audit accepts book seed NULL phone values when source lacked columns and schema sync added both', async () => {
  const sourceDbPath = join(dir, 'legacy-no-phone-source.db'), candidateDbPath = join(dir, 'legacy-no-phone-candidate.db');
  legacyFixtureWithoutPhones(sourceDbPath); copyFileSync(sourceDbPath, candidateDbPath);
  const allSteps = JSON.parse(readFileSync(new URL('../database/migrations/plan.json', import.meta.url), 'utf8')).steps;
  const steps = ['site-contact-phones-v1', 'book-seller-page-v1'].map((id) => allSteps.find((step) => step.id === id));
  const manifestPath = join(dir, 'legacy-no-phone-plan.json');
  writeFileSync(manifestPath, JSON.stringify({ version: 1, steps }) + '\n');
  const plan = { manifestPath, planSha256: sha(readFileSync(manifestPath)), steps };
  const candidate = new Database(candidateDbPath), binding = addLedger(candidate);
  candidate.exec('ALTER TABLE pages ADD COLUMN center_phone varchar(255); ALTER TABLE pages ADD COLUMN manager_phone varchar(255)');
  const sitePhones = (await import('../database/migrations/data-steps/site-phones.mjs')).apply;
  const bookSeller = (await import('../database/migrations/data-steps/book-seller.mjs')).apply;
  for (const [step, apply] of [[steps[0], sitePhones], [steps[1], bookSeller]]) {
    apply(candidate, { onApplied(db, row) {
      db.prepare('INSERT INTO ikpk_data_migration_history VALUES (?,?,?,?,?,1)').run(binding.lineage, binding.operation, step.id, step.sha256, JSON.stringify(row));
    } });
  }
  candidate.close();
  const receipt = () => ({
    sourceDbPath, candidateDbPath, planSha256: plan.planSha256, steps, operationId: binding.operation,
    source: { sourceFileFingerprint: fingerprint(sourceDbPath), snapshotSha256: binding.snapshot, schemaFingerprint: binding.schema },
    lifecycle: [
      { event: 'closed-load-started', at: '2026-11-27T09:00:00.000Z' },
      { event: 'strapi-load-complete', at: '2026-11-27T09:01:00.000Z' },
    ],
    candidatePostMigrationSha256: sha(require('node:fs').readFileSync(candidateDbPath)),
    candidatePostMigrationFileFingerprint: fingerprint(candidateDbPath),
  });
  const result = auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: receipt() });
  assert.equal(result.passed, true, JSON.stringify(result.differences));
  const candidateRead = new Database(candidateDbPath);
  const seeded = candidateRead.prepare("SELECT center_phone, manager_phone FROM pages WHERE slug='knigi-i-uchebnye-materialy'").all();
  assert.equal(seeded.length, 2);
  assert.ok(seeded.every((row) => row.center_phone === null && row.manager_phone === null));
  candidateRead.close();
});

test('audit accepts only nullable Open Graph columns added to the SEO component', async () => {
  const sourceDbPath = join(dir, 'og-source.db'), candidateDbPath = join(dir, 'og-candidate.db');
  fixture(sourceDbPath); copyFileSync(sourceDbPath, candidateDbPath);
  const step = JSON.parse(readFileSync(new URL('../database/migrations/plan.json', import.meta.url), 'utf8')).steps.find(({ id }) => id === 'book-seller-page-v1');
  const manifestPath = join(dir, 'og-plan.json');
  writeFileSync(manifestPath, JSON.stringify({ version: 1, steps: [step] }) + '\n');
  const plan = { manifestPath, planSha256: sha(readFileSync(manifestPath)), steps: [step] };
  const candidate = new Database(candidateDbPath), binding = addLedger(candidate);
  const { apply } = await import('../database/migrations/data-steps/book-seller.mjs');
  apply(candidate, { onApplied(db, row) {
    db.prepare('INSERT INTO ikpk_data_migration_history VALUES (?,?,?,?,?,1)').run(binding.lineage, binding.operation, step.id, step.sha256, JSON.stringify(row));
  } });
  candidate.exec('ALTER TABLE components_shared_seos ADD COLUMN og_title varchar(255); ALTER TABLE components_shared_seos ADD COLUMN og_description TEXT');
  candidate.close();
  const audit = () => auditMigration({ sourceDbPath, candidateDbPath, plan, receipt: {
    sourceDbPath, candidateDbPath, planSha256: plan.planSha256, steps: [step], operationId: binding.operation,
    source: { sourceFileFingerprint: fingerprint(sourceDbPath), snapshotSha256: binding.snapshot, schemaFingerprint: binding.schema },
    lifecycle: [{ event: 'closed-load-started', at: '2026-11-27T09:00:00.000Z' }, { event: 'strapi-load-complete', at: '2026-11-27T09:01:00.000Z' }],
    candidatePostMigrationSha256: sha(readFileSync(candidateDbPath)), candidatePostMigrationFileFingerprint: fingerprint(candidateDbPath),
  } });
  const accepted = audit();
  assert.equal(accepted.passed, true, JSON.stringify(accepted.differences));
  for (const mutation of [
    "UPDATE components_shared_seos SET og_title='Изменено' WHERE id=9",
    "UPDATE components_shared_seos SET seo_title='Изменено' WHERE id=9",
    'ALTER TABLE components_shared_seos ADD COLUMN unexpected TEXT',
  ]) {
    const db = new Database(candidateDbPath);
    db.exec(mutation);
    db.close();
    const rejected = audit();
    assert.equal(rejected.passed, false, `${mutation}: ${JSON.stringify(rejected.differences)}`);
    if (!mutation.startsWith('ALTER')) {
      const reset = new Database(candidateDbPath);
      reset.exec(mutation.includes('og_title') ? 'UPDATE components_shared_seos SET og_title=NULL WHERE id=9' : "UPDATE components_shared_seos SET seo_title='Other SEO' WHERE id=9");
      reset.close();
    }
  }
});
