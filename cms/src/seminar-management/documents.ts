import { errors } from '@strapi/utils';
import {
  SCHEDULE_ENTRY_UID,
  SEMINAR_MODEL_NAME,
  SEMINAR_UID,
  entryAdminLabel,
  classifyScheduleLink,
  isForeignAssignment,
  decideEntryName,
  decideSeminarSlug,
  documentIdOf,
  entryPublicationErrors,
  isTrustedImport,
  nextSeminarId,
  specifiedSeminar,
  relationDocumentIds,
  relationNumericIds,
  seminarPublicationError,
  SEMINAR_SLUG_PATTERN,
} from './rules.js';

const { ValidationError } = errors;
const COURSE_GROUP_UID = 'api::course-group.course-group';
const INSTITUTE_UID = 'api::institute.institute';
const TEACHER_UID = 'api::teacher.teacher';
const PUBLISHED_PROGRAM_MESSAGE = 'Выберите опубликованную программу перед публикацией семинара.';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Strapi treats any shorthand beginning with digits as a numeric id via parseInt.
// Preserve nonnumeric document IDs explicitly, including IDs beginning with digits.
function canonicalizeRelation(value) {
  if (typeof value === 'string' && !Number.isNaN(parseInt(value, 10)) && !/^\d+$/.test(value)) {
    return { documentId: value };
  }
  if (Array.isArray(value)) return value.map(canonicalizeRelation);
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  for (const key of ['set', 'connect', 'disconnect']) {
    if (Object.prototype.hasOwnProperty.call(result, key)) result[key] = canonicalizeRelation(result[key]);
  }
  return result;
}

