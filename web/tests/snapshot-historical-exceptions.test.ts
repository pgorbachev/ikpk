import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSnapshotContract, validateSnapshotContract } from '../scripts/lib/content-contract';
import { contentFingerprint, snapshotId, type Snapshot, type SnapshotContent } from '../scripts/lib/content-snapshot';
import { activeHistoricalExceptions, proposeHistoricalExceptions, trustForHistoricalSnapshot } from '../scripts/lib/historical-exceptions';

// seminar-content-and-occurrence-model / cms-content-source:
// the registry belongs to snapshot content; authority comes from a separate trusted pin.
// These optional arguments specify the proposed seam on the existing public functions,
// not a mock validator. The old functions execute normally and ignore the second argument.
type HistoricalException = {
  documentId: string;
  publishedAt: string;
  updatedAt: string;
  condition: 'paid-zero-price' | 'missing-duration';
  recordFingerprint: string;
};
type HistoryContent = SnapshotContent & { historicalExceptions?: HistoricalException[] };
type Trust = { trustedHistoricalExceptionsFingerprint?: string };
const validate = validateSnapshotContract as (snapshot: Snapshot, trust?: Trust) => ReturnType<typeof validateSnapshotContract>;
const assertContract = assertSnapshotContract as (snapshot: Snapshot, trust?: Trust) => void;
const event = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 23, documentId: 'occurrence-doc-a', name: 'Occurrence A',
  publishedAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-10T08:00:00.000Z',
  seminar: { id: 12, slug: 'seminar-a' }, isFree: false, price: 5000, duration: '8 часов',
  teachers: [], ...overrides,
});
function snapshot(record = event(), defaults: Record<string, unknown> = {}): Snapshot {
  return {
    referenceDate: '2026-11-14',
    content: { types: {
      seminars: [{ id: 12, documentId: 'seminar-doc-a', slug: 'seminar-a', publishedAt: '2026-11-01T00:00:00.000Z', duration: '24 часа', ...defaults }],
      schedule_entries: [record],
    }, media: [] },
  };
}
function exceptions(snap: Snapshot): HistoricalException[] {
  return (snap.content as HistoryContent).historicalExceptions ?? [];
}
function recordFingerprint(record: Record<string, unknown>): string {
  return contentFingerprint({ types: { schedule_entries: [record] }, media: [] });
}
function trustFor(snap: Snapshot): Trust {
  return { trustedHistoricalExceptionsFingerprint: contentFingerprint({ types: { historicalExceptions: exceptions(snap) }, media: [] }) };
}
function approve(snap: Snapshot, condition: HistoricalException['condition']): Trust {
  const record = snap.content.types.schedule_entries[0];
  const entry: HistoricalException = {
    documentId: String(record.documentId), publishedAt: String(record.publishedAt), updatedAt: String(record.updatedAt),
    condition, recordFingerprint: recordFingerprint(record),
  };
  (snap.content as HistoryContent).historicalExceptions = [...exceptions(snap), entry];
  return trustFor(snap);
}
function expectRejected(snap: Snapshot, trust?: Trust, field?: string): void {
  const result = validate(snap, trust);
  expect(result.ok, 'invalid snapshot must stop the build').toBe(false);
  expect(result.violations.length).toBeGreaterThan(0);
  expect(() => assertContract(snap, trust)).toThrow();
  if (field) {
    expect(result.violations).toContainEqual(expect.objectContaining({ type: 'schedule', recordId: '23', field }));
    expect(() => assertContract(snap, trust)).toThrow(new RegExp(`23|occurrence-doc-a`));
  }
}

