import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CONTEXT_CONSTANTS,
  DEFAULT_BRANCH,
  REPO_ROOT,
  concurrencyGroups,
  conditionsGuarding,
  declaresPagesPermission,
  dispatchContext,
  findPublishStep,
  isCodeFetchStep,
  riskyStepsInJob,
  jobsOnPathTo,
  loadWorkflows,
  publishingWorkflows,
  pushContext,
  pushTrigger,
  workflowRunContext,
  workflowRunTrigger,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from './helpers/workflows';
import {
  canBeTrue,
  evaluateToValue,
  isAlwaysFalse,
  usesAlways,
  type GithubContext,
} from './helpers/gh-expression';

// Проверки по спеке `openspec/changes/deploy-gated-on-tests/specs/deploy-gating/spec.md`.
//
// Предмет — конфигурация публикации в GitHub Actions. Часть сценариев спеки
// проверяется здесь разбором конфигурации, часть — только наблюдением реального
// события или прогоном в форке; вторая часть перечислена в отчёте к этой сессии как
// ручная приёмка и НЕ имитируется тестом. Тест, который делает вид, что наблюдал
// событие, — это «я не смогла проверить», выданное за «дефектов нет».
//
// Условия джобов не ищутся подстрокой, а ВЫЧИСЛЯЮТСЯ в контексте события
// (`helpers/gh-expression.ts`): подстрока `conclusion == 'success'` есть и в условии
// `conclusion == 'success' || true`, которое публикует всегда.
//
// ВАЖНО про этапы миграции. Спека описывает конечное состояние. План перехода
// (design.md) сохраняет `push: main` на первом шаге — значит проверка
// «push сам по себе не публикует» останется красной до второго шага. Это не дефект
// проверки: она стережёт требование, а не промежуточный шаг плана.

const { OWN_REPO, FORK_REPO, TESTED_SHA } = CONTEXT_CONSTANTS;

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];

/**
 * Имя workflow, на который вешается гейт. Константа взята из самой спеки
 * («гейт вешается только на `Tests`», proposal.md), а не угадана по содержимому:
 * объём гейта — предмет требования, а не деталь реализации. Существование workflow
 * с этим именем проверяется отдельно — переименование обязано ронять проверку, а не
 * молча обнулять её.
 */
const GATED_WORKFLOW_NAME = 'Tests';

const workflows = loadWorkflows();

function publishing(): Workflow {
  const found = publishingWorkflows(workflows);
  if (found.length !== 1)
    throw new Error(
      `ожидался ровно один workflow с шагом actions/deploy-pages, найдено ${found.length}: ` +
        `${found.map((w) => w.file).join(', ') || '—'}`,
    );
  return found[0];
}

/** Джоб и шаг публикации. */
function publishTarget(): { wf: Workflow; job: WorkflowJob; step: WorkflowStep } {
  const wf = publishing();
  const target = findPublishStep(wf);
  if (!target) throw new Error(`${wf.file}: шаг публикации не найден`);
  return { wf, job: target.job, step: target.step };
}

/** Все условия, которые обязаны быть истинны, чтобы содержимое уехало на сайт. */
function publishConditions(): { source: string; expr: string }[] {
  const { wf, job, step } = publishTarget();
  return conditionsGuarding(wf, job.key, step);
}

function publishPossible(ctx: GithubContext): boolean {
  return publishConditions().every(({ expr }) => canBeTrue(expr, ctx));
}

/** Workflow, которые могут запуститься по событию `workflow_run`. */
function workflowRunReceivers(): Workflow[] {
  return workflows.filter((wf) => workflowRunTrigger(wf) !== null);
}

