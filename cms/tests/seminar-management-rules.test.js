import { test } from 'node:test';
import { toWallClockISO } from '../src/seminar-management/wall-clock.js';
import assert from 'node:assert/strict';
import {
  SEMINAR_MODEL_NAME,
  adminLabel,
  entryAdminLabel,
  classifyScheduleLink,
  isForeignAssignment,
  decideEntryName,
  decideSeminarSlug,
  entryPublicationErrors,
  foreignLinkIds,
  isTrustedImport,
  nextSeminarId,
  relationDocumentIds,
  relationClears,
  relationNumericIds,
  seminarPublicationError,
} from '../src/seminar-management/rules.js';

function fakeStrapi(auth) {
  return { requestContext: { get: () => ({ state: { auth } }) } };
}

test('редактор не задаёт имя проведения, сервер берёт название семинара', () => {
  const name = decideEntryName({
    trustedImport: false,
    incomingName: 'подмена',
    existingName: null,
    previousSeminarId: null,
    nextSeminarId: 'sem-1',
    nextSeminarName: 'НПК-1',
  });
  assert.equal(name, 'НПК-1');
});

test('правка без смены семинара сохраняет импортированное имя', () => {
  const name = decideEntryName({
    trustedImport: false,
    incomingName: 'НПК-1',
    existingName: 'Н-ПК-1',
    previousSeminarId: 'sem-1',
    nextSeminarId: 'sem-1',
    nextSeminarName: 'НПК-1',
  });
  assert.equal(name, 'Н-ПК-1');
});

test('явный перенос в карточке проведения берёт название нового семинара', () => {
  const name = decideEntryName({
    trustedImport: false,
    incomingName: 'старое',
    existingName: 'Н-ПК-1',
    previousSeminarId: 'sem-1',
    nextSeminarId: 'sem-2',
    nextSeminarName: 'НПК-2',
  });
  assert.equal(name, 'НПК-2');
});

test('первое присоединение дозаполняет пустое имя и не затирает уже заданное', () => {
  assert.equal(
    decideEntryName({
      trustedImport: false,
      incomingName: null,
      existingName: null,
      previousSeminarId: null,
      nextSeminarId: 'sem-1',
      nextSeminarName: 'НПК-1',
    }),
    'НПК-1',
  );
  assert.equal(
    decideEntryName({
      trustedImport: false,
      incomingName: 'НПК-1',
      existingName: 'Н-ПК-1',
      previousSeminarId: null,
      nextSeminarId: 'sem-1',
      nextSeminarName: 'НПК-1',
    }),
    'Н-ПК-1',
  );
});

test('черновик без семинара сохраняется с пустым именем', () => {
  assert.equal(
    decideEntryName({
      trustedImport: false,
      incomingName: 'нельзя',
      existingName: null,
      previousSeminarId: null,
      nextSeminarId: null,
      nextSeminarName: null,
    }),
    null,
  );
});

test('доверенный импорт (токен полного доступа) сохраняет исходное имя', () => {
  const trusted = fakeStrapi({ strategy: { name: 'content-api-token' }, credentials: { type: 'full-access' } });
  const imported = decideEntryName({
    trustedImport: isTrustedImport(trusted),
    incomingName: 'Н-ПК-1',
    existingName: null,
    previousSeminarId: null,
    nextSeminarId: 'sem-1',
    nextSeminarName: 'НПК-1',
  });
  assert.equal(imported, 'Н-ПК-1');
});

test('настраиваемый токен, панель и запрос без auth доверия не дают', () => {
  const custom = fakeStrapi({ strategy: { name: 'content-api-token' }, credentials: { type: 'custom' } });
  const panel = fakeStrapi({ strategy: { name: 'admin' } });
  const noAuth = fakeStrapi(undefined);
  assert.equal(isTrustedImport(custom), false);
  assert.equal(isTrustedImport(panel), false);
  assert.equal(isTrustedImport(noAuth), false);
  assert.equal(isTrustedImport({ requestContext: { get: () => undefined } }), false);
});

