import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadWorkflows, publishingWorkflows, workflowRunTrigger, type Workflow } from './helpers/workflows';

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
 * Признаки проверки фильтра по месяцу. Проверка, переехавшая в файл из списка долга,
 * уносит их с собой — и мета-гейт краснеет.
 *
 * Без этой части критерий на уровне файлов не заметил бы перенос проверки в уже
 * названную сироту: её содержимое ничем не ограничено. Предмет, а не соглашение о
 * тегах: любая браузерная проверка месяца обращается к контролу или к признаку
 * карточки.
 */
const MONTH_MARKERS = ['data-schedule-filter="month"', 'data-months'];

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

  it('проверки фильтра месяца лежат в исполняемых файлах, а не в сиротах', () => {
    const executed = executedSpecFiles(loadWorkflows());
    const withMarkers = specFiles().filter((file) => {
      const text = readFileSync(join(TESTS_DIR, file), 'utf-8');
      return MONTH_MARKERS.some((marker) => text.includes(marker));
    });

    // Пустой список означает, что проверок месяца нет вовсе, — это провал, а не
    // успех: иначе гейт зеленел бы ярче всего после их удаления.
    expect(
      withMarkers.filter((file) => executed.has(file)),
      'ни один исполняемый файл не проверяет фильтр по месяцу — проверять было нечего',
    ).not.toEqual([]);

    const hidden = withMarkers.filter((file) => !executed.has(file));
    expect(
      hidden,
      `проверки фильтра месяца лежат в файлах, которые не исполняет гейт публикации:\n${hidden.join('\n')}`,
    ).toEqual([]);
  });
});
