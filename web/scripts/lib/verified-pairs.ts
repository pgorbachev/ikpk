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

/** Добавляет или заменяет пару с тем же commit+snapshotId. */
export function upsertVerifiedPair(pairs: VerifiedPair[], next: VerifiedPair): VerifiedPair[] {
  const without = pairs.filter(
    (p) => !(p.commit === next.commit && p.snapshotId === next.snapshotId),
  );
  return [...without, next];
}
