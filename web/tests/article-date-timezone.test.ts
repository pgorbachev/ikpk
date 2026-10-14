import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

// CMS хранит дату статьи как московскую полночь: все 68 `published_at` живого снимка —
// `T21:00:00Z` предыдущего дня. На исходном сайте у
// `gryzha-pishevodnogo-otverstiya-diafragmy` дата 2025-02-05; сборка на хосте UTC+2 печатала
// «4 февраля». Проведения семинаров приходят полночью UTC и обязаны остаться своим днём.
const cases = [
  ['2025-02-04T21:00:00.000Z', '5 февраля 2025 г.'],
  ['2026-02-26T21:00:00.000Z', '27 февраля 2026 г.'],
  ['2025-05-25T21:00:00.000Z', '26 мая 2025 г.'],
  ['2025-02-05T00:00:00+03:00', '5 февраля 2025 г.'],
  // Летнее время хоста дня не сдвигает: в Москве перехода нет.
  ['2025-03-29T21:00:00.000Z', '30 марта 2025 г.'],
  ['2025-10-25T21:00:00.000Z', '26 октября 2025 г.'],
  ['2025-02-05', '5 февраля 2025 г.'],
  // SeminarSchedulePanel печатает startAt/endAt тем же форматтером.
  ['2026-11-30T00:00:00.000Z', '30 ноября 2026 г.'],
  ['2026-12-02T00:00:00.000Z', '2 декабря 2026 г.'],
] as const;

// Отдельный процесс на каждый пояс: внутри воркера vitest TZ уже не переключить.
describe.each([
  ['UTC', 0],
  ['Europe/Moscow', -180],
  ['Asia/Nicosia', -120],
  ['Pacific/Kiritimati', -840],
  ['Pacific/Niue', 660],
] as const)('даты статей и семинаров при сборке в поясе %s', (timeZone, expectedOffset) => {
  let result: { offset: number; labels: string[] };

  beforeAll(() => {
    result = JSON.parse(execFileSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { formatDate } from './src/lib/data.ts';
       const dates = ${JSON.stringify(cases.map(([input]) => input))};
       console.log(JSON.stringify({
         offset: new Date('2025-02-04T21:00:00.000Z').getTimezoneOffset(),
         labels: dates.map(formatDate),
       }));`,
    ], {
      cwd: webRoot,
      env: { ...process.env, TZ: timeZone },
      encoding: 'utf8',
    }));
  });

  it('процесс действительно работает в заданном поясе', () => {
    expect(result.offset).toBe(expectedOffset);
  });

  it.each(cases)('%s печатается как %s', (input, expected) => {
    const index = cases.findIndex(([date]) => date === input);
    expect(result.labels[index]).toBe(expected);
  });
});
