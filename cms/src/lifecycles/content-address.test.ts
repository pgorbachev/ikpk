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
  beforeDelete(event: LifecycleEvent): Promise<void>;
  afterDelete(event: LifecycleEvent): Promise<void>;
}

function makeStrapi(opts: {
  rowsByUid: Record<string, FakeRow[]>;
  history?: FakeHistoryRow[];
  /** G2: имитирует отказ записи БД при создании строки истории. */
  failHistoryCreate?: boolean;
}) {
  const history = opts.history ? [...opts.history] : [];
  const created: { address: string; owner_id: string; owner_type: string }[] = [];
  const loggedErrors: string[] = [];
  let subscriber!: Subscriber;

  const strapi = {
    log: {
      error(message: string) {
        loggedErrors.push(message);
      },
    },
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
            if (opts.failHistoryCreate) throw new Error('БД недоступна (симуляция)');
            history.push({ address: data.address, owner_id: data.owner_id });
            created.push(data);
            return data;
          },
        };
      },
    },
  } as unknown as Parameters<typeof registerContentAddressLifecycle>[0];

  registerContentAddressLifecycle(strapi);
  return { subscriber, created, history, loggedErrors };
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

// Ревью PR #186, дельта: находка #1 (блокер). Strapi публикует запись с `draftAndPublish`
// через `db.query(uid).create()` — тот же вызов, что и обычное создание, — с сохранённым
// `documentId` черновика. `beforeCreate` до этой правки проверял новую запись под
// плейсхолдером `id: '__new__'`, поэтому не узнавал в уже существующей строке (тот же
// `documentId`, тот же slug) саму себя и отклонял публикацию как коллизию с записью,
// которую редактор публикует. Смоделировано ровно так, как Strapi собирает payload
// публикации: `documentId` черновика присутствует в `data`, слаг не меняется.
test('beforeCreate: публикация черновика (тот же documentId, тот же slug) не блокируется как коллизия с самим собой', async () => {
  const { subscriber } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'apledzher' }] },
  });
  const event = makeEvent('api::institute.institute', { data: { slug: 'apledzher', documentId: 'doc-1' } });
  await assert.doesNotReject(() => subscriber.beforeCreate(event));
});

// Негативный парный тест к предыдущему: настоящая коллизия (чужой documentId, тот же slug)
// обязана остаться отклонённой даже когда `documentId` присутствует в payload — иначе фикс
// finding #1 просто выключил бы проверку целиком вместо того, чтобы отличить публикацию
// от настоящего конфликта.
test('beforeCreate: коллизия с чужим documentId отклоняется, даже если payload несёт свой documentId', async () => {
  const { subscriber } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'apledzher' }] },
  });
  const event = makeEvent('api::institute.institute', { data: { slug: 'apledzher', documentId: 'doc-2' } });
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
  // F3 (ревью PR #186, дельта): для института пишутся ДВЕ строки истории — будущий
  // плоский адрес и голый корневой (живой сейчас) адрес одного и того же старого имени.
  assert.deepEqual(created, [
    { address: '/instituty/old-name', owner_id: 'doc-1', owner_type: 'institute' },
    { address: '/old-name', owner_id: 'doc-1', owner_type: 'institute' },
  ]);
});

test('beforeUpdate → afterUpdate: у программы (не института) пишется ОДНА строка истории', async () => {
  // Отрицательный контроль к предыдущему тесту: у программы/семинара/персоны нет голого
  // корневого маршрута — второй, «легаси», записи истории для них не должно быть.
  const { subscriber, created } = makeStrapi({
    rowsByUid: { 'api::course-group.course-group': [{ documentId: 'doc-1', slug: 'old-name' }] },
  });
  const event = makeEvent('api::course-group.course-group', {
    where: { documentId: 'doc-1' },
    data: { slug: 'new-name' },
  });
  await subscriber.beforeUpdate(event);
  await subscriber.afterUpdate(event);
  assert.deepEqual(created, [{ address: '/programmy/old-name', owner_id: 'doc-1', owner_type: 'course-group' }]);
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
  assert.equal(created.length, 2, 'институт пишет плоский адрес и голый корневой (F3)');
  assert.equal(history.length, 2);

  // Второй проход по тому же событию (например, ретрай) не должен упасть на unique-ограничении.
  await subscriber.afterUpdate(event);
  assert.equal(created.length, 2, 'дубль в историю не добавлен');
});

// H5 (ревью PR #186): институт живёт СЕЙЧАС и по голому корневому адресу `/<slug>`
// (`[institute].astro`, канонический до переключения источника), а не только по
// вычисляемому плоскому `/instituty/<slug>`. Статическая страница с тем же
// идентификатором раньше проходила проверку и на сборке `web` столкнулась бы с этим
// маршрутом — подтверждённый, а не гипотетический дефект.
test('beforeCreate: статическая страница не занимает идентификатор существующего института', async () => {
  const { subscriber } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'institut-apledzhera' }] },
  });
  const event = makeEvent('api::page.page', { data: { slug: 'institut-apledzhera' } });
  await assert.rejects(() => subscriber.beforeCreate(event), /маршрута сборки/);
});

