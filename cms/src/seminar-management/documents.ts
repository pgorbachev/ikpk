import { errors } from '@strapi/utils';
import {
  FOREIGN_LINK_MESSAGE,
  SCHEDULE_ENTRY_UID,
  SEMINAR_MODEL_NAME,
  SEMINAR_UID,
  adminLabel,
  classifyScheduleLink,
  isForeignAssignment,
  decideEntryName,
  decideSeminarSlug,
  documentIdOf,
  entryPublicationErrors,
  isTrustedImport,
  nextSeminarId,
  relationDocumentIds,
  relationNumericIds,
  seminarPublicationError,
} from './rules.js';

const { ValidationError } = errors;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function findDraft(strapi, uid, documentId, populate = undefined) {
  const where = { documentId, publishedAt: { $null: true } };
  const draft = await strapi.db.query(uid).findOne({ where, populate });
  if (draft) return draft;
  return strapi.db.query(uid).findOne({ where: { documentId }, populate });
}

function seminarIdOf(row) {
  if (!row?.seminar) return null;
  if (typeof row.seminar === 'string') return row.seminar;
  return text(row.seminar.documentId) || null;
}

async function seminarName(strapi, documentId) {
  if (!documentId) return '';
  const row = await findDraft(strapi, SEMINAR_UID, documentId);
  return text(row?.name);
}

function entryShape(row, documentId) {
  return {
    documentId: documentId || row?.documentId,
    seminarId: seminarIdOf(row),
    name: text(row?.name),
    id: row?.id ?? null,
  };
}

async function entryRows(strapi, documentIds) {
  const rows = [];
  for (const documentId of documentIds) {
    const row = await findDraft(strapi, SCHEDULE_ENTRY_UID, documentId, ['seminar']);
    rows.push(entryShape(row, documentId));
  }
  return rows;
}

async function entryRowsById(strapi, ids) {
  if (ids.length === 0) return [];
  const found = await strapi.db.query(SCHEDULE_ENTRY_UID).findMany({
    where: { id: { $in: ids } },
    populate: ['seminar'],
  });
  return found.map((row) => entryShape(row, row.documentId));
}

async function linkedRows(strapi, relation) {
  return [
    ...(await entryRows(strapi, relationDocumentIds(relation))),
    ...(await entryRowsById(strapi, relationNumericIds(relation))),
  ];
}

async function guardSeminarLinks(strapi, hostDocumentId, data) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'schedule_entries')) return;
  const rows = await linkedRows(strapi, data.schedule_entries);
  if (rows.length === 0) return;
  const foreign = rows.filter((row) => isForeignAssignment(hostDocumentId, row.seminarId));
  if (foreign.length > 0) {
    throw new ValidationError(FOREIGN_LINK_MESSAGE);
  }
}

async function fillAttachedEntries(strapi, hostDocumentId, data, seminarTitle) {
  if (!data || !seminarTitle) return;
  const rows = await linkedRows(strapi, data.schedule_entries);
  if (rows.length === 0) return;
  for (const row of rows) {
    if (classifyScheduleLink(hostDocumentId, row.seminarId) === 'foreign') continue;
    if (!row.id) continue;
    const current = await findDraft(strapi, SCHEDULE_ENTRY_UID, row.documentId);
    const data: { name?: string; admin_label?: string } = {};
    if (!row.name) data.name = seminarTitle;
    if (!text(current?.admin_label)) data.admin_label = adminLabel(current?.startAt, current?.city);
    if (Object.keys(data).length === 0) continue;
    await strapi.db.query(SCHEDULE_ENTRY_UID).update({
      where: { id: row.id },
      data,
    });
  }
}

async function assertPublishedWrite(strapi, context) {
  if (context.params?.status !== 'published') return;
  const data = context.params?.data ?? {};
  const existing = context.params?.documentId
    ? await findDraft(strapi, SCHEDULE_ENTRY_UID, context.params.documentId, ['seminar'])
    : null;
  const seminarId = nextSeminarId(data, seminarIdOf(existing));
  const messages = entryPublicationErrors({
    seminarId,
    seminarName: await seminarName(strapi, seminarId),
    startAt: Object.prototype.hasOwnProperty.call(data, 'startAt') ? data.startAt : existing?.startAt,
    endAt: Object.prototype.hasOwnProperty.call(data, 'endAt') ? data.endAt : existing?.endAt,
  });
  if (messages.length > 0) throw new ValidationError(messages.join(' '));
}

async function applyEntryWrite(strapi, context) {
  const data = context.params?.data ?? {};
  if (!context.params.data) context.params.data = data;
  const readsExisting = context.action === 'update' || context.action === 'clone';
  const existing =
    readsExisting && context.params.documentId
      ? await findDraft(strapi, SCHEDULE_ENTRY_UID, context.params.documentId, ['seminar'])
      : null;
  const previousSeminarId = seminarIdOf(existing);
  const seminarId = nextSeminarId(data, previousSeminarId);
  const name = decideEntryName({
    trustedImport: isTrustedImport(),
    incomingName: data.name,
    existingName: existing?.name ?? null,
    previousSeminarId,
    nextSeminarId: seminarId,
    nextSeminarName: await seminarName(strapi, seminarId),
  });
  const startAt = Object.prototype.hasOwnProperty.call(data, 'startAt') ? data.startAt : existing?.startAt;
  const city = Object.prototype.hasOwnProperty.call(data, 'city') ? data.city : existing?.city;
  data.name = name;
  data.admin_label = adminLabel(startAt, city);
}

