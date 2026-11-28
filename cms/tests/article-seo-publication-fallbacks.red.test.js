import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPublication as cmsCheck } from '../src/lib/publication-validation.ts';
import { checkPublication as scriptsCheck } from '../../scripts/lib/cms-publication-validation.ts';
import { registerPublicationLifecycle } from '../src/lifecycles/publication';

const completeArticle = {
  title: 'Заголовок статьи', slug: 'article-seo-red', body: '<script>удалено</script>',
  image: { id: 1 }, published_date: '2026-11-17T00:00:00.000Z', categories: [{ id: 1 }],
};

function lifecycle(article, action = 'publish') {
  let middleware;
  let activeTransaction = null;
  let activeTransactionHooks = null;
  const strapi = {
    requestContext: { get: () => ({ state: { auth: { strategy: { name: 'admin' }, credentials: { type: 'full-access' } } } }) },
    documents: () => ({
      findOne: async () => article,
      update: async ({ data }) => Object.assign(article, data),
    }),
    db: {
      config: { connection: { client: 'sqlite' } },
      inTransaction() { return activeTransaction !== null; },
      async transaction(callback) {
        if (!callback) return { get: () => activeTransaction };
        if (activeTransaction && activeTransactionHooks) {
          return callback({
            trx: activeTransaction,
            onCommit(fn) { activeTransactionHooks.commit.push(fn); },
            onRollback(fn) { activeTransactionHooks.rollback.push(fn); },
          });
        }
        const trx = { async raw() {} };
        activeTransaction = trx;
        const hooks = { commit: [], rollback: [] };
        activeTransactionHooks = hooks;
        try {
          const result = await callback({
            trx,
            onCommit(fn) { hooks.commit.push(fn); },
            onRollback(fn) { hooks.rollback.push(fn); },
          });
          hooks.commit.forEach((fn) => fn());
          return result;
        } catch (error) {
          hooks.rollback.forEach((fn) => fn());
          throw error;
        } finally {
          activeTransaction = null;
          activeTransactionHooks = null;
        }
      },
      query: () => ({ findMany: async () => [] }),
    },
  };
  strapi.documents.use = (handler) => { middleware = handler; };
  registerPublicationLifecycle(strapi);
  return (params) => {
    const contextParams = { documentId: 'article-seo-red', ...params };
    return middleware({ uid: 'api::article.article', action, params: contextParams }, async () => {
      if (action === 'update') Object.assign(article, contextParams.data ?? {});
      return 'published';
    });
  };
}

test('CMS and scripts validators accept optional Article SEO and image, preserving other required fields', () => {
  const rejected = [];
  for (const record of [
    { ...completeArticle, image: null, seo_title: undefined, seo_description: undefined },
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
  for (const missing of ['title', 'identifier', 'body', 'published_at']) {
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
    const expectedSeo = structuredClone(seo);
    const article = { ...completeArticle, ...(seo === undefined ? {} : { seo }) };
    let result;
    try { result = await lifecycle(article)({}); }
    catch (error) { outcomes.push(`${JSON.stringify(seo)}: ${error.message}`); continue; }
    assert.equal(result, 'published');
    assert.deepEqual(article.seo, expectedSeo, 'publication must not persist generated defaults into CMS');
  }
  assert.deepEqual(outcomes, [], `nested optional SEO rejected: ${outcomes.join('; ')}`);
});

test('CMS lifecycle does not require the web sanitizer to leave a description fallback', async () => {
  const article = { ...completeArticle, image: null, seo: null };
  assert.equal(await lifecycle(article)({}), 'published');
});

test('publication validates the persisted nested SEO component after a partial update payload', async () => {
  const persisted = {
    ...completeArticle,
    seo: { seo_title: 'Старый заголовок', seo_description: 'Сохраняемое описание' },
  };
  const result = await lifecycle(persisted, 'update')({
    status: 'published',
    data: { seo: { seo_title: 'Новый заголовок' } },
  });
  assert.equal(result, 'published');
  assert.deepEqual(persisted.seo, {
    seo_title: 'Новый заголовок', seo_description: 'Сохраняемое описание',
  }, 'a partial update changes only the supplied SEO field and retains the persisted description');
});
