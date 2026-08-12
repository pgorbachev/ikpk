import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { loadWorkflows, publishingWorkflows, workflowRunTrigger, type Workflow } from './helpers/workflows';
import { EXPECTED_MONTH_TAGS, normalizeTag } from './helpers/month-tags';

// ─── Мета-гейт: браузерная проверка обязана исполняться в гейте публикации ────
// Спецификация: openspec/changes/schedule-month-filter/specs/schedule-month-filter/spec.md,
// требование «Проверка месяца обязана исполняться в гейте публикации».
//
// Тест ЗЕЛЁНЫЙ по замыслу ([GREEN-BY-DESIGN] в tasks.md, 2.19): он фиксирует
// существующее состояние и не даёт молча его пополнить. Свидетельство для него —
// негативная мутация, а не красный прогон.
//
// Формулировка «все браузерные проверки исполняются» невыполнима с первого дня:
// файлов вне любого гейтующего workflow сейчас восемь, и приводить их в порядок —
// отдельная работа. Поэтому критерий двусоставный: файл либо исполняется workflow,
// требуемым для публикации, либо ПОИМЕННО назван в списке признанного долга ниже.
//
// Требуемые workflow не перечислены здесь константой намеренно: состав обязательного
// прогона меняется независимо от этой работы. Он выводится из репозитория — какой
// workflow публикует сайт, и о завершении какого workflow он ждёт события.

const TESTS_DIR = import.meta.dirname;
const PACKAGE_JSON = join(TESTS_DIR, '..', 'package.json');

/**
 * Признанный долг: браузерные проверки, которые не исполняет ни один гейтующий
 * workflow. Список — не молчаливое сужение: каждый файл назван, и новый файл вне
 * исполняемого набора и вне этого списка роняет проверку.
 *
 * Расхождение со спекой, названное вслух: спека перечисляет семь файлов-сирот и не
 * упоминает `compat.spec.ts`. Он исполняется — но workflow `Nightly full checks`,
 * который для публикации НЕ требуется (AGENTS.md, «Гейт публикации»), то есть по
 * критерию спеки он такая же сирота, как остальные. Восьмым он записан здесь, а не
 * скрыт подгонкой критерия под число.
 *
 * Приведение самих этих файлов в порядок — отдельная работа, не часть фильтра по
 * месяцу.
 */
const ACKNOWLEDGED_DEBT = [
  'compare.spec.ts',
  'compat.spec.ts',
  'course-group-parity.spec.ts',
  'institute-parity.spec.ts',
  'parity-audit.spec.ts',
  'schedule-parity.spec.ts',
  'seminar-parity.spec.ts',
  'visual-baseline.spec.ts',
];

/**
 * Признаки обращения к фильтру месяца. Используются ТОЛЬКО в одну сторону: строка,
 * найденная в файле из списка долга, роняет проверку — это условие про МЕСТО.
 *
 * Обратное направление запрещено: из наличия строки наличие проверки не выводится.
 * Прежняя редакция выводила, и потому была декоративной — все сценарии месяца можно
 * было удалить, оставив в файле `// data-months`, и гейт оставался зелёным. Наличие
 * проверки теперь устанавливается только по собранному набору тестов.
 */
const MONTH_MARKERS = ['data-schedule-filter="month"', 'data-months'];

