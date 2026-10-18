import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { readPublicationSnapshot } from '../../scripts/lib/publication-snapshot';
import { contentFingerprint, snapshotId, type DemoPublicationSnapshot } from '../../scripts/lib/content-snapshot';
import { walkHtml } from './dist-pages';
import { attr, findAll, textOf } from './dom';
import { candidateTemplateRoutes } from './publication-candidate-data';
import { installThirdPartyGuard } from './third-party-guard';

/** Read only the operator's captured source and the exact output being admitted. */
export function candidate() {
  const snapshotDir = process.env.CONTENT_SNAPSHOT_DIR;
  const treeDir = process.env.PUBLICATION_TREE_DIR;
  if (!snapshotDir || !treeDir || !isAbsolute(treeDir) || !process.env.PUBLICATION_BASE_URL) throw new Error('owned candidate context required');
  const snapshot = process.env.PUBLICATION_STAGING_CAPTURE === '1'
    ? readStagingSnapshot(snapshotDir, treeDir)
    : readPublicationSnapshot(snapshotDir);
  const pages = [...walkHtml(treeDir)].map((file) => ({
    route: `/${relative(treeDir, file).replace(/index\.html$/, '').replace(/\/$/, '')}`,
    html: readFileSync(file, 'utf8'),
  }));
  const home = pages.find((page) => page.route === '/')!;
  expect(home, 'candidate homepage missing').toBeDefined();
  const trigger = findAll(home.html, (node) => attr(node, 'data-chat-loader-src') !== null)[0];
  return { snapshot, treeDir, pages, chatLoaderSrc: trigger ? attr(trigger, 'data-chat-loader-src') : null };
}

/** Staging accepts the sealed SQLite demo contract; production's live-journal reader stays unchanged. */
function readStagingSnapshot(snapshotDir: string, treeDir: string): DemoPublicationSnapshot {
  const snapshot = JSON.parse(readFileSync(`${snapshotDir}/snapshot.json`, 'utf8')) as DemoPublicationSnapshot;
  const captureBytes = readFileSync(`${snapshotDir}/capture-manifest.json`);
  const capture = JSON.parse(captureBytes.toString('utf8')) as Record<string, unknown>;
  const proof = snapshot.captureProof;
  const release = JSON.parse(readFileSync(`${treeDir}/release.json`, 'utf8')) as Record<string, unknown>;
  if (snapshot.origin?.kind !== 'server-db' || snapshot.origin.sourceId !== 'demo193-cms' ||
      snapshot.sourcePolicy !== 'demo-publication-only' || snapshot.sourceAge !== 'untracked' ||
      snapshot.pinned || !proof || proof.version !== 1 || proof.method !== 'quiesced-sqlite-backup' ||
      proof.sourceId !== 'demo193-cms' || typeof proof.captureId !== 'string' || proof.captureId !== capture.operationId ||
      proof.schemaDigest !== capture.schemaDigest || proof.databaseDigest !== capture.databaseSha256 ||
      proof.mediaManifestDigest !== capture.mediaManifestSha256 ||
      proof.bundleDigest !== createHash('sha256').update(captureBytes).digest('hex') ||
      capture.operationId !== release.operationId || release.commit !== process.env.PUBLICATION_COMMIT ||
      release.snapshotId !== snapshot.snapshotId || typeof release.staticTreeSha256 !== 'string' ||
      !Array.isArray(snapshot.content?.media) || !snapshot.content.types || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.referenceDate)) {
    throw new Error('invalid sealed staging snapshot');
  }
  const fingerprint = contentFingerprint(snapshot.content);
  if (snapshot.fingerprint !== fingerprint || snapshot.snapshotId !== snapshotId({ fingerprint, referenceDate: snapshot.referenceDate })) {
    throw new Error('staging snapshot identity mismatch');
  }
  for (const type of ['articles', 'seminars', 'schedule_entries', 'teachers']) {
    if (!Array.isArray(snapshot.content.types[type]) || snapshot.content.types[type].length === 0) throw new Error(`staging snapshot has no ${type}`);
  }
  if (snapshot.content.media.length === 0) throw new Error('staging snapshot has no captured media');
  return snapshot;
}
export function actualTemplates() {
  const { pages, snapshot } = candidate();
  return candidateTemplateRoutes(snapshot.content.types, pages);
}
export const test = base.extend({
  page: async ({ page }, use) => {
    await installThirdPartyGuard(page, { chatLoaderSrc: candidate().chatLoaderSrc });
    await use(page);
  },
});
export { expect, attr, findAll, textOf };
