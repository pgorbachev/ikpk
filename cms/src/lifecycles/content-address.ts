import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { checkIdentifier, addressOf, type AddressState, type RecordRef, type RecordType } from '../lib/content-address';
import { KNOWN_CATALOG_SEGMENTS } from '../lib/build-route-segments';

const { ApplicationError } = errors;

/** Каталожные типы записи → UID Strapi. Ключи — предмет требования (спека, задача 3.11). */
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
      .findMany({ select: ['documentId', IDENTIFIER_FIELD] })) as { documentId: string; slug: string | null }[];
    for (const row of rows) {
      if (!row.slug) continue;
      records.push({ id: row.documentId, type, identifier: row.slug });
    }
  }

  const historyRows = (await strapi.db
    .query(ADDRESS_HISTORY_UID)
    .findMany({ select: ['address', 'owner_id'] })) as AddressHistoryRow[];
  const addressHistory = historyRows.map((h) => ({ address: h.address, ownerId: h.owner_id }));

  // Известные Strapi'у маршруты сборки — только шесть каталогов; произвольные страницы
  // web/src/pages не видны из этого процесса (см. build-route-segments.ts).
  const buildRouteSegments: string[] = [...KNOWN_CATALOG_SEGMENTS];

  return { records, addressHistory, buildRouteSegments };
}

async function recordAddressHistoryIfMissing(strapi: Core.Strapi, address: string, ownerId: string, ownerType: string) {
  const existing = await strapi.db.query(ADDRESS_HISTORY_UID).findOne({ where: { address } });
  if (existing) return;
  await strapi.db.query(ADDRESS_HISTORY_UID).create({
    data: { address, owner_id: ownerId, owner_type: ownerType },
  });
}

/**
 * Первая линия для грамматики идентификатора, областей уникальности по каталогам и истории
 * адресов (спека `cms-content-authoring`, задачи 3.11–3.12). Вторая линия — сборка `web`,
 * которая видит полный список маршрутов Astro; здесь — только то, что знает сама CMS.
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
      // Новая запись ещё не попала в state.records/addressHistory — id-плейсхолдер ни с чем
      // не совпадёт, самопересечение исключать не нужно.
      const record: RecordRef = { id: '__new__', type, identifier };
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
      await recordAddressHistoryIfMissing(strapi, oldAddress, documentId, previousType);
    },
  });
}