describe('гейт публикации: конфигурация', () => {
  // Пустой набор workflow, отсутствие публикующего файла или переименованный
  // `Tests` — это «проверка не выполнена». Без этого сторожа всё, что ниже, молча
  // выродилось бы в проверку пустоты.
  it('материал для проверки на месте', () => {
    expect(workflows.length, 'не найдено ни одного workflow-файла').toBeGreaterThan(0);

    const publishers = publishingWorkflows(workflows);
    expect(
      publishers.map((w) => w.file),
      'публикующий workflow (шаг actions/deploy-pages) должен быть ровно один',
    ).toHaveLength(1);

    expect(
      workflows.map((w) => w.displayName),
      `нет workflow с именем '${GATED_WORKFLOW_NAME}' — спека вешает гейт именно на него`,
    ).toContain(GATED_WORKFLOW_NAME);

    expect(findPublishStep(publishers[0]), 'шаг публикации не найден').toBeTruthy();
  });

  // Req1, сценарий «тесты прошли». Конфигурационная половина: публикация вообще
  // запускается событием о завершении `Tests` на основной ветке. Что публикация
  // ПРОИЗОШЛА — наблюдается на реальном прогоне (ручная приёмка).
  it('публикация запускается завершением прогона Tests на основной ветке', () => {
    const wf = publishing();
    const trigger = workflowRunTrigger(wf);
    expect(
      trigger,
      `${wf.file} не подписан на событие workflow_run — публикация не связана с прогоном тестов`,
    ).not.toBeNull();

    expect(
      trigger!.workflows,
      `workflow_run.workflows не называет '${GATED_WORKFLOW_NAME}'`,
    ).toContain(GATED_WORKFLOW_NAME);

    // Опечатка в имени означает, что событие не придёт никогда, а конфигурация
    // при этом выглядит рабочей.
    const known = new Set(workflows.map((w) => w.displayName));
    expect(
      trigger!.workflows.filter((n) => !known.has(n)),
      'workflow_run.workflows называет несуществующие workflow — событие не придёт',
    ).toEqual([]);

    expect(trigger!.types, 'workflow_run.types не включает completed').toContain('completed');
    expect(
      trigger!.branches,
      `workflow_run.branches не ограничен веткой ${DEFAULT_BRANCH} — успешный прогон ` +
        'на любой ветке потянет за собой путь публикации',
    ).toContain(DEFAULT_BRANCH);

    expect(
      publishPossible(workflowRunContext({ conclusion: 'success' })),
      `условия на пути публикации не дают ей выполниться даже при успешном прогоне:\n${publishConditions()
        .map((c) => `${c.source}: ${c.expr}`)
        .join('\n')}`,
    ).toBe(true);
  });

  // Req1, сценарии «тесты упали» и «прогон отменён». Проверяются все исходы
  // `workflow_run`, кроме success: спека держит отмену отдельным сценарием, а
  // «неуспешный» смешивает failure, cancelled, skipped и timed_out.
  it('неуспешный прогон не приводит к публикации', () => {
    const conditions = publishConditions();
    expect(
      conditions.length,
      'ни одного условия на пути публикации — публикуется что угодно',
    ).toBeGreaterThan(0);

    // `always()` отменяет пропуск джоба по цепочке needs, то есть ломает саму
    // модель «условие публикации = конъюнкция условий по пути».
    const withAlways = conditions.filter(({ expr }) => usesAlways(expr));
    expect(
      withAlways.map((c) => `${c.source}: ${c.expr}`),
      'always() на пути публикации: джоб выполнится и после пропуска зависимости',
    ).toEqual([]);

    const badOutcomes = ['failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale'];
    const leaks = badOutcomes.filter((conclusion) =>
      publishPossible(workflowRunContext({ conclusion })),
    );
    expect(
      leaks,
      'при этих исходах прогона тестов публикация всё ещё возможна:\n' +
        conditions.map((c) => `${c.source}: ${c.expr}`).join('\n'),
    ).toEqual([]);
  });

  // Регрессия из design.md, решение 2: голое
  // `github.event.workflow_run.conclusion == 'success'` ложно для событий, у которых
  // объекта `workflow_run` нет вовсе, и молча выключает ручную публикацию.
  // На текущем коде проверка зелёная (условий нет вообще) — она стережёт будущее.
  it('условие публикации не выключает ручной запуск', () => {
    expect(
      publishPossible(dispatchContext()),
      'условия на пути публикации ложны для workflow_dispatch — ручная публикация выключена:\n' +
        publishConditions()
          .map((c) => `${c.source}: ${c.expr}`)
          .join('\n'),
    ).toBe(true);
  });

  // Req1: публикация ТОЛЬКО после успешного прогона. Push сам по себе публиковать
  // не должен — ни триггером, ни условием.
  it('push в основную ветку сам по себе не публикует', () => {
    const wf = publishing();
    const push = pushTrigger(wf);
    if (push === null) return;
    expect(
      publishPossible(pushContext()),
      `${wf.file} публикует по push в ${DEFAULT_BRANCH} мимо прогона тестов ` +
        `(триггер push с ветками ${JSON.stringify(push.branches)})`,
    ).toBe(false);
  });

  // Req2: публикуется проверенный коммит. Значение `ref` вычисляется в контексте
  // события, а не сверяется подстрокой: у `${{ … && … || … }}` смысл в результате.
  it('выгружается проверенный коммит, а не голова ветки', () => {
    const { wf, job } = publishTarget();
    const checkouts = jobsOnPathTo(wf, job.key).flatMap((j) =>
      j.steps.filter(isCodeFetchStep).map((s) => ({ job: j.key, step: s })),
    );
    expect(
      checkouts.length,
      'на пути публикации нет ни одного шага выгрузки кода — проверять нечего',
    ).toBeGreaterThan(0);

    const ctx = workflowRunContext({ conclusion: 'success' });
    const wrong = checkouts
      .map(({ job: key, step }) => {
        const ref = step.with?.ref;
        if (ref === undefined)
          return `${wf.file}:${key}:шаг ${step.index} — ref не задан, checkout возьмёт голову ветки`;
        const resolved = evaluateToValue(String(ref), ctx);
        if (resolved === TESTED_SHA) return null;
        return `${wf.file}:${key}:шаг ${step.index} — ref='${String(ref)}' при workflow_run даёт '${String(resolved)}', а проверенный коммит — head_sha`;
      })
      .filter((x): x is string => x !== null);

    expect(wrong, `публикуется не тот коммит, который проверяли:\n${wrong.join('\n')}`).toEqual([]);
  });

  // Req3: устаревший результат не откатывает сайт. Сравнение делается в shell, и
  // вычислить его разбором нельзя — проверяется наличие сверки и то, что публикация
  // от неё зависит. Что сверка ПРАВИЛЬНАЯ, подтверждается наблюдением (ручная приёмка).
  it('устаревший коммит не публикуется: есть сверка head_sha с вершиной основной ветки', () => {
    const { wf, job, step } = publishTarget();
    const pathJobs = jobsOnPathTo(wf, job.key);

    // Откуда берут вершину основной ветки — вариантов немного, но перечислять их
    // как «известные» нельзя: ловим общий признак — обращение к состоянию ветки.
    const TIP_LOOKUP =
      /(ls-remote|rev-parse|rev-list|refs\/heads\/|commits\/|branches\/|\/git\/ref)/;

    const guards = pathJobs.flatMap((j) =>
      j.steps
        // Публикуемый коммит может приходить в шаг не только выражением
        // `...workflow_run.head_sha`, но и через выход шага или джоба — так его
        // передают туда, где выражения события уже недоступны. Распознаём ЗНАЧЕНИЕ,
        // а не одно написание: ссылку на head_sha либо на выход, который его несёт.
        .filter(
          (s) =>
            /head_sha|outputs\.sha\b/.test(s.raw) &&
            TIP_LOOKUP.test(s.raw) &&
            /\bmain\b|default_branch/.test(s.raw),
        )
        .map((s) => ({ job: j, step: s })),
    );

    expect(
      guards.map((g) => `${g.job.key}:${g.step.index}`),
      'на пути публикации нет шага, который сверяет head_sha с вершиной основной ветки — ' +
        'перезапуск давнего прогона опубликует устаревший коммит поверх свежего',
    ).not.toEqual([]);

    // Сверка обязана что-то решать: либо сама роняет джоб, либо её результат стоит
    // в условии, от которого зависит публикация. Шаг, который только печатает
    // расхождение, публикацию не остановит.
    const publishGuards = conditionsGuarding(wf, job.key, step)
      .map((c) => c.expr)
      .join('\n');
    const effective = guards.filter(
      ({ step: s }) =>
        /\bexit\s+[1-9]/.test(s.run ?? '') ||
        (s.id !== undefined && new RegExp(`\\b${s.id}\\b`).test(publishGuards)),
    );
    expect(
      effective.map((g) => `${g.job.key}:${g.step.index}`),
      'сверка head_sha с вершиной есть, но публикация от неё не зависит: шаг не роняет ' +
        'джоб и его результат не встречается в условиях на пути публикации',
    ).not.toEqual([]);
  });

  // Req4: ручная публикация публикует состояние ОСНОВНОЙ ветки. `workflow_dispatch`
  // запускается с любой ветки, где лежит файл, и `github.sha` там — голова этой
  // ветки, а не main.
  it('ручная публикация публикует состояние основной ветки', () => {
    const { wf, job } = publishTarget();
    const pathJobs = jobsOnPathTo(wf, job.key);
    const ctx = dispatchContext('feature/proba');

    const pinnedByRef = pathJobs
      .flatMap((j) => j.steps.filter(isCodeFetchStep))
      .every((s) => {
        const ref = s.with?.ref;
        if (ref === undefined) return false;
        const resolved = evaluateToValue(String(ref), ctx);
        return (
          typeof resolved === 'string' &&
          (resolved === DEFAULT_BRANCH || resolved === `refs/heads/${DEFAULT_BRANCH}`)
        );
      });

    // Второй допустимый вид: шаг, который роняет прогон, если ручной запуск сделан
    // не с основной ветки.
    // Мало найти текст: `if: false` выключил бы шаг, а перенос его ПОСЛЕ выгрузки
    // оставил бы окно, в котором чужая ветка уже выгружена. Поэтому условие шага
    // вычисляется в контексте ручного запуска, а позиция сверяется с первой выгрузкой.
    // Контекст здесь — ПОСТОРОННЯЯ ветка (тот же `ctx`, что и для проверки ref). Взять
    // `dispatchContext()` без аргумента значило бы вычислять условие для main, и тогда
    // guard вида `... && github.ref_name == 'main'` — который на посторонней ветке как
    // раз не сработает — считался бы рабочим.
    const guardedByCheck = pathJobs.some((j) => {
      const firstFetch = j.steps.find(isCodeFetchStep);
      return j.steps.some(
        (s) =>
          /github\.ref|ref_name/.test(s.raw) &&
          /\bmain\b|default_branch/.test(s.raw) &&
          /\bexit\s+[1-9]/.test(s.run ?? '') &&
          (s.if === undefined || canBeTrue(s.if, ctx)) &&
          (firstFetch === undefined || s.index < firstFetch.index),
      );
    });

    expect(
      pinnedByRef || guardedByCheck,
      `${wf.file}: ручной запуск с посторонней ветки опубликует её содержимое. ` +
        'Допустимо одно из двух: ref у выгрузки закреплён за основной веткой, либо ' +
        'шаг роняет прогон при запуске не с основной ветки',
    ).toBe(true);
  });

  // Сценарий «вершина сдвинулась, пока шла сборка». Ранняя сверка отвечает на вопрос
  // «стоило ли начинать», а не «можно ли публиковать сейчас»: между ней и выкладкой
  // проходит сборка. Решающая сверка обязана стоять в ТОМ ЖЕ джобе, что и выкладка, и
  // раньше неё — иначе остаётся окно, в котором медленная сборка публикуется поверх
  // свежего коммита.
  it('актуальность сверяется в джобе публикации, перед самой выкладкой', () => {
    const { wf, job, step } = publishTarget();
    const TIP_LOOKUP = /(ls-remote|rev-parse|rev-list|refs\/heads\/|commits\/|branches\/|\/git\/ref)/;

    // Сверка обязана СРАВНИВАТЬ собранный коммит с вершиной, а не просто спрашивать
    // вершину. Шаг вида `tip=$(...); if [ -z "$tip" ]; then exit 1; fi` формально
    // содержит и обращение к ветке, и `exit`, но ничего не сравнивает — и вернул бы
    // исходное окно, оставив suite зелёным.
    // Упоминания собранного коммита мало: шаг может объявить его в `env`, проверить на
    // пустоту и не сравнить ни с чем — тогда окно возвращается при зелёном тесте
    // (проверено мутацией: удаление сравнения suite не роняло). Поэтому требуется
    // именно СРАВНЕНИЕ: переменная, в которую приходит собранный SHA, должна стоять
    // рядом с оператором сравнения в теле шага.
    const BUILT_SHA = /needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]*sha\b/;
    const comparesBuiltSha = (s: (typeof job.steps)[number]): boolean => {
      const carriers = Object.entries(s.env ?? {})
        .filter(([, v]) => BUILT_SHA.test(String(v)))
        .map(([k]) => k);
      if (carriers.length === 0) return false;
      const body = s.run ?? '';

      // Переменные, в которые кладут вершину: `tip=$(git ls-remote ...)`, `x=$(gh api ...)`.
      // Сравнение обязано связать собранный SHA ИМЕННО с ними. Проверять лишь «участвует
      // в каком-то сравнении» мало: `[ "$SHA" != "$SHA" ]` такому условию удовлетворяет,
      // а пропускает любую устаревшую выкладку.
      const tipVars = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(([^)]*)\)/gm)]
        .filter(([, , cmd]) => TIP_LOOKUP.test(cmd))
        .map(([, name]) => name);
      if (tipVars.length === 0) return false;

      const ref = (n: string): string => `\\$\\{?${n}\\}?`;
      const CMP = '(!=|==|=~|\\s-ne\\s|\\s-eq\\s)';
      return carriers.some((c) =>
        tipVars.some((t) =>
          new RegExp(`${ref(c)}[^\\n]*${CMP}[^\\n]*${ref(t)}`).test(body) ||
          new RegExp(`${ref(t)}[^\\n]*${CMP}[^\\n]*${ref(c)}`).test(body),
        ),
      );
    };

    const decisive = job.steps.filter(
      (s) =>
        TIP_LOOKUP.test(s.raw) &&
        /\bmain\b|default_branch/.test(s.raw) &&
        /\bexit\s+[1-9]/.test(s.run ?? '') &&
        comparesBuiltSha(s) &&
        s.index < step.index,
    );

    expect(
      decisive.map((s) => s.index),
      `${wf.file}:${job.key} — перед выкладкой нет сверки СОБРАННОГО коммита с вершиной. ` +
        'Сверка в другом джобе не считается: между ней и выкладкой проходит сборка, ' +
        'и вершина успевает сдвинуться. Обращения к вершине без сравнения с собранным ' +
        'коммитом тоже недостаточно',
    ).not.toEqual([]);

    // Сериализация обязана быть у ТОГО ЖЕ джоба: группа, объявленная где-то ещё в
    // workflow, публикацию не сериализует. И политика ожидания должна беречь ожидающих:
    // при одном pending поздняя устаревшая сборка вытесняет свежую, та отменяется, а
    // сама устаревшая падает на сверке — сайт остаётся на позапрошлом состоянии.
    const groupOnJob = ((): Record<string, unknown> | null => {
      const c = job.concurrency as unknown;
      if (typeof c === 'string') return { group: c };
      return c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
    })();

    expect(
      groupOnJob && typeof groupOnJob.group === 'string' ? String(groupOnJob.group) : null,
      `${wf.file}:${job.key} — у джоба публикации нет своей группы сериализации; ` +
        'объявленная на уровне workflow затягивает в группу и те прогоны, которые ничего ' +
        'не публикуют',
    ).not.toBeNull();

    // Ограничение платформы, нарушение которого молчаливо: `queue: max` несовместим с
    // `cancel-in-progress: true` («The combination of `queue: max` and
    // `cancel-in-progress: true` is not allowed» — схема workflow). Такой файл станет
    // невалидным, и деплой перестанет ЗАПУСКАТЬСЯ — без красного прогона, потому что
    // запускать будет нечего. Обычные проверки PR этого не увидят: они деплой не гоняют.
    expect(
      !(groupOnJob?.queue === 'max' && groupOnJob?.['cancel-in-progress'] === true),
      `${wf.file}:${job.key} — queue: max вместе с cancel-in-progress: true запрещены ` +
        'платформой; workflow станет невалидным, и публикация перестанет запускаться молча',
    ).toBe(true);

    expect(
      groupOnJob?.queue ?? 'single',
      `${wf.file}:${job.key} — политика очереди '${String(groupOnJob?.queue ?? 'single')}': ` +
        'по умолчанию в группе держится один ожидающий прогон, и поздняя устаревшая ' +
        'сборка вытесняет свежую, после чего падает на сверке — публикация теряется молча',
    ).toBe('max');
  });

  // Req5, сценарий «проверка происхождения стоит раньше выгрузки». Именно порядок:
  // прогон по workflow_run получает секреты и права записи, и к моменту сверки
  // коммитов чужой код уже выгружен и исполнен.
  it('происхождение проверяется до выгрузки кода', () => {
    const receivers = workflowRunReceivers();
    expect(
      receivers.map((w) => w.file),
      'ни один workflow не принимает событие workflow_run — проверять порядок не на чем',
    ).not.toEqual([]);

    const forkCtx = workflowRunContext({ conclusion: 'success', headRepository: FORK_REPO });
    const ownCtx = workflowRunContext({ conclusion: 'success' });
    const problems: string[] = [];

    for (const wf of receivers) {
      for (const job of Object.values(wf.jobs)) {
        const firstRisky = riskyStepsInJob(job)[0];
        if (!firstRisky) continue;

        // Вид 1 (предпочтительный): условие джоба само ложно для стороннего источника.
        const jobIf = job.if;
        const guardedByJobIf =
          jobIf !== undefined && isAlwaysFalse(jobIf, forkCtx) && canBeTrue(jobIf, ownCtx);
        if (guardedByJobIf) continue;

        // Вид 2: первый шаг сверяет происхождение и роняет джоб.
        const guardStep = job.steps.find(
          (s) =>
            /head_repository/.test(s.raw) &&
            /\bexit\s+[1-9]/.test(s.run ?? '') &&
            (s.if === undefined || canBeTrue(s.if, forkCtx)),
        );
        if (guardStep && guardStep.index < firstRisky.index) continue;

        problems.push(
          `${wf.file}:${job.key} — ${
            guardStep
              ? `проверка происхождения стоит шагом ${guardStep.index}, после выгрузки/сборки (шаг ${firstRisky.index})`
              : `проверки происхождения нет, а шаг ${firstRisky.index} уже выгружает или исполняет код`
          }`,
        );
      }
    }

    expect(
      problems,
      'чужой код исполняется в контексте с правами записи:\n' + problems.join('\n'),
    ).toEqual([]);
  });

  // Req5, сценарий «прогон тестов запущен из форка». Здесь проверяется не порядок, а
  // сам факт: при стороннем происхождении ни один шаг выгрузки или сборки выполниться
  // не может ни при каких значениях выходов предыдущих шагов.
  it('код из стороннего репозитория не выгружается и не собирается', () => {
    const receivers = workflowRunReceivers();
    expect(
      receivers.map((w) => w.file),
      'ни один workflow не принимает событие workflow_run — проверять нечего',
    ).not.toEqual([]);

    const forkCtx = workflowRunContext({ conclusion: 'success', headRepository: FORK_REPO });
    const reachable: string[] = [];

    for (const wf of receivers) {
      for (const job of Object.values(wf.jobs)) {
        const risky = new Set(riskyStepsInJob(job).map((s) => s.index));
        for (const step of job.steps) {
          if (!risky.has(step.index)) continue;
          const conditions = conditionsGuarding(wf, job.key, step);
          if (conditions.every(({ expr }) => canBeTrue(expr, forkCtx)))
            reachable.push(
              `${wf.file}:${job.key}:шаг ${step.index} (${step.name ?? step.uses ?? 'run'})`,
            );
        }
      }
    }

    expect(
      reachable,
      `прогон из форка ${FORK_REPO} (основной репозиторий — ${OWN_REPO}) достигает этих шагов:\n` +
        reachable.join('\n'),
    ).toEqual([]);
  });

  // Решение 4 из design.md. Изначально правило писалось про временный dry-run-файл, но
  // предмет у него общий: посторонний workflow в группе `pages` занимал бы слот очереди
  // и вытеснял ожидающую публикацию, а лишние права `pages` расширяли бы поверхность.
  // Настройки самой группы см. в проверке про решающую сверку: там `cancel-in-progress:
  // false` и `queue: max`. Правило сформулировано общим признаком, поэтому продолжает
  // работать и после удаления того файла, ради которого появилось.
  it('права pages и группа pages — только у публикующего workflow', () => {
    const publisher = publishing();
    const offenders = workflows
      .filter((wf) => wf.file !== publisher.file)
      .flatMap((wf) => {
        const out: string[] = [];
        if (declaresPagesPermission(wf))
          out.push(`${wf.file}: объявляет permissions.pages, ничего не публикуя`);
        const groups = concurrencyGroups(wf).filter((g) => /(^|[^a-z])pages($|[^a-z])/.test(g));
        if (groups.length > 0)
          out.push(
            `${wf.file}: входит в группу concurrency ${JSON.stringify(groups)} — отменит идущую публикацию`,
          );
        return out;
      });

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  // Req6, конфигурационная половина: гейт покрывает ровно то, что названо, и не
  // больше. Если бы в условие затесался ещё один workflow, спека молчала бы о нём.
  // Req1 со стороны ПРЕДПОСЫЛКИ, а не только публикации. Гейт держится на том, что
  // названный workflow вообще запускается на коммиты основной ветки. Если у него
  // останется один `pull_request`, или появится фильтр `paths`, событие workflow_run для
  // коммитов main перестанет приходить — публикация встанет молча, а все проверки выше
  // останутся зелёными, потому что смотрят только на публикующий файл.
  it('workflow из гейта запускается на коммиты основной ветки без фильтров путей', () => {
    const gated = workflowRunTrigger(publishing())?.workflows ?? [];
    expect(gated, 'гейт не называет ни одного workflow').not.toEqual([]);

    const problems: string[] = [];
    for (const name of gated) {
      const wf = workflows.find((w) => w.displayName === name);
      if (!wf) {
        problems.push(`в гейте назван '${name}', но workflow с таким именем нет`);
        continue;
      }
      const push = wf.triggers.push as Record<string, unknown> | undefined;
      if (push === undefined) {
        problems.push(`${wf.file}: нет триггера push — на коммиты ${DEFAULT_BRANCH} не запустится`);
        continue;
      }
      const branches = asList(push.branches);
      if (!branches.includes(DEFAULT_BRANCH))
        problems.push(`${wf.file}: push не покрывает ${DEFAULT_BRANCH} (branches=${JSON.stringify(branches)})`);
      for (const key of ['paths', 'paths-ignore'])
        if (push[key] !== undefined)
          problems.push(`${wf.file}: у push есть ${key} — часть коммитов ${DEFAULT_BRANCH} не запустит прогон, и публикация для них не придёт`);
    }

    expect(problems, 'предпосылка гейта не выполняется:\n' + problems.join('\n')).toEqual([]);
  });

  // Гейт называет workflow ПО ИМЕНИ, а имя не уникально: второй файл с `name: Tests`
  // — пустой и быстрый — присылал бы событие о завершении и запускал публикацию без
  // настоящих тестов. Все остальные проверки при этом остались бы зелёными: они находят
  // первое совпадение по имени и на второе не смотрят.
  it('имя workflow из гейта уникально в репозитории', () => {
    const gated = workflowRunTrigger(publishing())?.workflows ?? [];
    expect(gated, 'гейт не называет ни одного workflow').not.toEqual([]);

    const problems = gated
      .map((name) => ({ name, files: workflows.filter((w) => w.displayName === name).map((w) => w.file) }))
      .filter(({ files }) => files.length !== 1)
      .map(({ name, files }) =>
        files.length === 0
          ? `в гейте назван '${name}', но workflow с таким именем нет`
          : `имя '${name}' носят несколько файлов: ${files.join(', ')} — публикацию сможет запустить любой из них`,
      );

    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('в условие публикации входит ровно один названный workflow', () => {
    const trigger = workflowRunTrigger(publishing());
    expect(
      trigger?.workflows ?? [],
      `объём гейта должен быть ровно ['${GATED_WORKFLOW_NAME}']`,
    ).toEqual([GATED_WORKFLOW_NAME]);
  });
});

// ---------------------------------------------------------------------------

/** Секции markdown-файла: заголовок и текст до следующего заголовка. */
function sections(text: string): { heading: string; lines: string[] }[] {
  const out: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      current = { heading: line, lines: [line] };
      out.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return out;
}

const EXCLUSION = /не\s+вход|не\s+блокиру|вне\s+гейта|не\s+влия(ет|ют)\s+на\s+публикацию/i;
const INCLUSION = /вход(ит|ят|ящие)\s+в\s+(гейт|услови)|условие\s+публикации|блокиру(ет|ют)\s+публикацию/i;
const GATE_TOPIC = /гейт|условие\s+публикации/i;

describe('гейт публикации: документация', () => {
  // Req6: «Документация процесса публикации SHALL называть, какие проверки входят в
  // условие публикации, а какие нет».
  //
  // Спека не называет файл, поэтому предметом взята вся отслеживаемая документация
  // репозитория, кроме самого неутверждённого change: описание перечисляется по
  // ФАКТИЧЕСКОМУ составу `.github/workflows`, а не по списку известных имён. Так
  // добавленный workflow, о котором документация промолчала, роняет проверку.
  it('документация называет, какие проверки входят в гейт и какие нет', () => {
    const publisher = publishing();
    const gated = new Set(workflowRunTrigger(publisher)?.workflows ?? []);
    const others = workflows
      .filter((wf) => wf.file !== publisher.file)
      .map((wf) => wf.displayName);
    const notGated = others.filter((n) => !gated.has(n));

    expect(gated.size, 'гейт не объявлен: у публикующего workflow нет триггера workflow_run').toBeGreaterThan(0);
    expect(notGated.length, 'нет ни одной проверки вне гейта — описывать нечего').toBeGreaterThan(0);

    const files = execFileSync('git', ['ls-files', '*.md'], { cwd: REPO_ROOT, encoding: 'utf-8' })
      .split('\n')
      .filter((f) => f !== '' && !f.startsWith('openspec/changes/'));
    expect(files.length, 'в репозитории нет отслеживаемой документации').toBeGreaterThan(0);

    const misses: string[] = [];
    const ok = files.some((file) => {
      const text = readFileSync(join(REPO_ROOT, file), 'utf-8');
      return sections(text).some((section) => {
        if (!GATE_TOPIC.test(section.lines.join('\n'))) return false;

        // Режим определяется ближайшей строкой-маркером сверху и действует до
        // следующей: так одинаково читаются и фраза в предложении, и список под
        // заголовком «Не входят в гейт».
        let mode: 'in' | 'out' | null = null;
        const declared = { in: new Set<string>(), out: new Set<string>() };
        for (const line of section.lines) {
          if (EXCLUSION.test(line)) mode = 'out';
          else if (INCLUSION.test(line)) mode = 'in';
          if (mode === null) continue;
          for (const name of [...gated, ...notGated])
            if (line.includes(name)) declared[mode].add(name);
        }
        const missingIn = [...gated].filter((n) => !declared.in.has(n));
        const missingOut = notGated.filter((n) => !declared.out.has(n));
        if (missingIn.length === 0 && missingOut.length === 0) return true;
        misses.push(
          `${file} — ${section.heading.trim()}: не названы входящими ${JSON.stringify(missingIn)}, ` +
            `не названы невходящими ${JSON.stringify(missingOut)}`,
        );
        return false;
      });
    });

    expect(
      ok,
      'ни в одном документе нет раздела, который называет и входящие в гейт проверки ' +
        `(${JSON.stringify([...gated])}), и невходящие (${JSON.stringify(notGated)}).\n` +
        `Ближайшие кандидаты:\n${misses.slice(0, 10).join('\n') || '— разделов про гейт не найдено вовсе'}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

// Вычислитель условий — сам инструмент проверки, и на слово его брать нельзя: если
// он ошибается, все проверки выше говорят не о том. Эти примеры фиксируют ровно те
// его свойства, на которых стоят проверки.
describe('вычислитель условий GitHub Actions', () => {
  const success = workflowRunContext({ conclusion: 'success' });
  const failure = workflowRunContext({ conclusion: 'failure' });
  const dispatch = dispatchContext();
  const fork = workflowRunContext({ conclusion: 'success', headRepository: FORK_REPO });

  const PER_EVENT =
    "github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'";

  it('по-событийное условие: успех да, провал нет, ручной запуск да', () => {
    expect(canBeTrue(PER_EVENT, success)).toBe(true);
    expect(canBeTrue(PER_EVENT, failure)).toBe(false);
    expect(canBeTrue(PER_EVENT, dispatch)).toBe(true);
  });

  it('голое сравнение conclusion выключает ручной запуск', () => {
    const bare = "github.event.workflow_run.conclusion == 'success'";
    expect(canBeTrue(bare, success)).toBe(true);
    expect(canBeTrue(bare, failure)).toBe(false);
    // Объекта workflow_run у dispatch нет — значение null, сравнение ложно.
    expect(canBeTrue(bare, dispatch)).toBe(false);
  });

  it('подстрока условия не считается за условие', () => {
    const fake = "github.event.workflow_run.conclusion == 'success' || true";
    expect(isAlwaysFalse(fake, failure)).toBe(false);
  });

  it('неизвестный выход шага делает условие выполнимым, но не истинным', () => {
    const withOutput = "needs.guard.outputs.fresh == 'true'";
    expect(canBeTrue(withOutput, success)).toBe(true);
    const closed = `github.event.workflow_run.conclusion == 'success' && ${withOutput}`;
    expect(canBeTrue(closed, failure)).toBe(false);
  });

  it('сравнение происхождения различает свой репозиторий и форк', () => {
    const origin = 'github.event.workflow_run.head_repository.full_name == github.repository';
    expect(canBeTrue(origin, success)).toBe(true);
    expect(canBeTrue(origin, fork)).toBe(false);
  });

  it('шаблон ref вычисляется до значения', () => {
    const ref =
      "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}";
    expect(evaluateToValue(ref, success)).toBe(TESTED_SHA);
    expect(evaluateToValue(ref, dispatch)).toBe(dispatch.sha);
  });

  it('always() опознаётся', () => {
    expect(usesAlways("always() && github.event_name == 'push'")).toBe(true);
    expect(usesAlways("github.event_name == 'push'")).toBe(false);
  });
});
