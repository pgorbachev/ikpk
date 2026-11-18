import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const serial = value => JSON.stringify(value);
const equal = (a, b) => serial(Object.entries(a).sort()) === serial(Object.entries(b).sort());
const nonempty = value => typeof value === 'string' && value.trim() !== '';
function reject(message) { throw new Error(`independent schedule business audit v2: ${message}`); }
function acceptedHistoricalZeroPriceConflict(row, decisions) {
  return row.is_free === 0 && row.price === 0 &&
    (decisions.acceptedExceptions ?? []).some(item => item.documentId === row.document_id && item.rowId === row.id && item.error === 'paid-price-conflict');
}
function blocks(errors, row, decisions) {
  return errors.some(error => error !== 'paid-price-conflict') ||
    (errors.includes('paid-price-conflict') && !acceptedHistoricalZeroPriceConflict(row, decisions));
}

/** Independent audit for the fresh-lineage v2 plan. V1 helpers remain byte-frozen. */
export function auditScheduleBusinessRules(db, { plan, decisions, expectedPlanDigest }) {
  if (!plan || !decisions || !Array.isArray(plan.entries) || !Array.isArray(plan.seminars) || !Array.isArray(plan.exceptions) || !Array.isArray(plan.durationMapping)) reject('malformed input');
  const { planDigest, ...payload } = plan;
  if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest ?? '') || planDigest !== expectedPlanDigest || hash(payload) !== expectedPlanDigest || hash(decisions) !== plan.decisionDigest) reject('unreviewed plan or decisions');
  if ((decisions.acceptedExceptions ?? []).some(item => item.error === 'duration-needs-review')) reject('duration exceptions are retired in v2');
  const read = table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
  const source = Object.fromEntries(['seminars', 'schedule_entries', 'schedule_entries_seminar_lnk', 'files_related_mph'].map(table => [table, read(table)]));
  if (hash(source) !== plan.sourceDigest) reject('source does not match plan');
  const paid = new Set(decisions.paid ?? []), free = new Set(decisions.free ?? []), online = new Map();
  for (const item of decisions.online ?? []) { if (online.has(item.documentId)) reject('duplicate online decision'); online.set(item.documentId, item); }
  if ([...paid].some(id => free.has(id))) reject('conflicting decisions');
  const plannedEntries = new Map();
  for (const item of plan.entries) { if (plannedEntries.has(item.rowId)) reject('duplicate entry'); plannedEntries.set(item.rowId, item); }
  if (plannedEntries.size !== source.schedule_entries.length) reject('entry coverage');
  const errorsById = new Map(), expectedChanges = new Map(), expectedExceptions = [];
  for (const row of source.schedule_entries) {
    const actual = plannedEntries.get(row.id);
    if (!actual || actual.documentId !== row.document_id || actual.published !== (row.published_at != null)) reject(`entry identity ${row.id}`);
    const changes = {}, errors = [];
    if (row.is_free !== 0 && row.is_free !== 1) errors.push('invalid-free-flag');
    if (row.is_free === 1 && row.price !== null && Number(row.price) !== 0) errors.push('free-price-conflict');
    if (row.is_free === 1 && row.price === null && !free.has(row.document_id)) errors.push('free-price-missing');
    if (row.is_free === 0 && row.price !== null && Number(row.price) <= 0) {
      if (Number(row.price) === 0 && paid.has(row.document_id)) changes.price = null;
      else if (Number(row.price) === 0 && free.has(row.document_id)) { changes.price = 0; changes.is_free = 1; }
      else errors.push('paid-price-conflict');
    } else if (free.has(row.document_id) && (row.price === null || Number(row.price) === 0)) { changes.price = 0; changes.is_free = 1; }
    else if (free.has(row.document_id) && row.is_free !== 1) errors.push('free-decision-conflicts-with-price');
    const decision = online.get(row.document_id);
    if (decision) {
      if (row.city === 'Онлайн' && row.city === decision.city && row.legacy_id === decision.legacyId) { changes.is_online = 1; changes.city = null; }
      else if (!(row.is_online === 1 && row.city === null)) errors.push('online-source-mismatch');
    } else if (typeof row.city === 'string' && /^онлайн$/iu.test(row.city.trim())) errors.push('online-requires-confirmation');
    else if (row.is_online == null) changes.is_online = 0;
    if (errors.length) expectedExceptions.push({ documentId: row.document_id, rowId: row.id, errors });
    errorsById.set(row.id, errors);
    expectedChanges.set(row.id, blocks(errors, row, decisions) ? {} : changes);
  }
  if (serial(expectedExceptions) !== serial(plan.exceptions)) reject('exception set differs from source');
  const approved = new Set((decisions.acceptedExceptions ?? []).map(item => serial([item.documentId, item.rowId, item.error])));
  if (expectedExceptions.some(item => item.errors.some(error => !approved.has(serial([item.documentId, item.rowId, error]))))) reject('exception has not been accepted');

  const sourceRows = { seminars: new Map(source.seminars.map(row => [row.id, row])), schedule_entries: new Map(source.schedule_entries.map(row => [row.id, row])) };
  const mappedTargets = new Set(), projected = { seminars: new Map(source.seminars.map(row => [row.id, { ...row }])), schedule_entries: new Map(source.schedule_entries.map(row => [row.id, { ...row }])) };
  const mappings = decisions.durationMapping ?? [];
  if (!Array.isArray(mappings) || serial(mappings) !== serial(plan.durationMapping)) reject('duration mapping differs from approved decisions');
  for (const mapping of mappings) {
    if (!mapping || !['seminars', 'schedule_entries'].includes(mapping.table) || !Number.isSafeInteger(mapping.rowId) || mapping.rowId <= 0 ||
        !mapping.source || !['seminars', 'schedule_entries'].includes(mapping.source.table) || !Number.isSafeInteger(mapping.source.rowId) || mapping.source.rowId <= 0 ||
        !(mapping.after === null || (typeof mapping.after === 'string' && mapping.after.trim() !== ''))) reject('invalid duration mapping');
    const key = `${mapping.table}:${mapping.rowId}`;
    if (mappedTargets.has(key)) reject(`duplicate duration mapping target ${key}`);
    mappedTargets.add(key);
    const target = projected[mapping.table].get(mapping.rowId), sourceRow = sourceRows[mapping.source.table].get(mapping.source.rowId);
    const sourceSupportsTarget = mapping.after === null ? sourceRow?.duration === mapping.before : sourceRow?.duration === mapping.after;
    if (!target || !sourceRow || target.duration !== mapping.before || !nonempty(sourceRow.duration) || !sourceSupportsTarget) reject(`duration mapping is not supported by source rows: ${key}`);
    if (mapping.table === 'schedule_entries' && blocks(errorsById.get(mapping.rowId) ?? [], sourceRows.schedule_entries.get(mapping.rowId), decisions)) reject(`duration mapping targets blocked occurrence ${mapping.rowId}`);
    projected[mapping.table].get(mapping.rowId).duration = mapping.after;
  }

  const linkByEntry = new Map(), seminarById = sourceRows.seminars;
  for (const link of source.schedule_entries_seminar_lnk) {
    if (linkByEntry.has(link.schedule_entry_id) || !seminarById.has(link.seminar_id) || !sourceRows.schedule_entries.has(link.schedule_entry_id)) reject('duplicate or broken relation');
    linkByEntry.set(link.schedule_entry_id, link.seminar_id);
  }
  for (const mapping of mappings.filter(item => item.table === 'seminars')) {
    const before = sourceRows.seminars.get(mapping.rowId), after = projected.seminars.get(mapping.rowId);
    for (const sibling of source.schedule_entries.filter(entry => linkByEntry.get(entry.id) === mapping.rowId)) {
      const prior = nonempty(sibling.duration) ? sibling.duration : (nonempty(before.duration) ? before.duration : null);
      const override = projected.schedule_entries.get(sibling.id).duration;
      const next = nonempty(override) ? override : (nonempty(after.duration) ? after.duration : null);
      if (prior === null || next !== prior) reject(`default mapping changes or invents sibling effective duration ${sibling.id}`);
    }
  }
  for (const mapping of mappings.filter(item => item.table === 'schedule_entries')) {
    const entry = sourceRows.schedule_entries.get(mapping.rowId), seminar = seminarById.get(linkByEntry.get(mapping.rowId));
    if (!seminar) reject(`override mapping has no seminar ${mapping.rowId}`);
    const prior = nonempty(entry.duration) ? entry.duration : (nonempty(seminar.duration) ? seminar.duration : null);
    const target = projected.schedule_entries.get(mapping.rowId).duration;
    const next = nonempty(target) ? target : (nonempty(projected.seminars.get(seminar.id).duration) ? projected.seminars.get(seminar.id).duration : null);
    if (prior === null || next !== prior) reject(`override mapping changes or invents effective duration ${mapping.rowId}`);
  }

  const expectedSeminars = mappings.filter(item => item.table === 'seminars').map(mapping => {
    const row = sourceRows.seminars.get(mapping.rowId);
    return { rowId: row.id, documentId: row.document_id, duration: mapping.after };
  });
  if (serial(expectedSeminars) !== serial(plan.seminars)) reject('seminar mapping differs from source');
  for (const mapping of mappings.filter(item => item.table === 'schedule_entries')) expectedChanges.get(mapping.rowId).duration = mapping.after;
  for (const row of plan.entries) if (!row.changes || !equal(row.changes, expectedChanges.get(row.rowId))) reject(`unjustified entry change ${row.rowId}`);
  return { passed: true, entryVersions: plannedEntries.size, seminarVersions: expectedSeminars.length, exceptions: expectedExceptions.length };
}
