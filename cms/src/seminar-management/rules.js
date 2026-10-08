import { AsyncLocalStorage } from 'node:async_hooks';
import { calendarDateParts, hasExplicitOffset } from './wall-clock.js';

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

/**
 * Доверенным переносом считается запрос Content API с токеном полного доступа (D5):
 * признак — учётные данные запроса, проверенные самим Strapi, а не тело запроса.
 * `strapi.requestContext.get()` в middleware document service отдаёт сам koa-контекст,
 * поэтому поле — `ctx.state.auth` (@strapi/core, services/auth: `ctx.state.auth =
 * { strategy, credentials, ability }`); у токена Content API имя стратегии —
 * `content-api-token` (@strapi/admin, strategies/content-api-token.js), тип токена —
 * `credentials.type`, доверие даёт только `full-access`.
 */
function isTrustedRequest(strapi) {
  const auth = strapi?.requestContext?.get()?.state?.auth;
  return auth?.strategy?.name === 'content-api-token' && auth?.credentials?.type === 'full-access';
}

export function isTrustedImport(strapi) {
  if (trustedImport.getStore() === true) return true;
  return isTrustedRequest(strapi);
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

export const SEMINAR_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Пустое название не получает служебный slug модели.
 * Уже заданный адрес сохраняется, в том числе если название потом очистили в черновике.
 * Заглушка `seminar` при пустом прежнем названии заменяется, когда название появляется.
 *
 * Доверенный перенос (D5) при создании сохраняет переданный адрес прежнего сайта — его
 * не пересчитывать из названия. Форматную проверку и проверку занятости делает вызывающий
 * код: им нужен доступ к БД, а эта функция — чистая.
 */
export function decideSeminarSlug({ name, existingSlug, existingName, modelName, trustedImport, isCreate, incomingSlug }) {
  const trimmed = text(name);
  const slug = text(existingSlug);
  const previousName = text(existingName);
  if (!trimmed) {
    if (!slug) return { action: 'clear' };
    return { action: 'keep', slug };
  }
  if (trustedImport && isCreate) {
    const incoming = text(incomingSlug);
    if (incoming) return { action: 'incoming', slug: incoming };
  }
  if (!slug) return { action: 'generate' };
  if (!previousName && slug === modelName) return { action: 'generate' };
  return { action: 'keep', slug };
}

export function adminLabel(startAt, city) {
  const place = text(city) || 'город не указан';
  return `${adminDate(startAt)} · ${place}`;
}

/**
 * Повторное сохранение присылает уже нормализованное мгновение (`Z`).
 * Если момент не менялся, день подписи не пересчитывается: в `Z` нет зоны редактора.
 * Новый выбор в форме приходит со сдвигом браузера, и день берётся из этой строки.
 */
export function entryAdminLabel({ startAt, city, existingLabel, existingStartAt }) {
  const place = text(city) || 'город не указан';
  if (hasExplicitOffset(startAt)) return `${adminDate(startAt)} · ${place}`;
  if (text(existingLabel) && sameInstant(startAt, existingStartAt)) {
    const datePart = text(existingLabel).split(' · ')[0];
    return `${datePart} · ${place}`;
  }
  return `${adminDate(startAt)} · ${place}`;
}

function sameInstant(left, right) {
  if (left == null || right == null || left === '' || right === '') return false;
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  return !Number.isNaN(a) && a === b;
}

function adminDate(value) {
  const parts = calendarDateParts(value);
  if (!parts || !MONTHS[parts.month - 1]) return 'дата не указана';
  return `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`;
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

function numericId(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

export function relationNumericIds(value) {
  const ids = [];
  for (const item of relationItems(value)) {
    if (documentIdOf(item)) continue;
    const raw =
      typeof item === 'number' || typeof item === 'string'
        ? item
        : numericId(item?.documentId) != null
          ? item.documentId
          : item?.id;
    const id = numericId(raw);
    if (id != null) ids.push(id);
  }
  return ids;
}

export function documentIdOf(item) {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (!trimmed || numericId(trimmed) != null) return null;
    return trimmed;
  }
  if (!item || typeof item !== 'object') return null;
  if (typeof item.documentId === 'string' && item.documentId.trim() && numericId(item.documentId) == null) {
    return item.documentId.trim();
  }
  return null;
}

/** Пустой set, пустой массив и disconnect без нового connect снимают связь. */
export function relationClears(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== 'object') return false;
  const hasSet = Object.prototype.hasOwnProperty.call(value, 'set');
  const hasConnect = Object.prototype.hasOwnProperty.call(value, 'connect');
  const hasDisconnect = Object.prototype.hasOwnProperty.call(value, 'disconnect');
  const setEmpty = hasSet && relationItems(value.set).length === 0;
  const connectEmpty = !hasConnect || relationItems(value.connect).length === 0;
  const disconnects = hasDisconnect && relationItems(value.disconnect).length > 0;
  if (setEmpty && connectEmpty) return true;
  if (!hasSet && connectEmpty && disconnects) return true;
  return false;
}

/**
 * Фактическая связь в запросе. Числовой id — отдельный вид: его documentId
 * известен только после чтения строки, и подставлять прежний семинар нельзя.
 */
export function specifiedSeminar(data) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'seminar')) return { kind: 'absent' };
  const seminar = data.seminar;
  if (relationClears(seminar)) return { kind: 'clear' };
  const documents = relationDocumentIds(seminar);
  if (documents.length > 0) return { kind: 'document', documentId: documents[0] };
  const numbers = relationNumericIds(seminar);
  if (numbers.length > 0) return { kind: 'numeric', id: numbers[0] };
  return { kind: 'unchanged' };
}

export function nextSeminarId(data, previousSeminarId, resolvedNumericDocumentId) {
  const specified = specifiedSeminar(data);
  if (specified.kind === 'absent' || specified.kind === 'unchanged') return previousSeminarId || null;
  if (specified.kind === 'clear') return null;
  if (specified.kind === 'document') return specified.documentId;
  if (resolvedNumericDocumentId == null || resolvedNumericDocumentId === '') return null;
  return text(resolvedNumericDocumentId) || null;
}
