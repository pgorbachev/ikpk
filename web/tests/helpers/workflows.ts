// Модель workflow-файлов GitHub Actions для проверок конфигурации публикации.
//
// Разбор настоящим YAML-парсером, а не построчным поиском: предмет проверки — сам
// YAML, и построчный разбор путал бы отступы, списки и многострочные скаляры.
// Ошибка разбора здесь — провал проверки, а не пустой результат.

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import type { GithubContext } from './gh-expression';

export interface WorkflowStep {
  index: number;
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  /** Весь шаг текстом — для проверок, которым важно любое место записи значения
   *  (`env`, `with`, `run`), а не одно заранее выбранное поле. */
  raw: string;
}

export interface WorkflowJob {
  key: string;
  if?: string;
  needs: string[];
  steps: WorkflowStep[];
  /** Вызов reusable workflow: у такого джоба нет ни одного шага, весь код — внутри него. */
  uses?: string;
  permissions?: unknown;
  concurrency?: unknown;
  environment?: unknown;
}

export interface Workflow {
  file: string;
  displayName: string;
  triggers: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: unknown;
  jobs: Record<string, WorkflowJob>;
}

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
export const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
/** Основная ветка репозитория: и цель фильтра `branches`, и вершина для guard'а. */
export const DEFAULT_BRANCH = 'main';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Читает все workflow-файлы. Отсутствие каталога или пустой список — исключение:
 * «проверять нечего» это провал проверки, а не её успех.
 */
export function loadWorkflows(): Workflow[] {
  if (!existsSync(WORKFLOWS_DIR)) throw new Error(`нет каталога ${WORKFLOWS_DIR}`);
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  if (files.length === 0) throw new Error(`в ${WORKFLOWS_DIR} нет ни одного workflow-файла`);

  return files.sort().map((file) => {
    const raw = readFileSync(join(WORKFLOWS_DIR, file), 'utf-8');
    let doc: Record<string, unknown>;
    try {
      doc = asRecord(parse(raw));
    } catch (err) {
      throw new Error(`${file} не разбирается как YAML: ${(err as Error).message}`);
    }
    // В YAML 1.1 голый `on` — булево true. Парсер работает по 1.2 и оставляет строку,
    // но ключ `true` обрабатываем тоже: иначе смена парсера молча обнулит проверки.
    const triggers = asRecord(doc.on ?? doc['true']);
    const jobs: Record<string, WorkflowJob> = {};
    for (const [key, value] of Object.entries(asRecord(doc.jobs))) {
      const job = asRecord(value);
      const steps = (Array.isArray(job.steps) ? job.steps : []).map((s, index) => {
        const step = asRecord(s);
        return {
          index,
          name: typeof step.name === 'string' ? step.name : undefined,
          id: typeof step.id === 'string' ? step.id : undefined,
          uses: typeof step.uses === 'string' ? step.uses : undefined,
          run: typeof step.run === 'string' ? step.run : undefined,
          if: step.if === undefined ? undefined : String(step.if),
          with: asRecord(step.with),
          env: asRecord(step.env),
          raw: JSON.stringify(step),
        } satisfies WorkflowStep;
      });
      jobs[key] = {
        key,
        if: job.if === undefined ? undefined : String(job.if),
        needs: asStringList(job.needs),
        steps,
        uses: typeof job.uses === 'string' ? job.uses : undefined,
        permissions: job.permissions,
        concurrency: job.concurrency,
        environment: job.environment,
      };
    }
    return {
      file,
      displayName: typeof doc.name === 'string' ? doc.name : file,
      triggers,
      permissions: doc.permissions,
      concurrency: doc.concurrency,
      jobs,
    };
  });
}

/** Шаг публикации: именно `deploy-pages` кладёт содержимое на сайт. */
export function isPublishStep(step: WorkflowStep): boolean {
  return /^actions\/deploy-pages(@|$)/.test(step.uses ?? '');
}

