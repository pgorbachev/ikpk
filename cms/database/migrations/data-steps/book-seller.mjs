import { createHash } from 'node:crypto';

const SLUG = 'knigi-i-uchebnye-materialy';
const BODY = 'Издательский дом ИКПК выпускает книги и учебные материалы. Продавец книг — ИП Тучанфа В.А.';
const TITLE = 'Книги и учебные материалы';
const SEO_TITLE = 'Книги и учебные материалы — ИКПК';
const SEO_DESCRIPTION = 'Книжные новинки издательского дома ИКПК, акции и ссылки на площадки продавца.';
const DOCUMENT_ID = createHash('sha256').update('ikpk:book-seller-page:v1').digest('hex').slice(0, 24);
const CREATED_AT = 1795766400000;
const PUBLISHED_AT = CREATED_AT + 1;

const EXPECTED_COLUMNS = {
  pages: ['id', 'document_id', 'title', 'slug', 'body', 'legacy_id', 'center_phone', 'manager_phone', 'student_document_form_url', 'created_at', 'updated_at', 'published_at', 'created_by_id', 'updated_by_id', 'locale'],
  components_shared_seos: ['id', 'seo_title', 'seo_description', 'noindex'],
  pages_cmps: ['id', 'entity_id', 'cmp_id', 'component_type', 'field', 'order'],
};

function fail(message) { throw new Error(`Cannot seed book Page: ${message}`); }
function maxId(db, table) { return db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM "${table}"`).get().id; }
function exactColumnSet(actual, expected) {
  const actualSet = new Set(actual), expectedSet = new Set(expected);
  return actualSet.size === actual.length && expectedSet.size === expected.length
    && actualSet.size === expectedSet.size && expected.every((name) => actualSet.has(name));
}

function inspectExisting(db) {
  const rows = db.prepare(`SELECT id, document_id, title, slug, body, legacy_id, published_at
    FROM pages WHERE slug = ? OR legacy_id = ? OR document_id IN
      (SELECT document_id FROM pages WHERE slug = ? OR legacy_id = ?) ORDER BY id`).all(SLUG, SLUG, SLUG, SLUG);
  if (!rows.length) return false;
  const draft = rows.find((row) => row.published_at === null);
  const published = rows.find((row) => row.published_at !== null);
  if (rows.length !== 2 || !draft || !published || !draft.document_id || draft.document_id !== published.document_id
      || rows.some((row) => row.slug !== SLUG || row.legacy_id !== SLUG || row.title !== TITLE)
      || published.body !== BODY) {
    fail('an existing Page is ambiguous or its published text does not match the current site; preserving it and stopping');
  }
  for (const row of rows) {
    const links = db.prepare(`SELECT c.seo_title, c.seo_description, c.noindex, p.component_type, p.field
      FROM pages_cmps p JOIN components_shared_seos c ON c.id = p.cmp_id
      WHERE p.entity_id = ? AND p.component_type = 'shared.seo' AND p.field = 'seo'`).all(row.id);
    if (links.length !== 1 || links[0].seo_title !== SEO_TITLE
        || links[0].seo_description !== SEO_DESCRIPTION || links[0].noindex !== 0) {
      fail('existing Page SEO component or link is not the confirmed seed');
    }
  }
  return true;
}

function insertRows(db) {
  const pageStart = Number(maxId(db, 'pages')) + 1;
  const seoStart = Number(maxId(db, 'components_shared_seos')) + 1;
  const linkStart = Number(maxId(db, 'pages_cmps')) + 1;
  const insertPage = db.prepare(`INSERT INTO pages
    (id, document_id, title, slug, body, legacy_id, center_phone, manager_phone,
     created_at, updated_at, published_at, created_by_id, updated_by_id, locale)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)`);
  const insertSeo = db.prepare(`INSERT INTO components_shared_seos (id, seo_title, seo_description, noindex) VALUES (?, ?, ?, 0)`);
  const insertLink = db.prepare(`INSERT INTO pages_cmps (id, entity_id, cmp_id, component_type, field, "order") VALUES (?, ?, ?, 'shared.seo', 'seo', NULL)`);
  insertPage.run(pageStart, DOCUMENT_ID, TITLE, SLUG, BODY, SLUG, CREATED_AT, CREATED_AT, null);
  insertPage.run(pageStart + 1, DOCUMENT_ID, TITLE, SLUG, BODY, SLUG, CREATED_AT, PUBLISHED_AT, PUBLISHED_AT);
  insertSeo.run(seoStart, SEO_TITLE, SEO_DESCRIPTION);
  insertSeo.run(seoStart + 1, SEO_TITLE, SEO_DESCRIPTION);
  insertLink.run(linkStart, pageStart, seoStart);
  insertLink.run(linkStart + 1, pageStart + 1, seoStart + 1);
  return { createdPages: 2, createdSeoComponents: 2, createdPageLinks: 2 };
}

export function apply(db, { onApplied } = {}) {
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_xinfo("${table}")`).all();
    const found = columns.map(({ name }) => name);
    if (!exactColumnSet(found, expected) || columns.some(({ hidden }) => hidden !== 0)) {
      fail(`unsupported Strapi postimage schema for ${table}`);
    }
  }
  return db.transaction(() => {
    const result = inspectExisting(db) ? { createdPages: 0, createdSeoComponents: 0, createdPageLinks: 0 } : insertRows(db);
    onApplied?.(db, result);
    return result;
  }).immediate();
}
