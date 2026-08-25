import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PINNED_SNAPSHOT_DIR = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'content-snapshot');

export interface PinnedSnapshot {
  pinned: boolean;
  referenceDate: string;
  fingerprint?: string;
  snapshotId?: string;
  content: { types: Record<string, unknown>; media?: unknown[] };
}

export function loadPinnedSnapshot(): PinnedSnapshot {
  const path = join(PINNED_SNAPSHOT_DIR, 'snapshot.json');
  if (!existsSync(path)) throw new Error(`нет закреплённого снимка ${path}`);
  return JSON.parse(readFileSync(path, 'utf-8')) as PinnedSnapshot;
}

export function loadPinnedType<T>(type: string): T {
  const records = loadPinnedSnapshot().content.types[type];
  if (records === undefined) throw new Error(`в закреплённом снимке нет типа ${type}`);
  return records as T;
}
