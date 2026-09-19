import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  loadWorkflows,
  requiredTestWorkflows,
  stripShellComments,
  REPO_ROOT,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from './helpers/workflows';
import {
  MODULES,
  loadModule,
  type PublishedStateModule,
} from './helpers/cms-content-publication-contract';

// manual-publication-only: Tests prepares a verdict from the pinned snapshot.
// Publication, live capture and release reconciliation belong to the local path.
// Snapshot compatibility remains a separate, deliberately networked workflow.

const workflows = loadWorkflows();
const TESTS_WORKFLOW = 'Tests';
const DEFAULT_BRANCH = 'main';

/**
 * Признак обращения к системе управления. Ловится ЛЮБОЕ упоминание её адреса или токена в
 * тексте шага — `run`, `env`, `with`, — а не одна заранее выбранная форма записи: обход
 * всегда находится там, где признак сужен до удобной формы.
 */
const CMS_MARKERS = /CMS_(URL|TOKEN|API|BASE)|STRAPI_(URL|TOKEN|API)|CONTENT_API/;

/** Шаг, который снимает снимок с живой системы управления. */
const SNAPSHOT_PRODUCER = /snapshot:capture|content:snapshot|capture-content-snapshot/;

/** Шаг, который получает уже снятый снимок артефактом. */
const SNAPSHOT_CONSUMER = /snapshot/i;

function stepText(step: WorkflowStep): string {
  return stripShellComments(step.raw);
}

function allSteps(): { wf: Workflow; job: WorkflowJob; step: WorkflowStep }[] {
  return workflows.flatMap((wf) =>
    Object.values(wf.jobs).flatMap((job) => job.steps.map((step) => ({ wf, job, step }))),
  );
}

/**
 * npm-скрипты `web/package.json`: сборка бывает спрятана внутри скрипта
 * (`test:build:remote` → `npm run build && …`), и текст шага в YAML тогда не содержит
 * буквального `npm run build` вовсе. Найдено измерением tasks.md 5.2b — предыдущая версия
 * этого файла ловила только буквальный текст и пропускала `nightly.yml:75`.
 */
const NPM_SCRIPTS: Record<string, string> = (() => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'web', 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) {
    throw new Error('web/package.json: секция scripts пуста или отсутствует — резолвить нечего');
  }
  return pkg.scripts;
})();

/** Разворачивает `npm run <имя>` рекурсивно через определения `web/package.json`. */
function resolveNpmScripts(script: string): string {
  let result = script;
  const seen = new Set<string>();
  for (let pass = 0; pass < 10; pass += 1) {
    const names = [...result.matchAll(/\bnpm run ([\w:-]+)\b/g)].map((m) => m[1]!);
    const next = names.filter((n) => !seen.has(n) && NPM_SCRIPTS[n] !== undefined);
    if (next.length === 0) return result;
    for (const name of next) {
      seen.add(name);
      result = result.replaceAll(`npm run ${name}`, NPM_SCRIPTS[name]!);
    }
  }
  throw new Error(`резолвинг npm-скриптов не сошёлся за 10 проходов: ${script}`);
}

/** `nightly.yml:75` «Run remote parity tests» — вершинная сборка, но вне объёма 5.2 (см. 5.2a):
 *  сверяет с живым ikpk.su, закреплённая фикстура делает эту сверку бессмысленной. */
const OUT_OF_SCOPE_5_2A = /remote parity/i;

/**
 * Вызовы сборки, строящие ВЕРШИНУ прогона. Три из одиннадцати строят `BASE_SHA` во временном
 * worktree и предметом задачи 5.2 не являются (tasks.md 3.9a) — отделяются по имени шага, а не
 * по номеру строки: номер сдвинется при первой же правке файла. Один (5.2a) исключён по тому же
 * принципу — по имени, а не по тексту команды, иначе появление явного `npm run build` в нём
 * молча вернуло бы его в это число.
 */
