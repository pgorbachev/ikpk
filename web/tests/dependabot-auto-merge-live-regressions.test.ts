// Регрессии, найденные живым прогоном после активации политики (2026-08-18).
//
// Оба дефекта не ловил ни один существующий тест, и причина у этого одна: предмет
// проверки — shell внутри workflow, а все прежние тесты проверяют TypeScript-модуль
// либо структуру YAML. Поэтому здесь исполняется ровно тот текст шага, который лежит
// в YAML: шаг берётся из файла, а не переписывается в тест. Переписанная копия
// разошлась бы с оригиналом молча — именно так оба дефекта и доехали до production.
//
// Дефект 1: `jq -e` завершается кодом 1, когда последнее выведенное значение — `false`.
// Шаг снимка читал marker выражением `.auto_merge != null`, поэтому для любого PR без
// включённого auto-merge падал весь job, а с ним и публикация обязательного check.
// Живой след: run 32151344352, job «Fresh pull-request snapshot», exit code 1.
//
// Дефект 2: у workflow run от `pull_request_target: closed` GitHub оставляет
// `pull_requests` пустым, поэтому dispatcher продвижения не мог опознать PR вовсе.
// Живой след: source run 32146430416 (`pull_requests: []`) и упавший dispatcher
// 32146446224, job «Authenticate merged source».

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkflows, type Workflow } from './helpers/workflows';

const POLICY_FILE = 'dependabot-auto-merge-policy.yml';
const REBASE_SIGNAL_FILE = 'dependabot-rebase.yml';
const REBASE_DISPATCH_FILE = 'dependabot-rebase-dispatch.yml';

const REBASE_SIGNAL_SCHEMA = 'dependabot-rebase-signal/v1';
const REBASE_SIGNAL_FILENAME = 'dependabot-rebase-signal.json';
const REBASE_ARTIFACT_PREFIX = 'dependabot-rebase-signal';

const REPOSITORY = 'pgorbachev/ikpk';
const RUN_ID = 32146430416;
const RUN_ATTEMPT = 1;
const PR_NUMBER = 137;
const HEAD_SHA = '01dc8e3d0c3ad3022058bcc4de7ce2377f233d59';
const ACTOR = 'pgorbachev';

const workflows = loadWorkflows();
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workflowNamed(file: string): Workflow {
  const found = workflows.find((workflow) => workflow.file === file);
  if (found === undefined) throw new Error(`нет workflow ${file}`);
  return found;
}

/**
 * Текст шага из YAML. Отсутствие джоба или шага — исключение, а не пустая строка:
 * тест, молча исполнивший пустой скрипт, был бы зелёным на любом дефекте.
 */
function stepRun(file: string, jobKey: string, stepId: string): string {
  const workflow = workflowNamed(file);
  const job = workflow.jobs[jobKey];
  if (job === undefined) throw new Error(`${file}: нет джоба ${jobKey}`);
  const step = job.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`${file}: в джобе ${jobKey} нет шага с id ${stepId}`);
  if (step.run === undefined || step.run.trim() === '') {
    throw new Error(`${file}: шаг ${stepId} джоба ${jobKey} не содержит run`);
  }
  return step.run;
}

interface ShellResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  calls: string;
}

/**
 * Исполняет шаг тем же интерпретатором, каким его исполняет GitHub Actions:
 * `bash -e`. Без `-e` падение любой промежуточной команды осталось бы незамеченным,
 * то есть тест проверял бы не то поведение, что на площадке.
 */
function runStep(script: string, env: Record<string, string>, stubs: Record<string, string>): ShellResult {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-live-regression-'));
  scratch.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  // На macOS нет `sha256sum`, на runner'е есть. Тонкая обёртка над `shasum -a 256`
  // сохраняет формат вывода, поэтому проверка digest остаётся настоящей.
  const shim = join(bin, 'sha256sum');
  writeFileSync(shim, `#!/usr/bin/env bash
if [ -x /usr/bin/sha256sum ]; then exec /usr/bin/sha256sum "$@"; fi
exec /usr/bin/shasum -a 256 "$@"
`);
  chmodSync(shim, 0o755);

  const scriptPath = join(dir, 'step.sh');
  writeFileSync(scriptPath, script);
  const outputPath = join(dir, 'github-output.txt');
  const callLogPath = join(dir, 'calls.txt');
  writeFileSync(outputPath, '');
  writeFileSync(callLogPath, '');

  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: dir,
      GH_CALL_LOG: callLogPath,
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: readFileSync(outputPath, 'utf8'),
    calls: readFileSync(callLogPath, 'utf8'),
  };
}

