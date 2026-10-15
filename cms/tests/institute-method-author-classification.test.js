import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applyClassification, planClassification } from '../scripts/institute-method-author-classification.mjs';

const TARGETS = [
  ['63', 'Шрайнер Валерий Эдуардович, MD, CST-D', 'institut-apledzhera'],
  ['64', 'Радзинская Елена Викторовна', 'institut-apledzhera'],
  ['65', 'Diego Maggio', 'institut-apledzhera'],
  ['66', 'Thomas Rasmussen', 'institut-apledzhera'],
  ['67', 'George Michael Morgan', 'institut-apledzhera'],
  ['68', 'Kenneth Koles Richard', 'institut-apledzhera'],
  ['74', 'Patricia Quirini', 'institut-apledzhera'],
  ['77', 'Chas Perry', 'institut-apledzhera'],
  ['79', 'Carol J. McLellan', 'institut-apledzhera'],
  ['69', 'Roberto Bonanzinga', 'institut-barralya'],
  ['70', 'Matteo Ghiretti', 'institut-barralya'],
  ['71', 'Paolo Ricci', 'institut-barralya'],
];

function createDatabase({ unexpected = false, unlinkedDraft = false, changedDraftLegacyId = false } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE teachers (
      id INTEGER PRIMARY KEY, document_id TEXT, legacy_id TEXT, name TEXT,
      trait TEXT, slug TEXT, bio TEXT, published_at TEXT, locale TEXT
    );
    CREATE TABLE institutes (
      id INTEGER PRIMARY KEY, document_id TEXT, legacy_id TEXT, name TEXT, slug TEXT
    );
    CREATE TABLE teachers_institute_lnk (id INTEGER PRIMARY KEY, teacher_id INTEGER, institute_id INTEGER);
    CREATE TABLE strapi_database_schema (id INTEGER PRIMARY KEY, schema TEXT, time TEXT, hash TEXT);
  `);
  const institute = db.prepare('INSERT INTO institutes VALUES (?, ?, ?, ?, ?)');
  institute.run(1, 'ikpk-doc', 'institut-klinicheskoy-prikladnoy-kineziologii', 'Институт клинической прикладной кинезиологии', 'institut-klinicheskoy-prikladnoy-kineziologii');
  institute.run(2, 'ap-doc', 'institut-apledzhera', 'Институт Апледжера', 'institut-apledzhera');
  institute.run(3, 'bar-doc', 'institut-barralya', 'Институт Барраля', 'institut-barralya');
  const person = db.prepare('INSERT INTO teachers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const link = db.prepare('INSERT INTO teachers_institute_lnk (teacher_id, institute_id) VALUES (?, ?)');
  let id = 1;
  for (const [legacyId, name, slug] of TARGETS) {
    const instituteId = slug === 'institut-apledzhera' ? 2 : 3;
    const trait = legacyId === '63' || legacyId === '64' ? 'teacher' : 'method-author';
    for (const publishedAt of [null, '2026-10-13T18:00:00.000Z']) {
      const rowLegacyId = changedDraftLegacyId && legacyId === '63' && publishedAt === null ? '630' : legacyId;
      person.run(id, `document-${legacyId}`, rowLegacyId, name, trait, `slug-${legacyId}`, `preserve-${legacyId}`, publishedAt, 'ru');
      if (!(unlinkedDraft && legacyId === '63' && publishedAt === null)
          && !(changedDraftLegacyId && legacyId === '63' && publishedAt === null)) link.run(id, instituteId);
      id += 1;
    }
  }
  person.run(id, 'ikpk-document', '53', 'Жарова Людмила Семеновна', 'teacher', '53', 'keep-ikpk', null, 'ru');
  link.run(id, 1);
  if (unexpected) {
    id += 1;
    person.run(id, 'unexpected-document', '99', 'Неожиданный сотрудник', 'teacher', '99', 'keep-unexpected', null, 'ru');
    link.run(id, 2);
  }
  return db;
}

test('dry-run reports the two teacher corrections and performs no writes', () => {
  const db = createDatabase();
  try {
    const before = db.prepare('SELECT * FROM teachers ORDER BY id').all();
    const plan = planClassification(db);
    assert.equal(plan.logicalPeople, 12);
    assert.equal(plan.physicalRows, 24);
    assert.deepEqual(plan.changes.map(({ legacyId, name }) => [legacyId, name]), TARGETS.slice(0, 2).map(([id, name]) => [id, name]));
    assert.equal(plan.noops.length, 10);
    assert.deepEqual(db.prepare('SELECT * FROM teachers ORDER BY id').all(), before);
  } finally {
    db.close();
  }
});

test('apply changes only trait in every draft and published row; a second apply is a no-op', () => {
  const db = createDatabase();
  try {
    const before = db.prepare('SELECT * FROM teachers ORDER BY id').all();
    const result = applyClassification(db);
    assert.equal(result.updatedRows, 4);
    const after = db.prepare('SELECT * FROM teachers ORDER BY id').all();
    assert.deepEqual(after.map(({ trait, ...rest }) => rest), before.map(({ trait, ...rest }) => rest));
    assert.deepEqual(after.slice(0, 4).map((row) => row.trait), Array(4).fill('method-author'));
    assert.equal(after.at(-1).trait, 'teacher');
    assert.deepEqual(applyClassification(db), { updatedRows: 0, noops: 12 });
  } finally {
    db.close();
  }
});

test('preflight aborts on an unexpected person in either institute', () => {
  const db = createDatabase({ unexpected: true });
  try {
    assert.throws(() => applyClassification(db), /unexpected|unexpectedly|неожидан/i);
    assert.equal(db.prepare('SELECT trait FROM teachers WHERE legacy_id = ? LIMIT 1').get('63').trait, 'teacher');
  } finally {
    db.close();
  }
});

test('preflight aborts on mismatched identity or unsupported trait without partial writes', () => {
  const db = createDatabase();
  try {
    db.prepare('UPDATE teachers SET name = ? WHERE legacy_id = ?').run('Иное имя', '64');
    assert.throws(() => applyClassification(db), /name|identity|идентич/i);
    assert.equal(db.prepare('SELECT trait FROM teachers WHERE legacy_id = ? LIMIT 1').get('63').trait, 'teacher');
  } finally {
    db.close();
  }
});

test('preflight rejects a target draft row whose institute relation is missing', () => {
  const db = createDatabase({ unlinkedDraft: true });
  try {
    assert.throws(() => applyClassification(db), /institute|institution|институт/i);
    assert.equal(db.prepare('SELECT trait FROM teachers WHERE legacy_id = ? LIMIT 1').get('63').trait, 'teacher');
  } finally {
    db.close();
  }
});

test('preflight rejects an unrecognized physical version sharing a target documentId', () => {
  const db = createDatabase({ changedDraftLegacyId: true });
  try {
    assert.throws(() => applyClassification(db), /physical versions|physical row|legacy_id/i);
    assert.equal(db.prepare('SELECT trait FROM teachers WHERE legacy_id = ? LIMIT 1').get('64').trait, 'teacher');
  } finally {
    db.close();
  }
});

test('database write failure rolls back the earlier trait-only updates in the transaction', () => {
  const db = createDatabase();
  try {
    db.exec("CREATE TRIGGER reject_second_teacher BEFORE UPDATE OF trait ON teachers WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'injected update failure'); END;");
    assert.throws(() => applyClassification(db), /injected update failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM teachers WHERE legacy_id IN (?, ?) AND trait = ?').get('63', '64', 'teacher').count, 4);
  } finally {
    db.close();
  }
});
