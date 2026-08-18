export interface GateResult {
  ok: boolean;
  message: string;
  headCount?: number;
  baseCount?: number;
  missingTuples?: string[];
  staleAllowances?: string[];
}

export interface LintCoverageInput {
  packageName: 'web' | 'cms' | 'scripts';
  threshold: number;
  changedFiles: string[];
  head: { exitCode: number; reportJson: string };
  base?: { exitCode: number; reportJson: string };
}

export interface PlatformTuple {
  packageName: string;
  os: string;
  cpu: string;
  libc: string;
}

export interface AcceptedPlatformLoss extends PlatformTuple {
  reason: string;
}

export interface PlatformEntriesInput {
  baseLockfile: unknown;
  headLockfile: unknown;
  baseAcceptedLosses?: AcceptedPlatformLoss[];
  headAcceptedLosses?: AcceptedPlatformLoss[];
}

export interface TestExecutionInput {
  runner: 'vitest' | 'playwright';
  threshold: number;
  changedFiles: string[];
  headReport: unknown;
  baseReport?: unknown;
}

export interface RuntimeAuditScopeInput {
  packageName: 'web' | 'cms' | 'scripts';
  baseManifest: unknown;
  headManifest: unknown;
  base: { exitCode: number; reportJson: string };
  head: { exitCode: number; reportJson: string };
}

export interface PublishedHeadInput {
  mainHeadSha: string;
  mainHeadCreatedAt: string;
  publishedSha: string | null;
  now: string;
  maxLagMs: number;
  cancelledIntermediateShas?: string[];
}

const DEPENDENCY_FILE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json)$/;

export function isDependencyOnlyChange(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every((file) => DEPENDENCY_FILE.test(file));
}

function failure(message: string, details: Omit<GateResult, 'ok' | 'message'> = {}): GateResult {
  return { ok: false, message, ...details };
}

function parseLintCount(measurement: { exitCode: number; reportJson: string }, label: string): GateResult {
  if (measurement.exitCode !== 0) {
    return failure(`${label}: lint завершился с кодом ${measurement.exitCode}; покрытие не измерено`);
  }

  let report: unknown;
  try {
    report = JSON.parse(measurement.reportJson);
  } catch {
    return failure(`${label}: отчёт lint не является JSON; покрытие не измерено`);
  }

  if (!Array.isArray(report) || report.length === 0) {
    return failure(`${label}: отчёт lint пуст; покрытие не измерено`);
  }

  if (!report.every((entry) =>
    entry && typeof entry === 'object' &&
    typeof (entry as { filePath?: unknown }).filePath === 'string' &&
    Boolean((entry as { filePath: string }).filePath)
  )) {
    return failure(`${label}: отчёт lint имеет неизвестный формат; покрытие не измерено`);
  }

  const paths = report.map((entry) => (entry as { filePath: string }).filePath);
  if (new Set(paths).size !== paths.length) {
    return failure(`${label}: отчёт lint содержит повторяющиеся файлы; покрытие не измерено`);
  }

  return { ok: true, message: `${label}: lint проанализировал ${report.length} файлов`, headCount: report.length };
}

export function checkLintCoverage(input: LintCoverageInput): GateResult {
  const head = parseLintCount(input.head, input.packageName);
  if (!head.ok) return head;

  const headCount = head.headCount!;
  if (!Number.isInteger(input.threshold) || input.threshold <= 0) {
    return failure(`${input.packageName}: порог lint не задан корректно`, { headCount });
  }
  if (headCount < input.threshold) {
    return failure(
      `${input.packageName}: lint проанализировал ${headCount} файлов, ниже порога ${input.threshold}`,
      { headCount },
    );
  }

  if (!isDependencyOnlyChange(input.changedFiles)) {
    return { ok: true, message: `${input.packageName}: lint ${headCount} >= ${input.threshold}`, headCount };
  }
  if (!input.base) {
    return failure(`${input.packageName}: для dependency-only PR отсутствует базовый отчёт lint`, { headCount });
  }

  const base = parseLintCount(input.base, `${input.packageName} base`);
  if (!base.ok) return failure(base.message, { headCount });
  const baseCount = base.headCount!;
  if (headCount < baseCount) {
    return failure(
      `${input.packageName}: покрытие lint сократилось с ${baseCount} до ${headCount} файлов`,
      { headCount, baseCount },
    );
  }
  return {
    ok: true,
    message: `${input.packageName}: lint ${headCount} >= base ${baseCount} и threshold ${input.threshold}`,
    headCount,
    baseCount,
  };
}

type LockfileEntry = {
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
};

function dimension(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [''];
  const values = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return values.length > 0 ? values : [''];
}

function tupleKey(tuple: PlatformTuple): string {
  return `${tuple.packageName}|${tuple.os}|${tuple.cpu}|${tuple.libc}`;
}

