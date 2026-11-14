import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshStatusLines } from './refresh-status-copy.ts';

const COMMIT = 'a'.repeat(40);
const FAILED = 'Новый релиз не прошёл проверку после переключения. Это не успех и не автоматический откат.';

test('старый успех показан как прошедшее событие, без сообщения о новом обновлении', () => {
  const lines = refreshStatusLines({ status: 'succeeded', message: 'Сайт обновлён. Опубликован весь снимок CMS, не только открытый семинар.', finishedAt: '2026-11-11T06:35:00Z' }, Date.parse('2026-11-13T06:35:00Z'));
  assert.equal(lines.message, '');
  assert.equal(lines.attempt, 'Последнее успешное обновление: 11 ноября 2026, 09:35 МСК.');
});

test('недавний успех показывается до 30 минут, но не при неверном или будущем времени', () => {
  const view = { status: 'succeeded', message: 'Сайт обновлён. Опубликован весь снимок CMS, не только открытый семинар.', finishedAt: '2026-11-11T06:35:00Z' };
  assert.equal(refreshStatusLines(view, Date.parse('2026-11-11T07:04:59Z')).message, 'Сайт обновлён.');
  assert.equal(refreshStatusLines(view, Date.parse('2026-11-11T07:05:00Z')).message, '');
  assert.equal(refreshStatusLines(view, Date.parse('2026-11-11T06:34:00Z')).message, '');
  assert.equal(refreshStatusLines({ ...view, finishedAt: 'invalid' }).message, '');
});

test('возврат предыдущего релиза не называется публикацией', () => {
  const lines = refreshStatusLines({ status: 'succeeded', message: 'Возвращён предыдущий релиз.', finishedAt: '2026-11-11T06:35:00Z' }, Date.parse('2026-11-13T06:35:00Z'));
  assert.equal(lines.message, 'Возвращён предыдущий релиз.');
  assert.match(lines.attempt ?? '', /^Завершено /);
});

test('подготовка материалов понятна и для сохранённого прежнего текста', () => {
  const lines = refreshStatusLines({ status: 'running', phase: 'capture', message: 'Снимается опубликованный снимок. Черновики в него не входят.' });
  assert.equal(lines.message, 'Подготавливаются опубликованные материалы. Черновики не попадут на сайт.');
  assert.equal(lines.phase, 'Подготавливаются опубликованные материалы');
});

test('успех называет время, релиз и коммит этой попытки', () => {
  const lines = refreshStatusLines({
    status: 'succeeded',
    message: 'Сайт обновлён. Опубликован весь снимок CMS, не только открытый семинар.',
    phase: 'done',
    releaseId: 'content-1',
    commit: COMMIT,
    finishedAt: '2026-09-27T00:00:00.000Z',
  });
  assert.equal(lines.phase, null);
  assert.equal(
    lines.attempt,
    `Последнее успешное обновление: 27 сентября 2026, 03:00 МСК — релиз content-1, коммит ${COMMIT}.`,
  );
});

test('HTTP 301 относится к завершённой попытке, а не к идущей проверке', () => {
  const lines = refreshStatusLines({
    status: 'verification-failed',
    message: FAILED,
    phase: 'verifying',
    detail: 'HTTP 301',
    releaseId: 'content-new',
    commit: COMMIT,
    finishedAt: '2026-09-27T00:00:00.000Z',
  });
  assert.equal(lines.phase, null);
  assert.equal(lines.message, FAILED);
  assert.equal(
    lines.attempt,
    `Завершено 27 сентября 2026, 03:00 МСК — релиз content-new, коммит ${COMMIT}. Проверка этого релиза вернула HTTP 301.`,
  );
  assert.doesNotMatch(`${lines.phase ?? ''} ${lines.attempt}`, /Проверяется/);
});

test('пока проверка идёт, видна фаза именно этого релиза', () => {
  const lines = refreshStatusLines({
    status: 'running',
    message: 'Проверяется выложенный релиз.',
    phase: 'verifying',
    releaseId: 'content-new',
    commit: COMMIT,
  });
  assert.equal(lines.phase, 'Проверяется выложенный релиз: content-new');
  assert.equal(lines.attempt, null);
});

test('старая запись без времени всё равно называет релиз сохранённой попытки', () => {
  const lines = refreshStatusLines({
    status: 'verification-failed',
    message: FAILED,
    phase: 'verifying',
    detail: 'HTTP 301',
    releaseId: 'content-old',
  });
  assert.equal(lines.phase, null);
  assert.equal(
    lines.attempt,
    'Последняя сохранённая попытка — релиз content-old. Проверка этого релиза вернула HTTP 301.',
  );
});
