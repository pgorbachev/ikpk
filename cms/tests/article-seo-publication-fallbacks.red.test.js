import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPublication as cmsCheck } from '../src/lib/publication-validation.ts';
import { checkPublication as scriptsCheck } from '../../scripts/lib/cms-publication-validation.ts';
import { registerPublicationLifecycle } from '../src/lifecycles/publication';

const completeArticle = {
  title: 'Заголовок статьи', slug: 'article-seo-red', body: '<script>удалено</script>',
  image: { id: 1 }, published_date: '2026-11-17T00:00:00.000Z', categories: [{ id: 1 }],
};

function lifecycle(article) {
  let middleware;
  const strapi = {
    requestContext: { get: () => ({ state: { auth: { strategy: { name: 'admin' }, credentials: { type: 'full-access' } } } }) },
    documents: () => ({ findOne: async () => article }),
    db: { query: () => ({ findMany: async () => [] }) },
  };
  strapi.documents.use = (handler) => { middleware = handler; };
  registerPublicationLifecycle(strapi);
  return (params) => middleware({ uid: 'api::article.article', action: 'publish', params: { documentId: 'article-seo-red', ...params } }, async () => 'published');
}

test('CMS and scripts validators accept absent or blank Article SEO only, preserving other required fields', () => {
  const rejected = [];
  for (const record of [
    { ...completeArticle, seo_title: undefined, seo_description: undefined },
    { ...completeArticle, seo_title: '   ', seo_description: null },
    { ...completeArticle, seo_title: 'Редакторский заголовок', seo_description: '' },
    { ...completeArticle, seo_title: '', seo_description: 'Редакторское описание' },
  ]) {
    const normalized = {
      title: record.title, identifier: record.slug, body: record.body,
      seo_title: record.seo_title, seo_description: record.seo_description,
      image: record.image, published_at: record.published_date, categories: record.categories,
    };
    const cms = cmsCheck({ type: 'article', record: normalized });
    const scripts = scriptsCheck({ type: 'article', record: normalized });
    assert.deepEqual(cms, scripts, 'the synchronized validators diverged');
    if (!cms.ok) rejected.push(`${JSON.stringify([record.seo_title, record.seo_description])}: ${cms.message}`);
  }
  for (const missing of ['title', 'identifier', 'body', 'image', 'published_at', 'categories']) {
    const record = { title: 't', identifier: 's', body: 'b', image: 'i', published_at: 'date', categories: ['c'] };
    delete record[missing];
    for (const validate of [cmsCheck, scriptsCheck]) {
      assert.equal(validate({ type: 'article', record }).ok, false, `${missing} must remain required`);
    }
  }
  assert.equal(cmsCheck({ type: 'static-page', record: { title: 't', identifier: 'x', body: 'b' } }).ok, false,
    'SEO remains required for non-Article content types');
  assert.deepEqual(rejected, [], `Article SEO overrides are optional; rejected cases: ${rejected.join('; ')}`);
});

test('CMS lifecycle publishes nested SEO omission or partial values without deriving or persisting defaults', async () => {
  const outcomes = [];
  for (const seo of [undefined, null, {}, { seo_title: 'Редакторский заголовок' }, { seo_description: 'Редакторское описание' }]) {
    const article = { ...completeArticle, ...(seo === undefined ? {} : { seo }) };
    let result;
    try { result = await lifecycle(article)({}); }
    catch (error) { outcomes.push(`${JSON.stringify(seo)}: ${error.message}`); continue; }
    assert.equal(result, 'published');
    assert.deepEqual(article.seo, seo, 'publication must not persist generated defaults into CMS');
  }
  assert.deepEqual(outcomes, [], `nested optional SEO rejected: ${outcomes.join('; ')}`);
});

test('CMS lifecycle does not require the web sanitizer to leave a description fallback', async () => {
  const article = { ...completeArticle, seo: null };
  assert.equal(await lifecycle(article)({}), 'published');
});

test('publication validates the persisted nested SEO component after a partial update payload', async () => {
  const persisted = {
    ...completeArticle,
    seo: { seo_title: 'Старый заголовок', seo_description: 'Сохраняемое описание' },
  };
  const result = await lifecycle(persisted)({
    data: { seo: { seo_title: 'Новый заголовок' } },
  });
  assert.equal(result, 'published');
  assert.deepEqual(persisted.seo, {
    seo_title: 'Старый заголовок', seo_description: 'Сохраняемое описание',
  }, 'lifecycle must not replace the persisted component with a partial request payload');
});
