import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentFingerprint, snapshotId, type ProductionStaticSnapshot } from '../scripts/lib/content-snapshot.ts';
import { candidate } from './helpers/publication-candidate.ts';

const sourceSha = 'a'.repeat(40);
const runId = 12345;
const attempt = 2;
const treeDigest = 'f'.repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'production-static-candidate-'));
  const snapshotDir = join(root, 'snapshot');
  const treeDir = join(root, 'tree');
  mkdirSync(snapshotDir);
  mkdirSync(treeDir);
  const capture = {
    version: 1, profile: 'production-static', host: '89.111.184.196', siteUrl: 'https://ikpk.su',
    sourceId: 'initial-prod-server-db', sourceSha, runId, attempt,
    operationId: 'release-2026-10-25-1', schemaDigest: 'b'.repeat(64),
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
  const snapshot: ProductionStaticSnapshot = {
    content, referenceDate: '2026-10-25', fingerprint,
    snapshotId: snapshotId({ fingerprint, referenceDate: '2026-10-25' }),
    origin: { kind: 'server-db', sourceId: 'initial-prod-server-db', capturedAt: '2026-10-25T10:00:00.000Z' },
    sourcePolicy: 'production-static', sourceAge: 'source-bound',
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
  writeFileSync(join(treeDir, 'index.html'), '<!doctype html><html><body>candidate</body></html>');
  vi.stubEnv('CONTENT_SNAPSHOT_DIR', snapshotDir);
  vi.stubEnv('PUBLICATION_TREE_DIR', treeDir);
  vi.stubEnv('PUBLICATION_BASE_URL', 'http://127.0.0.1:12345');
  vi.stubEnv('PUBLICATION_PRODUCTION_STATIC_CAPTURE', '1');
  vi.stubEnv('PUBLICATION_COMMIT', sourceSha);
  vi.stubEnv('PUBLICATION_RUN_ID', String(runId));
  vi.stubEnv('PUBLICATION_ATTEMPT', String(attempt));
  vi.stubEnv('PUBLICATION_STATIC_TREE_SHA256', treeDigest);
  vi.stubEnv('PUBLICATION_SNAPSHOT_ID', snapshot.snapshotId!);
  return { root, snapshot };
}

afterEach(() => vi.unstubAllEnvs());

describe('production-static publication candidate', () => {
  it('selects the production-static reader for the real browser candidate', () => {
    const data = fixture();
    try {
      expect(candidate().snapshot).toEqual(data.snapshot);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });
});
