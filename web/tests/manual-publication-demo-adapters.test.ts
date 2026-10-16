import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createPublicationCheckPorts } from '../scripts/lib/publication-check-adapters.ts';
import { adapterFixture, CANARY } from './helpers/publication-adapter-fixtures.ts';
const sealed = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../../scripts/lib/server-capture-bundle.mjs', () => ({ verifyBundle: sealed.verify }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); sealed.verify.mockReset(); });
async function fixture() {
  const f = await adapterFixture(); cleanups.push(f.clean);
  const id = '12345678-1234-4234-8234-123456789012';
  const proof = { version: 1, method: 'quiesced-sqlite-backup', sourceId: 'demo193-cms', captureId: id,
    schemaDigest: '1'.repeat(64), databaseDigest: '2'.repeat(64), mediaManifestDigest: '3'.repeat(64), bundleDigest: '4'.repeat(64) };
  Object.assign(f.options, { sourcePolicy: 'demo-publication-only', publicationId: id, captureBundle: join(f.temp, 'sealed', id),
    siteUrl: 'https://staging.ikpk.su', ledgerDir: join(f.temp, 'ledger-must-not-be-read') });
  delete f.snapshot.provenance;
  Object.assign(f.snapshot, { sourcePolicy: 'demo-publication-only', sourceAge: 'untracked', captureProof: proof,
    origin: { kind: 'server-db', sourceId: 'demo193-cms', capturedAt: '2026-10-16T12:00:00.000Z' } });
  sealed.verify.mockReturnValue({ proof });
  return { ...f, id, proof };
}
it('uses narrow fixed helper, verified bundle and the one ordinary web/dist build with staging origin', async () => {
  const f = await fixture(); const ports = createPublicationCheckPorts(f.options, f.runtime);
  await ports.capture(); await ports.build(f.context);
  expect(f.commands).toHaveLength(3);
  expect(f.commands[0]).toMatchObject({ file: '/usr/bin/sudo', args: ['-n', '/usr/local/sbin/ikpk-demo-capture-request', f.id] });
  expect(sealed.verify).toHaveBeenCalledExactlyOnceWith(f.options.captureBundle, { schemaRoot: join(f.temp, 'cms/src') });
  expect(f.commands[1].args).toEqual(['scripts/capture-content-snapshot.ts', '--server-capture', f.options.captureBundle]);
  expect(f.commands[2]).toMatchObject({ file: 'npm', args: ['run', 'build'], env: {
    DEMO_PROFILE: 'demo193', DEMO_SITE_URL: 'https://staging.ikpk.su', DEPLOY_MODE: 'stand', PAYMENT_ROLE: 'ci',
    PUBLICATION_SOURCE_POLICY: 'demo-publication-only', PUBLICATION_TREE_DIR: join(f.options.webRoot, 'dist') } });
  expect(JSON.stringify(f.commands)).not.toContain(CANARY);
});
it('refuses foreign capture operation before snapshot transformation or build', async () => {
  const f = await fixture(); sealed.verify.mockReturnValue({ proof: { ...f.proof, captureId: 'foreign' } });
  await expect(createPublicationCheckPorts(f.options, f.runtime).capture()).rejects.toThrow('foreign capture operation');
  expect(f.commands).toHaveLength(1);
});
it('failed helper does not fall back to REST capture', async () => {
  const f = await fixture(); f.state.exitCode = 1;
  await expect(createPublicationCheckPorts(f.options, f.runtime).capture()).rejects.toThrow('did not complete successfully');
  expect(f.commands).toHaveLength(1); expect(sealed.verify).not.toHaveBeenCalled();
});
