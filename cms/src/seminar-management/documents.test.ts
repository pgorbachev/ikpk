import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSeminarDocuments } from './documents';
import { SCHEDULE_ENTRY_UID } from './rules.js';

type Context = {
  uid: string;
  action: string;
  params: {
    documentId?: string;
    status?: string;
    data?: Record<string, unknown>;
  };
};
type Middleware = (context: Context, next: () => Promise<unknown>) => Promise<unknown>;

const SEMINAR_UID = 'api::seminar.seminar';
const documentId = 'seminar-draft';
const anchors = { intro: ['section-intro'], documents: ['section-documents'] };

function makeStrapi({ trustedImport = false, draft = {}, entries = [] }: { trustedImport?: boolean; draft?: Record<string, unknown>; entries?: Record<string, unknown>[] } = {}) {
  let middleware!: Middleware;
  const current = {
    id: 1,
    documentId,
    publishedAt: null,
    name: 'Семинар',
    slug: 'seminar',
    content_format: 'structured',
    content_section_anchors: anchors,
    full_text: null,
    duration: '24 часа',
    course_group: { documentId: 'program' },
    ...draft,
  };
  const strapi = {
    requestContext: {
      get: () => trustedImport
        ? { state: { auth: { strategy: { name: 'content-api-token' }, credentials: { type: 'full-access' } } } }
        : { state: { auth: { strategy: { name: 'admin' }, credentials: { type: 'full-access' } } } },
    },
    documents: {
      use: (value: Middleware) => { middleware = value; },
    },
    db: {
      query(uid: string) {
        return {
          async findOne({ where }: { where: Record<string, unknown> }) {
            if (uid === SCHEDULE_ENTRY_UID && where.documentId) {
              return entries.find((entry) => entry.documentId === where.documentId) ?? null;
            }
            if (uid === SEMINAR_UID && where.documentId === documentId) return current;
            if (uid === SEMINAR_UID && where.slug) return null;
            if (uid === 'api::course-group.course-group' && where.documentId === 'program') {
              return { documentId: 'program', publishedAt: '2026-01-01', legacy_id: 'program', institute: { documentId: 'institute' } };
            }
            if (uid === 'api::institute.institute' && where.documentId === 'institute') {
              return { documentId: 'institute', publishedAt: '2026-01-01', legacy_id: 'institute' };
            }
            return null;
          },
          async findMany() { return []; },
        };
      },
    },
    plugin: () => ({ service: () => ({ generateUIDField: async () => 'generated' }) }),
  };
  registerSeminarDocuments(strapi as never);
  return {
    current,
    run(context: Context, next: () => Promise<unknown> = async () => 'saved') {
      let nextCalled = false;
      return middleware(context, async () => { nextCalled = true; return next(); })
        .then((result) => ({ result, nextCalled }));
    },
  };
}

test('draft rich-text update accepts unchanged migration fields in a full-form payload', async () => {
  const { run } = makeStrapi();
  const context: Context = {
    uid: SEMINAR_UID,
    action: 'update',
    params: {
      documentId,
      status: 'draft',
      data: {
        description: '<p>Изменённый текст</p>',
        content_format: 'structured',
        // Same JSON object with a different property insertion order.
        content_section_anchors: { documents: ['section-documents'], intro: ['section-intro'] },
      },
    },
  };
  const result = await run(context);
  assert.equal(result.result, 'saved');
  assert.equal(result.nextCalled, true);
  assert.equal(context.params.data?.description, '<p>Изменённый текст</p>');
  assert.equal(Object.hasOwn(context.params.data ?? {}, 'content_format'), false);
  assert.equal(Object.hasOwn(context.params.data ?? {}, 'content_section_anchors'), false,
    'unchanged protected fields are not sent to persistence');
});

test('untrusted updates cannot change either migration-controlled field', async () => {
  for (const data of [
    { content_format: 'legacy' },
    { content_section_anchors: { intro: ['changed'] } },
  ]) {
    const { run } = makeStrapi();
    await assert.rejects(
      () => run({ uid: SEMINAR_UID, action: 'update', params: { documentId, data } }),
      /Формат содержимого меняется только при переносе данных/,
    );
  }
});

