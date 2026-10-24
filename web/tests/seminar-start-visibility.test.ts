import { describe, expect, it } from 'vitest';
import { isBeforeStart } from '../src/lib/schedule-window';

const webinar = {
  id: 389,
  startAt: '2026-10-22T00:00:00.000Z',
  endAt: '2026-10-22T00:00:00.000Z',
  additionalText: 'Начало в 19:00 (московское время)',
};

describe('public offer ends at its stated Moscow start time', () => {
  it('hides an 18:00 webinar at 18:00 Moscow time, not at midnight', () => {
    const atEighteen = { ...webinar, additionalText: 'Начало в 18:00' };
    expect(isBeforeStart(atEighteen, '2026-10-22T14:59:59Z')).toBe(true);
    expect(isBeforeStart(atEighteen, '2026-10-22T15:00:00Z')).toBe(false);
  });

  it('uses the 19:00 Moscow note on the actual October 22 webinar', () => {
    expect(isBeforeStart(webinar, '2026-10-22T15:59:59Z')).toBe(true);
    expect(isBeforeStart(webinar, '2026-10-22T16:00:00Z')).toBe(false);
    expect(isBeforeStart(webinar, '2026-10-23T12:00:00Z')).toBe(false);
  });

  it('recognizes a stated hour inside quotes or parentheses', () => {
    for (const additionalText of ['«Начало в 18:00»', '(Начало в 18:00)']) {
      expect(isBeforeStart({ ...webinar, additionalText }, '2026-10-22T14:59:59Z')).toBe(true);
      expect(isBeforeStart({ ...webinar, additionalText }, '2026-10-22T15:00:00Z')).toBe(false);
    }
  });

  it('uses midnight for a date without a stated start hour', () => {
    const dateOnly = { ...webinar, additionalText: '' };
    expect(isBeforeStart(dateOnly, '2026-10-21T20:59:59Z')).toBe(true);
    expect(isBeforeStart(dateOnly, '2026-10-21T21:00:00Z')).toBe(false);
  });

  it('does not interpret unrelated or invalid times as a start hour', () => {
    for (const additionalText of ['Длительность 18:00', 'Начало в 25:00', 'Начало в 18:90']) {
      expect(isBeforeStart({ ...webinar, additionalText }, '2026-10-21T21:00:00Z')).toBe(false);
    }
    expect(isBeforeStart({ ...webinar, additionalText: 'Начало в 18-00' }, '2026-10-22T14:59:59Z')).toBe(true);
  });

  it('does not keep a multi-day seminar in upcoming offers after its first day starts', () => {
    expect(isBeforeStart({ ...webinar, endAt: '2026-10-25T00:00:00Z' }, '2026-10-22T16:00:00Z')).toBe(false);
  });

  it('leaves a later session of the same course available', () => {
    const later = { ...webinar, id: 333, startAt: '2026-10-23T00:00:00Z' };
    expect(isBeforeStart(webinar, '2026-10-22T16:00:00Z')).toBe(false);
    expect(isBeforeStart(later, '2026-10-22T12:00:00Z')).toBe(true);
  });

  it('uses the public Moscow day of a serialized CMS date', () => {
    expect(isBeforeStart({ ...webinar, startAt: '2026-10-21T21:00:00Z' }, '2026-10-21T21:00:00Z')).toBe(true);
  });

  it('never offers a record without a start date', () => {
    expect(isBeforeStart({ endAt: webinar.endAt }, '2026-10-21T12:00:00Z')).toBe(false);
  });
});
