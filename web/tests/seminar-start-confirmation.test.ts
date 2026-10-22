import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyStartTimeConfirmation, startTimeFingerprint, startTimePublicationError,
} from '../../cms/src/seminar-management/start-time';
import { validateSnapshotContract } from '../scripts/lib/content-contract';
import { isLegacyPinnedSchedule, seminarStartReport } from '../scripts/lib/seminar-start-contract';
import { FIELD_MAP } from '../scripts/lib/content-field-map';
import type { JournalSnapshot, Snapshot } from '../scripts/lib/content-snapshot';

const entry = () => {
  const row = { id: '22', startAt: '2026-10-22T00:00:00.000Z', endAt: '2026-10-22T00:00:00.000Z',
    startsAtInstant: '2026-10-22T16:00:00.000Z', startTimeZone: 'Europe/Moscow',
    status: 'active', entry_status: 'active', startTimeConfirmed: true, startTimeConfirmation: '' };
  row.startTimeConfirmation = startTimeFingerprint(row)!;
  return row;
};
const snapshot = (rows: Record<string, unknown>[]): Snapshot => ({
  referenceDate: '2026-10-22', content: { types: { schedule_entries: rows }, media: [] },
});

describe('durable start-time confirmation', () => {
  it.each([
    ['calendar date', { startAt: '2026-10-23T00:00:00.000Z' }],
    ['hour within the same day', { startsAtInstant: '2026-10-22T17:00:00.000Z' }],
    ['zone with the same local date', { startTimeZone: 'Europe/Nicosia' }],
  ])('invalidates %s even with the old checked box in the write', (_name, patch) => {
    const old = entry();
    const data: Record<string, unknown> = { ...patch, startTimeConfirmed: true, startTimeConfirmation: old.startTimeConfirmation };
    applyStartTimeConfirmation(data, old);
    expect(data.startTimeConfirmed).toBe(false);
    expect(data.startTimeConfirmation).toBeNull();
    expect(startTimePublicationError({ ...old, ...data }, '2026-10-22')).not.toBeNull();
  });

  it('requires a separate confirmation save after a same-day hour edit', () => {
    const old = entry();
    const patch: Record<string, unknown> = { startsAtInstant: '2026-10-22T17:00:00.000Z', startTimeConfirmed: true };
    applyStartTimeConfirmation(patch, old);
    const saved = { ...old, ...patch };
    const confirm: Record<string, unknown> = { startTimeConfirmed: true };
    applyStartTimeConfirmation(confirm, saved);
    expect(confirm.startTimeConfirmation).not.toBe(old.startTimeConfirmation);
    expect(startTimePublicationError({ ...saved, ...confirm }, '2026-10-22')).toBeNull();
    expect(saved.startAt).toBe(saved.endAt);
  });

  it('preserves confirmation on unrelated edits and refuses incoming forged proof', () => {
    const old = entry();
    const unrelated = { city: 'Москва' };
    applyStartTimeConfirmation(unrelated, old);
    expect(startTimePublicationError({ ...old, ...unrelated }, '2026-10-22')).toBeNull();
    const forged: Record<string, unknown> = { startTimeConfirmation: old.startTimeConfirmation };
    applyStartTimeConfirmation(forged, { ...old, startTimeConfirmed: false, startTimeConfirmation: null });
    expect(forged.startTimeConfirmation).toBeNull();
  });

  it.each([
    { startsAtInstant: '2026-02-30T16:00:00Z' },
    { startAt: '2026-02-30' },
    { startsAtInstant: '2026-10-22T16:00:00' },
    { startTimeZone: '+03:00' },
    { startTimeZone: 'Mars/Moon' },
  ])('cannot confirm invalid input %j', (patch) => {
    const data = { ...entry(), ...patch };
    applyStartTimeConfirmation(data, null);
    expect(data.startTimeConfirmed).toBe(false);
    expect(startTimePublicationError(data, '2026-01-01')).not.toBeNull();
  });

  it('rejects stale proof even when all dates still agree', () => {
    expect(validateSnapshotContract(snapshot([{ ...entry(), startsAtInstant: '2026-10-22T17:00:00.000Z' }])).ok).toBe(false);
    expect(validateSnapshotContract(snapshot([{ ...entry(), startTimeZone: 'Europe/Nicosia' }])).ok).toBe(false);
  });

  it('reports active today/future and undated entries, excluding historical and inactive entries', () => {
    const records = [
      { ...entry(), id: 'today', startTimeConfirmed: false },
      { ...entry(), id: 'future', startAt: '2026-10-23' },
      { ...entry(), id: 'undated', startAt: null },
      { ...entry(), id: 'past', startAt: '2026-10-21', startTimeConfirmed: false },
      { ...entry(), id: 'cancelled', entry_status: 'cancelled', startTimeConfirmed: false },
    ];
    expect(seminarStartReport(snapshot(records)).map((issue) => issue.recordId)).toEqual(['today', 'future', 'undated']);
  });

  it('maps every confirmation field into live snapshots', () => {
    for (const field of ['startsAtInstant', 'startTimeZone', 'startTimeConfirmed', 'startTimeConfirmation']) {
      expect(FIELD_MAP).toContainEqual({ type: 'schedule_entries', field, source: field });
    }
  });

  it('bounds the historical exception to the exact old local schedule and rejects it as live', () => {
    const pinned = JSON.parse(readFileSync(new URL('../../fixtures/content-snapshot/snapshot.json', import.meta.url), 'utf8')) as JournalSnapshot;
    expect(isLegacyPinnedSchedule(pinned)).toBe(true);
    expect(validateSnapshotContract(pinned).ok).toBe(true);
    expect(seminarStartReport(pinned).length).toBeGreaterThan(0);
    const live = { ...pinned, origin: { kind: 'live' as const } };
    expect(isLegacyPinnedSchedule(live)).toBe(false);
    expect(validateSnapshotContract(live).ok).toBe(false);
    const changed = structuredClone(pinned);
    changed.content.types.schedule_entries[0].startAt = '2026-12-01';
    expect(isLegacyPinnedSchedule(changed)).toBe(false);
    expect(validateSnapshotContract(changed).ok).toBe(false);
  });
});

