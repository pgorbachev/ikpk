import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentFingerprint, snapshotId, type InitialProductionSnapshot } from '../scripts/lib/content-snapshot.ts';
import { readInitialProductionSnapshot } from './helpers/publication-candidate.ts';

const sourceSha = 'a'.repeat(40);
const runId = 12345;
const attempt = 2;
const treeDigest = 'f'.repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'initial-prod-candidate-'));
  const snapshotDir = join(root, 'snapshot');
  const treeDir = join(root, 'tree');
  mkdirSync(snapshotDir);
  mkdirSync(treeDir);
  const capture = {
    version: 1, profile: 'initial-prod', host: '89.111.184.196', siteUrl: 'https://ikpk.su',
    sourceId: 'initial-prod-server-db', sourceSha, runId, attempt,
    operationId: 'initial-prod-20261019-A-01', schemaDigest: 'b'.repeat(64),
    databaseSha256: 'c'.repeat(64), mediaManifestSha256: 'd'.repeat(64),
  } as const;
  const captureBytes = Buffer.from(JSON.stringify(capture));
  const content = {
    types: {
      articles: [{ slug: 'articles-one', title: 'Article', body: '<p>Text</p>', page_title: 'Article', page_description: 'Description', image: '/uploads/one.jpg' }],
      seminars: [{ slug: 'seminars-one' }],
      schedule_entries: [{ seminar: { slug: 'seminars-one' } }],
      teachers: [{ slug: 'teachers-one' }],
    },
    media: [{ ref: '/uploads/one.jpg', contentId: 'media-one' }],
  };
  const fingerprint = contentFingerprint(content);
  const snapshot: InitialProductionSnapshot = {
    content, referenceDate: '2026-10-19', fingerprint,
    snapshotId: snapshotId({ fingerprint, referenceDate: '2026-10-19' }),
    origin: { kind: 'server-db', sourceId: 'initial-prod-server-db', capturedAt: '2026-10-19T10:00:00.000Z' },
    sourcePolicy: 'initial-production', sourceAge: 'source-bound',
    captureProof: {
      version: 1, method: 'quiesced-sqlite-backup', targetHost: capture.host, siteUrl: capture.siteUrl,
      sourceSha, runId, attempt, captureId: capture.operationId, schemaDigest: capture.schemaDigest,
      databaseDigest: capture.databaseSha256, mediaManifestDigest: capture.mediaManifestSha256,
      bundleDigest: createHash('sha256').update(captureBytes).digest('hex'),
    },
  };
  writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
  writeFileSync(join(snapshotDir, 'capture-manifest.json'), captureBytes);
  writeFileSync(join(treeDir, 'release.json'), JSON.stringify({
    commit: sourceSha, operationId: capture.operationId, snapshotId: snapshot.snapshotId, staticTreeSha256: treeDigest,
  }));
  vi.stubEnv('PUBLICATION_COMMIT', sourceSha);
  vi.stubEnv('PUBLICATION_RUN_ID', String(runId));
  vi.stubEnv('PUBLICATION_ATTEMPT', String(attempt));
  vi.stubEnv('PUBLICATION_STATIC_TREE_SHA256', treeDigest);
  vi.stubEnv('PUBLICATION_SNAPSHOT_ID', snapshot.snapshotId!);
  return { root, snapshotDir, treeDir, snapshot, capture };
}

afterEach(() => vi.unstubAllEnvs());

describe('initial production publication candidate', () => {
  it('accepts the exact source-bound capture and release identity', () => {
    const data = fixture();
    try {
      expect(readInitialProductionSnapshot(data.snapshotDir, data.treeDir)).toEqual(data.snapshot);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  it('rejects capture proof digests and source/run/attempt identities that differ from the sealed inputs', () => {
    const data = fixture();
    try {
      const altered = { ...data.snapshot, captureProof: { ...data.snapshot.captureProof, databaseDigest: 'e'.repeat(64) } };
      writeFileSync(join(data.snapshotDir, 'snapshot.json'), JSON.stringify(altered));
      expect(() => readInitialProductionSnapshot(data.snapshotDir, data.treeDir)).toThrow(/admitted source, capture, and release/);
      writeFileSync(join(data.snapshotDir, 'snapshot.json'), JSON.stringify(data.snapshot));
      vi.stubEnv('PUBLICATION_ATTEMPT', String(attempt + 1));
      expect(() => readInitialProductionSnapshot(data.snapshotDir, data.treeDir)).toThrow(/admitted source, capture, and release/);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });
});
