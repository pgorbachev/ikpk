import assert from 'node:assert/strict';
import test from 'node:test';
import { registerEditorCardRestrictions } from './editor-role.ts';

type Seo = { seo_title: string; seo_description: string; og_title: string; og_description: string; noindex: boolean; og_image: { id: number } };
const seo: Seo = { seo_title: 'SEO', seo_description: 'Описание', og_title: 'OG заголовок', og_description: 'OG описание', noindex: true, og_image: { id: 17 } };

type Middleware = (context: { uid: string; action: string; params: { documentId: string; data?: Record<string, unknown> } }, next: () => Promise<void>) => Promise<void>;
function setup(draft: Seo, published: Seo = draft): Middleware {
  let middleware: Middleware | undefined;
  const docs = Object.assign((_uid: string) => ({
    findOne: async ({ status }: { status: string }) => ({ seo: status === 'draft' ? draft : published }),
  }), { use: (fn: Middleware) => { middleware = fn; } });
  const strapi = {
    documents: docs,
    requestContext: { get: () => ({ state: { user: { roles: [{ code: 'strapi-editor' }] } } }) },
    db: { transaction: async (fn: () => Promise<void>) => fn() },
  };
  registerEditorCardRestrictions(strapi as never);
  assert.ok(middleware);
  return middleware;
}

const program = 'api::course-group.course-group';
const institute = 'api::institute.institute';

test('программа сохраняет отсутствующие в запросе OG-поля и принимает изменённые', async () => {
  const middleware = setup(seo);
  const data: Record<string, unknown> = { seo: { seo_title: 'Новый SEO', og_title: 'Новый OG' } };
  await middleware({ uid: program, action: 'update', params: { documentId: 'p', data } }, async () => {});
  assert.deepEqual(data.seo, { seo_title: 'Новый SEO', seo_description: seo.seo_description,
    og_title: 'Новый OG', og_description: seo.og_description, noindex: true, og_image: 17 });
});

test('институт сохраняет защищённые OG-поля при редактировании SEO', async () => {
  const middleware = setup(seo);
  const data: Record<string, unknown> = { seo: { seo_title: 'Новый SEO', og_title: 'Обход прав', og_description: 'Обход прав' } };
  await middleware({ uid: institute, action: 'update', params: { documentId: 'i', data } }, async () => {});
  assert.deepEqual(data.seo, { seo_title: 'Новый SEO', seo_description: seo.seo_description,
    og_title: seo.og_title, og_description: seo.og_description, noindex: true, og_image: 17 });
});

for (const action of ['publish', 'discardDraft']) {
  for (const field of ['og_title', 'og_description'] as const) {
    test(`институт запрещает ${action}, когда в черновике изменён защищённый ${field}`, async () => {
      const middleware = setup({ ...seo, [field]: 'Изменение администратора' }, seo);
      let called = false;
      await assert.rejects(middleware({ uid: institute, action, params: { documentId: 'i' } }, async () => { called = true; }));
      assert.equal(called, false);
    });
  }
}
