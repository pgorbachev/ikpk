export type CaptureFailureKind =
  | 'unreachable'
  | 'request-failed'
  | 'truncated'
  | 'pagination-gap'
  | 'changed-during-capture'
  | 'mixed-state'
  | 'below-minimum-cardinality'
  | 'unknown-count';

export interface TypeObservation {
  type: string;
  declaredCount: number | null;
  records: Record<string, unknown>[];
  pages?: number[];
  requestFailed?: boolean;
}

export interface CaptureObservation {
  types: TypeObservation[];
  stateAtStart: string;
  stateAtEnd: string;
  reachable?: boolean;
}

export interface CaptureFailure {
  kind: CaptureFailureKind;
  type?: string;
  detail?: string;
}

export const MINIMUM_CARDINALITY: Readonly<Record<string, number>> = {
  institutes: 1,
  programs: 1,
  seminars: 1,
  articles: 1,
  teachers: 1,
  news: 0,
  promos: 0,
};

function paginationGap(pages: number[] | undefined): boolean {
  if (!pages || pages.length === 0) return false;
  const seen = new Set<number>();
  for (const page of pages) {
    if (seen.has(page)) return true;
    seen.add(page);
  }
  const max = Math.max(...pages);
  for (let expected = 1; expected <= max; expected += 1) {
    if (!seen.has(expected)) return true;
  }
  return false;
}

export function assessCapture(observation: CaptureObservation): { ok: boolean; failures: CaptureFailure[] } {
  const failures: CaptureFailure[] = [];

  if (observation.reachable === false) {
    return { ok: false, failures: [{ kind: 'unreachable' }] };
  }

  for (const type of observation.types) {
    if (type.requestFailed) {
      failures.push({ kind: 'request-failed', type: type.type });
      continue;
    }
    if (type.declaredCount === null) {
      failures.push({ kind: 'unknown-count', type: type.type });
    } else if (type.records.length !== type.declaredCount) {
      failures.push({ kind: 'truncated', type: type.type });
    }
    if (paginationGap(type.pages)) {
      failures.push({ kind: 'pagination-gap', type: type.type });
    }
    const minimum = MINIMUM_CARDINALITY[type.type];
    if (minimum !== undefined && type.records.length < minimum) {
      failures.push({ kind: 'below-minimum-cardinality', type: type.type });
    }
  }

  if (observation.stateAtStart !== observation.stateAtEnd) {
    failures.push({ kind: 'changed-during-capture' });
  }

  return { ok: failures.length === 0, failures };
}

export function selectPublished(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter((record) => {
    const publishedAt = record.publishedAt ?? record.published_at;
    if (publishedAt == null || publishedAt === '') return false;
    const unpublishedAt = record.unpublishedAt ?? record.unpublished_at;
    if (unpublishedAt != null && unpublishedAt !== '') return false;
    return true;
  });
}