/** Шаги, выгружающие код репозитория (в том числе чужого). */
export function isCodeFetchStep(step: WorkflowStep): boolean {
  if (/^actions\/checkout(@|$)/.test(step.uses ?? '')) return true;
  if (/^actions\/download-artifact(@|$)/.test(step.uses ?? '')) return true;
  return /\b(git\s+clone|git\s+fetch|gh\s+repo\s+clone)\b/.test(step.run ?? '');
}

/**
 * Шаги джоба, которые выполняются с правами, выданными джобу.
 *
 * Исключений НЕТ ни для одного шага, в том числе для проверки происхождения.
 * Исключение по тексту шага само было дырой: шаг вида
 * `curl … | bash` и следом `test "$HEAD_REPO" = … || exit 1` содержит признаки
 * guard'а, поэтому целиком уходил из-под проверки, хотя чужой код в нём исполняется
 * ДО сверки. Разбирать порядок команд внутри произвольного shell — заведомо
 * ненадёжно, поэтому происхождение обязано проверяться на уровне джоба (`if` самого
 * джоба или его зависимости по `needs`), а не шагом внутри него.
 */
export function riskyStepsInJob(job: WorkflowJob): WorkflowStep[] {
  const steps = job.steps.filter((step) => step.run !== undefined || step.uses !== undefined);
  if (job.uses === undefined) return steps;

  // Джоб, вызывающий reusable workflow, ШАГОВ НЕ ИМЕЕТ вовсе: весь код лежит внутри
  // вызванного workflow. Пока модель хранила только `steps`, такой джоб давал пустой
  // список опасных шагов и молча проходил обе проверки происхождения — то есть
  // приёмник `workflow_run` без guard'а, вызывающий reusable workflow, был для гейта
  // невидим. Сам вызов и есть исполнение кода.
  const call: WorkflowStep = {
    index: 0,
    name: `вызов reusable workflow ${job.uses}`,
    uses: job.uses,
    raw: JSON.stringify({ uses: job.uses }),
  };
  return [call, ...steps];
}

export function publishingWorkflows(all: Workflow[]): Workflow[] {
  return all.filter((wf) => Object.values(wf.jobs).some((j) => j.steps.some(isPublishStep)));
}

export function findPublishStep(wf: Workflow): { job: WorkflowJob; step: WorkflowStep } | undefined {
  for (const job of Object.values(wf.jobs)) {
    const step = job.steps.find(isPublishStep);
    if (step) return { job, step };
  }
  return undefined;
}

/** Джоб и все его зависимости по `needs`, транзитивно. */
export function jobsOnPathTo(wf: Workflow, jobKey: string): WorkflowJob[] {
  const seen = new Set<string>();
  const out: WorkflowJob[] = [];
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const job = wf.jobs[key];
    if (!job) throw new Error(`${wf.file}: needs ссылается на несуществующий джоб '${key}'`);
    job.needs.forEach(visit);
    out.push(job);
  };
  visit(jobKey);
  return out;
}

/**
 * Условия, которые обязаны быть истинны, чтобы шаг выполнился: `if` его джоба, `if`
 * всех джобов по цепочке `needs` и собственный `if` шага. Джоб, чья зависимость
 * пропущена, пропускается сам — поэтому конъюнкция, а не дизъюнкция.
 */
export function conditionsGuarding(
  wf: Workflow,
  jobKey: string,
  step?: WorkflowStep,
): { source: string; expr: string }[] {
  const out = jobsOnPathTo(wf, jobKey)
    .filter((j) => j.if !== undefined)
    .map((j) => ({ source: `${wf.file}:job ${j.key}`, expr: j.if as string }));
  if (step?.if !== undefined)
    out.push({ source: `${wf.file}:step ${step.name ?? step.index}`, expr: step.if });
  return out;
}

