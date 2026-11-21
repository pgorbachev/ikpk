import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moscowCalendarDate, moscowCalendarDateISO } from './article-publication';

test('Moscow calendar date round-trips across the 2010 DST transition', () => {
  const encoded = moscowCalendarDateISO('2010-03-28');
  assert.equal(moscowCalendarDate(encoded), '2010-03-28');
  assert.equal(new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(encoded)), '12');
});