test('beforeCreate: статическая страница может использовать идентификатор программы или семинара', async () => {
  // Отрицательный контроль к предыдущему тесту: расширение касается ТОЛЬКО институтов —
  // у программы и семинара иерархические адреса не занимают корневой сегмент.
  const { subscriber } = makeStrapi({
    rowsByUid: {
      'api::course-group.course-group': [{ documentId: 'doc-1', slug: 'kraniosakralnaya-terapiya' }],
      'api::seminar.seminar': [{ documentId: 'doc-2', slug: 'osnovy-testirovaniya' }],
    },
  });
  await assert.doesNotReject(() =>
    subscriber.beforeCreate(makeEvent('api::page.page', { data: { slug: 'kraniosakralnaya-terapiya' } })),
  );
  await assert.doesNotReject(() =>
    subscriber.beforeCreate(makeEvent('api::page.page', { data: { slug: 'osnovy-testirovaniya' } })),
  );
});

// F2 (ревью PR #186, дельта): предыдущая пара тестов защищала статическую страницу от
// занятия адреса института — обратное направление было НЕ защищено. Институт с
// идентификатором существующей статической страницы проходил проверку (вычисленные
// адреса разные: `/instituty/<id>` против `/<id>`), а на сборке оба претендовали бы на
// один и тот же корневой маршрут ([institute].astro и [slug].astro).
test('beforeCreate: институт не занимает идентификатор существующей статической страницы', async () => {
  const { subscriber } = makeStrapi({
    rowsByUid: { 'api::page.page': [{ documentId: 'doc-1', slug: 'garantii' }] },
  });
  const event = makeEvent('api::institute.institute', { data: { slug: 'garantii' } });
  await assert.rejects(() => subscriber.beforeCreate(event), /корневой сегмент уже занят/);
});

test('beforeUpdate: переименование института в идентификатор существующей статической страницы отклоняется', async () => {
  const { subscriber } = makeStrapi({
    rowsByUid: {
      'api::institute.institute': [{ documentId: 'doc-1', slug: 'institut-apledzhera' }],
      'api::page.page': [{ documentId: 'doc-2', slug: 'garantii' }],
    },
  });
  const event = makeEvent('api::institute.institute', {
    where: { documentId: 'doc-1' },
    data: { slug: 'garantii' },
  });
  await assert.rejects(() => subscriber.beforeUpdate(event), /корневой сегмент уже занят/);
});

test('beforeCreate: институт может использовать идентификатор программы или семинара', async () => {
  // Отрицательный контроль: расширение касается ТОЛЬКО статических страниц — программа и
  // семинар не претендуют на корневой сегмент, коллизии с институтом не даёт.
  const { subscriber } = makeStrapi({
    rowsByUid: {
      'api::course-group.course-group': [{ documentId: 'doc-1', slug: 'garantii' }],
    },
  });
  await assert.doesNotReject(() =>
    subscriber.beforeCreate(makeEvent('api::institute.institute', { data: { slug: 'garantii' } })),
  );
});

// H5: до этой правки история писалась только при переименовании. Запись, которую
// никогда не переименовывали, освобождала свой адрес при удалении молча — без единой
// строки в истории, то есть без какого-либо сигнала будущему владельцу того же адреса.
test('beforeDelete → afterDelete: адрес никогда не переименованной записи попадает в историю', async () => {
  const { subscriber, created } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'institut-barralya' }] },
  });
  const event = makeEvent('api::institute.institute', { where: { documentId: 'doc-1' } });
  await subscriber.beforeDelete(event);
  await subscriber.afterDelete(event);
  // F3: та же пара адресов, что и при переименовании — плоский и голый корневой.
  assert.deepEqual(created, [
    { address: '/instituty/institut-barralya', owner_id: 'doc-1', owner_type: 'institute' },
    { address: '/institut-barralya', owner_id: 'doc-1', owner_type: 'institute' },
  ]);
});

test('afterDelete: повторный проход по тому же событию не дублирует запись истории', async () => {
  const { subscriber, created, history } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'institut-barralya' }] },
  });
  const event = makeEvent('api::institute.institute', { where: { documentId: 'doc-1' } });
  await subscriber.beforeDelete(event);
  await subscriber.afterDelete(event);
  await subscriber.afterDelete(event);
  assert.equal(created.length, 2, 'институт пишет плоский адрес и голый корневой (F3)');
  assert.equal(history.length, 2);
});

