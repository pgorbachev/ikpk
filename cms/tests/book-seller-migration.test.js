import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const Database = createRequire(import.meta.url)('better-sqlite3');

function database(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pages (
      id INTEGER PRIMARY KEY, document_id varchar(255), title varchar(255), slug varchar(255), body TEXT,
      legacy_id varchar(255), created_at datetime, updated_at datetime, published_at datetime,
      created_by_id integer, updated_by_id integer, locale varchar(255), center_phone varchar(255), manager_phone varchar(255));
    CREATE TABLE components_shared_seos (
      id INTEGER PRIMARY KEY, seo_title varchar(255), seo_description TEXT, noindex boolean);
    CREATE TABLE pages_cmps (
      id INTEGER PRIMARY KEY, entity_id integer, cmp_id integer, component_type varchar(255), field varchar(255), "order" float);
    INSERT INTO pages VALUES (71,'other-doc','Контакты','kontakty','Сохранить','kontakty',100,100,100,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO components_shared_seos VALUES (91,'Контакты','Контактные данные',0);
    INSERT INTO pages_cmps VALUES (111,71,91,'shared.seo','seo',NULL);`);
  t.after(() => db.close());
  return db;
}

async function applyMigration() {
  return (await import('../database/migrations/data-steps/book-seller.mjs')).apply;
}

const read = (db) => Object.fromEntries(['pages', 'components_shared_seos', 'pages_cmps'].map((table) =>
  [table, db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()]));

test('creates the observed Strapi 5 published/draft Page pair, SEO components and links; replay preserves edits', async (t) => {
  const apply = await applyMigration();
  const db = database(t);
  const before = read(db);
  const result = apply(db, { onApplied() {} });
  assert.deepEqual(result, { createdPages: 2, createdSeoComponents: 2, createdPageLinks: 2 });
  const post = read(db);
  const pages = post.pages.filter((row) => row.slug === 'knigi-i-uchebnye-materialy');
  assert.equal(pages.length, 2);
  assert.equal(new Set(pages.map((row) => row.document_id)).size, 1);
  assert.equal(pages.filter((row) => row.published_at === null).length, 1);
  assert.equal(pages.filter((row) => row.published_at !== null).length, 1);
  assert.ok(pages.every((row) => row.body === 'Издательский дом ИКПК выпускает книги и учебные материалы. Продавец книг — ИП Тучанфа В.А.'));
  const links = post.pages_cmps.filter((row) => pages.some((page) => page.id === row.entity_id));
  assert.equal(links.length, 2);
  assert.ok(links.every((row) => row.component_type === 'shared.seo' && row.field === 'seo'));
  assert.deepEqual(post.pages[0], before.pages[0]);
  assert.deepEqual(post.components_shared_seos[0], before.components_shared_seos[0]);
  assert.deepEqual(post.pages_cmps[0], before.pages_cmps[0]);

  db.prepare('UPDATE pages SET body=? WHERE slug=? AND published_at IS NULL')
    .run('Черновик редактора', 'knigi-i-uchebnye-materialy');
  const edited = read(db);
  assert.deepEqual(apply(db, { onApplied() {} }), { createdPages: 0, createdSeoComponents: 0, createdPageLinks: 0 });
  assert.deepEqual(read(db), edited);
});

test('rolls back rows if the atomic ledger callback fails and refuses a partial Page', async (t) => {
  const apply = await applyMigration();
  const db = database(t);
  const before = read(db);
  assert.throws(() => apply(db, { onApplied: () => { throw new Error('ledger write failed'); } }), /ledger write failed/);
  assert.deepEqual(read(db), before);
  db.prepare(`INSERT INTO pages (id,document_id,title,slug,body,legacy_id,published_at)
    VALUES (72,'partial-doc','Книги','knigi-i-uchebnye-materialy','draft','knigi-i-uchebnye-materialy',NULL)`).run();
  const partial = read(db);
  assert.throws(() => apply(db, { onApplied() {} }), /ambiguous/);
  assert.deepEqual(read(db), partial);
});

test('refuses missing or extra page columns without inserting any book records', async (t) => {
  const apply = await applyMigration();
  const extra = database(t);
  extra.exec('ALTER TABLE pages ADD COLUMN unexpected TEXT');
  assert.throws(() => apply(extra, { onApplied() {} }), /unsupported Strapi postimage schema for pages/);
  assert.equal(extra.prepare("SELECT count(*) AS n FROM pages WHERE slug='knigi-i-uchebnye-materialy'").get().n, 0);

  const missing = database(t);
  missing.exec('ALTER TABLE pages DROP COLUMN manager_phone');
  assert.throws(() => apply(missing, { onApplied() {} }), /unsupported Strapi postimage schema for pages/);
  assert.equal(missing.prepare("SELECT count(*) AS n FROM pages WHERE slug='knigi-i-uchebnye-materialy'").get().n, 0);

  const generated = database(t);
  generated.exec('ALTER TABLE pages ADD COLUMN generated_extra TEXT GENERATED ALWAYS AS (id + 1) VIRTUAL');
  assert.throws(() => apply(generated, { onApplied() {} }), /unsupported Strapi postimage schema for pages/);
  assert.equal(generated.prepare("SELECT count(*) AS n FROM pages WHERE slug='knigi-i-uchebnye-materialy'").get().n, 0);
});

test('first run accepts only the current-site pair regardless of documentId', async (t) => {
  const apply = await applyMigration();
  const db = database(t);
  const slug = 'knigi-i-uchebnye-materialy';
  const expected = 'Издательский дом ИКПК выпускает книги и учебные материалы. Продавец книг — ИП Тучанфа В.А.';
  const doc = createHash('sha256').update('ikpk:book-seller-page:v1').digest('hex').slice(0, 24);
  const page = db.prepare(`INSERT INTO pages (id,document_id,title,slug,body,legacy_id,created_at,updated_at,published_at)
    VALUES (?,?,'Книги и учебные материалы',?,?,?,100,100,100)`);
  page.run(72, doc, slug, expected, slug);
  page.run(73, doc, slug, expected, slug);
  db.prepare(`UPDATE pages SET published_at=NULL WHERE id=72`).run();
  db.prepare('INSERT INTO components_shared_seos VALUES (92,?,?,0),(93,?,?,0)')
    .run('Книги и учебные материалы — ИКПК','Книжные новинки издательского дома ИКПК, акции и ссылки на площадки продавца.',
      'Книги и учебные материалы — ИКПК','Книжные новинки издательского дома ИКПК, акции и ссылки на площадки продавца.');
  db.prepare(`INSERT INTO pages_cmps VALUES (112,72,92,'shared.seo','seo',NULL),(113,73,93,'shared.seo','seo',NULL)`).run();
  assert.deepEqual(apply(db, { onApplied() {} }), { createdPages: 0, createdSeoComponents: 0, createdPageLinks: 0 });

  db.prepare('UPDATE pages SET document_id=? WHERE id IN (72,73)').run('not-the-seed-hash');
  assert.deepEqual(apply(db, { onApplied() {} }), { createdPages: 0, createdSeoComponents: 0, createdPageLinks: 0 });
  db.prepare('UPDATE pages SET document_id=?,body=? WHERE id IN (72,73)').run(doc, 'Чужой текст');
  assert.throws(() => apply(db, { onApplied() {} }), /current site/i);
});
