import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { VerifiedPair, PublicationRecord } from './publish-gate.ts';

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
  const previous = readVerifiedPairs(storeDir);
  const next = mergeVerifiedPairs([], pairs);
  const previousPublications = previous.filter((record) => (record as Partial<PublicationRecord>).publicationId);
  const nextPublications = next.filter((record) => (record as Partial<PublicationRecord>).publicationId);
  if (!isDeepStrictEqual(previousPublications, nextPublications.slice(0, previousPublications.length))) {
    throw new Error('publication-history-is-immutable:append-only-order');
  }
  mkdirSync(storeDir, { recursive: true });
  const target = join(storeDir, VERIFIED_PAIRS_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}

function pairKey(pair: VerifiedPair): string {
  const publicationId = (pair as Partial<PublicationRecord>).publicationId;
  return publicationId ? `publication:${publicationId}` : `legacy:${pair.commit}\0${pair.snapshotId}`;
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
 * Слияние публикаций по неизменяемому publicationId; старый кэш пар сохраняет прежний ключ.
 * Запоздавший прогон SHALL NOT выкинуть более новую пару из чужого индекса.
 */
export function mergeVerifiedPairs(left: VerifiedPair[], right: VerifiedPair[]): VerifiedPair[] {
  const map = new Map<string, VerifiedPair>();
  for (const pair of [...left, ...right]) {
    const key = pairKey(pair);
    const prev = map.get(key);
    if (key.startsWith('publication:')) {
      if (prev && !isDeepStrictEqual(prev, pair)) throw new Error(`publication-history-conflict:${key}`);
      if (!prev) map.set(key, pair);
    } else {
      map.set(key, prev ? newerVerifiedPair(prev, pair) : pair);
    }
  }
  return [...map.values()];
}

/** Добавляет запись; повтор того же publicationId допустим только побайтово равным по данным. */
export function upsertVerifiedPair(pairs: VerifiedPair[], next: VerifiedPair): VerifiedPair[] {
  return mergeVerifiedPairs(pairs, [next]);
}
