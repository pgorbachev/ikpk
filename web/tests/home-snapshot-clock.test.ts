import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as data from '../src/lib/data.js';
import { getCatalogStats, getUpcomingSeminars } from '../src/lib/home.js';
import { startTimeFingerprint } from '../../cms/src/seminar-management/start-time.js';

describe('homepage calendar uses the captured snapshot date', () => {
  beforeEach(() => {
    const source = data.getScheduleEntries()[0];
    const entry = {
      ...source, status: 'active', startAt: '2026-09-21', endAt: '2026-09-21',
      startsAtInstant: '2026-09-21T16:00:00Z', startTimeZone: 'Europe/Moscow',
      startTimeConfirmed: true,
    };
    vi.spyOn(data, 'getScheduleEntries').mockReturnValue([{
      ...entry, startTimeConfirmation: startTimeFingerprint(entry)!,
    }]);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('keeps upcoming events and catalogue counts when the build clock advances past the fixture horizon', () => {
    vi.spyOn(data, 'getSnapshotReferenceDate').mockReturnValue('2026-09-20');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    const upcoming = getUpcomingSeminars();
    const stats = getCatalogStats();
    expect(upcoming.length).toBeGreaterThan(0);
    expect(stats.dates).toBeGreaterThan(0);

    vi.setSystemTime(new Date('2035-01-01T12:00:00Z'));
    expect(getUpcomingSeminars()).toEqual(upcoming);
    expect(getCatalogStats()).toEqual(stats);
  });

  it('orders offers by their exact start even within the same calendar day', () => {
    const source = data.getScheduleEntries()[0];
    vi.mocked(data.getScheduleEntries).mockReturnValue([
      { ...source, id: 1, startsAtInstant: '2026-09-21T18:00:00Z' },
      { ...source, id: 2, startsAtInstant: '2026-09-21T16:00:00Z' },
    ].map((entry) => ({ ...entry, startTimeConfirmation: startTimeFingerprint(entry)! })));
    expect(getUpcomingSeminars(3, new Date('2026-09-21T12:00:00Z')).map((event) => event.id)).toEqual([2, 1]);
  });

  it('still accepts an explicit calendar date for callers inspecting another day', () => {
    vi.spyOn(data, 'getSnapshotReferenceDate').mockReturnValue('2026-09-20');
    const future = new Date('2035-01-01T12:00:00Z');
    expect(getUpcomingSeminars(3, future)).toEqual([]);
    expect(getCatalogStats(future).dates).toBe(0);
  });

});
