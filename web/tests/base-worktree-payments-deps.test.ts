// Живой дефект (обнаружен 2026-08-25 при приёмке dependabot-auto-merge, не связан с ним по
// существу): шаг «Measure base Vitest volume for dependency or Dependabot PR»
// (`.github/workflows/test.yml`) создаёт временный worktree `main` и ставит зависимости
// только для `web` (`npm ci --prefix "$base/web"`). Тесты web порождают процесс
// payments-сервиса через `node --import tsx` (`web/tests/helpers/payment-service.ts:368`), а
// `tsx` резолвится из `payments/node_modules`, которого в этом worktree никогда не было.
// Живой след: run 32676257554 (PR #175, job «Unit and build tests», 2026-08-24) и
// идентичный traceback на #177, #178, #180, #174 (повторный прогон 2026-08-25) —
// `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from
// .../web-base-worktree/payments/`. Этот шаг условно исполняется именно для
// dependency-only и Dependabot PR (`if: dependency_only == true || author ==
// 'dependabot[bot]'`), поэтому падает на каждом PR этого класса — независимо от
// dependabot-auto-merge, но блокирует и его: без зелёного «Unit and build tests» ни один
// Dependabot PR не может слиться, ни вручную, ни автоматически.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkflows } from './helpers/workflows';

const WORKFLOW_FILE = 'test.yml';
const JOB_KEY = 'unit-and-build';
const STEP_NAME = 'Measure base Vitest volume for dependency or Dependabot PR';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stepRun(): string {
  const workflow = loadWorkflows().find((w) => w.file === WORKFLOW_FILE);
  if (workflow === undefined) throw new Error(`нет workflow ${WORKFLOW_FILE}`);
  const job = workflow.jobs[JOB_KEY];
  if (job === undefined) throw new Error(`${WORKFLOW_FILE}: нет джоба ${JOB_KEY}`);
  const step = job.steps.find((candidate) => candidate.name === STEP_NAME);
  if (step === undefined) throw new Error(`${WORKFLOW_FILE}: в джобе ${JOB_KEY} нет шага ${STEP_NAME}`);
  if (step.run === undefined || step.run.trim() === '') {
    throw new Error(`${WORKFLOW_FILE}: шаг ${STEP_NAME} не содержит run`);
  }
  return step.run;
}

interface ShellResult {
  status: number | null;
  stderr: string;
  calls: string;
}

/**
 * Исполняет шаг тем же интерпретатором, что и GitHub Actions (`bash -e`), со стаб-бинарями
 * вместо `git`/`npm`/`npx` — реального worktree и реальной установки npm здесь не нужно,
 * предмет проверки — САМ ФАКТ вызова `npm ci` с нужным `--prefix`, а не результат сборки.
 */
function runStep(script: string): ShellResult {
  const dir = mkdtempSync(join(tmpdir(), 'base-worktree-payments-deps-'));
  scratch.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const callLogPath = join(dir, 'calls.txt');
  writeFileSync(callLogPath, '');

  const stubs: Record<string, string> = {
    git: `#!/usr/bin/env bash
printf 'GIT %s\\n' "$*" >>"$GIT_CALL_LOG"
# \`git worktree add --detach <base> <sha>\` обязан реально создать каталог <base>,
# иначе последующий \`cd\` внутри шага упадёт и тест не дойдёт до проверки npm ci.
if [ "$1" = worktree ] && [ "$2" = add ]; then
  mkdir -p "$4/web" "$4/payments"
fi
exit 0
`,
    npm: `#!/usr/bin/env bash
printf 'NPM %s\\n' "$*" >>"$GIT_CALL_LOG"
exit 0
`,
    npx: `#!/usr/bin/env bash
printf 'NPX %s\\n' "$*" >>"$GIT_CALL_LOG"
exit 0
`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  const scriptPath = join(dir, 'step.sh');
  writeFileSync(scriptPath, script);
  const runnerTemp = join(dir, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });

  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: runnerTemp,
      BASE_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      GIT_CALL_LOG: callLogPath,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    calls: readFileSync(callLogPath, 'utf8'),
  };
}

describe('живая регрессия: измерение базы Vitest не ставит payments/node_modules', () => {
  it('устанавливает зависимости payments в worktree до запуска тестов web', () => {
    const result = runStep(stepRun());

    expect(result.status, `шаг обязан завершаться успехом: ${result.stderr}`).toBe(0);
    expect(result.calls, 'ожидался npm ci --prefix .../payments до первого npx vitest run')
      .toMatch(/NPM ci --prefix \S*\/payments\b/);

    const calls = result.calls.split('\n').filter(Boolean);
    const paymentsInstallIndex = calls.findIndex((line) => /NPM ci --prefix \S*\/payments\b/.test(line));
    const firstVitestIndex = calls.findIndex((line) => /NPX vitest run\b/.test(line));
    expect(paymentsInstallIndex, 'установка payments не найдена вовсе').toBeGreaterThanOrEqual(0);
    expect(firstVitestIndex, 'запуск vitest не найден вовсе').toBeGreaterThanOrEqual(0);
    expect(paymentsInstallIndex, 'payments должен быть установлен ДО первого запуска vitest')
      .toBeLessThan(firstVitestIndex);
  });
});
