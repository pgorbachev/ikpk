import { createHash } from 'node:crypto';

export interface SnapshotMedia {
  ref: string;
  contentId: string;
}

export interface SnapshotContent {
  types: Record<string, Record<string, unknown>[]>;
  media: SnapshotMedia[];
}

export interface Snapshot {
  content: SnapshotContent;
  referenceDate: string;
  pinned?: boolean;
  fingerprint?: string;
  snapshotId?: string;
  provenance?: {
    observedEntry: number;
    revision: number | null;
    highWaterMark: number;
  };
}

/** Часовой пояс опорной даты живого снимка — задан явно, не наследуется от машины. */
export const REFERENCE_TIMEZONE = 'Europe/Moscow';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortValue(v)]),
    );
  }
  return value;
}

function canonicalContent(content: SnapshotContent): unknown {
  const typeNames = Object.keys(content.types).sort();
  const types = Object.fromEntries(
    typeNames.map((name) => {
      const records = [...content.types[name]].map((record) => sortValue(record));
      records.sort((a, b) => {
        const left = JSON.stringify(a);
        const right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      return [name, records];
    }),
  );
  const media = [...content.media]
    .map((item) => ({ contentId: item.contentId, ref: item.ref }))
    .sort((a, b) => {
      const byId = a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0;
      if (byId !== 0) return byId;
      return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
    });
  return { types, media };
}

export function contentFingerprint(content: SnapshotContent): string {
  const digest = createHash('sha256').update(JSON.stringify(canonicalContent(content))).digest('hex');
  return `sha256:${digest}`;
}

export function snapshotId(input: { fingerprint: string; referenceDate: string }): string {
  const digest = createHash('sha256')
    .update(`${input.fingerprint}\n${input.referenceDate}`)
    .digest('hex');
  return `snap:${digest}`;
}

export function referenceDateOf(snapshot: Snapshot, run: { calendarToday: string }): string {
  if (snapshot.pinned) return snapshot.referenceDate;
  return run.calendarToday;
}
