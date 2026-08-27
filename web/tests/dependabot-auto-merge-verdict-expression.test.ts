/**
 * Change `automerge-verdict-expression`: отрицательный вердикт SHALL NOT выражаться
 * падением джоба.
 *
 * Шаги вердикта — чистый bash со входами через `env`, поэтому они здесь ИСПОЛНЯЮТСЯ, а не
 * сверяются регуляркой: проверяется код выхода и записанное значение вердикта. Условие
 * включения пометки — выражение GitHub, поэтому оно разбирается парсером
 * (`helpers/gh-expression`), а не поиском подстроки.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExpression, type ExprNode } from './helpers/gh-expression';
import { loadWorkflows, type Workflow, type WorkflowJob } from './helpers/workflows';

const POLICY_FILE = 'dependabot-auto-merge-policy.yml';

function policy(): Workflow {
  const wf = loadWorkflows().find((w) => w.file === POLICY_FILE);
  expect(wf, `не найден ${POLICY_FILE}`).toBeDefined();
  return wf as Workflow;
}

function job(key: string): WorkflowJob {
  const found = policy().jobs[key];
  expect(found, `в ${POLICY_FILE} нет джоба ${key}`).toBeDefined();
  return found as WorkflowJob;
}

/** Единственный шаг джоба вердикта: его скрипт и объявленные им переменные. */
function verdictStep(jobKey: string): { script: string; env: Record<string, string> } {
  const steps = job(jobKey).steps.filter((s) => typeof s.run === 'string');
  expect(steps, `у джоба ${jobKey} ожидался ровно один run-шаг`).toHaveLength(1);
  const step = steps[0]!;
  return { script: step.run as string, env: (step.env ?? {}) as Record<string, string> };
}

/**
 * Исполняет скрипт шага так, как это делает раннер: `bash -e`, входы через окружение,
 * `GITHUB_OUTPUT` — файл. Возвращает код выхода и разобранные выходы джоба.
 */
function runStep(script: string, env: Record<string, string>): {
  status: number;
  outputs: Record<string, string>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-step-'));
  const outputFile = join(dir, 'github_output');
  writeFileSync(outputFile, '');
  const scriptFile = join(dir, 'step.sh');
  writeFileSync(scriptFile, script);
  let status = 0;
  try {
    execFileSync('bash', ['-e', scriptFile], {
      env: { ...process.env, ...env, GITHUB_OUTPUT: outputFile },
      stdio: 'pipe',
    });
  } catch (error) {
    status = (error as { status?: number }).status ?? 1;
  }
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outputFile, 'utf-8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { status, outputs };
}

/** Значение выхода вердикта, объявленное джобом (`outputs:` джоба ссылается на шаг). */
function verdictOutputName(jobKey: string): string {
  const outputs = job(jobKey).outputs ?? {};
  const names = Object.keys(outputs);
  expect(names, `джоб ${jobKey} не объявляет выхода с вердиктом`).not.toHaveLength(0);
  return names[0]!;
}

const ELIGIBILITY_DETERMINED = {
  FRESH_SNAPSHOT_RESULT: 'success',
  FRESH_HEAD_MATCHES_CURRENT: 'true',
  ASSESS_RESULT: 'success',
  REASON: 'мажорный подъём вне разрешающей строки',
};

describe('вердикт допустимости выражается значением, а не падением джоба', () => {
  it('отрицательный вердикт: джоб завершается успехом', () => {
    const { script } = verdictStep('eligibility-gate');
    const { status } = runStep(script, { ...ELIGIBILITY_DETERMINED, GATE_OK: 'false' });
    expect(status, 'определённый отрицательный вердикт не должен падать джобом').toBe(0);
  });

  it('отрицательный вердикт сообщается выходом джоба', () => {
    const { script } = verdictStep('eligibility-gate');
    const { outputs } = runStep(script, { ...ELIGIBILITY_DETERMINED, GATE_OK: 'false' });
    const name = verdictOutputName('eligibility-gate');
    expect(Object.keys(outputs)).toContain(name);
    expect(outputs[name]).not.toBe('positive');
  });

  it('положительный вердикт: успех и положительное значение', () => {
    const { script } = verdictStep('eligibility-gate');
    const { status, outputs } = runStep(script, { ...ELIGIBILITY_DETERMINED, GATE_OK: 'true' });
    expect(status).toBe(0);
    expect(outputs[verdictOutputName('eligibility-gate')]).toBe('positive');
  });

  it.each([
    ['несвежий снимок', { FRESH_SNAPSHOT_RESULT: 'failure' }],
    ['вершина события не совпала с текущей', { FRESH_HEAD_MATCHES_CURRENT: 'false' }],
    ['оценка не выполнена', { ASSESS_RESULT: 'failure' }],
  ])('неопределимость (%s) остаётся неуспехом', (_label, override) => {
    const { script } = verdictStep('eligibility-gate');
    const { status } = runStep(script, { ...ELIGIBILITY_DETERMINED, GATE_OK: 'true', ...override });
    expect(status, 'измерить не удалось — это обязано падать').not.toBe(0);
  });
});