// F3 (ревью PR #186, дельта), сквозной сценарий — именно то, для чего заведена запись
// голого корневого адреса: удалённый институт освобождает `/<slug>`, и следующая
// статическая страница с тем же идентификатором должна встретить «занят историей», а
// не молча перехватить адрес, который посетитель по старой ссылке ещё считает институтом.
test('сквозной сценарий: статическая страница не занимает адрес удалённого института', async () => {
  // Строки института — отдельный массив, мутируемый по ссылке: удаление в реальной БД
  // убирает запись из последующих findMany/findOne, а без этого шага fake хранит её
  // навсегда и следующая проверка отклонила бы страницу по buildRouteSegments (институт
  // «как будто жив»), а не по истории — то есть проверяла бы не то, что нужно этому тесту.
  const instituteRows = [{ documentId: 'doc-1', slug: 'institut-barralya' }];
  const { subscriber } = makeStrapi({ rowsByUid: { 'api::institute.institute': instituteRows } });

  const deleteEvent = makeEvent('api::institute.institute', { where: { documentId: 'doc-1' } });
  await subscriber.beforeDelete(deleteEvent);
  instituteRows.length = 0; // институт удалён из БД
  await subscriber.afterDelete(deleteEvent);

  const createEvent = makeEvent('api::page.page', { data: { slug: 'institut-barralya' } });
  await assert.rejects(() => subscriber.beforeCreate(createEvent), /занят историей/);
});

test('beforeDelete → afterDelete: у семинара (не института) пишется ОДНА строка истории', async () => {
  const { subscriber, created } = makeStrapi({
    rowsByUid: { 'api::seminar.seminar': [{ documentId: 'doc-1', slug: 'osnovy-testirovaniya' }] },
  });
  const event = makeEvent('api::seminar.seminar', { where: { documentId: 'doc-1' } });
  await subscriber.beforeDelete(event);
  await subscriber.afterDelete(event);
  assert.deepEqual(created, [{ address: '/seminary/osnovy-testirovaniya', owner_id: 'doc-1', owner_type: 'seminar' }]);
});

test('beforeDelete: запись без идентификатора не пишет историю (нечего терять)', async () => {
  const { subscriber, created } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: null }] },
  });
  const event = makeEvent('api::institute.institute', { where: { documentId: 'doc-1' } });
  await subscriber.beforeDelete(event);
  await subscriber.afterDelete(event);
  assert.equal(created.length, 0);
});

// G2 (ревью PR #186, teammate rev186-lifecycles): переименование/удаление в БД уже
// закоммичено к моменту записи истории — отказ этой записи не должен всплывать у
// вызывающего как отказ самой операции. Одновременно потеря не молчит вовсе: она идёт
// в лог сервера.
test('afterUpdate: отказ записи истории не прерывает обработчик и попадает в лог', async () => {
  const { subscriber, loggedErrors } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'old-name' }] },
    failHistoryCreate: true,
  });
  const event = makeEvent('api::institute.institute', {
    where: { documentId: 'doc-1' },
    data: { slug: 'new-name' },
  });
  await subscriber.beforeUpdate(event);
  await assert.doesNotReject(() => subscriber.afterUpdate(event));
  // F3: институт пишет ДВЕ строки истории (плоский адрес + голый корневой), поэтому при
  // сквозном отказе БД — два независимых лог-сообщения, а не одно.
  assert.equal(loggedErrors.length, 2);
  assert.ok(loggedErrors.every((m) => /old-name/.test(m)));
});

test('afterDelete: отказ записи истории не прерывает обработчик и попадает в лог', async () => {
  const { subscriber, loggedErrors } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'institut-barralya' }] },
    failHistoryCreate: true,
  });
  const event = makeEvent('api::institute.institute', { where: { documentId: 'doc-1' } });
  await subscriber.beforeDelete(event);
  await assert.doesNotReject(() => subscriber.afterDelete(event));
  assert.equal(loggedErrors.length, 2);
});

// G4 (teammate rev186-lifecycles): «слаг присутствует, но не изменился» — реалистичный
// случай для content-manager Strapi, который при каждом сохранении отправляет ВСЕ поля,
// включая неизменённые. Отдельная ветка от «слага нет в data вовсе» (тест выше,
// «идентификатор не меняется — история не пишется», где data: {}) — до этого теста была
// покрыта только вторая, реалистичная первая не была ничем.
test('beforeUpdate: слаг присутствует в data, но равен текущему — история не пишется', async () => {
  const { subscriber, created } = makeStrapi({
    rowsByUid: { 'api::institute.institute': [{ documentId: 'doc-1', slug: 'apledzher' }] },
  });
  const event = makeEvent('api::institute.institute', {
    where: { documentId: 'doc-1' },
    data: { slug: 'apledzher', name: 'Институт Апледжера' },
  });
  await subscriber.beforeUpdate(event);
  assert.equal(Object.keys(event.state).length, 0, 'состояние переименования не должно выставляться');
  await subscriber.afterUpdate(event);
  assert.equal(created.length, 0);
});
