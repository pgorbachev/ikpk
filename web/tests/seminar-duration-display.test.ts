import { describe, expect, it } from 'vitest';
import { formatDurationDisplay, shortDuration } from '../src/lib/data';

const eventDates = { startAt: '2026-06-01T00:00:00Z', endAt: '2026-06-03T00:00:00Z' };

describe('единое отображение продолжительности', () => {
  it('использует точный fallback только для пустого effective value', () => {
    expect(formatDurationDisplay(null)).toBe('Продолжительность не задана');
    expect(formatDurationDisplay('  ')).toBe('Продолжительность не задана');
    expect(formatDurationDisplay('две недели')).toBe('две недели');
  });

  it('сохраняет краткую подпись и числовые legacy-часы', () => {
    expect(shortDuration('16')).toBe('16 ч');
    expect(shortDuration('24 часов')).toBe('24 часов');
    expect(formatDurationDisplay('16 часов', { mode: 'seminar-event' })).toBe('16 часов');
  });

  it('сохраняет включительное число календарных дней у карточки проведения', () => {
    expect(formatDurationDisplay('16', { mode: 'seminar-event', ...eventDates })).toBe('3 дня (16 часов)');
    expect(formatDurationDisplay('16', {
      mode: 'seminar-event', startAt: eventDates.startAt, endAt: eventDates.startAt,
    })).toBe('16 часов');
  });

  it('сохраняет подпись часов и текстовое значение на строке расписания', () => {
    expect(formatDurationDisplay('16', { mode: 'schedule-row', ...eventDates }))
      .toBe('01.06.2026 - 03.06.2026 - 3 дня (16 часов)');
    expect(formatDurationDisplay('две недели', { mode: 'schedule-row', ...eventDates }))
      .toBe('01.06.2026 - 03.06.2026 - две недели');
  });

  it('сохраняет календарные даты строки расписания при пустой продолжительности', () => {
    expect(formatDurationDisplay(null, { mode: 'schedule-row', ...eventDates }))
      .toBe('01.06.2026 - 03.06.2026 - Продолжительность не задана');
  });
});