function outputValue(output: string, name: string): string | undefined {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1))
    .at(-1);
}

// ------------------------------------------------------------------ дефект 1

const SNAPSHOT_STEP = () => stepRun(POLICY_FILE, 'snapshot', 'current');

function pullPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: PR_NUMBER,
    head: { sha: HEAD_SHA },
    auto_merge: null,
    user: { login: 'dependabot[bot]' },
    ...overrides,
  };
}

function ghStubReturning(payload: unknown): Record<string, string> {
  return {
    gh: `#!/usr/bin/env bash
set -euo pipefail
printf 'GH %s\\n' "$*" >>"$GH_CALL_LOG"
cat <<'PAYLOAD'
${JSON.stringify(payload)}
PAYLOAD
`,
  };
}

function runSnapshot(payload: unknown, eventHeadSha = HEAD_SHA): ShellResult {
  return runStep(SNAPSHOT_STEP(), {
    EVENT_HEAD_SHA: eventHeadSha,
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: REPOSITORY,
    PR_NUMBER: String(PR_NUMBER),
  }, ghStubReturning(payload));
}

describe('живая регрессия: снимок PR читает выключенный marker', () => {
  it('сообщает auto-merge-enabled=false, а не падает, когда marker выключен', () => {
    const result = runSnapshot(pullPayload({ auto_merge: null }));

    expect(result.status, `шаг снимка обязан завершаться успехом: ${result.stderr}`).toBe(0);
    expect(outputValue(result.output, 'auto-merge-enabled')).toBe('false');
    expect(outputValue(result.output, 'head-sha')).toBe(HEAD_SHA);
    expect(outputValue(result.output, 'head-matches-event')).toBe('true');
    expect(outputValue(result.output, 'pr-number')).toBe(String(PR_NUMBER));
  });

  it('сообщает auto-merge-enabled=true, когда marker включён', () => {
    const result = runSnapshot(pullPayload({ auto_merge: { enabled_by: { login: 'github-actions[bot]' } } }));

    expect(result.status, result.stderr).toBe(0);
    expect(outputValue(result.output, 'auto-merge-enabled')).toBe('true');
  });

  it('отличает устаревшую вершину события от текущей', () => {
    const result = runSnapshot(pullPayload(), 'f'.repeat(40));

    expect(result.status, result.stderr).toBe(0);
    expect(outputValue(result.output, 'head-matches-event')).toBe('false');
  });

  it('падает fail closed, когда поля auto_merge в ответе нет вовсе', () => {
    const payload = pullPayload();
    delete payload.auto_merge;
    const result = runSnapshot(payload);

    expect(result.status, 'отсутствие поля marker обязано оставаться отказом').not.toBe(0);
    expect(outputValue(result.output, 'auto-merge-enabled')).toBeUndefined();
  });

  it('падает fail closed, когда head SHA не читается', () => {
    const result = runSnapshot(pullPayload({ head: { sha: 'not-a-sha' } }));

    expect(result.status).not.toBe(0);
  });
});

// ------------------------------------------------------------------ дефект 2

interface RebaseScenario {
  runOverrides?: Record<string, unknown>;
  signalOverrides?: Record<string, unknown>;
  artifactOverrides?: Record<string, unknown>;
  artifactCount?: number;
  corruptArchive?: boolean;
  pullOverrides?: Record<string, unknown>;
}

function closedSourceRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    run_attempt: RUN_ATTEMPT,
    // Ровно то, что площадка отдаёт для закрытого PR: связь потеряна.
    pull_requests: [],
    path: `.github/workflows/${REBASE_SIGNAL_FILE}`,
    repository: { full_name: REPOSITORY },
    event: 'pull_request_target',
    conclusion: 'success',
    actor: { login: ACTOR },
    ...overrides,
  };
}