test('null and an empty JSON object are different anchor values', async () => {
  const { run } = makeStrapi({ draft: { content_section_anchors: null } });
  await assert.rejects(
    () => run({ uid: SEMINAR_UID, action: 'update', params: { documentId, data: { content_section_anchors: {} } } }),
    /Формат содержимого меняется только при переносе данных/,
  );
});

test('trusted full-access import may change both migration-controlled fields', async () => {
  const { run } = makeStrapi({ trustedImport: true });
  const result = await run({
    uid: SEMINAR_UID,
    action: 'update',
    params: { documentId, data: { content_format: 'legacy', content_section_anchors: null } },
  });
  assert.equal(result.result, 'saved');
  assert.equal(result.nextCalled, true);
});

test('draft update with unchanged full-form fields passes before the separate publish action', async () => {
  const { run } = makeStrapi();
  const result = await run({
    uid: SEMINAR_UID,
    action: 'update',
    params: {
      documentId,
      status: 'draft',
      data: { name: 'Семинар', content_format: 'structured', content_section_anchors: anchors },
    },
  });
  assert.equal(result.result, 'saved');
  assert.equal(result.nextCalled, true);
});

test('accepts the Content Manager document id duplicated in the relation id field', async () => {
  const entryDocumentId = 'r3utbq0559i6j35l4dzen0pn';
  const entry = {
    id: 427,
    documentId: entryDocumentId,
    seminar: { documentId },
    name: 'Семинар',
    admin_label: '18 марта 2030 · Москва',
  };
  const { run } = makeStrapi({ entries: [entry] });
  const data = {
    schedule_entries: {
      connect: [{ id: entryDocumentId, documentId: entryDocumentId, locale: null }],
      disconnect: [],
    },
  };
  await run({
    uid: SEMINAR_UID,
    action: 'update',
    params: { documentId, data },
  });
  assert.deepEqual(data.schedule_entries, {
    connect: [{ documentId: entryDocumentId, locale: null }],
    disconnect: [],
  });
});

test('preserves numeric-string IDs, relation operators, and locale', async () => {
  const entryDocumentId = 'entry-document';
  const { run } = makeStrapi({ entries: [{
    id: 427,
    documentId: entryDocumentId,
    seminar: { documentId },
    name: 'Семинар',
    admin_label: '18 марта 2030 · Москва',
  }] });
  const data = {
    schedule_entries: {
      set: [{ id: '427', documentId: entryDocumentId, locale: 'ru-RU' }],
    },
  };
  await run({ uid: SEMINAR_UID, action: 'update', params: { documentId, data } });
  assert.deepEqual(data.schedule_entries, {
    set: [{ id: '427', documentId: entryDocumentId, locale: 'ru-RU' }],
  });
});

test('does not treat a conflicting non-numeric relation id as a document id', async () => {
  const { run } = makeStrapi();
  await assert.rejects(() => run({
    uid: SEMINAR_UID,
    action: 'update',
    params: {
      documentId,
      data: {
        schedule_entries: {
          connect: [{ id: 'different-document', documentId: 'entry-document', locale: null }],
          disconnect: [],
        },
      },
    },
  }), /Некорректный числовой идентификатор связи/);
});

test('keeps actual numeric relation ids unchanged and rejects invalid numeric ids', async () => {
  const { run } = makeStrapi();
  const data = {
    schedule_entries: {
      connect: [{ id: 427, documentId: 'entry-document', locale: null }],
      disconnect: [],
    },
  };
  await assert.rejects(() => run({
    uid: SEMINAR_UID,
    action: 'update',
    params: { documentId, data },
  }), /Нельзя изменить семинар сохранённого проведения/);
  assert.equal(data.schedule_entries.connect[0].id, 427);

  await assert.rejects(() => run({
    uid: SEMINAR_UID,
    action: 'update',
    params: { documentId, data: { schedule_entries: { connect: [{ id: 0, documentId: 'entry-document' }] } } },
  }), /Некорректный числовой идентификатор связи/);
});
