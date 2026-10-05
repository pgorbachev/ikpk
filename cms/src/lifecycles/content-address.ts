import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { checkIdentifier, addressOf, type AddressState, type RecordRef, type RecordType } from '../lib/content-address';
import { KNOWN_CATALOG_SEGMENTS } from '../lib/build-route-segments';

const { ApplicationError } = errors;

/** Каталожные типы записи → UID Strapi. Ключи — предмет требования (спека `cms-content-authoring-and-migration`, задача 3.11 — на момент этого коммита только на неслитой ветке PR #132, M1). */
const TYPE_BY_UID: Record<string, RecordType> = {
  'api::institute.institute': 'institute',
  'api::course-group.course-group': 'course-group',
  'api::seminar.seminar': 'seminar',
  'api::teacher.teacher': 'person',
  'api::article.article': 'article',
  'api::video-playlist.video-playlist': 'video-playlist',
  'api::page.page': 'static-page',
};

const ADDRESS_HISTORY_UID = 'api::address-history.address-history';
const IDENTIFIER_FIELD = 'slug';

interface AddressHistoryRow {
  address: string;
  owner_id: string;
}

async function loadAddressState(strapi: Core.Strapi): Promise<AddressState> {
  const records: RecordRef[] = [];
  for (const [uid, type] of Object.entries(TYPE_BY_UID)) {
    const rows = (await strapi.db
      .query(uid)
      .findMany({ select: ['documentId', IDENTIFIER_FIELD, 'publishedAt'] })) as {
      documentId: string;
      slug: string | null;
      publishedAt?: string | null;
    }[];
    for (const row of rows) {
      if (!row.slug) continue;
      records.push({ id: row.documentId, type, identifier: row.slug, publishedAt: row.publishedAt });
    }
  }

  const historyRows = (await strapi.db
    .query(ADDRESS_HISTORY_UID)
    .findMany({ select: ['address', 'owner_id'] })) as AddressHistoryRow[];
  const addressHistory = historyRows.map((h) => ({ address: h.address, ownerId: h.owner_id }));

  // Известные Strapi'у маршруты сборки — шесть каталогов плюс идентификаторы институтов.
  // Институт — единственный тип, у которого СЕЙЧАС, до переключения источника
  // (`cms-content-publication`), живой канонический маршрут — голый корневой сегмент
  // `/<slug>` (страница `web/src/pages/[institute].astro`), а не плоский `/instituty/<slug>`,
  // который вычисляет `addressOf`. Без этой добавки статическая страница с тем же
  // идентификатором проходила бы проверку (её вычисленный адрес `/<slug>` не совпадал ни с
  // одним другим вычисленным адресом) и на сборке `web` столкнулась бы с этим маршрутом —
  // подтверждённый ревью PR #186 дефект (H5), а не гипотетический. Прочие типы (программа,
  // семинар, персона) сюда не добавляются: их иерархические адреса — не корневой сегмент,
  // коллизии с плоской статической страницей не дают.
  const instituteIdentifiers = records.filter((r) => r.type === 'institute').map((r) => r.identifier);
  const buildRouteSegments: string[] = [...KNOWN_CATALOG_SEGMENTS, ...instituteIdentifiers];

  return { records, addressHistory, buildRouteSegments };
}

async function recordAddressHistoryIfMissing(strapi: Core.Strapi, address: string, ownerId: string, ownerType: string) {
  const existing = await strapi.db.query(ADDRESS_HISTORY_UID).findOne({ where: { address } });
  if (existing) return;
  await strapi.db.query(ADDRESS_HISTORY_UID).create({
    data: { address, owner_id: ownerId, owner_type: ownerType },
  });
}

