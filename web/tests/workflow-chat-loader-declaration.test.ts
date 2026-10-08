import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Регресс на дефект: ночной прогон `Parity vs live ikpk.su` краснел постоянно.
 *
 * Прогон Nightly full checks, run 37754933473 (событие schedule,
 * main@8a2042a8a90cdf3a85d197012f4588a6b98444b3), упал на
 * `web/tests/external-widgets-dist.test.ts` — «объявленная конфигурация боевой сборки
 * согласна с её выводом»: «не объявлено ничего (состояние 3) … измерить не удалось».
 *
 * Причина — в конфигурации workflow, а не в коде сайта. Спека `external-widgets` делает
 * «не объявлено ничего» (ключ `CHAT_LOADER_SRC` отсутствует или пуст) непройденной проверкой
 * ПО КОНСТРУКЦИИ, а объявление «чата пока нет» — это явное значение `none`. Обязательный
 * `Tests` (`.github/workflows/test.yml`) его объявляет; ночной `nightly.yml` собирал сайт и
 * гонял те же dist-проверки (`npm run test:build:remote`) без объявления.
 *
 * Здесь проверяется общий признак, а не имя одного джоба: КАЖДЫЙ шаг workflow, который
 * исполняет dist-проверки боевой сборки, обязан иметь в своём эффективном окружении
 * объявление чата — заданное на шаге, в джобе или в workflow.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

const KEY = 'CHAT_LOADER_SRC';

// Шаг исполняет dist-проверки боевой сборки: либо набор `vitest.build.config.ts`, либо
// npm-скрипты `test:build` / `test:build:remote`, которые его запускают.
const RUNS_DIST_CHECKS = /vitest\.build\.config\.ts|\bnpm\s+run\s+test:build(?::remote)?\b/;

type Env = Record<string, unknown> | undefined;
interface Step { name?: string; run?: string; env?: Env }
interface Job { env?: Env; steps?: Step[] }
interface Workflow { env?: Env; jobs?: Record<string, Job> }
interface Finding { job: string; step: string; problem: string }

function declared(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  // Допустимы ровно две формы из спеки: выделенное `none` либо адрес со схемой.
  return v === 'none' || /^https?:\/\/\S+$/.test(v);
}

/** Шаги, исполняющие dist-проверки, без объявления чата в их эффективном окружении. */
function undeclaredDistSteps(workflow: Workflow): { checked: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let checked = 0;
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string' || !RUNS_DIST_CHECKS.test(step.run)) continue;
      checked += 1;
      const env = { ...(workflow.env ?? {}), ...(job.env ?? {}), ...(step.env ?? {}) };
      const where = { job: jobName, step: step.name ?? '(без имени)' };
      if (!(KEY in env)) findings.push({ ...where, problem: `${KEY} не задан` });
      else if (!declared(env[KEY]))
        findings.push({
          ...where,
          problem: `${KEY}=${JSON.stringify(env[KEY])}: пусто, не 'none' и не адрес со схемой`,
        });
    }
  }
  return { checked, findings };
}

describe('проверка объявления чата в workflow: её собственные ветви', () => {
  const wf = (yaml: string): Workflow => parse(yaml) as Workflow;

  it('шаг без объявления — находка', () => {
    const { checked, findings } = undeclaredDistSteps(
      wf(`
jobs:
  j:
    steps:
      - name: parity
        run: npm run test:build:remote
`),
    );
    expect(checked).toBe(1);
    expect(findings).toHaveLength(1);
  });

  it('пустое значение — находка (это то же состояние 3)', () => {
    const { findings } = undeclaredDistSteps(
      wf(`
jobs:
  j:
    steps:
      - run: npx vitest run --config vitest.build.config.ts
        env: { CHAT_LOADER_SRC: '' }
`),
    );
    expect(findings).toHaveLength(1);
  });

  it('значение не из спеки — находка', () => {
    const { findings } = undeclaredDistSteps(
      wf(`
jobs:
  j:
    steps:
      - run: npm run test:build
        env: { CHAT_LOADER_SRC: 'nope' }
`),
    );
    expect(findings).toHaveLength(1);
  });

  it('объявление на шаге, в джобе и в workflow — принято', () => {
    for (const yaml of [
      `jobs: { j: { steps: [ { run: 'npm run test:build', env: { CHAT_LOADER_SRC: none } } ] } }`,
      `jobs: { j: { env: { CHAT_LOADER_SRC: none }, steps: [ { run: 'npm run test:build' } ] } }`,
      `env: { CHAT_LOADER_SRC: 'https://chat.example.invalid/loader.js' }\njobs: { j: { steps: [ { run: 'npm run test:build:remote' } ] } }`,
    ]) {
      const { checked, findings } = undeclaredDistSteps(wf(yaml));
      expect(checked).toBe(1);
      expect(findings).toEqual([]);
    }
  });

  it('шаги, не исполняющие dist-проверки, не считаются', () => {
    const { checked, findings } = undeclaredDistSteps(
      wf(`
jobs:
  j:
    steps:
      - run: npm run build
      - run: npm run test:e2e:compat
      - run: npx vitest run --config vitest.demo.config.ts
`),
    );
    expect(checked).toBe(0);
    expect(findings).toEqual([]);
  });
});

describe('workflow репозитория объявляют конфигурацию чата перед dist-проверками боевой сборки', () => {
  const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));

  it('предмет не пуст: workflow найдены и dist-проверки в них есть', () => {
    expect(files, 'в .github/workflows нет workflow — проверять нечего').not.toEqual([]);
    // Оба известных исполнителя обязаны быть увидены: иначе смена формы записи шага
    // (например, переименование скрипта) тихо превратила бы проверку в вакуумную.
    for (const name of ['test.yml', 'nightly.yml']) {
      const { checked } = undeclaredDistSteps(parse(readFileSync(join(workflowsDir, name), 'utf-8')));
      expect(checked, `${name}: ни одного шага с dist-проверками боевой сборки — признак устарел`).toBeGreaterThan(0);
    }
  });

  it.each(files)('%s', (file) => {
    const { findings } = undeclaredDistSteps(parse(readFileSync(join(workflowsDir, file), 'utf-8')));
    expect(
      findings,
      `шаги исполняют dist-проверки без объявления чата: без ${KEY} сборка даёт состояние 3 ` +
        '(unspecified), и «объявленная конфигурация боевой сборки согласна с её выводом» ' +
        'краснеет по конструкции, а не при регрессии. Адрес наугад подставлять нельзя — ' +
        `объявляется текущее состояние: ${KEY}=none`,
    ).toEqual([]);
  });
});
