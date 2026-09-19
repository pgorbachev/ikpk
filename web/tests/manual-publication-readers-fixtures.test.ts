import { expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API, REPORT_NAMES, SHA, ciFixture, fixtureDigest, localFixture } from './helpers/publication-readers-fixtures.ts';

it('positive CI fixture returns real Response objects, paginated metadata and three nonempty JSON reports', async () => {
  const f = ciFixture(); f.state.jobPages = [f.jobs.slice(0, 2), f.jobs.slice(2)];
  const ref = await f.input.fetch(`${API}/git/ref/heads/main`);
  expect(ref).toBeInstanceOf(Response);
  expect(await ref.json()).toMatchObject({ object: { sha: SHA } });
  const first = await f.input.fetch(`${API}/actions/runs/801/jobs?page=1`);
  expect((await first.json()).jobs).toHaveLength(2);
  expect(first.headers.get('link')).toContain('page=2');
  const second = await f.input.fetch(`${API}/actions/runs/801/jobs?page=2`);
  expect((await second.json()).jobs).toHaveLength(3);
  const reports = await f.input.readReports(f.artifact, { fetch: f.input.fetch });
  expect(Object.keys(reports).sort()).toEqual([...REPORT_NAMES].sort());
  expect(REPORT_NAMES.reduce((sum, name) => sum + (reports[name] as { numPassedTests: number }).numPassedTests, 0)).toBe(31);
  expect(f.calls).toHaveLength(3);
  expect(f.reportReads).toEqual([f.artifact]);
});

it('positive local fixture performs real temporary file IO and its digest notices changed bytes', async () => {
  const f = localFixture();
  try {
    const snapshot = await f.ports.capture();
    const context = { ...f.input, ...snapshot, env: f.input.env ?? {} };
    expect(await f.ports.checkSnapshot(context)).toEqual({ conclusion: 'success', executedTests: 2 });
    await f.ports.build(context);
    expect(readFileSync(join(f.input.treeDir, 'index.html'), 'utf8')).toContain('isolated coordinator fixture');
    const original = await f.ports.digest(f.input.treeDir);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(f.input.treeDir, 'index.html'), 'different fixture bytes');
    expect(fixtureDigest(f.input.treeDir)).not.toBe(original);
    expect(f.events).toEqual(['capture', 'checkSnapshot', 'build', 'digest']);
    expect(f.contexts.map(({ port }) => port)).toEqual(['checkSnapshot', 'build']);
  } finally { rmSync(f.temp, { recursive: true, force: true }); }
});
