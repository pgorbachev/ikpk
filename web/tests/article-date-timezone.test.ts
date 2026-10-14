import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['2025-02-04T21:00:00.000Z', '4 февраля 2025 г.'],
  ['2026-02-26T21:00:00.000Z', '26 февраля 2026 г.'],
  ['2025-02-05T00:00:00+03:00', '4 февраля 2025 г.'],
  ['2025-02-05', '5 февраля 2025 г.'],
  ['2026-02-27', '27 февраля 2026 г.'],
  // SeminarSchedulePanel uses the same formatter for startAt/endAt.
  ['2026-11-30T00:00:00.000Z', '30 ноября 2026 г.'],
  ['2026-12-02T00:00:00.000Z', '2 декабря 2026 г.'],
  ['2026-11-30', '30 ноября 2026 г.'],
  ['2026-12-02', '2 декабря 2026 г.'],
] as const;

// The article page and cards use formatDate. The accepted preview displays the
// UTC calendar day; the build host must not move it to the previous/next day.
// Separate processes make TZ effective even when the test runner uses workers.
describe.each([
  ['UTC', 0],
  ['Europe/Moscow', -180],
  ['Pacific/Kiritimati', -840],
  ['Pacific/Niue', 660],
] as const)('article and seminar dates on a %s build host', (timeZone, expectedOffset) => {
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

  it('actually runs in the requested host timezone', () => {
    expect(result.offset).toBe(expectedOffset);
  });

  it.each(cases)('formats %s as %s', (input, expected) => {
    const index = cases.findIndex(([date]) => date === input);
    expect(result.labels[index]).toBe(expected);
  });
});
