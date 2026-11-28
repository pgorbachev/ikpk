import assert from 'node:assert/strict';
import test from 'node:test';
import { registerEditorCardRestrictions } from './editor-role.ts';

type Seo = { seo_title: string; seo_description: string; og_title: string; og_description: string; noindex: boolean; og_image: { id: number } };
const seo: Seo = { seo_title: 'SEO', seo_description: 'Описание', og_title: 'OG заголовок', og_description: 'OG описание', noindex: true, og_image: { id: 17 } };

type Middleware = (context: { uid: string; action: string; params: { documentId: string; data?: Record<string, unknown> } }, next: () => Promise<void>) => Promise<void>;
function setup(draft: Seo | null, published: Seo | null = draft): Middleware {
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

for (const [uid, name] of [[institute, 'институт'], [program, 'программа']] as const) {
  test(`${name}: пустой SEO-компонент не позволяет передать защищённые поля`, async () => {
    const middleware = setup(null);
    const data: Record<string, unknown> = { seo: {
      seo_title: 'Разрешённый заголовок', seo_description: 'Разрешённое описание',
      og_title: uid === institute ? 'Запрещённый OG' : null, og_description: 'OG текст', noindex: true, og_image: 99,
    } };
    let called = false;
    await middleware({ uid, action: 'update', params: { documentId: 'new', data } }, async () => { called = true; });
    assert.equal(called, true);
    const result = data.seo as Record<string, unknown>;
    assert.equal(result.seo_title, 'Разрешённый заголовок');
    assert.equal(result.seo_description, 'Разрешённое описание');
    assert.notEqual(result.noindex, true);
    assert.notEqual(result.og_image, 99);
    if (uid === institute) {
      assert.equal(result.og_title == null, true);
      assert.equal(result.og_description == null, true);
    } else {
      assert.equal(result.og_title, null);
      assert.equal(result.og_description, 'OG текст');
    }
  });
}

test('программа: явный null SEO очищает разрешённые поля и сохраняет защищённые', async () => {
  const middleware = setup(seo);
  const data: Record<string, unknown> = { seo: null };
  await middleware({ uid: program, action: 'update', params: { documentId: 'p', data } }, async () => {});
  assert.deepEqual(data.seo, { seo_title: null, seo_description: null, og_title: null,
    og_description: null, noindex: true, og_image: 17 });
});
