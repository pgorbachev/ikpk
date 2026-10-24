import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { readPublicationSnapshot } from '../../scripts/lib/publication-snapshot';
import { contentFingerprint, snapshotId, type DemoPublicationSnapshot, type InitialProductionSnapshot } from '../../scripts/lib/content-snapshot';
import { assertCaptureSnapshotContract } from '../../scripts/lib/capture-snapshot-contract';
import { walkHtml } from './dist-pages';
import { attr, findAll, textOf } from './dom';
import { candidateTemplateRoutes } from './publication-candidate-data';
import { installThirdPartyGuard } from './third-party-guard';

/** Read only the operator's captured source and the exact output being admitted. */
export function candidate() {
  const snapshotDir = process.env.CONTENT_SNAPSHOT_DIR;
  const treeDir = process.env.PUBLICATION_TREE_DIR;
  if (!snapshotDir || !treeDir || !isAbsolute(treeDir) || !process.env.PUBLICATION_BASE_URL) throw new Error('owned candidate context required');
  const staging = process.env.PUBLICATION_STAGING_CAPTURE === '1';
  const initialProd = process.env.PUBLICATION_INITIAL_PRODUCTION_CAPTURE === '1';
  if (staging && initialProd) throw new Error('candidate capture profile is ambiguous');
  const snapshot = staging
    ? readStagingSnapshot(snapshotDir, treeDir)
    : initialProd ? readInitialProductionSnapshot(snapshotDir, treeDir) : readPublicationSnapshot(snapshotDir);
  const pages = [...walkHtml(treeDir)].map((file) => ({
    route: `/${relative(treeDir, file).replace(/index\.html$/, '').replace(/\/$/, '')}`,
    html: readFileSync(file, 'utf8'),
  }));
  const home = pages.find((page) => page.route === '/')!;
  expect(home, 'candidate homepage missing').toBeDefined();
  const trigger = findAll(home.html, (node) => attr(node, 'data-chat-loader-src') !== null)[0];
  return { snapshot, treeDir, pages, chatLoaderSrc: trigger ? attr(trigger, 'data-chat-loader-src') : null };
}

export function candidateSiteOrigin(): string {
  if (process.env.PUBLICATION_INITIAL_PRODUCTION_CAPTURE === '1') {
    const snapshotDir = process.env.CONTENT_SNAPSHOT_DIR;
    const treeDir = process.env.PUBLICATION_TREE_DIR;
    if (!snapshotDir || !treeDir) throw new Error('initial production capture context is missing');
    return readInitialProductionSnapshot(snapshotDir, treeDir).captureProof.siteUrl;
  }
  if (process.env.PUBLICATION_STAGING_CAPTURE !== '1') return 'https://ikpk.su';
  const snapshotDir = process.env.CONTENT_SNAPSHOT_DIR;
  if (!snapshotDir) throw new Error('staging capture context is missing');
  const capture = JSON.parse(readFileSync(`${snapshotDir}/capture-manifest.json`, 'utf8')) as Record<string, unknown>;
  if (capture.siteUrl !== 'https://194.226.99.10') throw new Error('staging capture names an unexpected serving origin');
  return capture.siteUrl;
}

