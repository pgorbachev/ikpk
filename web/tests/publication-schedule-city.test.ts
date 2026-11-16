import { describe, expect, it } from 'vitest';
import { firstSelectableCandidateCity } from './helpers/publication-schedule-city';

describe('firstSelectableCandidateCity', () => {
  it('skips an initial null city and chooses a real city present in the filter', () => {
    const rows = [
      { city: null, seminar: 'first row' },
      { city: { name: 'Санкт-Петербург' }, seminar: 'represented city' },
    ];

    expect(firstSelectableCandidateCity(rows, ['санкт-петербург'])).toEqual({
      row: rows[1],
      name: 'Санкт-Петербург',
      value: 'санкт-петербург',
    });
  });
});
