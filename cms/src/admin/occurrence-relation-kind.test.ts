import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lockedSeminarId,
  occurrenceEntryId,
  occurrenceFormModel,
  occurrenceRelationKind,
} from './occurrence-relation-kind.ts';

const SEMINAR = 'api::seminar.seminar';
const ENTRY = 'api::schedule-entry.schedule-entry';

test('проведения внутри семинара рисуются штатным полем связи', () => {
  assert.equal(occurrenceRelationKind(SEMINAR, 'schedule_entries'), 'native');
  assert.equal(occurrenceRelationKind(ENTRY, 'seminar'), 'seminar');
  assert.equal(occurrenceRelationKind(ENTRY, 'teachers'), 'teachers');
  assert.equal(occurrenceRelationKind(SEMINAR, 'teachers'), 'native');
});

test('проведение, открытое из семинара, знает свою форму, а не адрес семинара', () => {
  const seminarId = 'ow1o26phtkxy4gtc0gqvjzeu';
  assert.equal(occurrenceFormModel(SEMINAR, ENTRY), ENTRY);
  assert.equal(
    lockedSeminarId({ urlModel: SEMINAR, urlId: seminarId, entryDocumentId: null }),
    seminarId,
  );
  assert.equal(occurrenceEntryId(SEMINAR, seminarId, null), undefined);
  assert.equal(occurrenceEntryId(SEMINAR, seminarId, ''), undefined);
  assert.equal(lockedSeminarId({ urlModel: SEMINAR, urlId: seminarId, entryDocumentId: '' }), seminarId);
  assert.equal(
    lockedSeminarId({ urlModel: SEMINAR, urlId: seminarId, entryDocumentId: 'entry-1' }),
    null,
  );
  assert.equal(occurrenceEntryId(SEMINAR, seminarId, 'entry-1'), 'entry-1');
  assert.equal(
    lockedSeminarId({ urlModel: ENTRY, urlId: 'create', fromSeminar: seminarId, entryDocumentId: null }),
    seminarId,
  );
  assert.equal(occurrenceEntryId(ENTRY, 'create', null), undefined);
  assert.equal(lockedSeminarId({ urlModel: ENTRY, urlId: 'create', entryDocumentId: null }), null);
});