function assertUnambiguousRelation(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertUnambiguousRelation(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(value, '__pivot')) {
    throw new ValidationError('Некорректные служебные данные связи.');
  }
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id') ||
    Object.prototype.hasOwnProperty.call(value, 'documentId');
  if (Object.prototype.hasOwnProperty.call(value, 'id') &&
      !/^[1-9]\d*$/.test(String(value.id ?? ''))) {
    throw new ValidationError('Некорректный числовой идентификатор связи.');
  }
  const operators = ['set', 'connect', 'disconnect'];
  if (hasId && operators.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new ValidationError('Некорректный формат связи: идентификатор и операция заданы вместе.');
  }
  for (const key of operators) {
    if (Object.prototype.hasOwnProperty.call(value, key)) assertUnambiguousRelation(value[key]);
  }
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

function requestedProgram(data, existing) {
  if (!Object.prototype.hasOwnProperty.call(data, 'course_group')) return existing;
  const relation = data.course_group;
  if (!relation || Array.isArray(relation) || typeof relation !== 'object') return relation;
  if ('id' in relation || 'documentId' in relation) return relation;
  // Strapi applies `set` in preference to `connect`; an empty `set` clears the relation.
  if (relation.set) return relation.set;
  if (relationDocumentIds(relation.connect).length || relationNumericIds(relation.connect).length) {
    return relation.connect;
  }
  if (relationDocumentIds(relation.disconnect).length || relationNumericIds(relation.disconnect).length) {
    return null;
  }
  // The edit form also sends { connect: [], disconnect: [] } when the relation is unchanged.
  return existing;
}

async function assertSeminarProgram(strapi, relation) {
  const selected = Array.isArray(relation) ? relation : [relation];
  if (selected.length !== 1 || selected[0] == null) throw new ValidationError(PUBLISHED_PROGRAM_MESSAGE);
  const target = selected[0];
  const numericId = typeof target === 'object' ? target.id : target;
  const id = typeof numericId === 'number' || /^\d+$/.test(String(numericId ?? ''))
    ? Number(numericId)
    : null;
  const row = id == null ? null : await strapi.db.query(COURSE_GROUP_UID).findOne({ where: { id } });
  if (typeof target === 'object' && target.id != null && target.documentId != null &&
      row?.documentId !== target.documentId) {
    throw new ValidationError(PUBLISHED_PROGRAM_MESSAGE);
  }
  const documentId = row?.documentId ?? (typeof target === 'string' ? target : target?.documentId);
  if (!documentId) throw new ValidationError(PUBLISHED_PROGRAM_MESSAGE);
  const published = await strapi.db.query(COURSE_GROUP_UID).findOne({
    where: { documentId, publishedAt: { $notNull: true } },
    populate: ['institute'],
  });
  if (!published) throw new ValidationError(PUBLISHED_PROGRAM_MESSAGE);
  if (!text(published.legacy_id)) {
    throw new ValidationError('У выбранной программы нет идентификатора для сайта. Сообщите администратору.');
  }
  const instituteId = published.institute?.documentId;
  const institute = instituteId && await strapi.db.query(INSTITUTE_UID).findOne({
    where: { documentId: instituteId, publishedAt: { $notNull: true } },
  });
  if (!institute || !text(institute.legacy_id)) {
    throw new ValidationError('У выбранной программы нет опубликованного института для сайта. Сообщите администратору.');
  }
}

async function resolvedSeminarId(strapi, data, previousSeminarId) {
  if (Object.prototype.hasOwnProperty.call(data, 'seminar')) {
    const relation = data.seminar;
    assertUnambiguousRelation(relation);
    if (relation && !Array.isArray(relation) && typeof relation === 'object' &&
        Object.prototype.hasOwnProperty.call(relation, 'set') &&
        (relationDocumentIds(relation.connect).length || relationNumericIds(relation.connect).length ||
         relationDocumentIds(relation.disconnect).length || relationNumericIds(relation.disconnect).length)) {
      throw new ValidationError('Нельзя смешивать замену и изменение связи семинара.');
    }
    if (relationDocumentIds(relation).length + relationNumericIds(relation).length > 1) {
      throw new ValidationError('Укажите только один семинар для проведения.');
    }
  }
  const specified = specifiedSeminar(data);
  if (specified.kind !== 'numeric') return nextSeminarId(data, previousSeminarId);
  const row = await strapi.db.query(SEMINAR_UID).findOne({ where: { id: specified.id } });
  return nextSeminarId(data, previousSeminarId, row?.documentId ?? null);
}

async function teacherIds(strapi, relation) {
  const documents = relationDocumentIds(relation);
  const ids = relationNumericIds(relation);
  if (ids.length === 0) return documents;
  const rows = await strapi.db.query(TEACHER_UID).findMany({ where: { id: { $in: ids } } });
  if (rows.length !== new Set(ids).size) {
    throw new ValidationError('Выбранный преподаватель не найден.');
  }
  return [...documents, ...rows.map((row) => row.documentId)];
}

async function validateEntryTeachers(strapi, data, seminarId, existing, isCreate) {
  const hasSelection = Object.prototype.hasOwnProperty.call(data, 'teachers');
  if (hasSelection) assertUnambiguousRelation(data.teachers);
  if (!seminarId || (!hasSelection && !isCreate)) return;
  const seminar = await findDraft(strapi, SEMINAR_UID, seminarId, ['teachers']);
  const allowed = new Set((seminar?.teachers ?? []).map((row) => row.documentId));
  if (isCreate && !hasSelection && allowed.size === 1) {
    data.teachers = [...allowed];
    return;
  }
  if (!hasSelection) return;
  for (const row of existing?.teachers ?? []) allowed.add(row.documentId);
  const requested = await teacherIds(strapi, data.teachers);
  if (requested.some((id) => !allowed.has(id))) {
    throw new ValidationError('Выберите преподавателя из списка семинара.');
  }
}

async function assertEntryRequirements(strapi, seminarId, duration, teachers) {
  const publishedSeminar = seminarId && await strapi.db.query(SEMINAR_UID).findOne({
    where: { documentId: seminarId, publishedAt: { $notNull: true } },
  });
  const messages = [];
  if (!text(duration) && !text(publishedSeminar?.duration)) messages.push('Укажите продолжительность проведения или опубликованного семинара.');
  if (teachers.length === 0) messages.push('Выберите хотя бы одного преподавателя.');
  if (messages.length) throw new ValidationError(messages.join(' '));
}

async function resultingTeachers(strapi, relation, existing) {
  const current = new Set((existing ?? []).map((row) => row.documentId));
  if (relation === undefined) return [...current];
  if (relation == null || Array.isArray(relation) || typeof relation !== 'object') {
    return teacherIds(strapi, relation);
  }
  if (Object.prototype.hasOwnProperty.call(relation, 'set')) return teacherIds(strapi, relation.set);
  if ('id' in relation || 'documentId' in relation) return teacherIds(strapi, relation);
  for (const id of await teacherIds(strapi, relation.disconnect)) current.delete(id);
  for (const id of await teacherIds(strapi, relation.connect)) current.add(id);
  return [...current];
}

async function assertSeminarDurationRemoval(strapi, documentId, duration) {
  if (!documentId || text(duration)) return;
  const current = await strapi.db.query(SEMINAR_UID).findOne({
    where: { documentId, publishedAt: { $notNull: true } },
  });
  // Existing historical gaps must not prevent unrelated seminar updates.
  if (!text(current?.duration)) return;
  const entries = await strapi.db.query(SCHEDULE_ENTRY_UID).findMany({
    where: { publishedAt: { $notNull: true }, seminar: { documentId } },
  });
  const dependent = entries.filter((entry) => !text(entry.duration));
  if (dependent.length) {
    throw new ValidationError(`Нельзя убрать продолжительность: она нужна опубликованным проведениям: ${dependent.map((entry) => entry.admin_label || entry.name || entry.documentId).join(', ')}.`);
  }
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
  const relation = data.schedule_entries;
  assertUnambiguousRelation(relation);
  const rows = await linkedRows(strapi, relation);
  if (rows.some((row) => !row.seminarId || isForeignAssignment(hostDocumentId, row.seminarId))) {
    throw new ValidationError('Нельзя изменить семинар сохранённого проведения.');
  }
  if (!hostDocumentId) return;
  const disconnect = relation && !Array.isArray(relation) && typeof relation === 'object'
    ? await linkedRows(strapi, relation.disconnect)
    : [];
  if (disconnect.some((row) => row.seminarId === hostDocumentId)) {
    throw new ValidationError('Нельзя отсоединить сохранённое проведение от семинара.');
  }
  const shorthand = typeof relation === 'string' || typeof relation === 'number' ||
    (relation && !Array.isArray(relation) && typeof relation === 'object' &&
     ('documentId' in relation || 'id' in relation));
  const hasSet = relation == null || Array.isArray(relation) || shorthand ||
    (typeof relation === 'object' && Object.prototype.hasOwnProperty.call(relation, 'set'));
  const set = Array.isArray(relation) || shorthand ? relation : relation?.set;
  if (hasSet) {
    const existing = await findDraft(strapi, SEMINAR_UID, hostDocumentId, ['schedule_entries']);
    const included = new Set((await linkedRows(strapi, set)).map((row) => row.documentId));
    if ((existing?.schedule_entries ?? []).some((row) => !included.has(row.documentId))) {
      throw new ValidationError('Нельзя отсоединить сохранённое проведение от семинара.');
    }
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
    if (!text(current?.admin_label)) data.admin_label = entryAdminLabel({ startAt: current?.startAt, city: current?.city, isOnline: current?.isOnline, existingLabel: null, existingStartAt: null });
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
    ? await findDraft(strapi, SCHEDULE_ENTRY_UID, context.params.documentId, ['seminar', 'teachers'])
    : null;
  const seminarId = await resolvedSeminarId(strapi, data, seminarIdOf(existing));
  const messages = entryPublicationErrors({
    seminarId,
    seminarName: await seminarName(strapi, seminarId),
    startAt: Object.prototype.hasOwnProperty.call(data, 'startAt') ? data.startAt : existing?.startAt,
    endAt: Object.prototype.hasOwnProperty.call(data, 'endAt') ? data.endAt : existing?.endAt,
    isFree: Object.prototype.hasOwnProperty.call(data, 'isFree') ? data.isFree : existing?.isFree,
    price: Object.prototype.hasOwnProperty.call(data, 'price') ? data.price : existing?.price,
  });
  if (messages.length > 0) throw new ValidationError(messages.join(' '));
  await assertEntryRequirements(strapi, seminarId,
    Object.prototype.hasOwnProperty.call(data, 'duration') ? data.duration : existing?.duration,
    await resultingTeachers(strapi, data.teachers, existing?.teachers));
}

async function applyEntryWrite(strapi, context) {
  const data = context.params?.data ?? {};
  if (!context.params.data) context.params.data = data;
  const readsExisting = context.action === 'update' || context.action === 'clone';
  const existing =
    readsExisting && context.params.documentId
      ? await findDraft(strapi, SCHEDULE_ENTRY_UID, context.params.documentId, ['seminar', 'teachers'])
      : null;
  const previousSeminarId = seminarIdOf(existing);
  const seminarId = await resolvedSeminarId(strapi, data, previousSeminarId);
  if ((context.action === 'create' || context.action === 'clone') && !seminarId) {
    throw new ValidationError('Выберите семинар перед сохранением проведения.');
  }
  if (context.action === 'update' && existing && seminarId !== previousSeminarId) {
    throw new ValidationError('Нельзя изменить семинар сохранённого проведения.');
  }
  const explicitTeacherSet = data.teachers && !Array.isArray(data.teachers) &&
    typeof data.teachers === 'object' && Object.prototype.hasOwnProperty.call(data.teachers, 'set');
  if (context.action === 'clone' && !explicitTeacherSet) {
    await validateEntryTeachers(strapi, { teachers: (existing?.teachers ?? []).map((row) => row.documentId) }, seminarId, null, true);
  }
  await validateEntryTeachers(strapi, data, seminarId, context.action === 'clone' ? null : existing,
    context.action === 'create' || context.action === 'clone');
  const isFree = Object.prototype.hasOwnProperty.call(data, 'isFree') ? data.isFree : existing?.isFree;
  if (isFree) {
    const switchingToFree = data.isFree === true && existing?.isFree !== true;
    const price = Object.prototype.hasOwnProperty.call(data, 'price') ? data.price : existing?.price;
    if (switchingToFree) data.price = 0;
    else if (price == null || price === '' || !Number.isFinite(Number(price)) || Number(price) !== 0) {
      throw new ValidationError('Для бесплатного проведения цена должна быть равна нулю. Исправьте цену или измените признак бесплатного проведения.');
    }
  } else {
    if (existing?.isFree && data.isFree === false) {
      const switchingPrice = Object.prototype.hasOwnProperty.call(data, 'price') ? data.price : existing.price;
      if (switchingPrice != null && switchingPrice !== '' && Number(switchingPrice) === 0) data.price = null;
    }
    const price = Object.prototype.hasOwnProperty.call(data, 'price') ? data.price : existing?.price;
    if (price != null && price !== '' && (!Number.isFinite(Number(price)) || Number(price) <= 0)) {
      throw new ValidationError('Для платного проведения укажите положительную цену или оставьте её пустой.');
    }
  }
  const isOnline = Object.prototype.hasOwnProperty.call(data, 'isOnline') ? data.isOnline : existing?.isOnline;
  if (isOnline) data.city = null;
  const name = decideEntryName({
    trustedImport: isTrustedImport(strapi),
    incomingName: data.name,
    existingName: existing?.name ?? null,
    previousSeminarId,
    nextSeminarId: seminarId,
    nextSeminarName: await seminarName(strapi, seminarId),
  });
  const startAt = Object.prototype.hasOwnProperty.call(data, 'startAt') ? data.startAt : existing?.startAt;
  const city = Object.prototype.hasOwnProperty.call(data, 'city') ? data.city : existing?.city;
  data.name = name;
  data.admin_label = entryAdminLabel({
    startAt,
    city,
    isOnline,
    existingLabel: existing?.admin_label,
    existingStartAt: existing?.startAt,
  });
}

async function assertEntryPublishable(strapi, context) {
  const draft = await findDraft(strapi, SCHEDULE_ENTRY_UID, context.params.documentId, ['seminar', 'teachers']);
  if (!draft) throw new ValidationError('Проведение не найдено.');
  const seminarId = seminarIdOf(draft);
  const title = await seminarName(strapi, seminarId);
  const messages = entryPublicationErrors({
    seminarId,
    seminarName: title,
    startAt: draft.startAt,
    endAt: draft.endAt,
    isFree: draft.isFree,
    price: draft.price,
  });
  if (messages.length > 0) throw new ValidationError(messages.join(' '));
  await assertEntryRequirements(strapi, seminarId, draft.duration, draft.teachers ?? []);
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
      data: { name, admin_label: entryAdminLabel({ startAt: draft.startAt, city: draft.city, isOnline: draft.isOnline, existingLabel: draft.admin_label, existingStartAt: draft.startAt }) },
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
    trustedImport: isTrustedImport(strapi),
    isCreate: context.action === 'create',
    incomingSlug: data.slug,
  });
  if (decision.action === 'clear') {
    data.slug = null;
  } else if (decision.action === 'incoming') {
    if (!SEMINAR_SLUG_PATTERN.test(decision.slug)) {
      throw new ValidationError(
        `Адрес «${decision.slug}» не подходит для ссылки: только латинские строчные буквы, цифры и дефис между словами.`,
      );
    }
    const taken = await strapi.db.query(SEMINAR_UID).findOne({ where: { slug: decision.slug } });
    if (taken) {
      throw new ValidationError(`Адрес «${decision.slug}» уже используется другим семинаром.`);
    }
    data.slug = decision.slug;
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
  const draft = await findDraft(strapi, SEMINAR_UID, context.params.documentId, ['course_group']);
  if (!draft) throw new ValidationError('Семинар не найден.');
  const message = seminarPublicationError(draft.name);
  if (message) throw new ValidationError(message);
  if (draft.content_format === 'structured' && text(draft.full_text)) {
    throw new ValidationError('Перенесите прежний полный текст в отдельные разделы и очистите его перед публикацией.');
  }
  await assertSeminarProgram(strapi, draft.course_group);
  await assertSeminarDurationRemoval(strapi, draft.documentId, draft.duration);
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
    if (context.params?.data) {
      for (const field of context.uid === SEMINAR_UID ? ['schedule_entries'] : context.uid === SCHEDULE_ENTRY_UID ? ['seminar', 'teachers'] : []) {
        if (Object.prototype.hasOwnProperty.call(context.params.data, field)) {
          context.params.data[field] = canonicalizeRelation(context.params.data[field]);
        }
      }
    }
    if (context.uid === SEMINAR_UID && (context.action === 'create' || context.action === 'update')) {
      if (context.action === 'update' && !isTrustedImport(strapi) &&
          ['content_format', 'content_section_anchors'].some((field) => Object.prototype.hasOwnProperty.call(context.params?.data ?? {}, field))) {
        throw new ValidationError('Формат содержимого меняется только при переносе данных.');
      }
      if (context.action === 'create' && !isTrustedImport(strapi)) {
        context.params.data = { ...context.params.data, content_format: 'structured' };
      }
      if (context.params?.status === 'published') {
        const incoming = context.params.data ?? {};
        const existing =
          context.action === 'update' && context.params.documentId
            ? await findDraft(strapi, SEMINAR_UID, context.params.documentId, ['course_group'])
            : null;
        const name = Object.prototype.hasOwnProperty.call(incoming, 'name') ? incoming.name : existing?.name;
        const message = seminarPublicationError(name);
        if (message) throw new ValidationError(message);
        const format = Object.prototype.hasOwnProperty.call(incoming, 'content_format') ? incoming.content_format : existing?.content_format;
        const oldText = Object.prototype.hasOwnProperty.call(incoming, 'full_text') ? incoming.full_text : existing?.full_text;
        if (format === 'structured' && text(oldText)) {
          throw new ValidationError('Перенесите прежний полный текст в отдельные разделы и очистите его перед публикацией.');
        }
        const program = requestedProgram(incoming, existing?.course_group);
        await assertSeminarProgram(strapi, program);
        const duration = Object.prototype.hasOwnProperty.call(incoming, 'duration') ? incoming.duration : existing?.duration;
        await assertSeminarDurationRemoval(strapi, context.params.documentId, duration);
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
    if (context.uid === SEMINAR_UID && context.action === 'clone') {
      await guardSeminarLinks(strapi, null, context.params?.data);
      // Strapi otherwise copies one-to-many relations and moves the source's entries.
      context.params.data = { ...context.params.data, schedule_entries: { set: [] } };
      return next();
    }
    if (context.uid === SEMINAR_UID && context.action === 'publish') {
      await assertSeminarPublishable(strapi, context);
      return next();
    }
    if (
      context.uid === SCHEDULE_ENTRY_UID &&
      (context.action === 'create' || context.action === 'update' || context.action === 'clone')
    ) {
      for (const field of ['isFree', 'isOnline']) {
        if (Object.prototype.hasOwnProperty.call(context.params?.data ?? {}, field) &&
            typeof context.params.data[field] !== 'boolean') {
          throw new ValidationError(`Поле ${field} должно быть переключателем.`);
        }
      }
      await applyEntryWrite(strapi, context);
      await assertPublishedWrite(strapi, context);
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
      data: { admin_label: entryAdminLabel({ startAt: row.startAt, city: row.city, isOnline: row.isOnline, existingLabel: null, existingStartAt: null }) },
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
