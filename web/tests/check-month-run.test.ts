/**
 * Проверка самой проверки: `scripts/check-month-run.ts` обязана падать на ПУСТОМ
 * объявлении меток, а не отчитываться об успехе.
 *
 * Зачем это отдельным тестом. Цикл сверки идёт по `EXPECTED_MONTH_TAGS`, и при пустом
 * списке он не делает ни одного шага: `problems` остаётся пуст, скрипт печатает
 * «выполнены все 0 объявленных сценариев месяца» и выходит с кодом 0. То есть
 * «проверять было нечего» выдаётся за «дефектов нет» — ровно то, против чего написан
 * весь этот гейт. У сестринской сверки такой guard есть
 * (`tests/browser-test-gating.test.ts`, «объявленных меток месяца ноль — сверять
 * нечего»), и проверки обязаны быть однообразны: иначе потеря списка ловится в одной
 * из двух точек, а вторая молчит.
 *
 * Как подменяется объявление. Список — константа модуля, из окружения он не читается,
 * и трогать продуктовый файл ради теста нельзя. Поэтому скрипт запускается ПОДЛИННЫМ
 * содержимым (`copyFileSync` — байты те же) в одноразовом каталоге, где рядом лежит
 * `tests/helpers/month-tags.ts` с нужным списком и НАСТОЯЩИМ `normalizeTag`
 * (реэкспорт, а не копия: нормализация остаётся той же). Так измеряется поведение
 * реального файла, а не пересказ его логики.
 *
 * Отчёт в каждом прогоне содержит хотя бы один сценарий и НЕ содержит меток `month-*`:
 * иначе красное давала бы вторая половина симметрии («в прогоне метки, которых нет в
 * объявлении»), и тест был бы зелёным по совпадению, ничего не говоря про пустое
 * объявление.
 */

import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..');
const SCRIPT = join(WEB, 'scripts', 'check-month-run.ts');
const HELPER = join(WEB, 'tests', 'helpers', 'month-tags.ts');
const TSX = join(WEB, 'node_modules', '.bin', 'tsx');

interface FakeSpec {
  title: string;
  tags: string[];
  status: string;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Запустить подлинный скрипт с подменённым объявлением меток и синтетическим отчётом.
 * Метки в отчёте пишутся без ведущей `@` — так их кладёт playwright, см. `normalizeTag`.
 */
function runCheck(declared: string[], specs: FakeSpec[]): Run {
  const dir = mkdtempSync(join(tmpdir(), 'check-month-run-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'tests', 'helpers'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check-month-run.ts'));
  writeFileSync(
    join(dir, 'tests', 'helpers', 'month-tags.ts'),
    `export { normalizeTag } from ${JSON.stringify(HELPER)};\n` +
      `export const EXPECTED_MONTH_TAGS: string[] = ${JSON.stringify(declared)};\n`,
    'utf-8',
  );

  const report = join(dir, 'report.json');
  writeFileSync(
    report,
    JSON.stringify({
      errors: [],
      stats: { startTime: new Date().toISOString(), skipped: 0 },
      suites: [
        {
          file: 'tests/schedule-month.spec.ts',
          specs: specs.map((spec) => ({
            title: spec.title,
            tags: spec.tags,
            tests: [{ status: spec.status }],
          })),
        },
      ],
    }),
    'utf-8',
  );

  const run = spawnSync(TSX, [join(dir, 'scripts', 'check-month-run.ts')], {
    cwd: WEB,
    encoding: 'utf-8',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: report },
  });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

describe('гейт выполнения сценариев месяца', () => {
  it('на непустом объявлении с выполненным тестом проходит', () => {
    // Контроль вакуумности самого теста: без него красное ниже могло бы означать, что
    // запуск копии не работает вовсе — например, не разрешается подменённый модуль.
    const run = runCheck(['@month-narrow'], [
      { title: 'показаны только записи выбранного месяца @month-narrow', tags: ['month-narrow'], status: 'expected' },
    ]);

    expect(run.status, `ожидался код 0, а вышло ${run.status}\n${run.stderr}${run.stdout}`).toBe(0);
    expect(run.stdout).toContain('выполнены все 1 объявленных сценариев месяца');
  });

  it('на пустом объявлении падает, а не сообщает об успехе', () => {
    const run = runCheck([], [
      { title: 'посторонний сценарий без метки месяца', tags: ['smoke'], status: 'expected' },
    ]);

    // Отчёт без меток `month-*` — красным может быть только пустое объявление.
    expect(
      run.stderr,
      'красное дала вторая половина симметрии, а не пустое объявление — тест смотрит не на тот предмет',
    ).not.toContain('метки, которых нет в объявлении');
    expect(
      run.status,
      `пустое объявление принято за успех: код ${run.status}\n${run.stdout}${run.stderr}`,
    ).toBe(1);
    expect(run.stdout, 'вакуумность выдана за успех').not.toContain('выполнены все 0');
    expect(run.stderr).toMatch(/объявленных меток месяца ноль/);
  });
});
