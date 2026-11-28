import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSiteStudentDocumentForm } from './site-student-document-form';

const URL = 'https://b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/?telemetry_sign=approved';
function fixture({ roles = ['content-admin'], body = 'Опубликованный текст', draftBody = body } = {}) {
  const pages = [
    { id: 1, document_id: 'oplata-doc', slug: 'oplata', legacy_id: 'oplata', published_at: null,
      updated_at: 100, student_document_form_url: URL, title: 'Оплата', body: draftBody, center_phone: null, manager_phone: null, seo: null },
    { id: 2, document_id: 'oplata-doc', slug: 'oplata', legacy_id: 'oplata', published_at: 90,
      updated_at: 90, student_document_form_url: URL, title: 'Оплата', body, center_phone: null, manager_phone: null, seo: null },
  ];
  const routes = [];
  const trx = (table) => {
    let selected = pages;
    const builder = {
      select() { return builder; }, where(key, value) {
        if (key && typeof key === 'object' && 'id' in key) selected = pages.filter(page => page.id === key.id);
        return builder;
      }, orWhere() { return builder; },
      orderBy() { return builder; }, forUpdate() { return builder; },
      then(resolve, reject) { return Promise.resolve(selected).then(resolve, reject); },
      async update(values) { const row = selected[0]; Object.assign(row, values); return 1; },
    };
    if (table !== 'pages') throw new Error(`unexpected table ${table}`);
    return builder;
  };
  const strapi = {
    admin: { routes: { admin: { routes } } },
    db: {
      query(uid) { return { async findOne() { return uid === 'admin::user' ? { roles: roles.map(code => ({ code })) } : null; } }; },
      async transaction(callback) { return callback({ trx }); },
    },
  };
  registerSiteStudentDocumentForm(strapi);
  const makeContext = (method, userId = 7, bodyArg = undefined, ifMatch = '') => ({
    method, state: { user: { id: userId } }, query: {}, request: { body: bodyArg }, headers: { 'if-match': ifMatch },
    get(name) { return name === 'If-Match' ? this.headers['if-match'] : ''; },
    forbidden(message) { this.status = 403; this.body = { message }; return this.body; },
    badRequest(message) { this.status = 400; this.body = { message }; return this.body; },
    conflict(message) { this.status = 409; this.body = { message }; return this.body; },
  });
  const handlerFor = (path) => routes.find(route => route.path === path).handler;
  return { pages, handlerFor, makeContext };
}

test('publish updates only the address and keeps the unrelated draft pending', async () => {
  const { pages, handlerFor, makeContext } = fixture({ draftBody: 'Несвязанный черновик' });
  const read = makeContext('GET');
  await handlerFor('/site-student-document-form')(read);
  const priorDraftTime = pages[0].updated_at;
  const oldValue = pages[1].student_document_form_url;
  const next = 'https://b24-cbqwqo.bitrix24site.ru/crm_form_new7/?sig=next';
  const publish = makeContext('POST', 7, { student_document_form_url: next }, `"${read.body.revision}"`);
  await handlerFor('/site-student-document-form/publish')(publish);
  assert.equal(publish.status, undefined);
  assert.equal(pages[0].body, 'Несвязанный черновик');
  assert.equal(pages[0].student_document_form_url, next);
  assert.equal(pages[1].student_document_form_url, next);
  assert.notEqual(pages[1].student_document_form_url, oldValue);
  assert.ok(Number(pages[0].updated_at) > priorDraftTime);
  assert.ok(Number(pages[0].updated_at) > Number(pages[1].updated_at));
  assert.equal(publish.body.draft, next);
});

test('If-Match allows the first write and rejects a stale concurrent second write', async () => {
  const { pages, handlerFor, makeContext } = fixture();
  const read = makeContext('GET'); await handlerFor('/site-student-document-form')(read);
  const first = makeContext('PUT', 7, { student_document_form_url: URL + '&revision=one' }, `"${read.body.revision}"`);
  const second = makeContext('PUT', 7, { student_document_form_url: URL + '&revision=two' }, `"${read.body.revision}"`);
  await handlerFor('/site-student-document-form/draft')(first);
  await handlerFor('/site-student-document-form/draft')(second);
  assert.equal(first.status, undefined);
  assert.equal(second.status, 409);
  assert.equal(pages[0].student_document_form_url, URL + '&revision=one');
});

test('roles are reloaded from the database; unauthorized users cannot read or write', async () => {
  const { handlerFor, makeContext } = fixture({ roles: ['strapi-author'] });
  const context = makeContext('PUT', 7, { student_document_form_url: URL }, '"revision"');
  await handlerFor('/site-student-document-form/draft')(context);
  assert.equal(context.status, 403);
});

test('the endpoint rejects invalid addresses and fields outside its single-field contract', async () => {
  const { handlerFor, makeContext } = fixture();
  const invalid = makeContext('PUT', 7, { student_document_form_url: 'https://evil.test/' }, '"revision"');
  await handlerFor('/site-student-document-form/draft')(invalid);
  assert.equal(invalid.status, 400);
  const extra = makeContext('PUT', 7, { student_document_form_url: URL, body: 'replace content' }, '"revision"');
  await handlerFor('/site-student-document-form/draft')(extra);
  assert.equal(extra.status, 400);
});