function platformTuples(lockfile: unknown): Set<string> {
  if (!lockfile || typeof lockfile !== 'object' || !('packages' in lockfile)) return new Set();
  const packages = (lockfile as { packages?: unknown }).packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return new Set();

  const tuples = new Set<string>();
  for (const [path, rawEntry] of Object.entries(packages)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as LockfileEntry;
    if (!Array.isArray(entry.os) && !Array.isArray(entry.cpu) && !Array.isArray(entry.libc)) continue;

    const marker = 'node_modules/';
    const offset = path.lastIndexOf(marker);
    if (offset < 0) continue;
    const packageName = path.slice(offset + marker.length);
    if (!packageName) continue;

    for (const os of dimension(entry.os)) {
      for (const cpu of dimension(entry.cpu)) {
        for (const libc of dimension(entry.libc)) {
          tuples.add(tupleKey({ packageName, os, cpu, libc }));
        }
      }
    }
  }
  return tuples;
}

function acceptedLossMap(losses: AcceptedPlatformLoss[]): Map<string, AcceptedPlatformLoss> | null {
  const result = new Map<string, AcceptedPlatformLoss>();
  for (const loss of losses) {
    if (
      !loss ||
      typeof loss.packageName !== 'string' || !loss.packageName ||
      typeof loss.os !== 'string' ||
      typeof loss.cpu !== 'string' ||
      typeof loss.libc !== 'string' ||
      typeof loss.reason !== 'string' || !loss.reason.trim() ||
      [loss.packageName, loss.os, loss.cpu, loss.libc].some((part) => part.includes('*'))
    ) return null;
    result.set(tupleKey(loss), loss);
  }
  return result;
}

export function checkPlatformEntries(input: PlatformEntriesInput): GateResult {
  const base = platformTuples(input.baseLockfile);
  const head = platformTuples(input.headLockfile);
  if (base.size === 0 || head.size === 0) {
    return failure(
      `platform metadata не измерены: base=${base.size} tuple(s), head=${head.size} tuple(s)`,
    );
  }

  const baseAccepted = acceptedLossMap(input.baseAcceptedLosses ?? []);
  const headAccepted = acceptedLossMap(input.headAcceptedLosses ?? []);
  if (!baseAccepted || !headAccepted) {
    return failure('запись принятой platform-потери должна содержать точный кортеж и непустую причину');
  }

  const staleAllowances = [...headAccepted.keys()].filter((key) => head.has(key)).sort();
  if (staleAllowances.length > 0) {
    return failure(
      `устаревшие записи принятых потерь нужно убрать: ${staleAllowances.join(', ')}`,
      { staleAllowances },
    );
  }

  const missing = [...base].filter((key) => !head.has(key)).sort();
  const unauthorized = missing.filter((key) => !headAccepted.has(key) || baseAccepted.has(key));
  if (unauthorized.length > 0) {
    return failure(`потеряны platform tuples: ${unauthorized.join(', ')}`, { missingTuples: unauthorized });
  }

  return {
    ok: true,
    message: `platform tuples сохранены: base=${base.size}, head=${head.size}, accepted=${missing.length}`,
    missingTuples: [],
  };
}

function executedTestCount(runner: TestExecutionInput['runner'], report: unknown): number | null {
  if (!report || typeof report !== 'object') return null;
  if (runner === 'vitest') {
    const value = report as { numPassedTests?: unknown; numFailedTests?: unknown };
    if (
      !Number.isInteger(value.numPassedTests) || !Number.isInteger(value.numFailedTests) ||
      (value.numPassedTests as number) < 0 || (value.numFailedTests as number) < 0
    ) return null;
    return (value.numPassedTests as number) + (value.numFailedTests as number);
  }

  const stats = (report as { stats?: unknown }).stats;
  if (!stats || typeof stats !== 'object') return null;
  const value = stats as { expected?: unknown; unexpected?: unknown; flaky?: unknown };
  if (
    ![value.expected, value.unexpected, value.flaky].every(Number.isInteger) ||
    [value.expected, value.unexpected, value.flaky].some((count) => (count as number) < 0)
  ) return null;
  return (value.expected as number) + (value.unexpected as number) + (value.flaky as number);
}

