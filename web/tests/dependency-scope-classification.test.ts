import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDependencyUpdateGates } from './helpers/dependency-update-gates-contract';

// Классификация scope живёт в bash внутри workflow, а решение «нужен ли базовый отчёт»
// принимает скрипт гейта. Это ДВА разных определения «изменение только по зависимостям»,
// и разойтись они могут молча: валидацией такое не ловится, а падает потом на main.
//
// Замерено: джоб «Dependency update invariants» красен на вершине `36b58cec` с 08.09.2026 —
// она («bump tsx in /scripts») трогает только package.json/package-lock.json, скрипт считает
// это base-comparison scope и требует базовый отчёт, а workflow его не передаёт, потому что
// свой `dependency_only` вычисляет ТОЛЬКО при непустом PR_BASE_SHA (у push в main его нет).
//
// Две оговорки, без которых число вводит в заблуждение. Первая: сам main красен и раньше,
// с 06.09 — этим расхождением объясняется ОДИН из двух падающих джобов, второй (TD-63,
// «наблюдатель снаружи») к нему отношения не имеет и после этой правки main зелёным не
// станет. Вторая: прогоны на этой вершине — событие `schedule`, push-прогона у неё нет
// вовсе, потому что автомерж Dependabot событий push не порождает.
//
// Поэтому проверка гоняет НАСТОЯЩИЙ фрагмент из workflow, а не его пересказ: пересказ
// разойдётся с оригиналом той же тихой дорогой.

const ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'test.yml');

interface Step { name?: string; run?: string }
interface Job { name?: string; steps?: Step[] }

function classifyScopeScript(): string {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as { jobs?: Record<string, Job> };
  const jobs = Object.values(workflow.jobs ?? {});
  const job = jobs.find((candidate) => candidate.name === 'Dependency update invariants');
  if (!job) throw new Error('в test.yml нет джоба «Dependency update invariants»');
  const step = (job.steps ?? []).find((candidate) => candidate.name === 'Classify dependency update scope');
  if (!step?.run) throw new Error('в джобе нет шага «Classify dependency update scope» с run');
  return step.run;
}

const workspaces: string[] = [];

/** Репозиторий с двумя коммитами: вершина меняет ровно перечисленные файлы. */
function repoWithTipTouching(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dep-scope-'));
  workspaces.push(dir);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  const write = (relative: string, body: string): void => {
    mkdirSync(join(dir, relative, '..'), { recursive: true });
    writeFileSync(join(dir, relative), body);
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  // Базовый коммит: и манифесты, и обычный исходник — чтобы «только зависимости»
  // отличалось от «всё подряд» не отсутствием файлов, а составом изменения.
  for (const seed of ['web/package.json', 'web/package-lock.json', 'web/src/app.ts']) {
    write(seed, seed.endsWith('.json') ? '{"v":1}\n' : 'export const v = 1;\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'base');

  for (const file of files) write(file, file.endsWith('.json') ? '{"v":2}\n' : 'export const v = 2;\n');
  git('add', '-A');
  git('commit', '-qm', 'tip');
  return dir;
}

/** Прогон настоящего фрагмента workflow как при push в main: PR_BASE_SHA пуст. */
function classifyOnPush(repo: string): Record<string, string> {
  const runnerTemp = mkdtempSync(join(tmpdir(), 'dep-scope-runner-'));
  workspaces.push(runnerTemp);
  const githubOutput = join(runnerTemp, 'github-output');
  writeFileSync(githubOutput, '');

  execFileSync('bash', ['-c', classifyScopeScript()], {
    cwd: repo,
    stdio: 'pipe',
    env: { ...process.env, PR_BASE_SHA: '', RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: githubOutput },
  });

  const parsed: Record<string, string> = {};
  for (const line of readFileSync(githubOutput, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) parsed[line.slice(0, at)] = line.slice(at + 1);
  }
  parsed.changedFiles = readFileSync(join(runnerTemp, 'dependency-changed-files.txt'), 'utf8');
  return parsed;
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe('классификация scope обновления зависимостей', () => {
  it('push в main с изменением только манифестов помечается dependency_only', () => {
    const repo = repoWithTipTouching(['web/package.json', 'web/package-lock.json']);
    const out = classifyOnPush(repo);

    expect(out.changedFiles.trim().split('\n').sort()).toEqual(['web/package-lock.json', 'web/package.json']);
    expect(
      out.dependency_only,
      'вершина трогает только манифесты, но workflow не признал изменение зависимостным — ' +
        'значит базовый отчёт lint не будет передан, а скрипт гейта его потребует',
    ).toBe('true');
  });

  it('вердикт workflow совпадает с предикатом самого гейта — на обоих составах изменения', async () => {
    const { isDependencyOnlyChange } = await loadDependencyUpdateGates();

    for (const files of [
      ['web/package.json', 'web/package-lock.json'],
      ['web/package.json', 'web/src/app.ts'],
    ]) {
      const out = classifyOnPush(repoWithTipTouching(files));
      const changed = out.changedFiles.split('\n').filter(Boolean);
      expect(
        out.dependency_only === 'true',
        `workflow и гейт разошлись на составе ${files.join(', ')}: ` +
          `workflow=${out.dependency_only}, гейт=${isDependencyOnlyChange(changed)}`,
      ).toBe(isDependencyOnlyChange(changed));
    }
  });
});
