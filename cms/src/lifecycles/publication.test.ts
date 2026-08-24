import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPublicationLifecycle } from './publication';

type MiddlewareContext = {
  uid: string;
  action: string;
  params: Record<string, unknown>;
};
type Middleware = (context: MiddlewareContext, next: () => Promise<unknown>) => Promise<unknown>;

interface FakeArticle {
  slug: string;
  publishedAt: string | null;
  categories?: { slug: string }[];
}

function makeStrapi(opts: {
  draftsByUid?: Record<string, Record<string, unknown>>;
  courseGroupsByDocumentId?: Record<string, { slug: string }>;
  articles?: FakeArticle[];
}) {
  let middleware!: Middleware;
  const drafts = opts.draftsByUid ?? {};
  const courseGroups = opts.courseGroupsByDocumentId ?? {};
  const articles = opts.articles ?? [];

  const strapi = {
    documents(uid: string) {
      return {
        async findOne({ documentId }: { documentId: string; status?: string }) {
          if (uid === 'api::course-group.course-group') return courseGroups[documentId] ?? null;
          return drafts[documentId] ?? null;
        },
      };
    },
    db: {
      query(uid: string) {
        return {
          async findMany() {
            if (uid === 'api::article.article') return articles;
            return [];
          },
        };
      },
    },
  };
  (strapi as unknown as { documents: Middleware & { use: (m: Middleware) => void } }).documents.use = (m: Middleware) => {
    middleware = m;
  };

  registerPublicationLifecycle(strapi as unknown as Parameters<typeof registerPublicationLifecycle>[0]);
  const run = (context: MiddlewareContext) => middleware(context, async () => 'next-called');
  return { run };
}

test('publish: отклоняет публикацию института без обязательного поля', async () => {
  const { run } = makeStrapi({
    draftsByUid: {
      'doc-1': { name: 'Институт', slug: 'apledzher', description: '', order: 0, seo: null },
    },
  });
  await assert.rejects(
    () => run({ uid: 'api::institute.institute', action: 'publish', params: { documentId: 'doc-1' } }),
    /не заполнены обязательные поля/,
  );
});

test('publish: пропускает институт со всеми обязательными полями', async () => {
  const { run } = makeStrapi({
    draftsByUid: {
      'doc-1': {
        name: 'Институт',
        slug: 'apledzher',
        description: 'текст',
        order: 1,
        seo: { seo_title: 'заголовок', seo_description: 'описание' },
      },
    },
  });
  const result = await run({ uid: 'api::institute.institute', action: 'publish', params: { documentId: 'doc-1' } });
  assert.equal(result, 'next-called');
});

test('publish: не блокирует create/update — только действие publish', async () => {
  const { run } = makeStrapi({ draftsByUid: {} });
  const result = await run({ uid: 'api::institute.institute', action: 'update', params: { documentId: 'doc-1', data: {} } });
  assert.equal(result, 'next-called');
});

test('publish: семинар с documentsState=issued требует непустого набора документов', async () => {
  const { run } = makeStrapi({
    draftsByUid: {
      'doc-1': {
        name: 'Семинар',
        slug: 'dolgoletie',
        course_group: { id: 1 },
        description: 'текст',
        seo: { seo_title: 't', seo_description: 'd' },
        documents_state: 'issued',
        documents: [],
      },
    },
  });
  await assert.rejects(
    () => run({ uid: 'api::seminar.seminar', action: 'publish', params: { documentId: 'doc-1' } }),
    /документ/,
  );
});

test('publish: запись о документе без выдающего лица отклоняется', async () => {
  const { run } = makeStrapi({
    draftsByUid: {
      'doc-1': {
        name: 'Семинар',
        slug: 'dolgoletie',
        course_group: { id: 1 },
        description: 'текст',
        seo: { seo_title: 't', seo_description: 'd' },
        documents_state: 'issued',
        documents: [{ document: 'Диплом', issuer: '' }],
      },
    },
  });
  await assert.rejects(
    () => run({ uid: 'api::seminar.seminar', action: 'publish', params: { documentId: 'doc-1' } }),
    /выдающее лицо/,
  );
});

test('publish: значение «иное» у исходного образования требует уточняющего текста', async () => {
  const { run } = makeStrapi({
    draftsByUid: {
      'doc-1': {
        name: 'Семинар',
        slug: 'dolgoletie',
        course_group: { id: 1 },
        description: 'текст',
        seo: { seo_title: 't', seo_description: 'd' },
        documents_state: 'issued',
        documents: [{ document: 'Диплом', issuer: 'ИКПК', prior_education: 'other' }],
      },
    },
  });
  await assert.rejects(
    () => run({ uid: 'api::seminar.seminar', action: 'publish', params: { documentId: 'doc-1' } }),
    /уточняющего текста/,
  );
});

test('publish: недопустимое значение признака персоны отклоняется', async () => {
  const { run } = makeStrapi({
    draftsByUid: { 'doc-1': { name: 'Иванов', slug: 'ivanov', trait: 'director' } },
  });
  await assert.rejects(
    () => run({ uid: 'api::teacher.teacher', action: 'publish', params: { documentId: 'doc-1' } }),
    /недопустимое значение признака персоны/,
  );
});

test('снятие признака категории отклоняется, пока программа — единственная категория опубликованной статьи', async () => {
  const { run } = makeStrapi({
    courseGroupsByDocumentId: { 'cg-1': { slug: 'dolgoletie' } },
    articles: [{ slug: 'article-a', publishedAt: '2026-01-01', categories: [{ slug: 'dolgoletie' }] }],
  });
  await assert.rejects(
    () =>
      run({
        uid: 'api::course-group.course-group',
        action: 'update',
        params: { documentId: 'cg-1', data: { is_article_category: false } },
      }),
    /снятие признака оставит без категории/,
  );
});

test('снятие признака категории допустимо, если статья не единственная опубликованная с этой категорией', async () => {
  const { run } = makeStrapi({
    courseGroupsByDocumentId: { 'cg-1': { slug: 'dolgoletie' } },
    articles: [{ slug: 'article-a', publishedAt: '2026-01-01', categories: [{ slug: 'dolgoletie' }, { slug: 'other' }] }],
  });
  const result = await run({
    uid: 'api::course-group.course-group',
    action: 'update',
    params: { documentId: 'cg-1', data: { is_article_category: false } },
  });
  assert.equal(result, 'next-called');
});

test('удаление программы отклоняется по тому же правилу', async () => {
  const { run } = makeStrapi({
    courseGroupsByDocumentId: { 'cg-1': { slug: 'dolgoletie' } },
    articles: [{ slug: 'article-a', publishedAt: '2026-01-01', categories: [{ slug: 'dolgoletie' }] }],
  });
  await assert.rejects(
    () => run({ uid: 'api::course-group.course-group', action: 'delete', params: { documentId: 'cg-1' } }),
    /снятие признака оставит без категории/,
  );
});

test('обновление программы без изменения признака категории не запускает guard', async () => {
  const { run } = makeStrapi({
    courseGroupsByDocumentId: { 'cg-1': { slug: 'dolgoletie' } },
    articles: [{ slug: 'article-a', publishedAt: '2026-01-01', categories: [{ slug: 'dolgoletie' }] }],
  });
  const result = await run({
    uid: 'api::course-group.course-group',
    action: 'update',
    params: { documentId: 'cg-1', data: { name: 'Новое имя' } },
  });
  assert.equal(result, 'next-called');
});
