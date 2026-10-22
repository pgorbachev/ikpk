import type { Snapshot } from './content-snapshot.ts';
import { contentFingerprint } from './content-snapshot.ts';
import { startTimePublicationError } from '../../../cms/src/seminar-management/start-time.ts';

/** Historical local test input only. Content, reference day and provenance are all bounded. */
export function isLegacyPinnedSchedule(snapshot: Snapshot): boolean {
  return snapshot.pinned === true && (!snapshot.origin || snapshot.origin.kind === 'pinned')
    && snapshot.referenceDate === '2026-03-31'
    && !snapshot.content.types.schedule
    && contentFingerprint({ types: { schedule_entries: snapshot.content.types.schedule_entries ?? [] }, media: [] })
      === 'sha256:aafb1d4d3ae668e677d28dcc3435b7c5c0ece74ed4d36bd4a16c8e788b548798';
}

export interface SeminarStartIssue {
  recordId: string;
  name: string;
  startAt: unknown;
  startsAtInstant: unknown;
  startTimeZone: unknown;
  reason: string;
}

/** Explicitly strict: a live capture/report never receives the historical-fixture exception. */
export function seminarStartReport(snapshot: Snapshot): SeminarStartIssue[] {
  const records = snapshot.content.types.schedule ?? snapshot.content.types.schedule_entries ?? [];
  return records.flatMap((entry) => {
    const reason = startTimePublicationError(entry, snapshot.referenceDate);
    return reason ? [{
      recordId: String(entry.id ?? entry.legacy_id ?? entry.documentId ?? ''),
      name: String(entry.name ?? ''), startAt: entry.startAt ?? null,
      startsAtInstant: entry.startsAtInstant ?? null, startTimeZone: entry.startTimeZone ?? null, reason,
    }] : [];
  });
}
