/**
 * Test-owned lockfile subtree walk. Не считает пустой runtime-список «нет overlap».
 */
import { readFileSync } from 'node:fs';
import { PACKAGE_LOCK } from './paths.js';

interface Lockfile {
  packages?: Record<string, { name?: string; dependencies?: Record<string, string>; dev?: boolean }>;
}

export function loadLockfile(path = PACKAGE_LOCK): Lockfile {
  return JSON.parse(readFileSync(path, 'utf-8')) as Lockfile;
}

export function packageNodeKeys(lock: Lockfile, packageName: string): string[] {
  const packages = lock.packages ?? {};
  return Object.keys(packages).filter((key) => {
    if (key === `node_modules/${packageName}`) return true;
    if (key.endsWith(`/node_modules/${packageName}`)) return true;
    return packages[key]?.name === packageName;
  });
}

export function subtreePackageNames(lock: Lockfile, roots: string[]): string[] {
  const packages = lock.packages ?? {};
  const names = new Set<string>();
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length) {
    const pkg = queue.pop()!;
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    names.add(pkg);
    for (const key of packageNodeKeys(lock, pkg)) {
      const deps = packages[key]?.dependencies ?? {};
      for (const dep of Object.keys(deps)) queue.push(dep);
    }
  }
  return [...names].sort();
}

export function overlappingParserEngines(runtimePackages: string[], oraclePackages: string[], lock = loadLockfile()): string[] {
  if (runtimePackages.length === 0) {
    throw new Error('runtime sanitizer/parser packages пусты — dependency-graph нечем сверять');
  }
  const runtimeTree = subtreePackageNames(lock, runtimePackages);
  const oracleTree = subtreePackageNames(lock, oraclePackages);
  return runtimeTree.filter((name) => oracleTree.includes(name));
}