/** Триггеры workflow, в которых указан `workflow_run`. */
export function workflowRunTrigger(wf: Workflow): {
  workflows: string[];
  types: string[];
  branches: string[];
} | null {
  if (!('workflow_run' in wf.triggers)) return null;
  const cfg = asRecord(wf.triggers.workflow_run);
  return {
    workflows: asStringList(cfg.workflows),
    types: asStringList(cfg.types),
    branches: asStringList(cfg.branches),
  };
}

/** Триггер `push` с перечнем веток (пустой список = все ветки). */
export function pushTrigger(wf: Workflow): { branches: string[] } | null {
  if (!('push' in wf.triggers)) return null;
  const cfg = asRecord(wf.triggers.push);
  return { branches: asStringList(cfg.branches) };
}

export function hasTrigger(wf: Workflow, name: string): boolean {
  return name in wf.triggers;
}

/** Объявлены ли где-либо в файле права на Pages. */
export function declaresPagesPermission(wf: Workflow): boolean {
  const check = (perms: unknown): boolean => {
    if (typeof perms === 'string') return perms === 'write-all';
    const rec = asRecord(perms);
    return rec.pages !== undefined && rec.pages !== 'none';
  };
  return check(wf.permissions) || Object.values(wf.jobs).some((j) => check(j.permissions));
}

/** Имя группы `concurrency` — на уровне файла и джобов. */
export function concurrencyGroups(wf: Workflow): string[] {
  const names: string[] = [];
  const push = (c: unknown): void => {
    if (typeof c === 'string') names.push(c);
    else {
      const rec = asRecord(c);
      if (typeof rec.group === 'string') names.push(rec.group);
    }
  };
  push(wf.concurrency);
  Object.values(wf.jobs).forEach((j) => push(j.concurrency));
  return names.filter((n) => n !== '');
}

// ------------------------------------------------------- контексты событий

const OWN_REPO = 'ikpk/ikpk';
const FORK_REPO = 'chuzhoy/ikpk';
const TESTED_SHA = 'a'.repeat(40);

/** Событие `workflow_run` с заданным исходом и происхождением. */
export function workflowRunContext(options: {
  conclusion: string;
  headRepository?: string;
  headBranch?: string;
}): GithubContext {
  const head = options.headRepository ?? OWN_REPO;
  return {
    event_name: 'workflow_run',
    repository: OWN_REPO,
    repository_owner: OWN_REPO.split('/')[0],
    // При `workflow_run` эти два указывают на дефолтную ветку, а не на проверенный
    // коммит — именно поэтому спека требует явный `ref` у checkout.
    sha: 'b'.repeat(40),
    ref: `refs/heads/${DEFAULT_BRANCH}`,
    ref_name: DEFAULT_BRANCH,
    event: {
      workflow_run: {
        conclusion: options.conclusion,
        status: 'completed',
        head_sha: TESTED_SHA,
        head_branch: options.headBranch ?? DEFAULT_BRANCH,
        head_repository: { full_name: head, owner: { login: head.split('/')[0] } },
        repository: { full_name: OWN_REPO, owner: { login: OWN_REPO.split('/')[0] } },
      },
    },
  };
}

/** Push в основную ветку: объекта `workflow_run` тоже не существует. */
export function pushContext(branch = DEFAULT_BRANCH): GithubContext {
  return {
    event_name: 'push',
    repository: OWN_REPO,
    repository_owner: OWN_REPO.split('/')[0],
    sha: 'd'.repeat(40),
    ref: `refs/heads/${branch}`,
    ref_name: branch,
    event: { ref: `refs/heads/${branch}` },
  };
}

/** Ручной запуск: объекта `workflow_run` не существует вовсе. */
export function dispatchContext(refName = DEFAULT_BRANCH): GithubContext {
  return {
    event_name: 'workflow_dispatch',
    repository: OWN_REPO,
    repository_owner: OWN_REPO.split('/')[0],
    sha: 'c'.repeat(40),
    ref: `refs/heads/${refName}`,
    ref_name: refName,
    event: {},
  };
}

export const CONTEXT_CONSTANTS = { OWN_REPO, FORK_REPO, TESTED_SHA };