test('чужое проведение нельзя присоединить, своё и свободное можно', () => {
  assert.equal(classifyScheduleLink('sem-1', 'sem-2'), 'foreign');
  assert.equal(classifyScheduleLink('sem-1', 'sem-1'), 'keep');
  assert.equal(classifyScheduleLink('sem-1', null), 'attach');
  assert.equal(isForeignAssignment(null, 'sem-2'), true);
  assert.equal(isForeignAssignment(null, null), false);
  assert.deepEqual(
    foreignLinkIds('sem-1', [
      { documentId: 'own', seminarId: 'sem-1' },
      { documentId: 'free', seminarId: null },
      { documentId: 'other', seminarId: 'sem-2' },
    ]),
    ['other'],
  );
});

test('ошибочные даты блокируют публикацию, неполный черновик — нет', () => {
  assert.deepEqual(
    entryPublicationErrors({
      seminarId: 'sem-1',
      seminarName: 'НПК-1',
      startAt: '2026-05-10T00:00:00.000Z',
      endAt: '2026-05-09T00:00:00.000Z',
    }),
    ['Окончание проведения не может быть раньше начала.'],
  );
  assert.deepEqual(
    entryPublicationErrors({
      seminarId: 'sem-1',
      seminarName: 'НПК-1',
      startAt: '2026-05-10T00:00:00.000Z',
      endAt: null,
    }),
    [],
  );
  assert.deepEqual(
    entryPublicationErrors({
      seminarId: null,
      seminarName: null,
      startAt: null,
      endAt: null,
    }),
    ['Укажите семинар перед публикацией проведения.'],
  );
  assert.equal(seminarPublicationError('  '), 'Заполните название семинара.');
  assert.equal(seminarPublicationError('НПК-1'), null);
});

test('пустой новый семинар не получает slug модели, заполненное название его создаёт', () => {
  assert.deepEqual(
    decideSeminarSlug({
      name: '',
      existingSlug: null,
      existingName: null,
      modelName: SEMINAR_MODEL_NAME,
    }),
    { action: 'clear' },
  );
  assert.deepEqual(
    decideSeminarSlug({
      name: 'НПК-1',
      existingSlug: null,
      existingName: null,
      modelName: SEMINAR_MODEL_NAME,
    }),
    { action: 'generate' },
  );
  assert.deepEqual(
    decideSeminarSlug({
      name: 'Новое название',
      existingSlug: 'npk-1',
      existingName: 'НПК-1',
      modelName: SEMINAR_MODEL_NAME,
    }),
    { action: 'keep', slug: 'npk-1' },
  );
});

test('служебная заглушка seminar при пустом названии заменяется после заполнения', () => {
  assert.deepEqual(
    decideSeminarSlug({
      name: 'Основы кинезиологии',
      existingSlug: 'seminar',
      existingName: '',
      modelName: SEMINAR_MODEL_NAME,
    }),
    { action: 'generate' },
  );
  assert.deepEqual(
    decideSeminarSlug({
      name: 'Семинар',
      existingSlug: 'seminar',
      existingName: 'Семинар',
      modelName: SEMINAR_MODEL_NAME,
    }),
    { action: 'keep', slug: 'seminar' },
  );
});

test('подпись в списке показывает дату и город и не подменяет отсутствующие значения', () => {
  assert.equal(adminLabel('2026-03-12T00:00:00.000Z', 'Москва'), '12 марта 2026 · Москва');
  assert.equal(adminLabel(null, ''), 'дата не указана · город не указан');
  // Редактор ввёл полночь 1 октября. Строка несёт этот день и сдвиг браузера, не имя зоны.
  assert.equal(adminLabel('2026-10-01T00:00:00+03:00', 'Москва'), '1 октября 2026 · Москва');
  // Asia/Nicosia после перевода часов 2026-10-25 — UTC+2. 1 ноября 23:30 хранится как
  // 2026-11-01T21:30Z; в Москве это уже 2 ноября 00:30. Подпись остаётся 1 ноября.
  assert.equal(adminLabel('2026-11-01T23:30:00+02:00', 'Никосия'), '1 ноября 2026 · Никосия');
  assert.equal(adminLabel('2026-11-01T21:30:00.000Z', 'Никосия'), '1 ноября 2026 · Никосия');
  const instant = new Date('2026-11-01T21:30:00.000Z');
  assert.equal(zoned('Asia/Nicosia', instant), '2026-11-01 23:30');
  assert.equal(zoned('Europe/Moscow', instant), '2026-11-02 00:30');
});

