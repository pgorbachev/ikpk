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
  return [...new Set(subtreeLockfileNodes(lock, roots).map(packageNameFromNodeKey))].sort();
}

export function packageNameFromNodeKey(key: string): string {
  const idx = key.lastIndexOf('node_modules/');
  return idx >= 0 ? key.slice(idx + 'node_modules/'.length) : key;
}

/** Ключи `packages` из lockfile, а не имена: вложенный дубль того же пакета — другой node. */
export function subtreeLockfileNodes(lock: Lockfile, roots: string[]): string[] {
  const packages = lock.packages ?? {};
  const keys = new Set<string>();
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length) {
    const pkg = queue.pop()!;
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    for (const key of packageNodeKeys(lock, pkg)) {
      keys.add(key);
      const deps = packages[key]?.dependencies ?? {};
      for (const dep of Object.keys(deps)) queue.push(dep);
    }
  }
  return [...keys].sort();
}

export function overlappingParserEngines(runtimePackages: string[], oraclePackages: string[], lock = loadLockfile()): string[] {
  if (runtimePackages.length === 0) {
    throw new Error('runtime sanitizer/parser packages пусты — dependency-graph нечем сверять');
  }
  const runtimeTree = subtreePackageNames(lock, runtimePackages);
  const oracleTree = subtreePackageNames(lock, oraclePackages);
  return runtimeTree.filter((name) => oracleTree.includes(name));
}

/** Fail-closed: committed lockfileNodes обязаны совпасть с живым subtree, а не перезаписываться из него. */
export function assertCommittedLockfileNodes(
  committed: string[] | undefined,
  packages: string[],
  lock = loadLockfile(),
): string[] {
  if (!committed || committed.length === 0) {
    return ['committed lockfileNodes пусты — fail-closed, не строить baseline из текущего lockfile'];
  }
  const live = subtreeLockfileNodes(lock, packages);
  const errors: string[] = [];
  const committedSet = new Set(committed);
  const liveSet = new Set(live);
  for (const node of live) {
    if (!committedSet.has(node)) errors.push(`живой lockfile node не в registry: ${node}`);
  }
  for (const node of committed) {
    if (!liveSet.has(node)) errors.push(`registry node пропал из lockfile: ${node}`);
  }
  return errors;
}
