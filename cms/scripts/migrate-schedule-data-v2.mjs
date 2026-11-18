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
function duration(value) { return typeof value === 'string' ? value.trim() : ''; }
function acceptedHistoricalZeroPriceConflict(row, decisions) {
  return row.is_free === 0 && row.price === 0 &&
    (decisions.acceptedExceptions ?? []).some((item) => item.documentId === row.document_id &&
      item.rowId === row.id && item.error === 'paid-price-conflict');
}
function blocksIndependentChanges(errors, row, decisions) {
  return errors.some((error) => error !== 'paid-price-conflict') ||
    (errors.includes('paid-price-conflict') && !acceptedHistoricalZeroPriceConflict(row, decisions));
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
    return { documentId: id, rowId: row.id, published: row.published_at != null,
      changes: blocksIndependentChanges(errors, row, decisions) ? {} : changes };
  });
  const seminarById = new Map(source.seminars.map((row) => [row.id, row]));
  const entryById = new Map(source.schedule_entries.map((row) => [row.id, row]));
  const linkedSeminar = new Map();
  for (const link of source.schedule_entries_seminar_lnk) {
    if (!entryById.has(link.schedule_entry_id) || !seminarById.has(link.seminar_id)) throw new Error('Broken seminar relation');
    if (linkedSeminar.has(link.schedule_entry_id)) throw new Error('Duplicate seminar relation');
    linkedSeminar.set(link.schedule_entry_id, link.seminar_id);
  }
  const mappings = decisions.durationMapping ?? [];
  if (!Array.isArray(mappings)) throw new Error('Duration mapping must be an array');
  const seenTargets = new Set();
  const sourceRows = {
    seminars: new Map(source.seminars.map(row => [row.id, row])),
    schedule_entries: new Map(source.schedule_entries.map(row => [row.id, row])),
  };
  const projected = { seminars: new Map(source.seminars.map(row => [row.id, { ...row }])), schedule_entries: new Map(source.schedule_entries.map(row => [row.id, { ...row }])) };
  for (const mapping of mappings) {
    if (!mapping || !['seminars', 'schedule_entries'].includes(mapping.table) || !Number.isSafeInteger(mapping.rowId) || mapping.rowId <= 0 ||
        !mapping.source || !['seminars', 'schedule_entries'].includes(mapping.source.table) || !Number.isSafeInteger(mapping.source.rowId) || mapping.source.rowId <= 0 ||
        !(mapping.after === null || (typeof mapping.after === 'string' && mapping.after.trim() !== ''))) throw new Error('Invalid per-row duration mapping');
    const targetKey = `${mapping.table}:${mapping.rowId}`;
    if (seenTargets.has(targetKey)) throw new Error(`Duplicate duration mapping target ${targetKey}`);
    seenTargets.add(targetKey);
    const target = projected[mapping.table].get(mapping.rowId);
    // Mapping evidence must come from the immutable source snapshot. Earlier mappings
    // may update projected targets, but cannot become evidence for later mappings.
    const sourceRow = sourceRows[mapping.source.table].get(mapping.source.rowId);
    const sourceSupportsTarget = mapping.after === null ? sourceRow?.duration === mapping.before : sourceRow?.duration === mapping.after;
    if (!target || !sourceRow || target.duration !== mapping.before || !duration(sourceRow.duration) || !sourceSupportsTarget) {
      throw new Error(`Duration mapping source/target does not match reviewed rows: ${targetKey}`);
    }
    if (mapping.table === 'schedule_entries') {
      const entryPlan = entries.find((row) => row.rowId === mapping.rowId);
      const errors = exceptions.find((row) => row.rowId === mapping.rowId)?.errors ?? [];
      if (!entryPlan || Object.keys(entryPlan.changes).length === 0 && blocksIndependentChanges(errors, target, decisions)) {
        throw new Error(`Duration mapping targets a blocked occurrence: ${targetKey}`);
      }
    }
    projected[mapping.table].get(mapping.rowId).duration = mapping.after;
  }
  for (const seminarVersion of source.seminars) {
    const proposedDefault = projected.seminars.get(seminarVersion.id).duration;
    if (proposedDefault === seminarVersion.duration) continue;
    const siblings = source.schedule_entries.filter(entry => linkedSeminar.get(entry.id) === seminarVersion.id);
    for (const sibling of siblings) {
      const priorEffective = duration(sibling.duration) ? sibling.duration : (duration(seminarVersion.duration) ? seminarVersion.duration : null);
      const nextOverride = projected.schedule_entries.get(sibling.id).duration;
      const nextEffective = duration(nextOverride) ? nextOverride : (duration(proposedDefault) ? proposedDefault : null);
      if (priorEffective === null || nextEffective !== priorEffective) {
        throw new Error(`Duration default mapping changes or invents a sibling effective value: seminar ${seminarVersion.id}, occurrence ${sibling.id}`);
      }
    }
  }
  for (const mapping of mappings) if (mapping.table === 'schedule_entries') {
    const entry = entryById.get(mapping.rowId);
    const seminarId = linkedSeminar.get(mapping.rowId);
    const seminar = seminarById.get(seminarId);
    if (!seminar) throw new Error(`Duration override mapping has no linked seminar: ${mapping.rowId}`);
    const nextOverride = projected.schedule_entries.get(mapping.rowId).duration;
    const priorEffective = duration(entry.duration) ? entry.duration : (duration(seminar.duration) ? seminar.duration : null);
    const nextEffective = duration(nextOverride) ? nextOverride : (duration(projected.seminars.get(seminar.id).duration) ? projected.seminars.get(seminar.id).duration : null);
    if (priorEffective === null || nextEffective !== priorEffective) throw new Error(`Duration override mapping changes or invents the effective value: ${mapping.rowId}`);
  }
  const seminars = [];
  for (const mapping of mappings) {
    if (mapping.table === 'seminars') {
      const row = source.seminars.find(item => item.id === mapping.rowId);
      seminars.push({ rowId: row.id, documentId: row.document_id, duration: mapping.after });
    } else {
      const row = entries.find(item => item.rowId === mapping.rowId);
      row.changes.duration = mapping.after;
    }
  }
  const payload = { sourceDigest: digest(source), decisionDigest: digest(decisions), entries, seminars, durationMapping: mappings, exceptions };
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
