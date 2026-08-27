import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  loadWorkflows,
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

// Спека `deploy-gating` этого change: требования «Проверки и выкладка используют один и тот же
// снимок», «Изменение состояния сайта по календарю публикуется без правки контента»,
// «Изменение контента приводит к публикации через обязательный прогон», «Внешний триггер не
// выбирает, что собирать», «Опубликованный коммит наблюдаем на самой раздаче»; спека
// `cms-content-source`: «снимок сохранён вместе с результатом сборки», «Расхождение
// закреплённого снимка с системой управления обнаруживается отдельно».
//
// Предмет — конфигурация прогона и выкладки. Разбор настоящим YAML-парсером
// (`helpers/workflows.ts`), а не построчным поиском: тот же довод, что и у существующих
// проверок публикации.
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: ни шага снятия снимка, ни передачи артефакта, ни триггеров по контенту,
// ни календарного прогона в конфигурации сегодня нет (tasks.md 5.1–5.6, 8.1–8.6).

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

describe('один снимок на весь прогон', () => {
  it('вызовов сборки вершины в объёме задачи 5.2 — семь', () => {
    const invocations = headBuildInvocations();
    expect(
      invocations.length,
      `сборок вершины: ${invocations.map((i) => `${i.wf.file}:${i.job.key}/${i.step.name ?? i.step.index}`).join(', ')}`,
    ).toBe(7);
  });

  // Сценарий: все шаги прогона используют один снимок
  it('снимок снимает РОВНО ОДИН шаг во всех workflow', () => {
    const producers = allSteps().filter(({ step }) => SNAPSHOT_PRODUCER.test(stepText(step)));
    expect(
      producers.map((p) => `${p.wf.file}:${p.job.key}/${p.step.name ?? p.step.index}`),
      'производителей снимка не один: проверяется один сайт, а публикуется другой',
    ).toHaveLength(1);
  });

  /**
   * Джобы на пути публикации: тот же прогон, который их запустил, и снимает снимок —
   * артефакт физически достижим (ADDED «Проверки и выкладка используют один и тот же
   * снимок»). `lhci` (`pull_request`/`push`) и `compat` (`schedule`) идут ДРУГИМ событием,
   * не тем прогоном, что снял снимок публикации, — артефакт того прогона им недостижим
   * структурно, а не по недосмотру реализации. По D7 они работают с закреплённой
   * фикстурой. Требовать от них артефакта значило бы требовать того, чего спека не
   * требует и что недостижимо (tasks.md 5.2 разводит это явно).
   */
  const PUBLISH_PATH_WORKFLOWS = new Set(['test.yml', 'deploy.yml']);
  const FIXTURE_PATH_WORKFLOWS = new Set(['lighthouse.yml', 'nightly.yml']);

  it('классификация путей покрывает все сборки вершины без остатка', () => {
    const invocations = headBuildInvocations();
    const unclassified = invocations.filter(
      ({ wf }) => !PUBLISH_PATH_WORKFLOWS.has(wf.file) && !FIXTURE_PATH_WORKFLOWS.has(wf.file),
    );
    expect(
      unclassified.map((i) => `${i.wf.file}:${i.job.key}`),
      'новый workflow со сборкой вершины не отнесён ни к пути публикации, ни к фикстуре',
    ).toEqual([]);
  });

  it('каждая сборка на пути публикации получает снимок артефактом, а не снимает его сама', () => {
    const failures: string[] = [];
    for (const { wf, job, step } of headBuildInvocations()) {
      if (!PUBLISH_PATH_WORKFLOWS.has(wf.file)) continue;
      const receivesArtifact = job.steps.some(
        (s) => /^actions\/download-artifact(@|$)/.test(s.uses ?? '') && SNAPSHOT_CONSUMER.test(s.raw),
      );
      if (!receivesArtifact) failures.push(`${wf.file}:${job.key}/${step.name ?? step.index}`);
    }
    expect(failures, 'сборка на пути публикации без переданного снимка').toEqual([]);
  });

  it('к системе управления обращается только шаг снятия снимка', () => {
    const touching = allSteps().filter(({ step }) => CMS_MARKERS.test(stepText(step)));
    // Вакуумная зелень запрещена: «обращений вне снимка нет» при НУЛЕ обращений вообще
    // означает «сборка не берёт контент из системы управления», а не исправную конфигурацию.
    expect(
      touching.length,
      'к системе управления не обращается ни один шаг — проверять нечего',
    ).toBeGreaterThan(0);

    const outsideProducer = touching.filter(({ step }) => !SNAPSHOT_PRODUCER.test(stepText(step)));
    expect(
      outsideProducer.map((t) => `${t.wf.file}:${t.job.key}/${t.step.name ?? t.step.index}`),
      'самостоятельное обращение к системе управления вне шага снятия снимка',
    ).toEqual([]);
  });

  // Сценарий: снимок сохранён вместе с результатом сборки
  it('снимок, его отпечаток и идентификатор выгружаются артефактом прогона', () => {
    const uploads = allSteps().filter(
      ({ step }) => /^actions\/upload-artifact(@|$)/.test(step.uses ?? '') && SNAPSHOT_CONSUMER.test(step.raw),
    );
    expect(uploads.length, 'снимок не сохраняется: сборку нельзя ни повторить, ни назвать').toBeGreaterThan(0);
  });

  // Сценарий: шаг выкладки не обращается к системе управления
  it('джоб выкладки не обращается к системе управления ни одним шагом', () => {
    const deploying = workflows.flatMap((wf) =>
      Object.values(wf.jobs)
        .filter((job) => job.steps.some((s) => /deploy-pages|deploy-web\.sh|rsync/.test(`${s.uses ?? ''} ${s.run ?? ''}`)))
        .map((job) => ({ wf, job })),
    );
    expect(deploying.length, 'джоб выкладки не найден — проверять нечего').toBeGreaterThan(0);

    for (const { wf, job } of deploying) {
      const touching = job.steps.filter((s) => CMS_MARKERS.test(stepText(s)));
      expect(touching.map((s) => s.name ?? s.index), `${wf.file}:${job.key}`).toEqual([]);
    }
  });
});

