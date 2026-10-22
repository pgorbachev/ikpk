import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTimeFingerprint } from '../../cms/src/seminar-management/start-time';
import * as scheduleWindow from '../src/lib/schedule-window';
import { validateSnapshotContract } from '../scripts/lib/content-contract';
import type { Snapshot } from '../scripts/lib/content-snapshot';

// Approved contract: openspec/changes/seminar-start-visibility.
// Keep legacy calendar boundaries unchanged: one-day imports have startAt=endAt.
const webinar = {
  id: 22, status: 'active', startAt: '2026-10-22T00:00:00.000Z',
  endAt: '2026-10-22T00:00:00.000Z', startsAtInstant: '2026-10-22T16:00:00Z',
  startTimeConfirmed: true, startTimeConfirmation: '',
  startTimeZone: 'Europe/Moscow', additionalText: 'Начало в 19:00',
};
webinar.startTimeConfirmation = startTimeFingerprint(webinar)!;
type Entry = Partial<typeof webinar>;

function beforeStart(entry: Entry, now: string): boolean {
  // Namespace lookup lets RED report the missing contract explicitly instead of
  // failing module collection. No substitute implementation belongs in this test.
  const predicate = (scheduleWindow as Record<string, unknown>).isBeforeStart;
  expect(predicate, 'schedule-window must expose the approved pure isBeforeStart(entry, now) contract')
    .toBeTypeOf('function');
  return (predicate as (entry: Entry, now: string) => boolean)(entry, now);
}

function snapshot(entries: Entry[]): Snapshot {
  return {
    referenceDate: '2026-10-22',
    content: { types: { schedule_entries: entries }, media: [] },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T14:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('seminar exact start boundary', () => {
  it.each([undefined, false])('never offers an instant and zone without explicit confirmation: %s', (startTimeConfirmed) => {
    const entry = { ...webinar, startTimeConfirmed };
    expect(beforeStart(entry, '2026-10-22T15:59:59Z')).toBe(false);
  });

  it.each([
    ['one second before', '2026-10-22T15:59:59Z', true],
    ['one millisecond before', '2026-10-22T15:59:59.999Z', true],
    ['at equality', '2026-10-22T16:00:00Z', false],
    ['one millisecond after', '2026-10-22T16:00:00.001Z', false],
    ['one second after', '2026-10-22T16:00:01Z', false],
  ])('%s with unchanged one-day startAt=endAt', (_label, now, expected) => {
    expect(beforeStart(webinar, now)).toBe(expected);
  });

  it.each(['2026-10-22T19:00:00+03:00', '2026-10-22T09:00:00-07:00'])('compares the instant independently of the visitor offset: %s', (now) => {
      expect(beforeStart(webinar, now)).toBe(false);
      expect(beforeStart({ ...webinar, startsAtInstant: '2026-10-22T19:00:00+03:00' }, now)).toBe(false);
    });

  it('hides a multi-day event from offers on its second day', () => {
    expect(beforeStart({ ...webinar, endAt: '2026-10-25T00:00:00Z' }, '2026-10-23T10:00:00Z')).toBe(false);
  });

  it('keeps the future session of the same seminar when its earlier session starts', () => {
    const sessions = [
      { ...webinar, seminar: { slug: 'same-course' } },
      { ...webinar, id: 23, seminar: { slug: 'same-course' }, startAt: '2026-11-04', endAt: '2026-11-04', startsAtInstant: '2026-11-04T16:00:00Z' },
    ];
    expect(sessions.filter((entry) => beforeStart(entry, '2026-10-22T16:00:00Z')).map((entry) => entry.id))
      .toEqual([23]);
    expect(sessions[0].status, 'visibility must not mutate CMS status').toBe('active');
  });
});

describe('publication rejects unresolved seminar start time', () => {
  it.each(['2026-10-22T00:01:00Z', '2026-10-22T23:59:00Z'])('requires confirmation for today even when legacy midnight is past: %s', (now) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      const legacy: Entry = { ...webinar };
      delete legacy.startsAtInstant;
      delete legacy.startTimeZone;
      const result = validateSnapshotContract(snapshot([legacy]));
      expect(result.ok, 'today\'s midnight placeholder and text are not a confirmed start').toBe(false);
      expect(result.violations.some((violation) => violation.recordId === '22')).toBe(true);
    });

  it.each([
    ['future text-only time', { ...webinar, startAt: '2026-11-04', endAt: '2026-11-04', startsAtInstant: undefined, startTimeZone: undefined }],
    ['missing date', { ...webinar, startAt: undefined, endAt: undefined }],
    ['missing instant', { ...webinar, startsAtInstant: undefined }],
    ['missing zone', { ...webinar, startTimeZone: undefined }],
    ['invalid zone', { ...webinar, startTimeZone: 'Mars/Olympus_Mons' }],
    ['invalid instant', { ...webinar, startsAtInstant: 'not-a-time' }],
    ['instant without explicit offset', { ...webinar, startsAtInstant: '2026-10-22T19:00:00' }],
    ['rescheduled calendar date', { ...webinar, startAt: '2026-10-23', endAt: '2026-10-23' }],
    ['changed instant on another local date', { ...webinar, startsAtInstant: '2026-10-23T16:00:00Z' }],
    ['changed zone makes local date disagree', { ...webinar, startsAtInstant: '2026-10-22T00:30:00Z', startTimeZone: 'America/Los_Angeles' }],
  ])('rejects %s and identifies the record', (_label, entry) => {
    const result = validateSnapshotContract(snapshot([entry]));
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.recordId === '22')).toBe(true);
  });

  it('accepts explicit Moscow time without changing one-day calendar boundaries', () => {
    expect(validateSnapshotContract(snapshot([webinar]))).toEqual({ ok: true, violations: [] });
    expect(webinar.startAt).toBe(webinar.endAt);
  });

  it('validates the displayed normalized date rather than the UTC date prefix', () => {
    const entry = { ...webinar, startAt: '2026-10-21T21:00:00Z', endAt: '2026-10-21T21:00:00Z' };
    expect(scheduleWindow.calendarDay(entry.startAt)).toBe('2026-10-22');
    expect(validateSnapshotContract(snapshot([entry]))).toEqual({ ok: true, violations: [] });
  });
});
