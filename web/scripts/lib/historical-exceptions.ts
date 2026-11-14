import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { contentFingerprint, type HistoricalException, type SnapshotContent } from './content-snapshot.ts';

/** Authority is supplied separately from the snapshot and checked against the exact file. */
export function historicalExceptionsFromEnvironment(): { entries: HistoricalException[]; trustedHistoricalExceptionsFingerprint?: string } {
  const path = process.env.CONTENT_HISTORICAL_EXCEPTIONS_FILE;
  const expected = process.env.CONTENT_HISTORICAL_EXCEPTIONS_SHA256;
  if (!path && !expected) return { entries: [] };
  if (!path || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('historical exception file and external SHA-256 are required together');
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('historical exception file digest mismatch');
  const entries: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(entries)) throw new Error('historical exception registry must be an array');
  return { entries: entries as HistoricalException[], trustedHistoricalExceptionsFingerprint: contentFingerprint({ types: { historicalExceptions: entries }, media: [] }) };
}

/** Only unchanged rows with the specific remaining violation need an exception. */
export function activeHistoricalExceptions(content: SnapshotContent, entries: HistoricalException[]): HistoricalException[] {
  const events = content.types.schedule_entries ?? content.types.schedule ?? [];
  const seminars = content.types.seminars ?? [];
  const nonempty = (value: unknown) => typeof value === 'string' ? value.trim().length > 0 : value != null;
  return entries.filter((entry) => events.some((event) => {
    if (event.documentId !== entry.documentId || event.publishedAt !== entry.publishedAt || event.updatedAt !== entry.updatedAt ||
        contentFingerprint({ types: { schedule_entries: [event] }, media: [] }) !== entry.recordFingerprint) return false;
    if (entry.condition === 'paid-zero-price') {
      const price = Object.hasOwn(event, 'price') ? event.price : event.newPrice;
      return event.isFree === false && price != null && price !== '' && Number(price) === 0;
    }
    if (entry.condition !== 'missing-duration') return false;
    const relation = typeof event.seminar === 'string' ? event.seminar : (event.seminar as { slug?: unknown } | null)?.slug;
    const seminar = seminars.find((row) => row.slug === relation && row.publishedAt !== null);
    return !nonempty(event.duration) && !nonempty(seminar?.duration);
  }));
}

/** Produce review candidates, never an authorization, from an already projected snapshot. */
export function proposeHistoricalExceptions(content: SnapshotContent): HistoricalException[] {
  const events = content.types.schedule_entries ?? content.types.schedule ?? [];
  const candidates: HistoricalException[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (typeof event.documentId !== 'string' || typeof event.publishedAt !== 'string' || typeof event.updatedAt !== 'string') {
      throw new Error('historical audit requires logical identity and publication/update timestamps');
    }
    if (seen.has(event.documentId)) throw new Error('historical audit found duplicate logical occurrences');
    seen.add(event.documentId);
    const recordFingerprint = contentFingerprint({ types: { schedule_entries: [event] }, media: [] });
    for (const condition of ['paid-zero-price', 'missing-duration'] as const) {
      const item: HistoricalException = { documentId: event.documentId, publishedAt: event.publishedAt, updatedAt: event.updatedAt, condition, recordFingerprint };
      if (activeHistoricalExceptions(content, [item]).length) candidates.push(item);
    }
  }
  return candidates;
}

/** The snapshot may contain only a subset of the separately pinned approved file. */
export function trustForHistoricalSnapshot(content: SnapshotContent): { trustedHistoricalExceptionsFingerprint?: string } {
  const source = historicalExceptionsFromEnvironment();
  const entries = content.historicalExceptions ?? [];
  if (!entries.length || !source.trustedHistoricalExceptionsFingerprint) return {};
  const fingerprint = (entry: HistoricalException) => contentFingerprint({ types: { historicalExceptions: [entry as unknown as Record<string, unknown>] }, media: [] });
  const approved = new Set(source.entries.map(fingerprint));
  if (!entries.every((entry) => approved.has(fingerprint(entry)))) throw new Error('snapshot historical exception is not in the approved registry');
  return { trustedHistoricalExceptionsFingerprint: contentFingerprint({ types: { historicalExceptions: entries as unknown as Record<string, unknown>[] }, media: [] }) };
}