export function checkTestExecution(input: TestExecutionInput): GateResult {
  const headCount = executedTestCount(input.runner, input.headReport);
  if (headCount === null) return failure(`${input.runner}: машинный отчёт тестов отсутствует или неразбираем`);
  if (!Number.isInteger(input.threshold) || input.threshold <= 0) {
    return failure(`${input.runner}: порог выполненных тестов не задан корректно`, { headCount });
  }
  if (headCount < input.threshold) {
    return failure(`${input.runner}: выполнено ${headCount} тестов, ниже порога ${input.threshold}`, { headCount });
  }

  if (!isDependencyOnlyChange(input.changedFiles)) {
    return { ok: true, message: `${input.runner}: выполнено ${headCount} тестов`, headCount };
  }
  const baseCount = executedTestCount(input.runner, input.baseReport);
  if (baseCount === null) {
    return failure(`${input.runner}: базовый машинный отчёт тестов отсутствует или неразбираем`, { headCount });
  }
  if (headCount < baseCount) {
    return failure(`${input.runner}: число выполненных тестов сократилось с ${baseCount} до ${headCount}`, {
      headCount,
      baseCount,
    });
  }
  return {
    ok: true,
    message: `${input.runner}: выполнено ${headCount} тестов, base=${baseCount}`,
    headCount,
    baseCount,
  };
}

function runtimeTreeCount(measurement: { exitCode: number; reportJson: string }, label: string): GateResult {
  if (measurement.exitCode !== 0) {
    return failure(`${label}: runtime audit measurement завершился с кодом ${measurement.exitCode}`);
  }
  let report: unknown;
  try {
    report = JSON.parse(measurement.reportJson);
  } catch {
    return failure(`${label}: runtime audit report отсутствует или не является JSON`);
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return failure(`${label}: runtime audit report имеет неизвестный формат`);
  }

  let count = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (!('dependencies' in node)) return;
    const dependencies = (node as { dependencies?: unknown }).dependencies;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      count = -1;
      return;
    }
    for (const dependency of Object.values(dependencies)) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
        count = -1;
        return;
      }
      count += 1;
      visit(dependency);
      if (count < 0) return;
    }
  };
  visit(report);
  if (count < 0) return failure(`${label}: runtime audit report содержит повреждённый dependency node`);
  if (count === 0) return failure(`${label}: runtime audit scope пуст; измерение не выполнено`);
  return { ok: true, message: `${label}: runtime audit scope=${count}`, headCount: count };
}

export function checkRuntimeAuditScope(input: RuntimeAuditScopeInput): GateResult {
  const base = runtimeTreeCount(input.base, `${input.packageName} base`);
  if (!base.ok) return base;
  const head = runtimeTreeCount(input.head, `${input.packageName} head`);
  if (!head.ok) return head;
  const baseCount = base.headCount!;
  const headCount = head.headCount!;

  const dependencies = (manifest: unknown, section: 'dependencies' | 'devDependencies'): Set<string> | null => {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    const value = (manifest as Record<string, unknown>)[section];
    if (value === undefined) return new Set();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return new Set(Object.keys(value));
  };
  const baseRuntime = dependencies(input.baseManifest, 'dependencies');
  const headRuntime = dependencies(input.headManifest, 'dependencies');
  const headDevelopment = dependencies(input.headManifest, 'devDependencies');
  if (!baseRuntime || !headRuntime || !headDevelopment) {
    return failure(`${input.packageName}: manifests для runtime audit отсутствуют или повреждены`, {
      baseCount,
      headCount,
    });
  }
  const movedToDevelopment = [...baseRuntime]
    .filter((name) => !headRuntime.has(name) && headDevelopment.has(name))
    .sort();

  if (movedToDevelopment.length > 0 && headCount < baseCount) {
    return failure(
      `${input.packageName}: runtime audit scope сократился с ${baseCount} до ${headCount} после переноса ${movedToDevelopment.join(', ')} в devDependencies`,
      { baseCount, headCount },
    );
  }
  return {
    ok: true,
    message: movedToDevelopment.length > 0
      ? `${input.packageName}: runtime audit scope ${headCount} >= base ${baseCount} после переноса ${movedToDevelopment.join(', ')}`
      : `${input.packageName}: переносов dependencies -> devDependencies нет; scope base=${baseCount}, head=${headCount}`,
    baseCount,
    headCount,
  };
}

export function checkPublishedHead(input: PublishedHeadInput): GateResult {
  if (!/^[0-9a-f]{40}$/i.test(input.mainHeadSha)) return failure('не удалось определить SHA вершины main');
  if (input.publishedSha === input.mainHeadSha) {
    return { ok: true, message: `вершина main ${input.mainHeadSha} опубликована` };
  }
  if (!Number.isFinite(input.maxLagMs) || input.maxLagMs <= 0) {
    return failure('допустимое отставание публикации не задано');
  }
  const headCreatedAt = Date.parse(input.mainHeadCreatedAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(headCreatedAt) || !Number.isFinite(now) || now < headCreatedAt) {
    return failure('не удалось измерить возраст вершины main');
  }
  const lag = now - headCreatedAt;
  if (lag <= input.maxLagMs) {
    return {
      ok: true,
      message: `вершина main ${input.mainHeadSha} ещё в допустимом окне публикации (${lag} ms)`,
    };
  }
  return failure(
    `вершина main ${input.mainHeadSha} не опубликована ${lag} ms; опубликован ${input.publishedSha ?? 'none'}`,
  );
}
