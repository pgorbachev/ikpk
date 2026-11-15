import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshStatusLines } from './refresh-status-copy.ts';

const COMMIT = 'a'.repeat(40);
const FAILED = 'Новый релиз не прошёл проверку после переключения. Это не успех и не автоматический откат.';

test('во время сборки показывается одно понятное сообщение', () => {
  const lines = refreshStatusLines({ status: 'running', phase: 'build', message: 'Собирается сайт. Зависимости заново не ставятся.' });
  assert.equal(lines.message, 'Собирается и публикуется обновление сайта ...');
  assert.equal(lines.phase, null);
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
    `Завершено 27 сентября 2026, 03:00 МСК — релиз content-1, коммит ${COMMIT}.`,
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
