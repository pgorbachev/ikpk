import { readFileSync } from 'node:fs';
import {
  checkLintCoverage,
  checkPlatformEntries,
  checkRuntimeAuditScope,
  checkTestExecution,
  type AcceptedPlatformLoss,
  type GateResult,
} from './lib/dependency-update-gates';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing required option ${name}`);
  return process.argv[index + 1];
}

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function options(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function readReport(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} report ${path} is not readable: ${String(error)}`, { cause: error });
  }
}

function integerOption(name: string, fallback?: number): number {
  const raw = optional(name);
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function jsonFile(path: string, label: string): unknown {
  const source = readReport(path, label);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} report ${path} is not valid JSON`, { cause: error });
  }
}

function combineReports(runner: 'vitest' | 'playwright', paths: string[], label: string): unknown {
  if (paths.length === 0) throw new Error(`${label} report is required`);
  if (runner === 'vitest') {
    return paths.reduce(
      (sum, path) => {
        const report = jsonFile(path, label) as Record<string, unknown>;
        for (const key of ['numPassedTests', 'numFailedTests', 'numPendingTests'] as const) {
          if (!Number.isInteger(report[key])) throw new Error(`${label} report ${path} misses ${key}`);
          sum[key] += report[key] as number;
        }
        return sum;
      },
      { numPassedTests: 0, numFailedTests: 0, numPendingTests: 0 },
    );
  }
  return paths.reduce(
    (sum, path) => {
      const report = jsonFile(path, label) as { stats?: Record<string, unknown> };
      for (const key of ['expected', 'unexpected', 'flaky', 'skipped'] as const) {
        if (!Number.isInteger(report.stats?.[key])) throw new Error(`${label} report ${path} misses stats.${key}`);
        sum.stats[key] += report.stats![key] as number;
      }
      return sum;
    },
    { stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } },
  );
}

function emit(result: GateResult): void {
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${result.message}\n`);
  if (!result.ok) process.exitCode = 1;
}

function main(): void {
  const command = process.argv[2];
  const packageName = optional('--package');
  if (packageName && !['web', 'cms', 'scripts'].includes(packageName)) throw new Error(`unknown package: ${packageName}`);

  if (command === 'runtime-audit-scope') {
    emit(checkRuntimeAuditScope({
      packageName: option('--package') as 'web' | 'cms' | 'scripts',
      base: {
        exitCode: integerOption('--base-exit', 0),
        reportJson: readReport(option('--base-report'), 'base'),
      },
      head: {
        exitCode: integerOption('--head-exit', 0),
        reportJson: readReport(option('--head-report'), 'head'),
      },
    }));
    return;
  }

  if (command === 'lint-coverage') {
    const baseReport = optional('--base-report');
    emit(checkLintCoverage({
      packageName: option('--package') as 'web' | 'cms' | 'scripts',
      threshold: integerOption('--threshold'),
      changedFiles: options('--changed-file'),
      head: {
        exitCode: integerOption('--head-exit', 0),
        reportJson: readReport(option('--head-report'), 'head'),
      },
      base: baseReport ? {
        exitCode: integerOption('--base-exit', 0),
        reportJson: readReport(baseReport, 'base'),
      } : undefined,
    }));
    return;
  }

  if (command === 'platform-entries') {
    const baseAccepted = optional('--base-accepted');
    const headAccepted = optional('--head-accepted');
    emit(checkPlatformEntries({
      baseLockfile: jsonFile(option('--base-lockfile'), 'base lockfile'),
      headLockfile: jsonFile(option('--head-lockfile'), 'head lockfile'),
      baseAcceptedLosses: baseAccepted
        ? jsonFile(baseAccepted, 'base accepted losses') as AcceptedPlatformLoss[]
        : [],
      headAcceptedLosses: headAccepted
        ? jsonFile(headAccepted, 'head accepted losses') as AcceptedPlatformLoss[]
        : [],
    }));
    return;
  }

  if (command === 'test-count') {
    const runner = option('--runner');
    if (runner !== 'vitest' && runner !== 'playwright') throw new Error(`unknown test runner: ${runner}`);
    const baseReports = options('--base-report');
    emit(checkTestExecution({
      runner,
      threshold: integerOption('--threshold'),
      changedFiles: options('--changed-file'),
      headReport: combineReports(runner, options('--head-report'), 'head'),
      baseReport: baseReports.length > 0 ? combineReports(runner, baseReports, 'base') : undefined,
    }));
    return;
  }

  throw new Error(`unknown dependency gate command: ${command ?? '(none)'}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