function headBuildInvocations(): { wf: Workflow; job: WorkflowJob; step: WorkflowStep }[] {
  return allSteps().filter(({ step }) => {
    if (/\bbase\b/i.test(step.name ?? '')) return false;
    if (OUT_OF_SCOPE_5_2A.test(step.name ?? '')) return false;
    const script = resolveNpmScripts(stripShellComments(step.run ?? ''));
    return /\bnpm run build(:demo|:stand)?\b/.test(script) || /\bastro build\b/.test(script);
  });
}

describe('закреплённый снимок обязательного CI', () => {
  const tests = (): Workflow => requiredTestWorkflows(workflows)[0];

  it('обязательный прогон содержит все пять обязательных джобов и не пишет публикации', () => {
    expect(Object.keys(tests().jobs).sort()).toEqual([
      'content-snapshot', 'dependency-invariants', 'e2e-smoke', 'scripts-unit', 'unit-and-build',
    ]);
    expect(tests().permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(tests().jobs)) {
      expect(job.permissions).not.toEqual(expect.objectContaining({ contents: 'write' }));
      expect(job.permissions).not.toBe('write-all');
    }
  });

  it('единственный подготовитель Tests явно выбирает закреплённый источник', () => {
    const producers = Object.values(tests().jobs).flatMap((job) => job.steps)
      .filter((step) => /snapshot:prepare/.test(step.run ?? ''));
    expect(producers).toHaveLength(1);
    expect(producers[0].env?.CONTENT_SNAPSHOT_DIR).toBe('${{ github.workspace }}/fixtures/content-snapshot');
    expect(producers[0].run).toMatch(/cp -R "?\.snapshot\/\./);
  });

  it('Tests не обращается к CMS и не сверяет закреплённый снимок с живым журналом или раздачей', () => {
    const steps = Object.values(tests().jobs).flatMap((job) => job.steps);
    expect(steps.length).toBeGreaterThan(0);
    const forbidden = steps.filter((step) => CMS_MARKERS.test(stepText(step)) ||
      SNAPSHOT_PRODUCER.test(stepText(step)) ||
      /publication-cli\.ts\s+(?:reconcile|gate-snapshot|record-pair|merge-pairs|choose-manual|event-gate)|publication:(?:reconcile|gate-snapshot|record-pair)/.test(step.run ?? ''));
    expect(forbidden.map((step) => step.name ?? step.index)).toEqual([]);
  });

  it('сборки вершины непусты, используют артефакт Tests либо закреплённую фикстуру соседнего CI', () => {
    const invocations = headBuildInvocations();
    expect(invocations.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const { wf, job, step } of invocations) {
      if (wf.displayName === TESTS_WORKFLOW) {
        if (!job.steps.some((s) => /^actions\/download-artifact(@|$)/.test(s.uses ?? '') && SNAPSHOT_CONSUMER.test(s.raw)))
          problems.push(`${wf.file}:${job.key}/${step.name}: snapshot artifact missing`);
      } else if (!['lighthouse.yml', 'nightly.yml'].includes(wf.file)) {
        problems.push(`${wf.file}: unclassified head build`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('артефакт снимка сохраняется и доступен обоим потребителям Tests', () => {
    const wf = tests();
    const uploads = Object.values(wf.jobs).flatMap((job) => job.steps)
      .filter((step) => /^actions\/upload-artifact(@|$)/.test(step.uses ?? '') && SNAPSHOT_CONSUMER.test(step.raw));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].with?.name).toBe('content-snapshot');
    for (const name of ['unit-and-build', 'e2e-smoke']) {
      const job = wf.jobs[name];
      expect(job.needs).toContain('content-snapshot');
      expect(job.steps.some((step) => /^actions\/download-artifact(@|$)/.test(step.uses ?? '') && step.with?.name === 'content-snapshot')).toBe(true);
    }
  });
});

describe('события готовят вердикт и не выбирают чужое содержимое', () => {
  const tests = (): Workflow => requiredTestWorkflows(workflows)[0];

  it('внешнее событие и календарь сохраняют возможность запустить проверки', () => {
    expect(Object.keys(tests().triggers)).toEqual(expect.arrayContaining(['push', 'repository_dispatch', 'schedule']));
    const push = tests().triggers.push as { branches: string[] };
    expect(push.branches).toContain(DEFAULT_BRANCH);
  });

  it('ни один шаг не берёт ref, коммит или источник контента из тела запроса', () => {
    expect('repository_dispatch' in tests().triggers).toBe(true);
    const fromPayload = allSteps().filter(({ step }) =>
      /github\.event\.client_payload\.(ref|sha|commit|branch|source|content)/.test(step.raw));
    expect(fromPayload.map((s) => `${s.wf.file}:${s.job.key}/${s.step.name ?? s.step.index}`)).toEqual([]);
  });

  // Сценарии: форма данных разошлась; неуспех проверки имеет адресата; расхождение не влияет
  // на предложения изменений
  it('проверка соответствия закреплённого снимка API — по расписанию, с адресатом, вне PR', () => {
    const compat = workflows.filter((wf) =>
      /fixture|compat|snapshot-compat/i.test(`${wf.file} ${wf.displayName}`) &&
      Object.values(wf.jobs).some((job) => job.steps.some((s) => CMS_MARKERS.test(stepText(s)))),
    );
    expect(compat.length, 'отдельной сетевой проверки соответствия фикстуры нет').toBe(1);

    const wf = compat[0];
    expect('schedule' in wf.triggers, 'у проверки нет названного расписания запуска').toBe(true);
    expect('pull_request' in wf.triggers, 'сетевая проверка попала в обязательные для PR').toBe(false);

    const namesAddressee = Object.values(wf.jobs).some((job) =>
      job.steps.some((s) => /issues|slack|mailto|assignee|notify/i.test(s.raw)),
    );
    expect(namesAddressee, 'у неуспеха проверки нет адресата — её никто не смотрит').toBe(true);
  });
});

describe('наблюдение опубликованного состояния: коммит И снимок', () => {
  const publishedState = (): Promise<PublishedStateModule> =>
    loadModule<PublishedStateModule>(MODULES.publishedState);

  // Сценарий: выкладка прошла
  it('совпадение коммита и снимка — совпадение', async () => {
    const mod = await publishedState();
    expect(
      mod.comparePublishedState({
        expected: { commit: 'a'.repeat(40), snapshotId: 'snap-1' },
        observed: { commit: 'a'.repeat(40), snapshotId: 'snap-1' },
      }).status,
    ).toBe('match');
  });

  // Сценарий: релиз переключён на предыдущий вручную
  it('другой коммит на раздаче — расхождение', async () => {
    const mod = await publishedState();
    const result = mod.comparePublishedState({
      expected: { commit: 'a'.repeat(40), snapshotId: 'snap-1' },
      observed: { commit: 'b'.repeat(40), snapshotId: 'snap-1' },
    });
    expect(result.status).toBe('mismatch');
    expect(result.differing).toEqual(['commit']);
  });

  // Сценарий: коммит тот же, снимок другой
  it('совпавший коммит при другом снимке — расхождение, а не совпадение', async () => {
    const mod = await publishedState();
    const result = mod.comparePublishedState({
      expected: { commit: 'a'.repeat(40), snapshotId: 'snap-1' },
      observed: { commit: 'a'.repeat(40), snapshotId: 'snap-2' },
    });
    expect(result.status).toBe('mismatch');
    expect(result.differing).toEqual(['snapshotId']);
  });

  // Сценарий: адрес состояния не ответил
  it('нечитаемый ответ — непройденная проверка, а не отсутствие расхождения', async () => {
    const mod = await publishedState();
    const result = mod.comparePublishedState({
      expected: { commit: 'a'.repeat(40), snapshotId: 'snap-1' },
      observed: null,
    });
    expect(result.status).toBe('unreadable');
    expect(result.status).not.toBe('match');
  });
});
