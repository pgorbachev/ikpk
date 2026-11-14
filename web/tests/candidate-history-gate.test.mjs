import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activeHistoricalExceptions, historicalExceptionsFromEnvironment, proposeHistoricalExceptions, trustForHistoricalSnapshot } from '../scripts/lib/historical-exceptions.ts';
import { assertSnapshotContract } from '../scripts/lib/content-contract.ts';

const event = (extra = {}) => ({id: 23, documentId:'occurrence-a', name:'Occurrence A',
  publishedAt:'2026-11-10T09:00:00.000Z', updatedAt:'2026-11-10T08:00:00.000Z',
  seminar:{id:12, slug:'seminar-a'}, isFree:false, price:0, duration:null, teachers:[], ...extra});
const content = () => ({types:{seminars:[{id:12, documentId:'seminar-a', slug:'seminar-a', publishedAt:'2026-11-01T00:00:00.000Z', duration:null}], schedule_entries:[event()]}, media:[]});

test('snapshot capture trust requires all current violations and permits stale corrected approvals', t => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-gate-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,'registry.json');
  const original = content(); const correct = proposeHistoricalExceptions(original);
  assert.equal(correct.length, 2);
  const check = (current, registry, passed) => {
    const bytes = Buffer.from(JSON.stringify(registry)); writeFileSync(path,bytes);
    process.env.CONTENT_HISTORICAL_EXCEPTIONS_FILE = path;
    process.env.CONTENT_HISTORICAL_EXCEPTIONS_SHA256 = createHash('sha256').update(bytes).digest('hex');
    const approved = historicalExceptionsFromEnvironment();
    const currentContent = structuredClone(current);
    const active = activeHistoricalExceptions(currentContent, approved.entries);
    if (active.length) currentContent.historicalExceptions = active;
    const snap = {referenceDate:'2026-11-14', content:currentContent};
    const validate = () => assertSnapshotContract(snap, trustForHistoricalSnapshot(currentContent));
    if (passed) assert.doesNotThrow(validate); else assert.throws(validate);
  };
  try {
    check(original, [], false);
    check(original, correct.slice(0,1), false);
    check(original, correct, true);
    check(original, [...correct, correct[0]], false);
    check(original, correct.map((entry, i) => i ? entry : {...entry, updatedAt:'2026-11-11T00:00:00.000Z'}), false);
    check(content(), [...correct, {...correct[0], documentId:'different-stale-record'}], true);
    check({...content(), types:{...content().types, schedule_entries:[event({name:'changed with stale timestamps'})]}}, correct, false);
    const fixed = content(); fixed.types.schedule_entries[0].price = 100;
    check(fixed, correct, false); // fingerprint binds both conditions to the old row
    check(fixed, proposeHistoricalExceptions(fixed), true);
  } finally { delete process.env.CONTENT_HISTORICAL_EXCEPTIONS_FILE; delete process.env.CONTENT_HISTORICAL_EXCEPTIONS_SHA256; }
});