describe('historical occurrence exceptions: exact condition and published version', () => {
  it.each([undefined, null, ''])('paid unspecified price %s is legal without an exception', (price) => {
    const snap = snapshot(event({ price }));
    expect(validate(snap).violations).toEqual([]);
  });

  it.each([{ price: 0 }, { price: '0' }, { newPrice: 0 }, { newPrice: '0' }])('rejects unapproved paid zero in current/legacy shape %j', (price) => {
    const record = event(price);
    if ('newPrice' in price) delete record.price;
    expectRejected(snapshot(record), undefined, 'price');
  });

  it('free zero remains valid and requires no registry', () => {
    expect(validate(snapshot(event({ isFree: true, price: 0 }))).violations).toEqual([]);
  });

  it.each([{ isFree: false, price: -1 }, { isFree: true, price: 100 }, { isFree: true, price: null }])('rejects inconsistent price and free flag %j', (patch) => {
    expectRejected(snapshot(event(patch)), undefined, 'price');
  });

  it.each([undefined, null, '', '  '])('rejects absent effective duration %s', (duration) => {
    expectRejected(snapshot(event({ duration }), { duration: null }), undefined, 'duration');
  });

  it('inherits the separately captured published seminar default', () => {
    expect(validate(snapshot(event({ duration: null }))).violations).toEqual([]);
  });

  it('an override works without a seminar default', () => {
    expect(validate(snapshot(event(), { duration: null })).violations).toEqual([]);
  });

  it('embedded relation duration cannot replace a missing published default', () => {
    expectRejected(snapshot(event({ duration: null, seminar: { slug: 'seminar-a', duration: 'draft 24 часа' } }), { duration: null }), undefined, 'duration');
  });

  it('an explicitly unpublished seminar cannot supply the default', () => {
    expectRejected(snapshot(event({ duration: null }), { publishedAt: null }), undefined, 'duration');
  });

  it.each(['paid-zero-price', 'missing-duration'] as const)('accepts exact reviewed %s and preserves the record', (condition) => {
    const snap = snapshot(event(condition === 'paid-zero-price' ? { price: 0 } : { duration: null }), { duration: null });
    const trust = approve(snap, condition);
    const before = structuredClone(snap);
    expect(validate(snap, trust).violations).toEqual([]);
    expect(() => assertContract(snap, trust)).not.toThrow();
    expect(snap).toEqual(before);
    expect(snap.content.types.schedule_entries[0].isFree).toBe(false);
  });

  it('a missing-duration exception becomes stale when the published default is filled', () => {
    const snap = snapshot(event({ duration: null }), { duration: null });
    const trust = approve(snap, 'missing-duration');
    snap.content.types.seminars[0].duration = '16 часов';
    expectRejected(snap, trust);
  });

  it('each failing condition needs its own exception', () => {
    const snap = snapshot(event({ price: 0, duration: null }), { duration: null });
    const trust = approve(snap, 'paid-zero-price');
    expectRejected(snap, trust, 'duration');
    expect(validate(snap, approve(snap, 'missing-duration')).violations).toEqual([]);
  });

  it.each([
    ['another logical document', { documentId: 'occurrence-doc-b' }],
    ['another publication', { publishedAt: '2026-11-11T09:00:00.000Z' }],
    ['changed update timestamp', { updatedAt: '2026-11-11T08:00:00.000Z' }],
    ['changed content with stale timestamps', { name: 'Edited occurrence' }],
    ['another physical row', { id: 24 }],
  ])('rejects an exception reused for %s', (_label, patch) => {
    const snap = snapshot(event({ price: 0 }));
    const trust = approve(snap, 'paid-zero-price');
    Object.assign(snap.content.types.schedule_entries[0], patch);
    expectRejected(snap, trust);
  });

  it('does not exempt another new row with the same failing condition', () => {
    const snap = snapshot(event({ price: 0 }));
    const trust = approve(snap, 'paid-zero-price');
    snap.content.types.schedule_entries.push(event({ id: 24, documentId: 'occurrence-doc-new', price: 0 }));
    expectRejected(snap, trust);
  });

  it('a duration exception does not exempt a broken seminar relation', () => {
    const snap = snapshot(event({ duration: null, seminar: { slug: 'missing' } }), { duration: null });
    const result = validate(snap, approve(snap, 'missing-duration'));
    expect(result.violations).toContainEqual(expect.objectContaining({ type: 'schedule', rule: 'broken-relation' }));
  });

  it('does not require a published teacher in the snapshot for an omitted relation', () => {
    expect(validate(snapshot(event({ teachers: [] }))).violations).toEqual([]);
  });
});

