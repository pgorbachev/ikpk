import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const serial = value => JSON.stringify(value);
const entriesEqual = (a, b) => serial(Object.entries(a).sort()) === serial(Object.entries(b).sort());
const duration = value => typeof value === 'string' ? value.trim() : '';
const hours = value => {
  if (!/^\d+$/.test(value)) return value;
  const n = Number(value), last = n % 10, lastTwo = n % 100;
  const suffix = last === 1 && lastTwo !== 11 ? 'час' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'часа' : 'часов';
  return `${value} ${suffix}`;
};
function reject(message) { throw new Error(`independent schedule business audit: ${message}`); }

/** Independently check the reviewed decisions and each proposed field against source rows.
 * This is read-only and does not depend on the migration planner or on its output digest.
 * The caller must separately bind expectedPlanDigest and decisions to the reviewed files.
 */
export function auditScheduleBusinessRules(db, { plan, decisions, expectedPlanDigest }) {
  if (!plan || !decisions || !Array.isArray(plan.entries) || !Array.isArray(plan.seminars) || !Array.isArray(plan.exceptions)) reject('malformed input');
  const { planDigest, ...payload } = plan;
  if (!/^[a-f0-9]{64}$/.test(expectedPlanDigest ?? '') || planDigest !== expectedPlanDigest || hash(payload) !== expectedPlanDigest || hash(decisions) !== plan.decisionDigest) reject('unreviewed plan or decisions');
  const read = table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
  const source = Object.fromEntries(['seminars', 'schedule_entries', 'schedule_entries_seminar_lnk', 'files_related_mph'].map(table => [table, read(table)]));
  if (hash(source) !== plan.sourceDigest) reject('source does not match plan');
  const paid = new Set(decisions.paid ?? []), free = new Set(decisions.free ?? []);
  const online = new Map();
  for (const item of decisions.online ?? []) { if (online.has(item.documentId)) reject('duplicate online decision'); online.set(item.documentId, item); }
  if ([...paid].some(id => free.has(id))) reject('conflicting decisions');
  const byId = new Map();
  for (const item of plan.entries) { if (byId.has(item.rowId)) reject('duplicate entry'); byId.set(item.rowId, item); }
  if (byId.size !== source.schedule_entries.length) reject('entry coverage');
  const expectedExceptions = [], expectedEntryChanges = new Map();
  for (const row of source.schedule_entries) {
    const result = byId.get(row.id);
    if (!result || result.documentId !== row.document_id || result.published !== (row.published_at != null)) reject(`entry identity ${row.id}`);
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
    if (!duration(row.duration)) expectedExceptions.push({ documentId: row.document_id, rowId: row.id, errors: ['duration-needs-review'] });
    expectedEntryChanges.set(row.id, errors.length ? {} : changes);
  }
  if (serial(expectedExceptions) !== serial(plan.exceptions)) reject('exception set differs from source');
  const accepted = new Set((decisions.acceptedExceptions ?? []).map(x => serial([x.documentId, x.rowId, x.error])));
  if (expectedExceptions.some(x => x.errors.some(e => !accepted.has(serial([x.documentId, x.rowId, e]))))) reject('exception has not been accepted');
  const sourceEntries = new Map(source.schedule_entries.map(row => [row.id, row]));
  const sourceSeminars = new Map(source.seminars.map(row => [row.id, row]));
  const linksByDocument = new Map();
  for (const link of source.schedule_entries_seminar_lnk) {
    const sem = sourceSeminars.get(link.seminar_id), entry = sourceEntries.get(link.schedule_entry_id);
    if (!sem || !entry) reject('broken seminar relation');
    if (!linksByDocument.has(sem.document_id)) linksByDocument.set(sem.document_id, []);
    linksByDocument.get(sem.document_id).push({ sem, entry });
  }
  const expectedSeminars = new Map(), excludedRows = new Set(expectedExceptions.map(item => item.rowId));
  for (const [documentId, links] of linksByDocument) {
    const versions = source.seminars.filter(row => row.document_id === documentId);
    if (versions.length !== 2 || new Set(versions.map(row => row.published_at != null)).size !== 2 || versions.some(row => duration(row.duration))) continue;
    const occurrenceIds = new Set(links.map(({entry}) => entry.document_id));
    const occurrenceVersions = source.schedule_entries.filter(row => occurrenceIds.has(row.document_id));
    if (!occurrenceIds.size || occurrenceVersions.length !== occurrenceIds.size * 2) continue;
    if ([...occurrenceIds].some(id => {
      const pair = occurrenceVersions.filter(row => row.document_id === id);
      return pair.length !== 2 || new Set(pair.map(row => row.published_at != null)).size !== 2;
    })) continue;
    if (occurrenceVersions.some(entry => {
      const allLinks = source.schedule_entries_seminar_lnk.filter(link => link.schedule_entry_id === entry.id);
      if (allLinks.length !== 1) return true;
      const sem = sourceSeminars.get(allLinks[0].seminar_id);
      return !sem || sem.document_id !== documentId || (sem.published_at != null) !== (entry.published_at != null) || excludedRows.has(entry.id);
    })) continue;
    const values = new Set(occurrenceVersions.map(row => duration(row.duration)));
    if (values.size !== 1 || values.has('')) continue;
    for (const version of versions) expectedSeminars.set(version.id, { rowId: version.id, documentId, duration: hours([...values][0]) });
    for (const entry of occurrenceVersions) expectedEntryChanges.get(entry.id).duration = null;
  }
  if (expectedSeminars.size !== plan.seminars.length) reject('seminar coverage');
  const seen = new Set();
  for (const item of plan.seminars) {
    if (seen.has(item.rowId) || !entriesEqual(item, expectedSeminars.get(item.rowId) ?? {})) reject(`unjustified seminar duration ${item.rowId}`);
    seen.add(item.rowId);
  }
  for (const entry of plan.entries) if (!entry.changes || !entriesEqual(entry.changes, expectedEntryChanges.get(entry.rowId))) reject(`unjustified entry change ${entry.rowId}`);
  return { passed: true, entryVersions: byId.size, seminarVersions: seen.size, exceptions: expectedExceptions.length };
}