function rebaseSignal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: REBASE_SIGNAL_SCHEMA,
    sourceRunId: RUN_ID,
    sourceRunAttempt: RUN_ATTEMPT,
    action: 'closed',
    actor: ACTOR,
    prNumber: PR_NUMBER,
    headSha: HEAD_SHA,
    merged: true,
    ...overrides,
  };
}

function mergedPull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: PR_NUMBER,
    head: { sha: HEAD_SHA },
    merged: true,
    merged_at: '2026-08-18T14:07:34Z',
    ...overrides,
  };
}

function zipWith(name: string, content: string, dir: string): string {
  const archive = join(dir, 'artifact.zip');
  const source = join(dir, name);
  writeFileSync(source, content);
  const result = spawnSync('python3', [
    '-c',
    'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w"); z.write(sys.argv[2], sys.argv[3]); z.close()',
    archive,
    source,
    name,
  ], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return archive;
}

function runRebaseAuthentication(scenario: RebaseScenario = {}): ShellResult {
  const fixtures = mkdtempSync(join(tmpdir(), 'dependabot-rebase-fixture-'));
  scratch.push(fixtures);

  const signal = rebaseSignal(scenario.signalOverrides);
  const archive = zipWith(REBASE_SIGNAL_FILENAME, `${JSON.stringify(signal)}\n`, fixtures);
  const digest = `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`;
  if (scenario.corruptArchive === true) {
    // Дайджест объявлен по исходному содержимому, а отдаётся другое: ровно подмена
    // содержимого artifact при верной записи в API.
    zipWith(REBASE_SIGNAL_FILENAME, `${JSON.stringify(rebaseSignal({ prNumber: 999 }))}\n`, fixtures);
  }

  const artifact = {
    id: 4242,
    name: `${REBASE_ARTIFACT_PREFIX}-${RUN_ID}-${RUN_ATTEMPT}`,
    expired: false,
    digest,
    workflow_run: { id: RUN_ID },
    ...scenario.artifactOverrides,
  };
  const count = scenario.artifactCount ?? 1;
  const artifacts = {
    total_count: count,
    artifacts: Array.from({ length: count }, (_, index) => ({ ...artifact, id: artifact.id + index })),
  };

  writeFileSync(join(fixtures, 'run.json'), JSON.stringify(closedSourceRun(scenario.runOverrides)));
  writeFileSync(join(fixtures, 'artifacts.json'), JSON.stringify(artifacts));
  writeFileSync(join(fixtures, 'pull.json'), JSON.stringify(mergedPull(scenario.pullOverrides)));

  const gh = `#!/usr/bin/env bash
set -euo pipefail
printf 'GH %s\\n' "$*" >>"$GH_CALL_LOG"
case "$*" in
  *artifacts/*/zip*) cat "${archive}";;
  *"/artifacts?"*) cat "${join(fixtures, 'artifacts.json')}";;
  *actions/runs/*) cat "${join(fixtures, 'run.json')}";;
  *pulls/*) cat "${join(fixtures, 'pull.json')}";;
  *) printf 'unexpected gh call: %s\\n' "$*" >&2; exit 3;;
esac
`;

  return runStep(stepRun(REBASE_DISPATCH_FILE, 'authenticate', 'source'), {
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: REPOSITORY,
    SOURCE_REPOSITORY: REPOSITORY,
    SOURCE_RUN_ATTEMPT: String(RUN_ATTEMPT),
    SOURCE_RUN_ID: String(RUN_ID),
  }, { gh });
}

describe('живая регрессия: продвижение опознаёт слитый PR без связи run→PR', () => {
  it('аутентифицирует закрытый PR по типизированному artifact, хотя pull_requests пуст', () => {
    const result = runRebaseAuthentication();

    expect(result.status, `dispatcher обязан аутентифицировать слитый PR: ${result.stderr}`).toBe(0);
    expect(outputValue(result.output, 'merged')).toBe('true');
    expect(outputValue(result.output, 'pr-number')).toBe(String(PR_NUMBER));
  });

  it('отвергает artifact с несовпадающим digest', () => {
    const result = runRebaseAuthentication({ corruptArchive: true });

    expect(result.status, 'подмена содержимого artifact обязана быть отказом').not.toBe(0);
    expect(outputValue(result.output, 'merged')).toBeUndefined();
  });

  it('отвергает второй одноимённый artifact', () => {
    const result = runRebaseAuthentication({ artifactCount: 2 });

    expect(result.status).not.toBe(0);
  });

  it('отвергает artifact от другого run', () => {
    const result = runRebaseAuthentication({ artifactOverrides: { workflow_run: { id: RUN_ID + 1 } } });

    expect(result.status).not.toBe(0);
  });

  it('отвергает artifact от другой попытки того же run', () => {
    const result = runRebaseAuthentication({ signalOverrides: { sourceRunAttempt: RUN_ATTEMPT + 1 } });

    expect(result.status).not.toBe(0);
  });

  it('отвергает source run от другого workflow', () => {
    const result = runRebaseAuthentication({
      runOverrides: { path: '.github/workflows/lint.yml' },
    });

    expect(result.status).not.toBe(0);
  });

  it('отвергает source run от другого события', () => {
    const result = runRebaseAuthentication({ runOverrides: { event: 'pull_request' } });

    expect(result.status).not.toBe(0);
  });

  it('отвергает source run с неуспешным исходом', () => {
    const result = runRebaseAuthentication({ runOverrides: { conclusion: 'failure' } });

    expect(result.status).not.toBe(0);
  });

  it('отвергает schema другого сигнала', () => {
    const result = runRebaseAuthentication({
      signalOverrides: { schema: 'dependabot-auto-merge-signal/v1' },
    });

    expect(result.status).not.toBe(0);
  });

  it('отвергает противоречие между artifact и свежим снимком', () => {
    // Artifact утверждает слияние, API его не подтверждает: это несогласованность,
    // а не обычное закрытие, поэтому отказ жёсткий.
    const result = runRebaseAuthentication({ pullOverrides: { merged: false, merged_at: null } });

    expect(result.status, 'противоречие о факте слияния обязано быть отказом').not.toBe(0);
    expect(outputValue(result.output, 'merged')).toBeUndefined();
  });

  it('тихо пропускает согласованное закрытие без слияния', () => {
    // Закрытый без слияния PR — не ошибка автоматизации: продвижение просто не нужно.
    // Отказ здесь красил бы прогон на каждом закрытом PR и обесценивал красный цвет.
    const result = runRebaseAuthentication({
      signalOverrides: { merged: false },
      pullOverrides: { merged: false, merged_at: null },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(outputValue(result.output, 'merged')).toBe('false');
  });

  it('отвергает свежий снимок с другой вершиной, чем в artifact', () => {
    const result = runRebaseAuthentication({ pullOverrides: { head: { sha: 'c'.repeat(40) } } });

    expect(result.status).not.toBe(0);
  });

  it('читает свежий снимок PR из API, а не доверяет artifact на слово', () => {
    const result = runRebaseAuthentication();

    expect(result.calls, 'аутентификация обязана перечитать PR из API').toMatch(
      new RegExp(`pulls/${PR_NUMBER}`),
    );
  });
});

describe('живая регрессия: сигнал продвижения выпускает типизированный artifact', () => {
  it('остаётся read-only и выгружает ровно один типизированный artifact', () => {
    const signal = workflowNamed(REBASE_SIGNAL_FILE);
    const steps = Object.values(signal.jobs).flatMap((job) => job.steps);

    const uploads = steps.filter((step) => /^actions\/upload-artifact@[0-9a-f]{40}$/.test(step.uses ?? ''));
    expect(uploads, 'сигнал обязан выгружать ровно один artifact').toHaveLength(1);
    expect(String(uploads[0].with?.name)).toContain(REBASE_ARTIFACT_PREFIX);
    expect(String(uploads[0].with?.name)).toMatch(/github\.run_id/);
    expect(String(uploads[0].with?.name)).toMatch(/github\.run_attempt/);
    expect(String(uploads[0].with?.['if-no-files-found'])).toBe('error');

    expect(signal.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(steps.some((step) => /^actions\/checkout@/.test(step.uses ?? '')),
      'сигнал не выгружает код PR').toBe(false);

    const body = steps.map((step) => step.run ?? '').join('\n');
    expect(body, 'сигнал обязан записывать схему типизированного artifact').toContain(REBASE_SIGNAL_SCHEMA);
    expect(body, 'сигнал обязан записывать признак слияния').toMatch(/merged/);
  });
});