describe('registry authority and identity', () => {
  it('offline audit identifies exact candidates without authorizing them', () => {
    const snap = snapshot(event({ price: 0, duration: null }), { duration: null });
    const candidates = proposeHistoricalExceptions(snap.content);
    expect(candidates.map((entry) => entry.condition)).toEqual(['paid-zero-price', 'missing-duration']);
    expect(candidates.every((entry) => entry.documentId === 'occurrence-doc-a' && entry.recordFingerprint === recordFingerprint(snap.content.types.schedule_entries[0]))).toBe(true);
    (snap.content as HistoryContent).historicalExceptions = candidates;
    expectRejected(snap);
  });

  it('offline audit refuses ambiguous identity or a missing published version', () => {
    const snap = snapshot(event({ documentId: null, price: 0 }));
    expect(() => proposeHistoricalExceptions(snap.content)).toThrow(/identity/);
    snap.content.types.schedule_entries = [event({ price: 0 }), event({ id: 24, price: 0 })];
    expect(() => proposeHistoricalExceptions(snap.content)).toThrow(/duplicate/);
  });
  it('drops an old exception when corrected, but never exempts a changed still-invalid occurrence', () => {
    const snap = snapshot(event({ price: 0 }));
    approve(snap, 'paid-zero-price');
    const approved = structuredClone(exceptions(snap));
    snap.content.types.schedule_entries[0].price = 1200;
    expect(activeHistoricalExceptions(snap.content, approved)).toEqual([]);
    snap.content.types.schedule_entries[0].price = 0;
    snap.content.types.schedule_entries[0].name = 'Изменённая запись';
    expect(activeHistoricalExceptions(snap.content, approved)).toEqual([]);
    delete (snap.content as HistoryContent).historicalExceptions;
    expectRejected(snap, undefined, 'price');
  });

  it('trusts an active subset only when every entry comes from the externally pinned file', () => {
    const snap = snapshot(event({ price: 0 }));
    approve(snap, 'paid-zero-price');
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-history-'));
    const oldPath = process.env.CONTENT_HISTORICAL_EXCEPTIONS_FILE;
    const oldHash = process.env.CONTENT_HISTORICAL_EXCEPTIONS_SHA256;
    try {
      const path = join(dir, 'approved.json');
      const bytes = JSON.stringify([...exceptions(snap), { ...exceptions(snap)[0], documentId: 'older-entry' }]);
      writeFileSync(path, bytes);
      process.env.CONTENT_HISTORICAL_EXCEPTIONS_FILE = path;
      process.env.CONTENT_HISTORICAL_EXCEPTIONS_SHA256 = createHash('sha256').update(bytes).digest('hex');
      expect(validate(snap, trustForHistoricalSnapshot(snap.content)).violations).toEqual([]);
      exceptions(snap)[0].documentId = 'forged-entry';
      expect(() => trustForHistoricalSnapshot(snap.content)).toThrow(/approved registry/);
    } finally {
      if (oldPath === undefined) delete process.env.CONTENT_HISTORICAL_EXCEPTIONS_FILE; else process.env.CONTENT_HISTORICAL_EXCEPTIONS_FILE = oldPath;
      if (oldHash === undefined) delete process.env.CONTENT_HISTORICAL_EXCEPTIONS_SHA256; else process.env.CONTENT_HISTORICAL_EXCEPTIONS_SHA256 = oldHash;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('self-issued registry is not authority', () => {
    const snap = snapshot(event({ price: 0 }));
    approve(snap, 'paid-zero-price');
    expectRejected(snap);
  });

  it('forged entry and recomputed record hash cannot replace the trusted registry pin', () => {
    const snap = snapshot(event({ price: 0 }));
    const trust = approve(snap, 'paid-zero-price');
    snap.content.types.schedule_entries[0].name = 'Unauthorised edit';
    exceptions(snap)[0].recordFingerprint = recordFingerprint(snap.content.types.schedule_entries[0]);
    expectRejected(snap, trust);
  });

  it.each(['duplicate', 'unknown condition', 'stale condition', 'unknown document'] as const)('rejects %s registry entry even under a matching external pin', (kind) => {
    const snap = snapshot(event({ price: 0 }));
    approve(snap, 'paid-zero-price');
    const entries = exceptions(snap);
    if (kind === 'duplicate') entries.push({ ...entries[0] });
    if (kind === 'unknown condition') Object.assign(entries[0], { condition: 'skip-all-validation' });
    if (kind === 'stale condition') {
      snap.content.types.schedule_entries[0].price = 5000;
      entries[0].recordFingerprint = recordFingerprint(snap.content.types.schedule_entries[0]);
    }
    if (kind === 'unknown document') entries[0].documentId = 'missing';
    expectRejected(snap, trustFor(snap));
  });

  it('adding/removing or changing the registry changes content and snapshot identity', () => {
    const snap = snapshot(event({ price: 0 }));
    const before = contentFingerprint(snap.content);
    approve(snap, 'paid-zero-price');
    const after = contentFingerprint(snap.content);
    expect(after).not.toBe(before);
    expect(snapshotId({ fingerprint: after, referenceDate: snap.referenceDate })).not.toBe(snapshotId({ fingerprint: before, referenceDate: snap.referenceDate }));
    exceptions(snap)[0].publishedAt = '2026-11-12T00:00:00.000Z';
    expect(contentFingerprint(snap.content)).not.toBe(after);
  });

  it('empty registry needs no trust secret or synthetic exception', () => {
    const snap = snapshot();
    (snap.content as HistoryContent).historicalExceptions = [];
    expect(validate(snap).violations).toEqual([]);
  });

  it('ordinary checked-in legacy fixture remains usable without automatic blanket exemptions', () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/content-snapshot/snapshot.json'), 'utf8')) as Snapshot;
    expect(validate(fixture).violations).toEqual([]);
    const changed = structuredClone(fixture);
    const paidZero = changed.content.types.schedule_entries.find((record) => record.isFree === false && record.newPrice === 0)!;
    expect(paidZero).toBeDefined();
    paidZero.name = 'Changed historical occurrence';
    expectRejected(changed);
  });
});