async function assertEntryPublishable(strapi, context) {
  const draft = await findDraft(strapi, SCHEDULE_ENTRY_UID, context.params.documentId, ['seminar']);
  if (!draft) throw new ValidationError('Проведение не найдено.');
  const seminarId = seminarIdOf(draft);
  const title = await seminarName(strapi, seminarId);
  const messages = entryPublicationErrors({
    seminarId,
    seminarName: title,
    startAt: draft.startAt,
    endAt: draft.endAt,
  });
  if (messages.length > 0) throw new ValidationError(messages.join(' '));
  const name = decideEntryName({
    trustedImport: false,
    incomingName: null,
    existingName: draft.name,
    previousSeminarId: seminarId,
    nextSeminarId: seminarId,
    nextSeminarName: title,
  });
  if (name !== text(draft.name) || !text(draft.admin_label)) {
    await strapi.db.query(SCHEDULE_ENTRY_UID).update({
      where: { id: draft.id },
      data: { name, admin_label: adminLabel(draft.startAt, draft.city) },
    });
  }
}

async function applySeminarSlug(strapi, context, next) {
  const data = context.params?.data ?? {};
  const existing =
    context.action === 'update' && context.params.documentId
      ? await findDraft(strapi, SEMINAR_UID, context.params.documentId)
      : null;
  const decision = decideSeminarSlug({
    name: Object.prototype.hasOwnProperty.call(data, 'name') ? data.name : existing?.name,
    existingSlug: existing?.slug ?? null,
    existingName: existing?.name ?? null,
    modelName: SEMINAR_MODEL_NAME,
  });
  if (decision.action === 'clear') {
    data.slug = null;
  } else if (decision.action === 'keep') {
    data.slug = decision.slug;
  } else if (text(existing?.slug) === SEMINAR_MODEL_NAME && existing?.id) {
    await strapi.db.query(SEMINAR_UID).update({
      where: { id: existing.id },
      data: { slug: null },
    });
  }
  if (decision.action === 'generate') {
    const uid = strapi.plugin('content-manager').service('uid');
    data.slug = await uid.generateUIDField({
      contentTypeUID: SEMINAR_UID,
      field: 'slug',
      data: { ...data, id: context.params.documentId ?? '' },
    });
  }
  context.params.data = data;
  return next();
}

async function assertSeminarPublishable(strapi, context) {
  const draft = await findDraft(strapi, SEMINAR_UID, context.params.documentId);
  if (!draft) throw new ValidationError('Семинар не найден.');
  const message = seminarPublicationError(draft.name);
  if (message) throw new ValidationError(message);
  if (!text(draft.slug)) {
    const uid = strapi.plugin('content-manager').service('uid');
    const slug = await uid.generateUIDField({
      contentTypeUID: SEMINAR_UID,
      field: 'slug',
      data: { name: draft.name, id: draft.documentId },
    });
    await strapi.db.query(SEMINAR_UID).update({ where: { id: draft.id }, data: { slug } });
  }
}

export function registerSeminarDocuments(strapi) {
  strapi.documents.use(async (context, next) => {
    if (context.uid === SEMINAR_UID && (context.action === 'create' || context.action === 'update')) {
      if (context.params?.status === 'published') {
        const incoming = context.params.data ?? {};
        const existing =
          context.action === 'update' && context.params.documentId
            ? await findDraft(strapi, SEMINAR_UID, context.params.documentId)
            : null;
        const name = Object.prototype.hasOwnProperty.call(incoming, 'name') ? incoming.name : existing?.name;
        const message = seminarPublicationError(name);
        if (message) throw new ValidationError(message);
      }
      const hostId = context.params.documentId || documentIdOf(context.params.data);
      await guardSeminarLinks(strapi, hostId, context.params.data);
      const result = await applySeminarSlug(strapi, context, next);
      const title = text(context.params.data?.name) || text(result?.name);
      if (context.params.documentId || result?.documentId) {
        await fillAttachedEntries(
          strapi,
          context.params.documentId || result?.documentId,
          context.params.data,
          title,
        );
      }
      return result;
    }
    if (context.uid === SEMINAR_UID && context.action === 'publish') {
      await assertSeminarPublishable(strapi, context);
      return next();
    }
    if (
      context.uid === SCHEDULE_ENTRY_UID &&
      (context.action === 'create' || context.action === 'update' || context.action === 'clone')
    ) {
      await assertPublishedWrite(strapi, context);
      await applyEntryWrite(strapi, context);
      return next();
    }
    if (context.uid === SCHEDULE_ENTRY_UID && context.action === 'publish') {
      await assertEntryPublishable(strapi, context);
      return next();
    }
    return next();
  });
}

export async function backfillAdminLabels(strapi) {
  const rows = await strapi.db.query(SCHEDULE_ENTRY_UID).findMany({
    where: {
      $or: [{ admin_label: { $null: true } }, { admin_label: '' }],
    },
  });
  for (const row of rows) {
    await strapi.db.query(SCHEDULE_ENTRY_UID).update({
      where: { id: row.id },
      data: { admin_label: adminLabel(row.startAt, row.city) },
    });
  }
}

export function registerSeminarUid(strapi) {
  const uid = strapi.plugin('content-manager').service('uid');
  const original = uid.generateUIDField.bind(uid);
  uid.generateUIDField = async (args) => {
    if (args?.contentTypeUID === SEMINAR_UID && args?.field === 'slug') {
      const name = args.data?.name;
      if (typeof name !== 'string' || name.trim() === '') return '';
    }
    return original(args);
  };
}
