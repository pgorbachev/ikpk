/**
 * Гейт: объявленные сценарии месяца обязаны ВЫПОЛНИТЬСЯ в том прогоне, который держит
 * публикацию, а не просто существовать в собранном наборе.
 *
 * Предмет — JSON-отчёт **того самого** запуска playwright, который делает шаг
 * `Run schedule month filter tests` в job `e2e-smoke` workflow `Tests`. Поэтому проверка
 * живёт здесь и вызывается из `npm run test:e2e:schedule`, а не в юнит-конфигурации:
 * иначе юнит-прогон стал бы зависеть от браузерного, а браузерный — единственное место,
 * где вообще существует факт «тест выполнился».
 *
 * Что ловит именно эта проверка и не ловит соседняя (`tests/browser-test-gating.test.ts`,
 * сверка с `playwright test --list`): пропуск, случившийся ВО ВРЕМЯ прогона. Строка
 * `test.skip(true, '…')` в теле теста в собранном перечне выглядит как
 * `expectedStatus: "passed"` с пустыми `annotations` — статически она неотличима от
 * живого теста. Измерено на голове `19fdc1a1c8657404af5ac8f0d02eb0c0d7c52f5f`: одна такая
 * строка в `@month-narrow` оставила мета-гейт зелёным целиком (6 passed → 6 passed), а сам
 * прогон дал `1 skipped` и код выхода 0. То есть весь объём сценариев месяца выключался
 * одной строкой при двух зелёных гейтах.
 *
 * «Проверять было нечего» здесь — провал, а не успех: отсутствующий отчёт, нулевой
 * перечень и отчёт от прошлого запуска роняют проверку. Последнее не паранойя: зелёный
 * отчёт, оставшийся от предыдущего прогона, удовлетворил бы сверку ровно в том случае,
 * против которого она написана.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXPECTED_MONTH_TAGS, normalizeTag } from '../tests/helpers/month-tags';

/** Тот же путь по умолчанию, что задаёт `npm run test:e2e:schedule`. */
const REPORT = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME
  ?? join('test-results', 'schedule-month-run.json');

/** Отчёт старше этого — свидетельством не является: он про другой прогон. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

interface ReportTest {
  status?: string;
  results?: { status?: string }[];
}

interface ReportSpec {
  title?: string;
  file?: string;
  tags?: string[];
  tests?: ReportTest[];
}

interface ReportSuite {
  file?: string;
  specs?: ReportSpec[];
  suites?: ReportSuite[];
}

interface Report {
  suites?: ReportSuite[];
  errors?: unknown[];
  stats?: { startTime?: string; expected?: number; skipped?: number; unexpected?: number };
}

const fail = (message: string): never => {
  console.error(`check-month-run: ${message}`);
  process.exit(1);
};

if (!existsSync(REPORT)) {
  fail(
    `нет отчёта ${REPORT} — прогон сценариев месяца не состоялся либо писал отчёт не туда. ` +
      `Отсутствие отчёта это «не смогла проверить», а не «дефектов нет».`,
  );
}

const ageMs = Date.now() - statSync(REPORT).mtimeMs;
if (ageMs > MAX_AGE_MS) {
  fail(
    `отчёт ${REPORT} записан ${Math.round(ageMs / 60000)} мин назад — это отчёт другого ` +
      `прогона, и зелёный результат в нём ничего не говорит про текущий`,
  );
}

let report: Report;
try {
  report = JSON.parse(readFileSync(REPORT, 'utf-8')) as Report;
} catch (error) {
  fail(`отчёт ${REPORT} не разбирается как JSON: ${(error as Error).message}`);
  throw error;
}

if ((report.errors ?? []).length > 0) {
  fail(`прогон сообщил об ошибках: ${JSON.stringify(report.errors).slice(0, 400)}`);
}

const specs: ReportSpec[] = [];
const visit = (suites: ReportSuite[] | undefined, file: string): void => {
  for (const suite of suites ?? []) {
    const suiteFile = suite.file ?? file;
    for (const spec of suite.specs ?? []) specs.push({ ...spec, file: spec.file ?? suiteFile });
    visit(suite.suites, suiteFile);
  }
};
visit(report.suites, '');

if (specs.length === 0) {
  fail(`в отчёте ${REPORT} ноль сценариев — сверять не с чем`);
}

/** Метки одного сценария в нормализованном виде (`month-narrow`, без `@`). */
const tagsOf = (spec: ReportSpec): string[] => (spec.tags ?? []).map(normalizeTag);

/**
 * Выполнился ли сценарий. `expected` — прошёл как задумано, `flaky` — прошёл на повторе.
 * `skipped` не считается выполнением: именно этот случай проверка и ловит. `unexpected`
 * (падение) роняет сам прогон playwright, здесь он тоже назван — чтобы зелёный вывод
 * этой проверки не мог сопровождать красный прогон.
 */
const statusesOf = (spec: ReportSpec): string[] =>
  (spec.tests ?? []).map((test) => test.status ?? test.results?.[0]?.status ?? 'unknown');

const problems: string[] = [];
let live = 0;

for (const declared of EXPECTED_MONTH_TAGS.map(normalizeTag)) {
  const matching = specs.filter((spec) => tagsOf(spec).includes(declared));
  if (matching.length === 0) {
    problems.push(`@${declared} — в прогоне нет теста с этой меткой`);
    continue;
  }
  const executed = matching.filter((spec) =>
    statusesOf(spec).some((status) => status === 'expected' || status === 'flaky'),
  );
  if (executed.length === 0) {
    const seen = matching.map((spec) => `«${spec.title}» → ${statusesOf(spec).join(', ')}`);
    problems.push(`@${declared} — тест есть, но не выполнился: ${seen.join('; ')}`);
    continue;
  }
  live += 1;
}

/** Вторая половина симметрии: метка месяца в прогоне, которой нет в объявлении. */
const undeclared = [
  ...new Set(
    specs
      .flatMap(tagsOf)
      .filter((tag) => tag.startsWith('month-'))
      .filter((tag) => !EXPECTED_MONTH_TAGS.map(normalizeTag).includes(tag)),
  ),
];
if (undeclared.length > 0) {
  problems.push(`в прогоне метки, которых нет в объявлении: ${undeclared.map((t) => `@${t}`).join(', ')}`);
}

if (problems.length > 0) {
  fail(
    `сценарии месяца не выполнились в гейте публикации (${problems.length} из ` +
      `${EXPECTED_MONTH_TAGS.length} объявленных):\n${problems.join('\n')}`,
  );
}

console.log(
  `check-month-run: выполнены все ${live} объявленных сценариев месяца ` +
    `(в отчёте ${specs.length} сценариев, пропущено по данным прогона ${report.stats?.skipped ?? 0})`,
);
