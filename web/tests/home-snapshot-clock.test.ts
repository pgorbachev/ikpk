import { afterEach, describe, expect, it, vi } from 'vitest';
import * as data from '../src/lib/data.js';
import { getCatalogStats, getUpcomingSeminars } from '../src/lib/home.js';

describe('homepage dated offers use the build clock', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('expires offers even when the snapshot reference date remains old', () => {
    vi.spyOn(data, 'getSnapshotReferenceDate').mockReturnValue('2026-09-20');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    const upcoming = getUpcomingSeminars();
    const stats = getCatalogStats();
    expect(upcoming.length).toBeGreaterThan(0);
    expect(stats.dates).toBeGreaterThan(0);

    vi.setSystemTime(new Date('2035-01-01T12:00:00Z'));
    expect(getUpcomingSeminars()).toEqual([]);
    expect(getCatalogStats().dates).toBe(0);
  });

  it('still accepts an explicit calendar date for callers inspecting another day', () => {
    vi.spyOn(data, 'getSnapshotReferenceDate').mockReturnValue('2026-09-20');
    const future = new Date('2035-01-01T12:00:00Z');
    expect(getUpcomingSeminars(3, future)).toEqual([]);
    expect(getCatalogStats(future).dates).toBe(0);
  });

});
