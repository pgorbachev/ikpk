import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sourceHtml = '<p>Сертификат <a href="https://example.test/cert">реестр</a></p>';
export const proposal = () => ({
  documentId: 'sem-a', route: '/institute/section/example', sourceHtml,
  sourceSha256: sha(sourceHtml), sourceLinks: ['https://example.test/cert'],
  snapshotSha256: 'a'.repeat(64), rulesVersion: 'documents-test-v1',
  approved: true, eligibleForAutomaticWrite: true, readyForReviewOnly: false,
  migrationDate: '2026-11-13', migrationAuthor: 'Миграция контента',
  proposal: { documents_state: 'issued', documents: [
    { document: 'Первый', issuer: 'Институт', prior_education: 'medical', registry: [
      { name: 'Реестр документа', subject: 'document', url: 'https://example.test/cert' },
      { name: 'Второй реестр', subject: 'document', url: 'https://example.test/second' },
    ] },
    { document: 'Второй', issuer: 'Организация', prior_education: 'unspecified' },
  ], training_registries: [
    { name: 'Обучение 1', subject: 'training', international: true, url: 'https://example.test/training' },
    { name: 'Обучение 2', subject: 'training', international: false },
  ], nmo: { status: 'possible', audience: 'Врачи', url: 'https://example.test/nmo' } },
});
export function database(path) {
  const db = new DatabaseSync(path);
  db.transaction = (fn) => ({ immediate: () => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  } });
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE seminars (id INTEGER PRIMARY KEY, document_id TEXT, slug TEXT, legacy_id TEXT, name TEXT, full_text TEXT, published_at TEXT, documents_state TEXT, documents_confirmation_date TEXT, documents_confirmation_source TEXT, documents_confirmation_author TEXT, documents_owner_verified BOOLEAN);
    CREATE TABLE institutes (id INTEGER PRIMARY KEY, slug TEXT);
    CREATE TABLE course_groups (id INTEGER PRIMARY KEY, slug TEXT);
    CREATE TABLE seminars_course_group_lnk (id INTEGER PRIMARY KEY, seminar_id INTEGER, course_group_id INTEGER);
    CREATE TABLE course_groups_institute_lnk (id INTEGER PRIMARY KEY, course_group_id INTEGER, institute_id INTEGER);
    CREATE TABLE seminars_cmps (id INTEGER PRIMARY KEY, entity_id INTEGER, cmp_id INTEGER, component_type TEXT, field TEXT, "order" REAL);
    CREATE TABLE components_seminar_document_records (id INTEGER PRIMARY KEY, document TEXT, issuer TEXT, issuer_unknown BOOLEAN, prior_education TEXT, prior_education_note TEXT, outcome TEXT, basis TEXT, completion_scope TEXT, other_seminar_href TEXT, other_seminar_label TEXT, signed_by TEXT, qualification_topic TEXT, hours_mode TEXT, includes_completed_level BOOLEAN, completion_required BOOLEAN, completion_after_seminar_number INTEGER, completion_cycle_name TEXT, hours_may_vary BOOLEAN, regulation_url TEXT, document_type_unspecified BOOLEAN, regulation_issuer TEXT, document_on_template BOOLEAN);
    CREATE TABLE components_seminar_document_records_cmps (id INTEGER PRIMARY KEY, entity_id INTEGER, cmp_id INTEGER, component_type TEXT, field TEXT, "order" REAL);
    CREATE TABLE components_seminar_registry_facts (id INTEGER PRIMARY KEY, name TEXT, international BOOLEAN, subject TEXT, url TEXT, basis TEXT);
    CREATE TABLE components_seminar_nmo_facts (id INTEGER PRIMARY KEY, status TEXT, audience TEXT, awarded_for TEXT, url TEXT, completion_required BOOLEAN, purpose TEXT);
    CREATE TABLE components_shared_seos (id INTEGER PRIMARY KEY, seo_title TEXT);
    INSERT INTO seminars VALUES (11,'sem-a','example','/institute/section/example','Draft name','${sourceHtml}',NULL,'unconfirmed',NULL,NULL,NULL,0), (12,'sem-a','example','/institute/section/example','Published name','${sourceHtml}','2026-01-01','unconfirmed',NULL,NULL,NULL,0), (21,'sem-b','other','/institute/section/other','Other','keep',NULL,NULL,NULL,NULL,NULL,0);
    INSERT INTO institutes VALUES (1,'institute'); INSERT INTO course_groups VALUES (1,'section');
    INSERT INTO seminars_course_group_lnk VALUES (1,11,1),(2,12,1),(3,21,1); INSERT INTO course_groups_institute_lnk VALUES (1,1,1);
    INSERT INTO components_shared_seos VALUES (9,'SEO stays');
    INSERT INTO seminars_cmps VALUES (1,11,9,'shared.seo','seo',1), (2,12,9,'shared.seo','seo',1);
  `);
  return db;
}
