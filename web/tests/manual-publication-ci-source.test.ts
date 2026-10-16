import { it, expect } from 'vitest';
import { readCiEvidence } from '../scripts/lib/publication-ci.ts';
import { ciFixture } from './helpers/publication-readers-fixtures.ts';
it('reads exact dev push evidence and report counts; refuses schedule for dev', async () => {
  const f = ciFixture('dev');
  const input = { ...f.input, sourceRef: 'dev' as const };
  const result = await readCiEvidence(input);
  expect(result).toMatchObject({ branch: 'dev', executedTests: 31 });
  f.run.event = 'schedule';
  await expect(readCiEvidence(input)).rejects.toThrow();
});

import { runPublicationRollback } from '../scripts/lib/publication-rollback.ts';
import { rollbackFixture } from './helpers/publication-rollback-fixture.ts';
it('refuses a dev stand record for a prod rollback before opening transport', async () => {
  const f = rollbackFixture();
  try {
    Object.assign(f.original, { deployMode: 'stand', sourceRef: 'dev', sourceProfile: 'demo-dev' });
    f.original.ciEvidence.branch = 'dev';
    await expect(runPublicationRollback({ ...f.input, deployMode: 'prod' }, f.ports)).rejects.toThrow(/original|mode/);
    expect(f.events.map(event => event.name)).not.toContain('lock');
  } finally { f.clean(); }
});
it('retains dev branch identity when rolling back within the configured stand mode', async () => {
  const f = rollbackFixture();
  try {
    Object.assign(f.original, { deployMode: 'stand', sourceRef: 'dev', sourceProfile: 'demo-dev' });
    f.original.ciEvidence.branch = 'dev';
    const result = await runPublicationRollback({ ...f.input, deployMode: 'stand' }, f.ports);
    expect(result).toMatchObject({ sourceRef: 'dev', sourceProfile: 'demo-dev', deployMode: 'stand', paymentRole: 'ci' });
  } finally { f.clean(); }
});
