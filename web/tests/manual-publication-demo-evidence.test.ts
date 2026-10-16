import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { demoEvidencePaths, saveDemoOperation, verifyDemoRecoveryEvidence } from '../scripts/lib/demo-publication-evidence.ts';
import { runnerFixture } from './helpers/publication-runner-fixture.ts';

const sealed = vi.hoisted(() => ({ verify: vi.fn() }));
// The helper's root-ownership/digest attestation has its own native tests; here
// the trusted return is controlled to exercise recovery identity, not recapture.
vi.mock('../../scripts/lib/server-capture-bundle.mjs', () => ({ verifyBundle: sealed.verify }));
const temporary: string[] = [];
afterEach(() => { sealed.verify.mockReset(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  // Protected ancestors are part of the production contract; /tmp is deliberately unsuitable.
  const root = mkdtempSync(join(homedir(), '.ikpk-evidence-test-')); temporary.push(root); chmodSync(root, 0o700);
  const captureBundleRoot = join(root, 'captures'), publicationEvidenceRoot = join(root, 'evidence');
  mkdirSync(captureBundleRoot, { mode: 0o750 }); mkdirSync(publicationEvidenceRoot, { mode: 0o700 });
  return { root, config: { captureBundleRoot, publicationEvidenceRoot } };
}
it('durable operation survives scratch removal and is never overwritten by a retry', () => {
  const f = fixture(), runner = runnerFixture();
  try {
    const paths = demoEvidencePaths(f.config, runner.input.publicationId);
    saveDemoOperation(paths.root, runner.operation());
    runner.clean();
    expect(JSON.parse(readFileSync(join(paths.root, 'operation.json'), 'utf8'))).toEqual(runner.operation());
    expect(() => saveDemoOperation(paths.root, runner.operation())).toThrow();
    expect(existsSync(paths.root)).toBe(true);
  } finally { runner.clean(); }
});
it('unsafe evidence roots and escaping operation IDs fail before saving', () => {
  const f = fixture();
  for (const id of ['../escape', '/absolute', 'two/parts', '']) expect(() => demoEvidencePaths(f.config, id)).toThrow();
  expect(() => demoEvidencePaths({ ...f.config, webRoot: f.root }, 'operation')).toThrow('inside serving root');
  chmodSync(f.config.publicationEvidenceRoot, 0o777);
  expect(() => demoEvidencePaths(f.config, 'operation')).toThrow('unsafe durable evidence root');
  chmodSync(f.config.publicationEvidenceRoot, 0o700);
  const link = join(f.root, 'link'); symlinkSync(f.config.publicationEvidenceRoot, link);
  expect(() => demoEvidencePaths({ ...f.config, publicationEvidenceRoot: link }, 'operation')).toThrow('unsafe durable evidence root');
  expect(() => demoEvidencePaths({ ...f.config, captureBundleRoot: undefined }, 'operation')).toThrow('missing protected');
});

it.each(['none', 'operation', 'bundle', 'snapshot', 'report'])('recovery verifies saved %s evidence and never captures a replacement', async (fault) => {
  const f = fixture(), runner = runnerFixture();
  try {
    const proof = { version: 1 as const, method: 'quiesced-sqlite-backup' as const, sourceId: 'demo193-cms' as const,
      captureId: runner.input.publicationId, schemaDigest: '1'.repeat(64), databaseDigest: '2'.repeat(64),
      mediaManifestDigest: '3'.repeat(64), bundleDigest: '4'.repeat(64) };
    const { revision: _revision, observedEntry: _observed, highWaterMark: _hwm, ...identity } = runner.operation();
    void _revision; void _observed; void _hwm;
    const operation = { ...identity, recordKind: 'publication-snapshot' as const, sourcePolicy: 'demo-publication-only' as const,
      sourceAge: 'untracked' as const, captureProof: proof };
    const snapshot = { ...runner.snapshot, provenance: undefined, sourcePolicy: operation.sourcePolicy, sourceAge: operation.sourceAge,
      captureProof: proof, origin: { kind: 'server-db', sourceId: 'demo193-cms', capturedAt: operation.capturedAt } };
    const paths = demoEvidencePaths(f.config, operation.publicationId);
    saveDemoOperation(paths.root, operation);
    mkdirSync(paths.snapshot, { mode: 0o700 }); mkdirSync(paths.reports, { mode: 0o700 });
    if (fault === 'operation') writeFileSync(join(paths.root, 'operation.json'), JSON.stringify({ ...operation, actor: 'other' }));
    if (fault === 'snapshot') snapshot.content.types.articles = [{ title: 'changed after capture' }];
    writeFileSync(join(paths.snapshot, 'snapshot.json'), JSON.stringify(snapshot));
    writeFileSync(join(paths.reports, 'publication.json'), JSON.stringify(fault === 'report' ? { ...operation.localChecks, groups: [] } : operation.localChecks));
    sealed.verify.mockReturnValue({ proof: fault === 'bundle' ? { ...proof, bundleDigest: '5'.repeat(64) } : proof });
    const config = { ...f.config, sourcePolicy: operation.sourcePolicy } as Parameters<typeof verifyDemoRecoveryEvidence>[0];
    runner.clean();
    if (fault === 'none') {
      await expect(verifyDemoRecoveryEvidence(config, operation)).resolves.toBeUndefined();
      expect(sealed.verify).toHaveBeenCalledExactlyOnceWith(paths.bundle);
    } else await expect(verifyDemoRecoveryEvidence(config, operation)).rejects.toThrow();
  } finally { runner.clean(); }
});