// Отказ здесь не должен всплыть у вызывающего как отказ уже закоммиченной операции
// (переименования или удаления) — H5/G2, ревью PR #186. Потеря записи истории — реальная
// потеря, поэтому не молчим вовсе, а пишем в лог сервера.
async function writeHistorySafely(
  strapi: Core.Strapi,
  address: string,
  ownerId: string,
  ownerType: string,
  action: 'переименования' | 'удаления',
) {
  try {
    await recordAddressHistoryIfMissing(strapi, address, ownerId, ownerType);
  } catch (err) {
    strapi.log.error(
      `[content-address] не удалось записать историю адреса ${address} (владелец ${ownerId}) после ${action}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Институт — единственный тип, у которого СЕЙЧАС, до переключения источника
// (`cms-content-publication`), живой канонический маршрут — голый корневой сегмент
// `/<identifier>` ([institute].astro), а НЕ плоский `/instituty/<identifier>`, который
// вычисляет `addressOf`. F3 (ревью PR #186, дельта): без этой добавки переименование или
// удаление института писало в историю только будущий плоский адрес — а статическая
// страница, претендующая на освободившийся КОРНЕВОЙ сегмент (её собственный вычисленный
// адрес — тот же `/<identifier>`), под проверку «занят историей» не попадала и молча
// перехватывала бы адрес, который посетитель по старой ссылке всё ещё считает институтом.
function legacyRootAddress(type: RecordType, identifier: string): string | undefined {
  return type === 'institute' ? `/${identifier}` : undefined;
}

/**
 * Первая линия для грамматики идентификатора, областей уникальности по каталогам и истории
 * адресов (спека `cms-content-authoring-and-migration`, задачи 3.11–3.12 — на момент этого
 * коммита только на неслитой ветке PR #132, M1). Вторая линия — сборка `web`, которая видит
 * полный список маршрутов Astro; здесь — только то, что знает сама CMS.
 */
export function registerContentAddressLifecycle(strapi: Core.Strapi): void {
  strapi.db.lifecycles.subscribe({
    models: Object.keys(TYPE_BY_UID),

    async beforeCreate(event) {
      const type = TYPE_BY_UID[event.model.uid];
      const data = (event.params.data ?? {}) as Record<string, unknown>;
      const identifier = data[IDENTIFIER_FIELD];
      if (typeof identifier !== 'string' || identifier === '') return;

      const state = await loadAddressState(strapi);
      // Ревью PR #186, дельта, находка #1 (блокер): плейсхолдер `id: '__new__'` был верен
      // только для настоящего создания — там новой записи ещё нет ни в state.records, ни в
      // истории, и placeholder ни с чем не совпадает. Но у типов с `draftAndPublish: true`
      // (все семь каталожных) публикация ТОЖЕ идёт через `db.query(uid).create()` — Strapi
      // берёт черновик, выставляет `publishedAt` и создаёт вторую строку с ТЕМ ЖЕ
      // `documentId`, который остаётся в `data.documentId` (сам `id` вырезан, `documentId`
      // нет). На момент проверки черновик уже лежит в `state.records` под этим documentId и
      // с тем же слагом — с плейсхолдером `beforeCreate` не узнавал в нём себя и отклонял
      // публикацию как «адрес уже занят записью <тот же документ>». `data.documentId`,
      // когда он есть, — как раз тот различитель: настоящее создание его не передаёт.
      const record: RecordRef = { id: (data.documentId as string | undefined) ?? '__new__', type, identifier };
      const verdict = checkIdentifier({ record, state });
      if (!verdict.ok) throw new ApplicationError(verdict.message);
    },

    async beforeUpdate(event) {
      const type = TYPE_BY_UID[event.model.uid];
      const data = (event.params.data ?? {}) as Record<string, unknown>;
      if (!(IDENTIFIER_FIELD in data)) return; // идентификатор не меняется — проверять нечего

      const identifier = data[IDENTIFIER_FIELD];
      if (typeof identifier !== 'string' || identifier === '') return;

      const existing = (await strapi.db
        .query(event.model.uid)
        .findOne({ where: event.params.where, select: ['documentId', IDENTIFIER_FIELD] })) as
        | { documentId: string; slug: string | null }
        | null;
      if (!existing) return;

      if (existing.slug === identifier) return; // не изменился — записывать историю не о чем

      const state = await loadAddressState(strapi);
      const previousAddresses = state.addressHistory
        .filter((h) => h.ownerId === existing.documentId)
        .map((h) => h.address);
      const record: RecordRef = { id: existing.documentId, type, identifier, previousAddresses };
      const verdict = checkIdentifier({ record, state });
      if (!verdict.ok) throw new ApplicationError(verdict.message);

      // Перенесено в afterUpdate: пишем историю только после успешной записи в БД, а не при
      // одной лишь прошедшей проверке (запись может ещё упасть на уровне БД/связей).
      event.state.previousIdentifier = existing.slug ?? undefined;
      event.state.previousType = type;
      event.state.documentId = existing.documentId;
    },

    async afterUpdate(event) {
      const previousIdentifier = event.state.previousIdentifier as string | undefined;
      const previousType = event.state.previousType as RecordType | undefined;
      const documentId = event.state.documentId as string | undefined;
      if (!previousIdentifier || !previousType || !documentId) return;

      const oldAddress = addressOf({ type: previousType, identifier: previousIdentifier });
      await writeHistorySafely(strapi, oldAddress, documentId, previousType, 'переименования');

      const legacyOldAddress = legacyRootAddress(previousType, previousIdentifier);
      if (legacyOldAddress) {
        await writeHistorySafely(strapi, legacyOldAddress, documentId, previousType, 'переименования');
      }
    },

    // H5 (ревью PR #186): до этой правки история писалась ТОЛЬКО при переименовании —
    // запись, которую никогда не переименовывали, при удалении освобождала свой адрес
    // без единой записи в истории. Новый владелец того же адреса не получал никакого
    // сигнала о том, что здесь раньше было другое содержимое, и посетитель по старой
    // ссылке молча попадал бы на чужую страницу вместо ожидаемого 404 или редиректа.
    // Тот же beforeX/afterX швов, что и у переименования: адрес читаем ДО удаления (после
    // него записи уже нет, где искать), пишем историю ПОСЛЕ (запись в БД удалена не сразу
    // же и может ещё не дойти — тогда истории лучше не быть, чем указывать на несуществующее
    // удаление).
    async beforeDelete(event) {
      const type = TYPE_BY_UID[event.model.uid];
      const existing = (await strapi.db
        .query(event.model.uid)
        .findOne({ where: event.params.where, select: ['documentId', IDENTIFIER_FIELD] })) as
        | { documentId: string; slug: string | null }
        | null;
      if (!existing || !existing.slug) return;

      event.state.deletedIdentifier = existing.slug;
      event.state.deletedType = type;
      event.state.deletedDocumentId = existing.documentId;
    },

    async afterDelete(event) {
      const identifier = event.state.deletedIdentifier as string | undefined;
      const type = event.state.deletedType as RecordType | undefined;
      const documentId = event.state.deletedDocumentId as string | undefined;
      if (!identifier || !type || !documentId) return;

      const address = addressOf({ type, identifier });
      await writeHistorySafely(strapi, address, documentId, type, 'удаления');

      const legacyAddress = legacyRootAddress(type, identifier);
      if (legacyAddress) {
        await writeHistorySafely(strapi, legacyAddress, documentId, type, 'удаления');
      }
    },
  });
}
