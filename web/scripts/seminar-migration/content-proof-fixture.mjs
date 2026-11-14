// Test fixture: construct a real document-writer receipt and independent physical graphs.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { capturePlan, applyPlan, inspectVersions } from '../../../cms/scripts/documents-migration-writer.mjs';

const [databasePath, receiptPath] = process.argv.slice(2);
const db = new DatabaseSync(databasePath);
const sourceHtml = '<p>Сертификат <a href="https://example.test/cert">реестр</a></p>';
db.exec(`
 CREATE TABLE seminars (id INTEGER PRIMARY KEY, document_id TEXT, locale TEXT, slug TEXT, legacy_id TEXT, description TEXT, full_text TEXT, learning_plan TEXT, learning_mode TEXT, recommendations TEXT, published_at TEXT, content_format TEXT, audience TEXT, content_section_anchors TEXT, documents_state TEXT, documents_confirmation_date TEXT, documents_confirmation_source TEXT, documents_confirmation_author TEXT, documents_owner_verified INTEGER);
 CREATE TABLE institutes (id INTEGER PRIMARY KEY, slug TEXT);
 CREATE TABLE course_groups (id INTEGER PRIMARY KEY, slug TEXT);
 CREATE TABLE seminars_course_group_lnk (id INTEGER PRIMARY KEY, seminar_id INTEGER, course_group_id INTEGER);
 CREATE TABLE course_groups_institute_lnk (id INTEGER PRIMARY KEY, course_group_id INTEGER, institute_id INTEGER);
 CREATE TABLE seminars_cmps (id INTEGER PRIMARY KEY, entity_id INTEGER, cmp_id INTEGER, component_type TEXT, field TEXT, "order" REAL);
 CREATE TABLE components_seminar_document_records_cmps (id INTEGER PRIMARY KEY, entity_id INTEGER, cmp_id INTEGER, component_type TEXT, field TEXT, "order" REAL);
 INSERT INTO institutes VALUES (1,'inst'); INSERT INTO course_groups VALUES (1,'course');
 INSERT INTO seminars_course_group_lnk VALUES (1,1,1),(2,2,1); INSERT INTO course_groups_institute_lnk VALUES (1,1,1);
`);
for (const [schema, table] of [
 ['document-record', 'components_seminar_document_records'],
 ['registry-fact', 'components_seminar_registry_facts'],
 ['nmo-fact', 'components_seminar_nmo_facts'],
]) {
 const attributes = JSON.parse(readFileSync(new URL(`../../../cms/src/components/seminar/${schema}.json`, import.meta.url))).attributes;
 const snake = name => name.replace(/[A-Z]/g, value => `_${value.toLowerCase()}`);
 const columns = Object.entries(attributes).filter(([, attr]) => attr.type !== 'component').map(([name, attr]) => `"${snake(name)}" ${['boolean','integer'].includes(attr.type) ? 'INTEGER' : 'TEXT'}`);
 db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, ${columns.join(',')})`);
}
for (const [id, publishedAt] of [[1, null], [2, '2026-01-01']]) {
 db.prepare('INSERT INTO seminars (id,document_id,slug,legacy_id,description,full_text,published_at,documents_state,documents_owner_verified) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(id, 'doc', 'slug', '/inst/course/slug', '<p>Text</p>', sourceHtml, publishedAt, 'unconfirmed', 0);
}
const item = {
 documentId: 'doc', route: '/inst/course/slug', sourceHtml,
 sourceSha256: createHash('sha256').update(sourceHtml).digest('hex'),
 sourceLinks: ['https://example.test/cert'], snapshotSha256: 'a'.repeat(64), rulesVersion: 'test-documents-v1',
 approved: true, eligibleForAutomaticWrite: true, readyForReviewOnly: false,
 migrationDate: '2026-11-14', migrationAuthor: 'Миграция контента',
 proposal: {
  documents_state: 'issued',
  documents: [{ document: 'Сертификат', issuer: 'Институт', registry: [{ name: 'Реестр', subject: 'document', url: 'https://example.test/cert' }] }],
  training_registries: [{ name: 'Обучение', subject: 'training', url: 'https://example.test/training' }],
  nmo: { status: 'possible', audience: 'Врачи', url: 'https://example.test/nmo' },
 },
 reviewedPreimages: inspectVersions(db, 'doc'),
};
const plan = capturePlan(db, [item]);
const receipt = applyPlan(db, plan, { expectedPlanDigest: plan.digest });
writeFileSync(receiptPath, JSON.stringify({ receipt, item }));
db.close();