/** The one-off production capture is admitted only when snapshot, capture manifest, and release agree. */
export function readInitialProductionSnapshot(snapshotDir: string, treeDir: string): InitialProductionSnapshot {
  const snapshot = JSON.parse(readFileSync(`${snapshotDir}/snapshot.json`, 'utf8')) as InitialProductionSnapshot;
  const captureBytes = readFileSync(`${snapshotDir}/capture-manifest.json`);
  const capture = JSON.parse(captureBytes.toString('utf8')) as Record<string, unknown>;
  const release = JSON.parse(readFileSync(`${treeDir}/release.json`, 'utf8')) as Record<string, unknown>;
  const proof = snapshot.captureProof;
  const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
  const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const sourceSha = process.env.PUBLICATION_COMMIT;
  const runId = Number(process.env.PUBLICATION_RUN_ID);
  const attempt = Number(process.env.PUBLICATION_ATTEMPT);
  const treeDigest = process.env.PUBLICATION_STATIC_TREE_SHA256;
  if (!sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha) || !positiveInteger(runId) || !positiveInteger(attempt) || !digest(treeDigest) ||
      snapshot.sourcePolicy !== 'initial-production' || snapshot.sourceAge !== 'source-bound' || snapshot.pinned ||
      snapshot.origin?.kind !== 'server-db' || snapshot.origin.sourceId !== 'initial-prod-server-db' ||
      capture.version !== 1 || capture.profile !== 'initial-prod' || capture.sourceId !== 'initial-prod-server-db' ||
      capture.host !== '89.111.184.196' || capture.siteUrl !== 'https://ikpk.su' ||
      capture.sourceSha !== sourceSha || capture.runId !== runId || capture.attempt !== attempt ||
      capture.operationId !== 'initial-prod-20261019-A-01' ||
      proof.targetHost !== '89.111.184.196' || proof.siteUrl !== 'https://ikpk.su' || proof.sourceSha !== sourceSha ||
      proof.runId !== runId || proof.attempt !== attempt || proof.captureId !== capture.operationId ||
      proof.schemaDigest !== capture.schemaDigest || proof.databaseDigest !== capture.databaseSha256 ||
      proof.mediaManifestDigest !== capture.mediaManifestSha256 ||
      !digest(proof.schemaDigest) || !digest(proof.databaseDigest) || !digest(proof.mediaManifestDigest) ||
      proof.bundleDigest !== createHash('sha256').update(captureBytes).digest('hex') ||
      release.commit !== sourceSha || release.operationId !== capture.operationId ||
      'reusedCapture' in release ||
      release.snapshotId !== snapshot.snapshotId || release.staticTreeSha256 !== treeDigest ||
      process.env.PUBLICATION_SNAPSHOT_ID !== snapshot.snapshotId) {
    throw new Error('initial production candidate does not match the admitted source, capture, and release');
  }
  assertCaptureSnapshotContract(snapshot, undefined, 'initial-prod');
  const fingerprint = contentFingerprint(snapshot.content);
  if (snapshot.fingerprint !== fingerprint || snapshot.snapshotId !== snapshotId({ fingerprint, referenceDate: snapshot.referenceDate })) {
    throw new Error('initial production snapshot identity mismatch');
  }
  for (const type of ['articles', 'seminars', 'schedule_entries', 'teachers']) {
    if (!Array.isArray(snapshot.content.types[type]) || snapshot.content.types[type].length === 0) throw new Error(`initial production snapshot has no ${type}`);
  }
  if (!Array.isArray(snapshot.content.media) || snapshot.content.media.length === 0) throw new Error('initial production snapshot has no captured media');
  return snapshot;
}

/** Staging accepts the sealed SQLite demo contract; production's live-journal reader stays unchanged. */
function readStagingSnapshot(snapshotDir: string, treeDir: string): DemoPublicationSnapshot {
  const snapshot = JSON.parse(readFileSync(`${snapshotDir}/snapshot.json`, 'utf8')) as DemoPublicationSnapshot;
  const captureBytes = readFileSync(`${snapshotDir}/capture-manifest.json`);
  const capture = JSON.parse(captureBytes.toString('utf8')) as Record<string, unknown>;
  const proof = snapshot.captureProof;
  const release = JSON.parse(readFileSync(`${treeDir}/release.json`, 'utf8')) as Record<string, unknown>;
  const bundleDigest = createHash('sha256').update(captureBytes).digest('hex');
  const reusedCapture = release.reusedCapture;
  const sameOperation = capture.operationId === release.operationId
    && capture.sourceSha === process.env.PUBLICATION_COMMIT;
  const reuseReferenceValid = sameOperation
    ? reusedCapture === undefined
    : reusedCapture !== null && typeof reusedCapture === 'object' && !Array.isArray(reusedCapture)
      && Object.keys(reusedCapture).sort().join(',') === 'bundleDigest,operationId,sourceSha'
      && (reusedCapture as Record<string, unknown>).operationId === capture.operationId
      && (reusedCapture as Record<string, unknown>).sourceSha === capture.sourceSha
      && (reusedCapture as Record<string, unknown>).bundleDigest === bundleDigest;
  if (capture.siteUrl !== 'https://194.226.99.10' || snapshot.origin?.kind !== 'server-db' || snapshot.origin.sourceId !== 'demo193-cms' ||
      snapshot.sourcePolicy !== 'demo-publication-only' || snapshot.sourceAge !== 'untracked' ||
      snapshot.pinned || !proof || proof.version !== 1 || proof.method !== 'quiesced-sqlite-backup' ||
      proof.sourceId !== 'demo193-cms' || typeof proof.captureId !== 'string' || proof.captureId !== capture.operationId ||
      proof.schemaDigest !== capture.schemaDigest || proof.databaseDigest !== capture.databaseSha256 ||
      proof.mediaManifestDigest !== capture.mediaManifestSha256 ||
      proof.bundleDigest !== bundleDigest || !reuseReferenceValid || release.commit !== process.env.PUBLICATION_COMMIT ||
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
