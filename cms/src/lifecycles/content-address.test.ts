import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerContentAddressLifecycle } from './content-address';

interface FakeRow {
  documentId: string;
  slug: string | null;
}

interface FakeHistoryRow {
  address: string;
  owner_id: string;
}

type LifecycleEvent = {
  model: { uid: string };
  params: { data?: Record<string, unknown>; where?: Record<string, unknown> };
  state: Record<string, unknown>;
};

interface Subscriber {
  beforeCreate(event: LifecycleEvent): Promise<void>;
  beforeUpdate(event: LifecycleEvent): Promise<void>;
  afterUpdate(event: LifecycleEvent): Promise<void>;
}

function makeStrapi(opts: {
  rowsByUid: Record<string, FakeRow[]>;
  history?: FakeHistoryRow[];
}) {
  const history = opts.history ? [...opts.history] : [];
  const created: { address: string; owner_id: string; owner_type: string }[] = [];
  let subscriber!: Subscriber;

  const strapi = {
    db: {
      lifecycles: {
        subscribe(sub: Subscriber) {
          subscriber = sub;
        },
      },
      query(uid: string) {
        return {
          async findMany() {
            if (uid === 'api::address-history.address-history') {
              return history.map((h) => ({ address: h.address, owner_id: h.owner_id }));
            }
            return opts.rowsByUid[uid] ?? [];
          },
          async findOne({ where }: { where?: Record<string, unknown> }) {
            if (uid === 'api::address-history.address-history') {
              const address = where?.address as string | undefined;
              return history.find((h) => h.address === address) ?? null;
            }
            const rows = opts.rowsByUid[uid] ?? [];
            const filter = where ?? {};
            return (
              rows.find((r) =>
                Object.entries(filter).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v),
              ) ?? null
            );
          },
          async create({ data }: { data: { address: string; owner_id: string; owner_type: string } }) {
            history.push({ address: data.address, owner_id: data.owner_id });
            created.push(data);
            return data;
          },
        };
      },
    },
  } as unknown as Parameters<typeof registerContentAddressLifecycle>[0];

  registerContentAddressLifecycle(strapi);
  return { subscriber, created, history };
}

function makeEvent(uid: string, params: LifecycleEvent['params']): LifecycleEvent {
  return { model: { uid }, params, state: {} };
}

test('beforeCreate: отклоняет недопустимую грамматику идентификатора', async () => {
  const { subscriber } = makeStrapi({ rowsByUid: {} });
  const event = makeEvent('api::institute.institute', { data: { slug: '-bad-' } });
  await assert.rejects(() => subscriber.beforeCreate(event), /недопустимый идентификатор/);
});

test('beforeCreate: отклоняет идентификатор, уже занятый записью того же каталога', async () => {
  const { subscriber } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'apledzher' }] },
  });
  const event = makeEvent('api::institute.institute', { data: { slug: 'apledzher' } });
  await assert.rejects(() => subscriber.beforeCreate(event), /уже занят/);
});

test('beforeCreate: одинаковый идентификатор в разных каталогах не конфликт', async () => {
  const { subscriber } = makeStrapi({
    rowsByUid: { 'api::seminar.seminar': [{ documentId: 'doc-1', slug: 'dolgoletie' }] },
  });
  const event = makeEvent('api::course-group.course-group', { data: { slug: 'dolgoletie' } });
  await assert.doesNotReject(() => subscriber.beforeCreate(event));
});

test('beforeCreate: статическая страница не занимает сегмент каталога', async () => {
  const { subscriber } = makeStrapi({ rowsByUid: {} });
  const event = makeEvent('api::page.page', { data: { slug: 'instituty' } });
  await assert.rejects(() => subscriber.beforeCreate(event), /маршрута сборки/);
});

test('beforeCreate: без значения identifier — проверка пропускается (ещё не вычислен)', async () => {
  const { subscriber } = makeStrapi({ rowsByUid: {} });
  const event = makeEvent('api::institute.institute', { data: {} });
  await assert.doesNotReject(() => subscriber.beforeCreate(event));
});

test('beforeUpdate: идентификатор не меняется — история не пишется', async () => {
  const { subscriber, created } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'apledzher' }] },
  });
  const event = makeEvent('api::institute.institute', {
    where: { documentId: 'doc-1' },
    data: {},
  });
  await subscriber.beforeUpdate(event);
  assert.equal(Object.keys(event.state).length, 0);
  await subscriber.afterUpdate(event);
  assert.equal(created.length, 0);
});

test('beforeUpdate → afterUpdate: смена идентификатора допустима и пишет прежний адрес в историю', async () => {
  const { subscriber, created } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'old-name' }] },
  });
  const event = makeEvent('api::institute.institute', {
    where: { documentId: 'doc-1' },
    data: { slug: 'new-name' },
  });
  await subscriber.beforeUpdate(event);
  await subscriber.afterUpdate(event);
  assert.deepEqual(created, [{ address: '/instituty/old-name', owner_id: 'doc-1', owner_type: 'institute' }]);
});

test('beforeUpdate: отклоняет смену идентификатора на адрес, занятый историей', async () => {
  const { subscriber } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'a' }] },
    history: [{ address: '/instituty/b', owner_id: 'doc-2' }],
  });
  const event = makeEvent('api::institute.institute', {
    where: { documentId: 'doc-1' },
    data: { slug: 'b' },
  });
  await assert.rejects(() => subscriber.beforeUpdate(event), /занят историей/);
});

test('afterUpdate: повторная запись того же старого адреса в историю не дублируется (unique)', async () => {
  const { subscriber, created, history } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'old-name' }] },
  });
  const event = makeEvent('api::institute.institute', {
    where: { documentId: 'doc-1' },
    data: { slug: 'new-name' },
  });
  await subscriber.beforeUpdate(event);
  await subscriber.afterUpdate(event);
  assert.equal(created.length, 1);
  assert.equal(history.length, 1);

  // Второй проход по тому же событию (например, ретрай) не должен упасть на unique-ограничении.
  await subscriber.afterUpdate(event);
  assert.equal(created.length, 1, 'дубль в историю не добавлен');
});
