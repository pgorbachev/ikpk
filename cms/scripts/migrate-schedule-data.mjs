import { createHash } from 'node:crypto';

// Planning and application are separate so operators can inspect exceptions before a write.
// This module never opens a database and is not invoked by CMS bootstrap.
const TABLES = ['seminars', 'schedule_entries', 'schedule_entries_seminar_lnk', 'files_related_mph'];
function read(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }));
}
function snapshot(db) {
  return Object.fromEntries(TABLES.map((table) => [table, read(db, table)]));
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function duration(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function acceptedHistoricalZeroPriceConflict(row, decisions) {
  return row.is_free === 0 && row.price === 0 &&
    (decisions.acceptedExceptions ?? []).some((item) => item.documentId === row.document_id &&
      item.rowId === row.id && item.error === 'paid-price-conflict');
}
function blocksIndependentChanges(errors, row, decisions) {
  return errors.some((error) => error !== 'paid-price-conflict') ||
    (errors.includes('paid-price-conflict') && !acceptedHistoricalZeroPriceConflict(row, decisions));
}
function seminarDuration(value) {
  if (!/^\d+$/.test(value)) return value;
  const hours = Number(value);
  const last = hours % 10;
  const lastTwo = hours % 100;
  const unit = last === 1 && lastTwo !== 11 ? 'час' :
    last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'часа' : 'часов';
  return `${value} ${unit}`;
}

export function planScheduleDataMigration(db, { decisions }) {
  const source = snapshot(db);
  const paid = new Set(decisions.paid ?? []);
  const free = new Set(decisions.free ?? []);
  if ([...paid].some((id) => free.has(id))) throw new Error('Conflicting price decisions');
  const online = new Map((decisions.online ?? []).map((item) => [item.documentId, item]));
  const exceptions = [];
  const entries = source.schedule_entries.map((row) => {
    const changes = {};
    const errors = [];
    const id = row.document_id;
    if (row.is_free !== 0 && row.is_free !== 1) errors.push('invalid-free-flag');
    if (row.is_free === 1 && row.price !== null && Number(row.price) !== 0) errors.push('free-price-conflict');
    if (row.is_free === 1 && row.price === null && !free.has(id)) errors.push('free-price-missing');
    if (Number(row.is_free) === 0 && row.price !== null && Number(row.price) <= 0) {
      if (paid.has(id) && Number(row.price) === 0) changes.price = null;
      else if (free.has(id) && Number(row.price) === 0) { changes.is_free = 1; changes.price = 0; }
      else errors.push('paid-price-conflict');
    } else if (free.has(id) && (row.price === null || Number(row.price) === 0)) {
      changes.is_free = 1; changes.price = 0;
    } else if (free.has(id) && Number(row.is_free) !== 1) {
      errors.push('free-decision-conflicts-with-price');
    }
    const selected = online.get(id);
    if (selected) {
      if (row.city === selected.city && row.legacy_id === selected.legacyId && row.city === 'Онлайн') {
        changes.is_online = 1; changes.city = null;
      } else if (!(row.is_online === 1 && row.city === null)) errors.push('online-source-mismatch');
    } else if (typeof row.city === 'string' && /^онлайн$/iu.test(row.city.trim())) {
      errors.push('online-requires-confirmation');
    } else if (row.is_online == null) changes.is_online = 0;
    if (errors.length) exceptions.push({ documentId: id, rowId: row.id, errors });
    if (!duration(row.duration)) exceptions.push({ documentId: id, rowId: row.id, errors: ['duration-needs-review'] });
    return { documentId: id, rowId: row.id, published: row.published_at != null,
      changes: blocksIndependentChanges(errors, row, decisions) ? {} : changes };
  });
  const seminarById = new Map(source.seminars.map((row) => [row.id, row]));
  const entryById = new Map(source.schedule_entries.map((row) => [row.id, row]));
  const linksByDocument = new Map();
  for (const link of source.schedule_entries_seminar_lnk) {
    const seminar = seminarById.get(link.seminar_id);
    const entry = entryById.get(link.schedule_entry_id);
    if (!seminar || !entry) throw new Error('Broken seminar relation');
    const group = linksByDocument.get(seminar.document_id) ?? [];
    group.push(entry);
    linksByDocument.set(seminar.document_id, group);
  }
  const seminars = [];
  for (const [documentId, related] of linksByDocument) {
    const values = new Set(related.map((row) => duration(row.duration)));
    const seminarVersions = source.seminars.filter((row) => row.document_id === documentId);
    // A divergent, missing, or already populated value requires individual review.
    if (values.size !== 1 || values.has('') || seminarVersions.some((row) => duration(row.duration))) continue;
    if (seminarVersions.some((seminar) => {
      const versionEntries = source.schedule_entries_seminar_lnk
        .filter((link) => link.seminar_id === seminar.id)
        .map((link) => entryById.get(link.schedule_entry_id));
      return versionEntries.length === 0 || versionEntries.some((entry) =>
        (entry.published_at != null) !== (seminar.published_at != null));
    })) continue;
    // Clearing an override is safe only when every logical occurrence has one
    // draft and one published row, each linked to the matching seminar version.
    if (seminarVersions.length !== 2 || seminarVersions.filter((r) => r.published_at != null).length !== 1) continue;
    const relatedIds = new Set(related.map((row) => row.document_id));
    const safe = [...relatedIds].every((id) => {
      const versions = source.schedule_entries.filter((row) => row.document_id === id);
      if (versions.length !== 2 || versions.filter((row) => row.published_at != null).length !== 1) return false;
      return versions.every((row) => {
        const links = source.schedule_entries_seminar_lnk.filter((link) => link.schedule_entry_id === row.id);
        const target = links.length === 1 ? seminarById.get(links[0].seminar_id) : null;
        const planned = entries.find((entry) => entry.rowId === row.id);
        return target?.document_id === documentId && (target.published_at != null) === (row.published_at != null) &&
          planned && !exceptions.some((exception) => exception.rowId === row.id &&
            blocksIndependentChanges(exception.errors, row, decisions));
      });
    });
    if (!safe) continue;
    const value = seminarDuration([...values][0]);
    for (const row of seminarVersions) seminars.push({ rowId: row.id, documentId, duration: value });
    for (const row of related) entries.find((entry) => entry.rowId === row.id).changes.duration = null;
  }
  const payload = { sourceDigest: digest(source), decisionDigest: digest(decisions), entries, seminars, exceptions };
  return { ...payload, planDigest: digest(payload) };
}

export function applyScheduleDataMigration(db, { decisions, plan, expectedPlanDigest, onApplied }) {
  return db.transaction(() => {
    if (!plan || digest(decisions) !== plan.decisionDigest || digest(snapshot(db)) !== plan.sourceDigest) {
      throw new Error('Migration source changed since plan; refusing stale plan');
    }
    const { planDigest, ...payload } = plan;
    if (!expectedPlanDigest || planDigest !== expectedPlanDigest || digest(payload) !== expectedPlanDigest) throw new Error('Reviewed migration plan digest mismatch');
    const expected = planScheduleDataMigration(db, { decisions });
    if (digest(expected) !== digest(plan)) throw new Error('Migration plan changed');
    const accepted = new Set((decisions.acceptedExceptions ?? []).map((item) => `${item.documentId}\0${item.rowId}\0${item.error}`));
    const unresolved = expected.exceptions.some((item) => item.errors.some((error) => !accepted.has(`${item.documentId}\0${item.rowId}\0${error}`)));
    if (unresolved) throw new Error('Unresolved migration exceptions require review');
    const updateEntry = db.prepare('UPDATE schedule_entries SET price = ?, is_free = ?, city = ?, is_online = ?, duration = ? WHERE id = ?');
    const source = new Map(snapshot(db).schedule_entries.map((row) => [row.id, row]));
    for (const entry of expected.entries) {
      if (!Object.keys(entry.changes).length) continue;
      const row = source.get(entry.rowId);
      const merged = { ...row, ...entry.changes };
      updateEntry.run(merged.price, merged.is_free, merged.city, merged.is_online, merged.duration, entry.rowId);
    }
    const updateSeminar = db.prepare('UPDATE seminars SET duration = ? WHERE id = ?');
    for (const seminar of expected.seminars) updateSeminar.run(seminar.duration, seminar.rowId);
    const result = { entries: expected.entries.length, seminars: expected.seminars.length, exceptions: expected.exceptions };
    const callbackResult = onApplied?.(db, result);
    if (callbackResult && typeof callbackResult.then === 'function') throw new Error('onApplied must be synchronous');
    return result;
  }).immediate();
}