describe('триггеры публикации', () => {
  const tests = (): Workflow => {
    const found = workflows.find((wf) => wf.displayName === TESTS_WORKFLOW);
    if (!found) throw new Error(`не найден workflow «${TESTS_WORKFLOW}» — проверять нечего`);
    return found;
  };

  // Сценарии: изменение публикуется; снятие с публикации приводит к прогону; изменение
  // медиафайла приводит к прогону. Перечень событий — предмет системы управления, здесь
  // проверяется приёмник: обязательный прогон запускается внешним событием.
  it('обязательный прогон запускается событием об изменении контента', () => {
    const triggers = tests().triggers;
    expect(
      Object.keys(triggers),
      'у обязательного прогона нет входа для события об изменении контента',
    ).toEqual(expect.arrayContaining(['repository_dispatch']));
  });

  // Сценарий: параметры запроса не влияют на собираемое
  it('ни один шаг не берёт ref, коммит или источник контента из тела запроса', () => {
    // Без входа для внешнего запроса проверять нечего: «параметры ни на что не влияют»
    // верно и тогда, когда параметров не существует.
    expect(
      'repository_dispatch' in tests().triggers,
      'входа для внешнего запроса нет — проверка вакуумна',
    ).toBe(true);

    const fromPayload = allSteps().filter(({ step }) =>
      /github\.event\.client_payload\.(ref|sha|commit|branch|source|content)/.test(step.raw),
    );
    expect(
      fromPayload.map((s) => `${s.wf.file}:${s.job.key}/${s.step.name ?? s.step.index}`),
      'тело внешнего запроса выбирает, что собирать — это способ выложить чужое содержимое',
    ).toEqual([]);
  });

  it('checkout обязательного прогона берёт вершину основной ветки, а не ref из запроса', () => {
    const checkouts = Object.values(tests().jobs).flatMap((job) =>
      job.steps
        .filter((s) => /^actions\/checkout(@|$)/.test(s.uses ?? ''))
        .map((s) => ({ job, ref: String((s.with ?? {}).ref ?? '') })),
    );
    expect(checkouts.length, 'checkout не найден — проверять нечего').toBeGreaterThan(0);
    for (const { job, ref } of checkouts) {
      expect(ref, `${job.key}: ref взят из тела запроса`).not.toMatch(/client_payload/);
    }
  });

  // Сценарий: серия изменений сходится к последнему состоянию; изменение во время прогона не
  // теряется. Задача 8.4a: `cancel-in-progress` на основной ветке противоречит очереди.
  it('прогон на основной ветке не отменяется следующим событием', () => {
    const wf = tests();
    const concurrency = wf.concurrency as { group?: unknown; 'cancel-in-progress'?: unknown } | undefined;
    expect(concurrency, 'у обязательного прогона нет настройки concurrency').toBeDefined();

    const cancel = String(concurrency?.['cancel-in-progress'] ?? 'false');
    // Безусловная отмена запрещена: «прогон отменён → публикация не запускается», а очередь
    // требует не терять изменение. Допустима только отмена, выключенная на `main`.
    expect(cancel, 'на main каждое следующее событие отменяет идущий прогон').not.toBe('true');
    if (cancel !== 'false') {
      expect(cancel, 'условие отмены не различает основную ветку').toContain(DEFAULT_BRANCH);
    }
  });

  // Сценарий: завершившийся семинар перестаёт быть запланированным без правок
  it('публикующий прогон идёт по СУТОЧНОМУ расписанию', () => {
    // Расписание требуется ИМЕННО у прогона, успех которого разрешает публикацию. Суточный
    // cron у соседнего workflow («Nightly full checks») этому требованию не отвечает: он
    // ничего не публикует, и зачесть его — тот же ложный зелёный, что axe на странице 404.
    const publishingScheduled = [tests()].filter((wf) => 'schedule' in wf.triggers);
    expect(
      publishingScheduled.length,
      `у публикующего прогона «${TESTS_WORKFLOW}» нет расписания: завершившийся семинар остаётся ` +
        'запланированным до чьей-то посторонней правки',
    ).toBe(1);

    const crons = publishingScheduled.flatMap((wf) => {
      const raw = wf.triggers.schedule;
      const list = Array.isArray(raw) ? raw : [];
      return list
        .map((entry) => (entry as { cron?: unknown }).cron)
        .filter((c): c is string => typeof c === 'string')
        .map((cron) => ({ file: wf.file, cron }));
    });
    expect(crons.length, 'календарного прогона нет вовсе').toBeGreaterThan(0);

    // Суточное расписание: день месяца, месяц и день недели не сужают запуск.
    const daily = crons.filter(({ cron }) => {
      const parts = cron.trim().split(/\s+/);
      return parts.length === 5 && parts[2] === '*' && parts[3] === '*' && parts[4] === '*';
    });
    expect(daily.length, `суточного cron нет: ${crons.map((c) => `${c.file} «${c.cron}»`).join(', ')}`).toBeGreaterThan(
      0,
    );
  });

  // Сценарий: оповещение потеряно
  it('есть сверка опубликованного состояния с контентом, не зависящая от оповещения', () => {
    // Признак составной: одного слова «сверка» мало — существующие шаги сверяют коммит с
    // вершиной ветки и о контенте не знают вовсе. Предмет здесь — расхождение
    // ОПУБЛИКОВАННОГО СОСТОЯНИЯ С КОНТЕНТОМ, поэтому шаг обязан упоминать снимок или
    // систему управления И вызывать comparePublishedState (не заглушку).
    const reconciling = allSteps().filter(({ step }) => {
      const text = `${step.name ?? ''} ${stepText(step)}`;
      return (
        /reconcile|сверк|drift/i.test(text) &&
        (/snapshot/i.test(text) || CMS_MARKERS.test(text)) &&
        /comparePublishedState|publication-cli\.ts reconcile|publication:reconcile/.test(text)
      );
    });
    expect(
      reconciling.map((r) => `${r.wf.file}:${r.job.key}/${r.step.name ?? r.step.index}`),
      'потерянное оповещение оставляет сайт расходящимся с контентом навсегда',
    ).not.toEqual([]);
  });

  it('publication gate и ledger вызываются из workflow, а не только из unit-тестов', () => {
    const text = allSteps()
      .map(({ step }) => stepText(step))
      .join('\n');
    expect(text, 'createLedger / gate-snapshot не вызван в CI').toMatch(
      /createLedger|gate-snapshot|publication-cli\.ts gate-snapshot/,
    );
    expect(text, 'chooseManualPublication не вызван в deploy').toMatch(
      /chooseManualPublication|choose-manual|publication-cli\.ts choose-manual/,
    );
    expect(text, 'classifyEventDrivenPublication / event-gate не вызван').toMatch(
      /event-gate|classifyEventDrivenPublication|publication-cli\.ts event-gate/,
    );
    expect(text, '/release.json не пишется при выкладке').toMatch(
      /write-release|writeReleaseDeclaration|release\.json/,
    );
  });

  it('ручной deploy принимает inputs отката', () => {
    const deploy = workflows.find((wf) => wf.file === 'deploy.yml');
    expect(deploy, 'deploy.yml не найден').toBeTruthy();
    const dispatch = deploy!.triggers.workflow_dispatch;
    expect(dispatch, 'workflow_dispatch без inputs').toBeTruthy();
    const inputs = (dispatch as { inputs?: Record<string, unknown> }).inputs ?? {};
    expect(Object.keys(inputs)).toEqual(
      expect.arrayContaining(['rollback_snapshot_id', 'rollback_confirmed', 'rollback_reason']),
    );
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
