import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Редакторские правила семинара и проведения.
 * Чистые функции: сервер вызывает их из document middleware, тесты — напрямую.
 * Исключение доверенного импорта живёт в AsyncLocalStorage и не читается из тела запроса.
 */

const trustedImport = new AsyncLocalStorage();

export const SEMINAR_UID = 'api::seminar.seminar';
export const SCHEDULE_ENTRY_UID = 'api::schedule-entry.schedule-entry';
export const SEMINAR_MODEL_NAME = 'seminar';

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

export function isTrustedImport() {
  return trustedImport.getStore() === true;
}

export function runTrustedImport(fn) {
  return trustedImport.run(true, fn);
}

/** Тело запроса не включает исключение, даже если в нём лежит одноимённый флаг. */
export function trustedImportFromEditorPayload(payload) {
  const requested =
    Boolean(payload) &&
    typeof payload === 'object' &&
    payload.trustedImport === true;
  return requested ? isTrustedImport() : isTrustedImport();
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function decideEntryName({
  trustedImport: trusted,
  incomingName,
  existingName,
  previousSeminarId,
  nextSeminarId,
  nextSeminarName,
}) {
  if (trusted) {
    const imported = text(incomingName);
    if (imported) return imported;
  }

  const previous = text(previousSeminarId) || null;
  const next = text(nextSeminarId) || null;
  const seminarName = text(nextSeminarName);
  const existing = text(existingName);
  const moved = Boolean(previous && next && previous !== next);

  if (moved && seminarName) return seminarName;
  if (!existing && next && seminarName) return seminarName;
  return existing || null;
}

export function classifyScheduleLink(hostSeminarId, entrySeminarId) {
  const host = text(hostSeminarId);
  const current = text(entrySeminarId);
  if (!current) return 'attach';
  if (current === host) return 'keep';
  return 'foreign';
}

export const FOREIGN_LINK_MESSAGE =
  'Это проведение уже относится к другому семинару. Перенести его можно только в карточке самого проведения.';

export function isForeignAssignment(hostSeminarId, entrySeminarId) {
  if (!text(hostSeminarId)) return Boolean(text(entrySeminarId));
  return classifyScheduleLink(hostSeminarId, entrySeminarId) === 'foreign';
}

export function foreignLinkIds(hostSeminarId, entries) {
  return entries
    .filter((entry) => isForeignAssignment(hostSeminarId, entry.seminarId))
    .map((entry) => entry.documentId);
}

export function dateOrderError(startAt, endAt) {
  if (!startAt || !endAt) return null;
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 'Укажите корректные дату начала и дату окончания.';
  }
  if (end < start) return 'Окончание проведения не может быть раньше начала.';
  return null;
}

export function entryPublicationErrors({ seminarId, seminarName, startAt, endAt }) {
  const errors = [];
  if (!text(seminarId)) errors.push('Укажите семинар перед публикацией проведения.');
  else if (!text(seminarName)) {
    errors.push('Заполните название семинара перед публикацией проведения.');
  }
  const dates = dateOrderError(startAt, endAt);
  if (dates) errors.push(dates);
  return errors;
}

export function seminarPublicationError(name) {
  return text(name) ? null : 'Заполните название семинара.';
}

/**
 * Пустое название не получает служебный slug модели.
 * Уже заданный адрес сохраняется, в том числе если название потом очистили в черновике.
 * Заглушка `seminar` при пустом прежнем названии заменяется, когда название появляется.
 */
export function decideSeminarSlug({ name, existingSlug, existingName, modelName }) {
  const trimmed = text(name);
  const slug = text(existingSlug);
  const previousName = text(existingName);
  if (!trimmed) {
    if (!slug) return { action: 'clear' };
    return { action: 'keep', slug };
  }
  if (!slug) return { action: 'generate' };
  if (!previousName && slug === modelName) return { action: 'generate' };
  return { action: 'keep', slug };
}

export function adminLabel(startAt, city) {
  const place = text(city) || 'город не указан';
  return `${adminDate(startAt)} · ${place}`;
}

function adminDate(value) {
  if (!value) return 'дата не указана';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'дата не указана';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function relationItems(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(relationItems);
  if (typeof value === 'string' || typeof value === 'number') return [value];
  if (typeof value !== 'object') return [];
  const hasOperator = value.set || value.connect || value.disconnect;
  if (!hasOperator && (value.documentId != null || value.id != null)) return [value];
  return [...relationItems(value.set), ...relationItems(value.connect)];
}

export function relationDocumentIds(value) {
  return relationItems(value).map(documentIdOf).filter(Boolean);
}

export function relationNumericIds(value) {
  const ids = [];
  for (const item of relationItems(value)) {
    if (documentIdOf(item)) continue;
    const raw = typeof item === 'number' ? item : item?.id;
    const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
    if (Number.isInteger(id)) ids.push(id);
  }
  return ids;
}

export function documentIdOf(item) {
  if (typeof item === 'string' && item.trim()) return item.trim();
  if (!item || typeof item !== 'object') return null;
  if (typeof item.documentId === 'string' && item.documentId.trim()) return item.documentId.trim();
  return null;
}

export function nextSeminarId(data, previousSeminarId) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'seminar')) return previousSeminarId || null;
  const seminar = data.seminar;
  if (seminar == null) return null;
  if (typeof seminar === 'string') return text(seminar) || null;
  const connected = relationDocumentIds(seminar);
  if (connected.length > 0) return connected[0];
  if (
    seminar &&
    typeof seminar === 'object' &&
    !Array.isArray(seminar) &&
    Array.isArray(seminar.disconnect) &&
    seminar.disconnect.length > 0 &&
    !seminar.connect &&
    !seminar.set
  ) {
    return null;
  }
  return previousSeminarId || null;
}