/**
 * Метки браузерных сценариев фильтра месяца — объявление, с которым сверяется
 * СОБРАННЫЙ набор тестов. Сам список лежит в `helpers/month-tags.ts`, потому что с ним
 * сверяются ДВА гейта: этот (сбор) и `scripts/check-month-run.ts` (прогон). Две копии
 * разошлись бы, и «объявлено» перестало бы быть одним фактом.
 *
 * Метка, а не название теста: названия переписывают при правке формулировок, и сверка
 * по ним краснела бы от переименования, то есть от работы, которая ничего не ломает.
 * Метка живёт в имени теста (`@month-…`) и попадает в поле `tags` собранного перечня.
 *
 * Сверка СИММЕТРИЧНА: объявленная метка без теста и собранная метка без объявления
 * роняют гейт одинаково. Асимметричная сверка сделала бы «сценарий переименовали»
 * неотличимым от «сценарий потеряли».
 *
 * Граница этой сверки названа вслух: пропуск ВО ВРЕМЯ ПРОГОНА (`test.skip(true, …)` в
 * теле) она увидеть не может — в собранном перечне такой тест выглядит как
 * `expectedStatus: "passed"` без аннотаций. Ловится он только сверкой с прогоном, и
 * потому вторая сверка живёт рядом с прогоном, а не здесь. Сам список и нормализация
 * метки импортированы из `helpers/month-tags.ts` выше.
 */

/** Workflow, успех которых требуется для публикации сайта. */
function gatingWorkflows(all: Workflow[]): Workflow[] {
  const publishing = publishingWorkflows(all);
  expect(publishing.length, 'в репозитории нет workflow, публикующего сайт — проверять нечего')
    .toBeGreaterThan(0);

  const required = new Set(
    publishing.flatMap((wf) => workflowRunTrigger(wf)?.workflows ?? []),
  );
  expect(
    [...required],
    'ни один публикующий workflow не ждёт события о завершении проверок — гейта публикации нет',
  ).not.toEqual([]);

  const gating = all.filter((wf) => required.has(wf.displayName));
  const missing = [...required].filter((name) => !all.some((wf) => wf.displayName === name));
  expect(missing, `публикация ждёт workflow, которых нет в репозитории: ${missing.join(', ')}`).toEqual([]);
  return gating;
}

/** Команды, которые гейтующие workflow действительно запускают. */
function gatingCommands(all: Workflow[]): string[] {
  const commands = gatingWorkflows(all)
    .flatMap((wf) => Object.values(wf.jobs))
    .flatMap((job) => job.steps)
    .map((step) => step.run ?? '')
    .filter(Boolean);
  expect(commands.length, 'в гейтующих workflow не нашлось ни одной команды — разбор сломан').toBeGreaterThan(0);
  return commands;
}

/**
 * Файлы браузерных проверок, до которых доходит исполнение: команды workflow
 * раскрываются по скриптам `package.json` транзитивно, потому что `npm run
 * test:e2e:smoke` в самом workflow имени файла не содержит.
 */
