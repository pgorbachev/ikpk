import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CONTEXT_CONSTANTS, DEFAULT_BRANCH, REPO_ROOT, conditionsGuarding,
  dispatchContext, riskyStepsInJob, loadWorkflows, requiredTestWorkflows,
  workflowRunContext, workflowRunTrigger, type Workflow,
} from './helpers/workflows';
import { canBeTrue, evaluateToValue, isAlwaysFalse, usesAlways } from './helpers/gh-expression';

// manual-publication-only: CI выдаёт вердикт по коммиту. Публикация выполняется локально.
// Общие guards оставшихся workflow_run (Dependabot) сохраняются.
const { OWN_REPO, FORK_REPO, TESTED_SHA } = CONTEXT_CONSTANTS;
const GATED_WORKFLOW_NAME = 'Tests';
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
const workflows = loadWorkflows();
function workflowRunReceivers(): Workflow[] {
  return workflows.filter((wf) => workflowRunTrigger(wf) !== null);
}

describe('обязательный CI и происхождение событий', () => {
  it('материал для проверки на месте', () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(requiredTestWorkflows(workflows)).toHaveLength(1);
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

        // Единственный принимаемый вид защиты — условие на уровне джоба, ложное для
        // стороннего источника. Берётся ВСЯ цепочка по `needs`: джоб публикации
        // защищён тем, что его зависимость не выполнится на чужом прогоне, и по
        // собственному условию выглядел бы незащищённым.
        //
        // Прежде принимался и второй вид — шаг, сверяющий происхождение раньше
        // опасных шагов. От него пришлось отказаться: определить такой шаг можно было
        // только по его тексту, а шаг вида `curl … | bash` со сверкой в той же команде
        // получал признаки guard'а и уходил из-под проверки целиком, хотя чужой код в
        // нём исполняется ДО сверки. Разбирать порядок команд внутри произвольного
        // shell надёжно нельзя, поэтому вид со шагом убран, а не залатан.
        const chain = conditionsGuarding(wf, job.key);
        const guardedByConditions =
          chain.some(({ expr }) => isAlwaysFalse(expr, forkCtx)) &&
          chain.every(({ expr }) => canBeTrue(expr, ownCtx));
        if (guardedByConditions) continue;

        problems.push(
          `${wf.file}:${job.key} — происхождение не проверено условием джоба или его ` +
            `зависимости по needs, а шаг ${firstRisky.index} уже выполняется с правами джоба`,
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
        // Обходим именно опасные шаги, а не `job.steps`: у джоба, вызывающего
        // reusable workflow, шагов нет вовсе, и обход по `job.steps` пропускал бы
        // такой джоб целиком.
        for (const step of riskyStepsInJob(job)) {
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

  // Req6, конфигурационная половина: гейт покрывает ровно то, что названо, и не
  // больше. Если бы в условие затесался ещё один workflow, спека молчала бы о нём.
  // Req1 со стороны ПРЕДПОСЫЛКИ, а не только публикации. Гейт держится на том, что
  // названный workflow вообще запускается на коммиты основной ветки. Если у него
  // останется один `pull_request`, или появится фильтр `paths`, событие workflow_run для
  // коммитов main перестанет приходить — публикация встанет молча, а все проверки выше
  // останутся зелёными, потому что смотрят только на публикующий файл.
  it('workflow из гейта запускается на коммиты основной ветки без фильтров путей', () => {
    const gated = requiredTestWorkflows(workflows).map((wf) => wf.displayName);
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
    const gated = requiredTestWorkflows(workflows).map((wf) => wf.displayName);
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

  it('обязательный источник вердикта — ровно Tests', () => {
    expect(requiredTestWorkflows(workflows).map((wf) => wf.displayName)).toEqual([GATED_WORKFLOW_NAME]);
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
    const gated = new Set(requiredTestWorkflows(workflows).map((wf) => wf.displayName));
    const others = workflows
      .map((wf) => wf.displayName);
    const notGated = others.filter((n) => !gated.has(n));

    expect(gated.size, 'обязательный Tests не найден').toBeGreaterThan(0);
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
