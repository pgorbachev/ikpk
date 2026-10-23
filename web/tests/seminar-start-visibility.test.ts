import { describe, expect, it } from 'vitest';
import { isBeforeStart } from '../src/lib/schedule-window';

const webinar = {
  id: 389,
  startAt: '2026-10-22T00:00:00.000Z',
  endAt: '2026-10-22T00:00:00.000Z',
  additionalText: 'Начало в 19:00 (московское время)',
};

describe('public offer ends on its start date in Moscow', () => {
  it('keeps a date-only webinar until midnight Moscow time, then hides it', () => {
    expect(isBeforeStart(webinar, '2026-10-21T20:59:59Z')).toBe(true);
    expect(isBeforeStart(webinar, '2026-10-21T21:00:00Z')).toBe(false);
    expect(isBeforeStart(webinar, '2026-10-22T15:00:00Z')).toBe(false);
    expect(isBeforeStart(webinar, '2026-10-23T12:00:00Z')).toBe(false);
  });

  it('does not keep a multi-day seminar in upcoming offers after its first day starts', () => {
    expect(isBeforeStart({ ...webinar, endAt: '2026-10-25T00:00:00Z' }, '2026-10-22T00:00:00Z')).toBe(false);
  });

  it('leaves a later session of the same course available', () => {
    const later = { ...webinar, id: 333, startAt: '2026-10-23T00:00:00Z' };
    expect(isBeforeStart(webinar, '2026-10-22T12:00:00Z')).toBe(false);
    expect(isBeforeStart(later, '2026-10-22T12:00:00Z')).toBe(true);
  });

  it('uses the public Moscow day of a serialized CMS date', () => {
    expect(isBeforeStart({ ...webinar, startAt: '2026-10-21T21:00:00Z' }, '2026-10-21T21:00:00Z')).toBe(false);
  });

  it('never offers a record without a start date', () => {
    expect(isBeforeStart({ endAt: webinar.endAt }, '2026-10-21T12:00:00Z')).toBe(false);
  });
});
