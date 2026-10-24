import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentFingerprint, snapshotId } from '../scripts/lib/content-snapshot.ts';
import { readInitialProductionSnapshot, candidate } from './helpers/publication-candidate.ts';

const currentSha = 'a'.repeat(40);
const priorSha = 'b'.repeat(40);
let temporary: string;

afterEach(() => {
  vi.unstubAllEnvs();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

function stagingCandidate(reusedCapture: unknown, includeReference = true) {
  temporary = mkdtempSync(join(tmpdir(), 'ikpk-staging-reuse-reader-'));
  const snapshotDir = join(temporary, 'snapshot');
  const treeDir = join(temporary, 'tree');
  mkdirSync(snapshotDir);
  mkdirSync(treeDir);
  writeFileSync(join(treeDir, 'index.html'), '<html><body>candidate</body></html>');
  const manifest = {
    version: 1, host: '194.226.99.10', siteUrl: 'https://194.226.99.10', sourceId: 'demo193-cms',
    operationId: 'sealed-capture', sourceSha: priorSha, capturedAt: '2026-10-23T10:00:00.000Z',
    schemaDigest: 'c'.repeat(64), databaseSha256: 'd'.repeat(64), mediaManifestSha256: 'e'.repeat(64),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const digest = createHash('sha256').update(manifestBytes).digest('hex');
  const content = {
    types: {
      articles: [{ id: 1 }], seminars: [{ id: 2 }], schedule_entries: [{ id: 3 }], teachers: [{ id: 4 }],
    },
    media: [{ ref: '/uploads/example.jpg', contentId: `sha256:${'f'.repeat(64)}` }],
  };
  const fingerprint = contentFingerprint(content);
  const id = snapshotId({ fingerprint, referenceDate: '2026-10-23' });
  const snapshot = {
    content, referenceDate: '2026-10-23', fingerprint, snapshotId: id, pinned: false,
    sourcePolicy: 'demo-publication-only', sourceAge: 'untracked',
    origin: { kind: 'server-db', sourceId: 'demo193-cms', capturedAt: manifest.capturedAt },
    captureProof: {
      version: 1, method: 'quiesced-sqlite-backup', sourceId: 'demo193-cms',
      captureId: manifest.operationId, schemaDigest: manifest.schemaDigest,
      databaseDigest: manifest.databaseSha256, mediaManifestDigest: manifest.mediaManifestSha256,
      bundleDigest: digest,
    },
  };
  writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
  writeFileSync(join(snapshotDir, 'capture-manifest.json'), manifestBytes);
  const release: Record<string, unknown> = {
    commit: currentSha, operationId: 'new-main-build', snapshotId: id,
    staticTreeSha256: '1'.repeat(64),
  };
  if (includeReference) release.reusedCapture = reusedCapture;
  writeFileSync(join(treeDir, 'release.json'), JSON.stringify(release));
  vi.stubEnv('CONTENT_SNAPSHOT_DIR', snapshotDir);
  vi.stubEnv('PUBLICATION_TREE_DIR', treeDir);
  vi.stubEnv('PUBLICATION_BASE_URL', 'https://194.226.99.10');
  vi.stubEnv('PUBLICATION_STAGING_CAPTURE', '1');
  vi.stubEnv('PUBLICATION_COMMIT', currentSha);
  return { id, digest, operationId: manifest.operationId, sourceSha: manifest.sourceSha };
}

describe('staging release linked capture identity', () => {
  it('accepts an explicit exact reference to the previous-day sealed capture', () => {
    const reference = stagingCandidate(undefined, false);
    vi.stubEnv('PUBLICATION_TREE_DIR', join(temporary, 'tree'));
    const release = {
      operationId: 'sealed-capture', sourceSha: priorSha, bundleDigest: reference.digest,
    };
    writeFileSync(join(temporary, 'tree/release.json'), JSON.stringify({
      commit: currentSha, operationId: 'new-main-build', snapshotId: reference.id,
      staticTreeSha256: '1'.repeat(64), reusedCapture: release,
    }));
    expect(candidate().snapshot.snapshotId).toBe(reference.id);
    expect(candidate().snapshot.referenceDate).toBe('2026-10-23');
  });

  it('rejects a missing, mismatched, or extra-field reuse reference', () => {
    const reference = stagingCandidate(undefined, false);
    const releasePath = join(temporary, 'tree/release.json');
    const baseRelease = { commit: currentSha, operationId: 'new-main-build', snapshotId: reference.id,
      staticTreeSha256: '1'.repeat(64) };
    for (const reusedCapture of [undefined,
      { operationId: reference.operationId, sourceSha: reference.sourceSha, bundleDigest: '0'.repeat(64) },
      { operationId: reference.operationId, sourceSha: reference.sourceSha, bundleDigest: reference.digest, extra: true },
    ]) {
      writeFileSync(releasePath, JSON.stringify({ ...baseRelease, ...(reusedCapture === undefined ? {} : { reusedCapture }) }));
      expect(() => candidate()).toThrow(/invalid sealed staging snapshot/);
    }
  });
});

describe('initial production release identity', () => {
  it('keeps reused capture references outside the production contract', () => {
    temporary = mkdtempSync(join(tmpdir(), 'ikpk-production-reuse-reader-'));
    const snapshotDir = join(temporary, 'snapshot');
    const treeDir = join(temporary, 'tree');
    mkdirSync(snapshotDir);
    mkdirSync(treeDir);
    const captureId = 'initial-prod-20261019-A-01';
    const manifest = {
      version: 1, profile: 'initial-prod', sourceId: 'initial-prod-server-db',
      host: '89.111.184.196', siteUrl: 'https://ikpk.su', sourceSha: currentSha,
      runId: 123, attempt: 1, operationId: captureId,
      schemaDigest: 'c'.repeat(64), databaseSha256: 'd'.repeat(64), mediaManifestSha256: 'e'.repeat(64),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const content = {
      types: {
        articles: [{ id: 1 }], seminars: [{ id: 2 }], schedule_entries: [{ id: 3 }], teachers: [{ id: 4 }],
      },
      media: [{ ref: '/uploads/example.jpg', contentId: `sha256:${'f'.repeat(64)}` }],
    };
    const fingerprint = contentFingerprint(content);
    const referenceDate = '2026-10-19';
    const id = snapshotId({ fingerprint, referenceDate });
    const snapshot = {
      content, referenceDate, fingerprint, snapshotId: id, pinned: false,
      sourcePolicy: 'initial-production', sourceAge: 'source-bound',
      origin: { kind: 'server-db', sourceId: 'initial-prod-server-db', capturedAt: '2026-10-19T10:00:00.000Z' },
      captureProof: {
        version: 1, method: 'quiesced-sqlite-backup', targetHost: manifest.host, siteUrl: manifest.siteUrl,
        sourceSha: currentSha, runId: 123, attempt: 1, captureId,
        schemaDigest: manifest.schemaDigest, databaseDigest: manifest.databaseSha256,
        mediaManifestDigest: manifest.mediaManifestSha256,
        bundleDigest: createHash('sha256').update(manifestBytes).digest('hex'),
      },
    };
    writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
    writeFileSync(join(snapshotDir, 'capture-manifest.json'), manifestBytes);
    const release = { commit: currentSha, operationId: captureId, snapshotId: id,
      staticTreeSha256: '1'.repeat(64), reusedCapture: { operationId: captureId } };
    writeFileSync(join(treeDir, 'release.json'), JSON.stringify(release));
    vi.stubEnv('PUBLICATION_COMMIT', currentSha);
    vi.stubEnv('PUBLICATION_RUN_ID', '123');
    vi.stubEnv('PUBLICATION_ATTEMPT', '1');
    vi.stubEnv('PUBLICATION_STATIC_TREE_SHA256', release.staticTreeSha256);
    vi.stubEnv('PUBLICATION_SNAPSHOT_ID', id);
    expect(() => readInitialProductionSnapshot(snapshotDir, treeDir)).toThrow(/initial production candidate/);
  });
});