test('повторное сохранение мгновения не переписывает день подписи чужой зоной', () => {
  assert.equal(
    entryAdminLabel({
      startAt: '2026-09-30T21:00:00.000Z',
      city: 'Тула',
      existingLabel: '1 октября 2026 · Москва',
      existingStartAt: '2026-10-01T00:00:00+03:00',
    }),
    '1 октября 2026 · Тула',
  );
  assert.equal(
    entryAdminLabel({
      startAt: '2026-11-01T23:30:00+02:00',
      city: 'Никосия',
      existingLabel: '2 ноября 2026 · Никосия',
      existingStartAt: '2026-11-01T21:30:00.000Z',
    }),
    '1 ноября 2026 · Никосия',
  );
});

test('календарь формы сохраняет выбранный день, а не день UTC', () => {
  const picked = new Date(2026, 9, 1, 0, 0, 0);
  const submitted = toWallClockISO(picked);
  assert.match(submitted, /^2026-10-01T00:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(adminLabel(submitted, 'Москва'), '1 октября 2026 · Москва');
  assert.equal(new Date(submitted).getTime(), picked.getTime());
});

function zoned(timeZone, instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
}

test('идентификаторы связи читаются из всех форм, которые принимает Strapi', () => {
  assert.deepEqual(
    relationDocumentIds({ connect: [{ documentId: 'a' }, { id: 7 }] }),
    ['a'],
  );
  assert.deepEqual(relationNumericIds({ connect: [{ documentId: 'a' }, { id: 7 }, 8, '9'] }), [7, 8, 9]);
  assert.deepEqual(relationDocumentIds({ connect: ['9'] }), []);
  assert.deepEqual(relationDocumentIds(['entry-a', { documentId: 'entry-b' }]), ['entry-a', 'entry-b']);
  assert.deepEqual(relationDocumentIds({ set: ['entry-a'] }), ['entry-a']);
  assert.equal(nextSeminarId({ seminar: { connect: [{ documentId: 'sem-2' }] } }, 'sem-1'), 'sem-2');
  assert.equal(nextSeminarId({ seminar: ['sem-2'] }, 'sem-1'), 'sem-2');
  assert.equal(nextSeminarId({}, 'sem-1'), 'sem-1');
  assert.equal(nextSeminarId({ seminar: { disconnect: [{ documentId: 'sem-1' }] } }, 'sem-1'), null);
  assert.equal(nextSeminarId({ seminar: { set: [] } }, 'sem-1'), null);
  assert.equal(nextSeminarId({ seminar: [] }, 'sem-1'), null);
  assert.equal(nextSeminarId({ seminar: { disconnect: ['sem-1'], connect: [] } }, 'sem-1'), null);
  assert.equal(relationClears({ connect: [] }), false);
  assert.equal(nextSeminarId({ seminar: { connect: [] } }, 'sem-1'), 'sem-1');
  assert.equal(nextSeminarId({ seminar: '9' }, 'sem-1'), null);
  assert.equal(nextSeminarId({ seminar: '9' }, 'sem-1', 'sem-2'), 'sem-2');
  assert.equal(nextSeminarId({ seminar: { connect: [{ id: 9 }] } }, 'sem-1', 'sem-2'), 'sem-2');
  assert.equal(nextSeminarId({ seminar: [9] }, 'sem-1', 'sem-2'), 'sem-2');
  assert.equal(nextSeminarId({ seminar: { set: [{ id: 9 }] } }, 'sem-1', 'sem-2'), 'sem-2');
  assert.equal(nextSeminarId({ seminar: { id: 9 } }, 'sem-1', 'sem-2'), 'sem-2');
  assert.equal(nextSeminarId({ seminar: { connect: ['9'] } }, 'sem-1', 'sem-2'), 'sem-2');
  assert.equal(
    decideEntryName({
      trustedImport: false,
      incomingName: null,
      existingName: 'Семинар А',
      previousSeminarId: 'sem-1',
      nextSeminarId: 'sem-2',
      nextSeminarName: 'Семинар Б',
    }),
    'Семинар Б',
  );
});