describe('свидетельство о происхождении разделяет те же состояния', () => {
  it('отрицательное происхождение: джоб завершается успехом и сообщает вердикт', () => {
    const { script } = verdictStep('provenance-evidence');
    const { status, outputs } = runStep(script, {
      ASSESS_RESULT: 'success',
      ORIGIN_POSITIVE: 'false',
    });
    expect(status).toBe(0);
    expect(outputs[verdictOutputName('provenance-evidence')]).not.toBe('positive');
  });

  it('оценка не выполнена — неуспех', () => {
    const { script } = verdictStep('provenance-evidence');
    const { status } = runStep(script, { ASSESS_RESULT: 'failure', ORIGIN_POSITIVE: 'true' });
    expect(status).not.toBe(0);
  });
});

describe('включение пометки требует положительного вердикта, а не только зелёного джоба', () => {
  /**
   * Почему проверяется СОСТАВ КОНЪЮНКТОВ, а не результат вычисления условия.
   *
   * Помощник `gh-expression` намеренно считает `needs.*` неизвестным: на этом стоят
   * соседние тесты, рассуждающие о выполнимости. Подставлять туда значения — значит менять
   * общую инфраструктуру под один тест.
   *
   * Проверка состава при этом не слабее, а является доказательством: конъюнкция монотонна,
   * поэтому наличие конъюнкта `X == 'positive'` на верхнем уровне ОЗНАЧАЕТ, что при любом
   * другом значении `X` всё условие ложно. Ради этого отдельно утверждается, что верхний
   * уровень — чистая цепочка `&&` без объемлющего `||`: внутри дизъюнкции конъюнкт такой
   * силы не имел бы.
   */
  const condition = (): string => {
    const raw = (job('enable-auto-merge') as unknown as { if?: string }).if;
    expect(raw, 'у джоба включения пометки нет условия').toBeDefined();
    return String(raw).trim();
  };

  /** Конъюнкты верхнего уровня: дерево разбирается, а не текст делится по `&&`. */
  const conjuncts = (): ExprNode[] => {
    const out: ExprNode[] = [];
    const walk = (node: ExprNode): void => {
      if (node.t === 'bin' && node.op === '&&') {
        walk(node.a);
        walk(node.b);
        return;
      }
      out.push(node);
    };
    walk(parseExpression(`\${{ ${condition()} }}`));
    return out;
  };

  /** Есть ли среди конъюнктов сравнение `path == 'value'`. */
  const hasEquality = (path: string, value: string): boolean =>
    conjuncts().some((node) =>
      node.t === 'bin' && node.op === '==' &&
      ((node.a.t === 'path' && node.a.p === path && node.b.t === 'lit' && node.b.v === value) ||
       (node.b.t === 'path' && node.b.p === path && node.a.t === 'lit' && node.a.v === value)),
    );

  it('верхний уровень условия — чистая цепочка И', () => {
    const top = parseExpression(`\${{ ${condition()} }}`);
    expect(
      top.t === 'bin' && top.op === '&&',
      'при объемлющем ИЛИ отдельный конъюнкт не гарантирует ложности условия',
    ).toBe(true);
  });

  it('положительный вердикт допустимости — обязательный конъюнкт', () => {
    expect(
      hasEquality('needs.eligibility-gate.outputs.verdict', 'positive'),
      'зелёный джоб при отрицательном вердикте иначе откроет путь к пометке',
    ).toBe(true);
  });

  it('успех джоба вердикта остаётся обязательным конъюнктом', () => {
    expect(
      hasEquality('needs.eligibility-gate.result', 'success'),
      'без него пропущенный или отменённый джоб не остановит пометку',
    ).toBe(true);
  });

  it('положительное происхождение обязательно, когда свидетельство отрабатывало', () => {
    const guarded = conjuncts().some((node) => {
      if (node.t !== 'bin' || node.op !== '||') return false;
      const parts = [node.a, node.b];
      const skipped = parts.some((x) =>
        x.t === 'bin' && x.op === '==' && x.a.t === 'path' &&
        x.a.p === 'needs.provenance-evidence.result' && x.b.t === 'lit' && x.b.v === 'skipped');
      const positive = parts.some((x) =>
        x.t === 'bin' && x.op === '==' && x.a.t === 'path' &&
        x.a.p === 'needs.provenance-evidence.outputs.verdict' && x.b.t === 'lit' && x.b.v === 'positive');
      return skipped && positive;
    });
    expect(
      guarded,
      'после разделения `result == success` больше не означает «происхождение допустимо»',
    ).toBe(true);
  });
});

describe('публикуемая проверка выводится из вердикта, а не из цвета джоба', () => {
  it('шаг публикации не получает результат джоба вердикта на вход', () => {
    const { env } = verdictStep('publish-checks');
    const fromJobResult = Object.entries(env).filter(([, value]) =>
      /needs\.(eligibility-gate|provenance-evidence)\.result/.test(value),
    );
    expect(
      fromJobResult.map(([key]) => key),
      'исход публикуемой проверки обязан выводиться из вердикта: результат джоба на вход не подаётся',
    ).toEqual([]);
  });

  it('шаг публикации получает вердикты на вход', () => {
    const { env } = verdictStep('publish-checks');
    const values = Object.values(env).join('\n');
    for (const jobKey of ['eligibility-gate', 'provenance-evidence']) {
      expect(values, `нет вердикта джоба ${jobKey}`).toContain(
        `needs.${jobKey}.outputs.${verdictOutputName(jobKey)}`,
      );
    }
  });
});
