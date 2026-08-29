import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifiedPair } from './publish-gate.ts';

export const PROVENANCE_BRANCH = 'state/cms-provenance';
export const VERIFIED_PAIRS_FILE = 'verified-pairs.json';

export function readVerifiedPairs(storeDir: string): VerifiedPair[] {
  const path = join(storeDir, VERIFIED_PAIRS_FILE);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`${path}: ожидался массив проверенных пар`);
  }
  return raw as VerifiedPair[];
}

export function writeVerifiedPairs(storeDir: string, pairs: VerifiedPair[]): void {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, VERIFIED_PAIRS_FILE), `${JSON.stringify(pairs, null, 2)}\n`, 'utf-8');
}

function pairKey(pair: VerifiedPair): string {
  return `${pair.commit}\0${pair.snapshotId}`;
}

/** Какая пара «новее» для одного ключа commit+snapshotId (и при слиянии индексов). */
export function newerVerifiedPair(left: VerifiedPair, right: VerifiedPair): VerifiedPair {
  if (left.revision !== right.revision) return left.revision > right.revision ? left : right;
  if (left.referenceDate !== right.referenceDate) {
    return left.referenceDate >= right.referenceDate ? left : right;
  }
  return left.capturedAt >= right.capturedAt ? left : right;
}

/**
 * Слияние двух снимков индекса: объединение по commit+snapshotId без регресса.
 * Запоздавший прогон SHALL NOT выкинуть более новую пару из чужого индекса.
 */
export function mergeVerifiedPairs(left: VerifiedPair[], right: VerifiedPair[]): VerifiedPair[] {
  const map = new Map<string, VerifiedPair>();
  for (const pair of [...left, ...right]) {
    const key = pairKey(pair);
    const prev = map.get(key);
    map.set(key, prev ? newerVerifiedPair(prev, pair) : pair);
  }
  return [...map.values()];
}

/** Добавляет или заменяет пару с тем же commit+snapshotId (через merge, без потери прочих). */
export function upsertVerifiedPair(pairs: VerifiedPair[], next: VerifiedPair): VerifiedPair[] {
  return mergeVerifiedPairs(pairs, [next]);
}
