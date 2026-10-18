import { afterEach, expect, it } from 'vitest';
import { adapterFixture, browserReport, vitestReport, writeReportWithSubprocess } from './helpers/publication-adapter-fixtures.ts';
import { validateSnapshotContract } from '../scripts/lib/content-contract.ts';

const fixtures: Awaited<ReturnType<typeof adapterFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.clean(); });

it('adapter fixture has a valid live snapshot matching an actual temporary provenance journal', async () => {
  const f = await adapterFixture(); fixtures.push(f);
  expect(validateSnapshotContract(f.snapshot)).toEqual({ ok: true, violations: [] });
  expect(f.snapshot.origin?.kind).toBe('live');
  const entries = await f.ledger.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0].fingerprint).toBe(f.snapshot.fingerprint);
  expect(await f.ledger.observe({ fingerprint: f.snapshot.fingerprint! })).toMatchObject({ observedEntry: 1, revision: 1, highWaterMark: 1 });
});

it('report fixture really crosses local subprocess stdin/stdout and filesystem with counted results', async () => {
  const f = await adapterFixture(); fixtures.push(f);
  const unit = vitestReport(3);
  const first = writeReportWithSubprocess(f.reportPath('build'), unit);
  expect(JSON.parse(first.stdout)).toEqual(unit); expect(first.disk).toEqual(unit);
  expect(unit.testResults.flatMap((suite) => suite.assertionResults).filter((result) => result.status === 'passed')).toHaveLength(3);
  const browser = browserReport();
  const second = writeReportWithSubprocess(f.reportPath('browser'), browser);
  expect(second.disk).toEqual(browser);
  const tests = browser.suites.flatMap((suite) => suite.specs.flatMap((spec) => spec.tests));
  expect(tests.filter((test) => test.projectName === 'desktop')).toHaveLength(2);
  expect(tests.filter((test) => test.projectName === 'mobile')).toHaveLength(2);
  expect(tests.flatMap((test) => test.results).filter((result) => result.status === 'passed')).toHaveLength(4);
});