function executedSpecFiles(all: Workflow[]): Set<string> {
  const scripts: Record<string, string> = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')).scripts ?? {};
  expect(Object.keys(scripts).length, 'в package.json нет скриптов — раскрывать нечего').toBeGreaterThan(0);

  const seen = new Set<string>();
  const found = new Set<string>();

  const expand = (command: string): void => {
    for (const match of command.matchAll(/([\w./-]+\.spec\.ts)/g)) {
      found.add(match[1].replace(/^tests\//, ''));
    }
    for (const match of command.matchAll(/npm\s+(?:run\s+)?([\w:-]+)/g)) {
      const name = match[1] === 'test' ? 'test' : match[1];
      if (seen.has(name) || scripts[name] === undefined) continue;
      seen.add(name);
      expand(scripts[name]);
    }
  };

  gatingCommands(all).forEach(expand);
  return found;
}

const specFiles = (): string[] => {
  const files = readdirSync(TESTS_DIR).filter((name) => name.endsWith('.spec.ts'));
  expect(files.length, `в ${TESTS_DIR} нет ни одного *.spec.ts — проверять нечего`).toBeGreaterThan(0);
  return files;
};

// ─── Собранный набор тестов, а не текст файлов ────────────────────────────────
// Сбор импортирует файлы и исполняет регистрации `test()`, поэтому закомментированный
// или удалённый тест в перечень не попадает, а строка в комментарии в него попасть не
// может вовсе. Именно этим новая редакция отличается от прежней, текстовой.

const WEB_DIR = join(TESTS_DIR, '..');
const PLAYWRIGHT_BIN = join(WEB_DIR, 'node_modules', '.bin', 'playwright');

interface CollectedTest {
  file: string;
  title: string;
  tags: string[];
  /** Пропускаемый тест в перечне ВИДЕН, но не выполняется. */
  skipKind?: string;
}

/**
 * Аргументы всех вызовов `playwright test` внутри гейтующих workflow — те самые, с
 * которыми проверки запускает публикация. Раскрываются по скриптам `package.json`:
 * в самом workflow стоит `npm run test:e2e:…`, а имя файла и проекты лежат в скрипте.
 *
 * Собираются ВСЕ вызовы, а не только тот, что упоминает файл месяца: требование —
 * «сценарий исполняется гейтом публикации», а не «лежит в конкретном файле». Перенос
 * сценария в другой гейтующий файл требование не нарушает и гейт ронять не должен.
 */
function gatingPlaywrightArgs(all: Workflow[]): string[][] {
  const scripts: Record<string, string> = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')).scripts ?? {};
  const seen = new Set<string>();
  const invocations: string[][] = [];

  const expand = (command: string): void => {
    for (const part of command.split(/&&|;|\|\|/)) {
      const call = part.match(/(?:^|\s)(?:npx\s+)?playwright\s+test\s+(.+)$/);
      if (call) invocations.push(call[1].trim().split(/\s+/).filter(Boolean));
      for (const match of part.matchAll(/npm\s+(?:run\s+)?([\w:-]+)/g)) {
        const name = match[1];
        if (seen.has(name) || scripts[name] === undefined) continue;
        seen.add(name);
        expand(scripts[name]);
      }
    }
  };

  gatingCommands(all).forEach(expand);
  expect(
    invocations.length,
    'в гейтующих workflow не нашлось ни одного вызова playwright — сверять набор не с чем',
  ).toBeGreaterThan(0);
  return invocations;
}

/** Сбор запускает подпроцессы; результат один и тот же, поэтому считается один раз. */
let collectedCache: CollectedTest[] | undefined;

/** Перечень тестов, собранный тем же вызовом с добавленными `--list --reporter=json`. */
function collectTests(all: Workflow[]): CollectedTest[] {
  if (collectedCache !== undefined) return collectedCache;
  expect(
    existsSync(PLAYWRIGHT_BIN),
    `нет ${PLAYWRIGHT_BIN} — собрать набор нечем (npm ci не выполнялся?)`,
  ).toBe(true);

  const collected: CollectedTest[] = [];
  for (const args of gatingPlaywrightArgs(all)) {
    // `--list` перечисляет тесты и НЕ поднимает `webServer` из playwright.config.ts
    // (проверено прогоном: ни одного слушающего порта до и после, сборки dist нет
    // вовсе). Поэтому сбор идёт подпроцессом отсюда и сайт при этом не собирается.
    const run = spawnSync(PLAYWRIGHT_BIN, ['test', ...args, '--list', '--reporter=json'], {
      cwd: WEB_DIR,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });

    // Три исхода различаются по СОДЕРЖИМОМУ, а не по коду выхода: при несовпавшем
    // фильтре playwright отдаёт код 1 с корректным JSON и пустым `suites`, при
    // ошибке разбора аргументов — код 1 и текст вместо JSON. Проверка только по коду
    // выхода свалила бы «перечень пуст» и «сбор сломан» в одно сообщение, а разница
    // между ними — это ровно разница между «проверять было нечего» и «инструмент не
    // запустился».
    const call = `playwright test ${args.join(' ')} --list`;
    let report: { suites?: unknown[]; errors?: unknown[] };
    try {
      report = JSON.parse(run.stdout) as { suites?: unknown[]; errors?: unknown[] };
    } catch {
      throw new Error(
        `сбор набора не запустился (${call}), код ${run.status}, вывод не разбирается как JSON:\n${(run.stderr || run.stdout).slice(0, 400)}`,
      );
    }
    expect(
      report.errors ?? [],
      `сбор набора сообщил об ошибках (${call}): ${JSON.stringify(report.errors).slice(0, 400)}`,
    ).toEqual([]);
    // Подстраховка, а НЕ та проверка, которая ловит пустой перечень сегодня: в
    // playwright 1.62.1 нулевой результат приходит как `errors: ["No tests found"]`,
    // то есть падает условие выше — проверено мутацией с несовпадающим `--grep`.
    // Ветка остаётся на случай версии, которая отдаст пустой список без ошибки;
    // выдавать её за действующий страж было бы неправдой.
    expect(
      (report.suites ?? []).length,
      `вызов «${call}» собрал ноль тестов — перечень пуст, сверять не с чем`,
    ).toBeGreaterThan(0);
    const visit = (suites: unknown[] | undefined, file: string): void => {
      for (const raw of suites ?? []) {
        const suite = raw as { file?: string; specs?: unknown[]; suites?: unknown[] };
        const suiteFile = suite.file ?? file;
        for (const rawSpec of suite.specs ?? []) {
          const spec = rawSpec as {
            title?: string;
            tags?: string[];
            file?: string;
            tests?: { expectedStatus?: string; annotations?: { type?: string }[] }[];
          };
          // Тест числится пропускаемым, если ПО ВСЕМ проектам он пропущен: прогон в
          // одном проекте и пропуск в другом — это выполняемый сценарий.
          const runs = spec.tests ?? [];
          const skips = runs.map(
            (test) =>
              test.annotations?.find((note) => note.type === 'skip' || note.type === 'fixme')?.type ??
              (test.expectedStatus === 'skipped' ? 'skipped' : undefined),
          );
          collected.push({
            file: spec.file ?? suiteFile,
            title: spec.title ?? '',
            tags: (spec.tags ?? []).map(normalizeTag),
            skipKind: runs.length > 0 && skips.every(Boolean) ? skips[0] : undefined,
          });
        }
        visit(suite.suites, suiteFile);
      }
    };
    visit(report.suites, '');
  }

  // Пустой перечень — провал, а не успех: сверка с пустым набором проходит всегда.
  expect(collected.length, 'собранный набор тестов пуст — сверять не с чем').toBeGreaterThan(0);
  collectedCache = collected;
  return collected;
}

const monthTagsOf = (tests: CollectedTest[]): CollectedTest[] =>
  tests.filter((test) => test.tags.some((tag) => tag.startsWith('month-')));

describe('браузерные проверки и гейт публикации', () => {
  it('каждый файл либо исполняется гейтующим workflow, либо назван в списке долга', () => {
    const executed = executedSpecFiles(loadWorkflows());
    expect(executed.size, 'ни один файл браузерных проверок не исполняется — разбор workflow сломан')
      .toBeGreaterThan(0);

    const orphans = specFiles().filter((file) => !executed.has(file) && !ACKNOWLEDGED_DEBT.includes(file));
    expect(
      orphans,
      `эти проверки не исполняет ни один workflow, требуемый для публикации, и в списке признанного долга их нет:\n${orphans.join('\n')}`,
    ).toEqual([]);
  });

  it('список долга не содержит имён, которые уже исполняются или которых нет', () => {
    // Список, который ничего не держит, — декорация. Устаревшее имя в нём молча
    // разрешало бы будущему файлу с тем же именем не исполняться.
    const executed = executedSpecFiles(loadWorkflows());
    const present = specFiles();

    const stale = ACKNOWLEDGED_DEBT.filter((file) => !present.includes(file));
    const resolved = ACKNOWLEDGED_DEBT.filter((file) => executed.has(file));

    expect(stale, `в списке долга файлы, которых в репозитории нет: ${stale.join(', ')}`).toEqual([]);
    expect(resolved, `файлы уже исполняются — их пора убрать из списка долга: ${resolved.join(', ')}`).toEqual([]);
  });

  it('под каждую объявленную метку в собранном наборе есть выполняемый тест', () => {
    const collected = collectTests(loadWorkflows());
    const live = new Set(
      collected.filter((test) => test.skipKind === undefined).flatMap((test) => test.tags),
    );
    const skipped = new Map(
      collected
        .filter((test) => test.skipKind !== undefined)
        .flatMap((test) => test.tags.map((tag) => [tag, `${test.skipKind}: «${test.title}»`])),
    );

    const missing = EXPECTED_MONTH_TAGS.map(normalizeTag)
      .filter((tag) => !live.has(tag))
      .map((tag) => (skipped.has(tag) ? `@${tag} — ${skipped.get(tag)}` : `@${tag} — теста нет в собранном наборе`));

    expect(
      missing,
      `объявленные сценарии месяца не исполняются гейтом публикации (${missing.length}):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('в собранном наборе нет меток месяца, которых нет в объявлении', () => {
    // Вторая половина симметрии. Без неё переименование метки выглядело бы как
    // порядок: объявленная метка исчезла бы вместе с проверкой, а новая прошла бы
    // незамеченной.
    const collected = monthTagsOf(collectTests(loadWorkflows()));
    expect(
      collected.length,
      'в собранном наборе нет ни одного сценария месяца — проверять было нечего',
    ).toBeGreaterThan(0);

    const declared = new Set(EXPECTED_MONTH_TAGS.map(normalizeTag));
    const undeclared = collected
      .flatMap((test) => test.tags.filter((tag) => tag.startsWith('month-')))
      .filter((tag) => !declared.has(tag))
      .map((tag) => `@${tag}`);

    expect(
      [...new Set(undeclared)],
      `в собранном наборе метки, которых нет в объявлении: ${[...new Set(undeclared)].join(', ')}`,
    ).toEqual([]);
  });

  it('у каждого сценария месяца есть метка — непомеченный гейту невидим', () => {
    // Файл здесь только ЛОКАТОР: по признакам находим файлы про месяц, а наличие и
    // помеченность сценариев берём из собранного набора. Без этой проверки новый
    // сценарий без метки был бы для сверки невидим — ни в одну сторону не упало бы.
    const executed = executedSpecFiles(loadWorkflows());
    const monthFiles = specFiles().filter((file) => {
      const text = readFileSync(join(TESTS_DIR, file), 'utf-8');
      return executed.has(file) && MONTH_MARKERS.some((marker) => text.includes(marker));
    });
    expect(
      monthFiles,
      'ни один исполняемый файл не обращается к фильтру месяца — проверять было нечего',
    ).not.toEqual([]);

    const untagged = collectTests(loadWorkflows())
      .filter((test) => monthFiles.some((file) => test.file.endsWith(file)))
      .filter((test) => !test.tags.some((tag) => tag.startsWith('month-')))
      .map((test) => `«${test.title}» (${test.file})`);

    expect(
      untagged,
      `сценарии в файлах про месяц без метки @month-…:\n${untagged.join('\n')}`,
    ).toEqual([]);
  });

  it('признаки фильтра месяца не встречаются в файлах из списка долга', () => {
    // Условие про МЕСТО — единственное направление, в котором текст файла остаётся
    // законным доводом: строка в сироте роняет гейт. Обратное («строка есть — значит
    // проверка есть») запрещено и заменено сверкой с собранным набором выше.
    const hidden = ACKNOWLEDGED_DEBT.filter((file) => {
      const path = join(TESTS_DIR, file);
      return existsSync(path) && MONTH_MARKERS.some((marker) => readFileSync(path, 'utf-8').includes(marker));
    });
    expect(
      hidden,
      `проверки фильтра месяца уехали в файлы вне обязательного прогона:\n${hidden.join('\n')}`,
    ).toEqual([]);
  });
});
