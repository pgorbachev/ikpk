import { isDeepStrictEqual } from 'node:util';
import { it, expect } from 'vitest';
import { join } from 'node:path';
import { assertSnapshotContract } from '../../scripts/lib/content-contract';
import { readFromStore } from '../../scripts/lib/content-media-store';
import { publicationObservation, readPublicationSnapshot } from '../../scripts/lib/publication-snapshot';
import { required } from './helpers';

it('live snapshot has nonempty structural content and valid references', () => {
  const snapshot = readPublicationSnapshot(required('CONTENT_SNAPSHOT_DIR'), process.env.PUBLICATION_SOURCE_POLICY === 'demo-publication-only' ? 'demo-publication-only' : undefined);
  for (const name of ['institutes', 'course_groups', 'seminars', 'articles', 'teachers']) {
    expect(snapshot.content.types[name]?.length, `empty ${name}`).toBeGreaterThan(0);
  }
  assertSnapshotContract(snapshot);
});
it('every declared media object is present and matches its content digest', () => {
  const snapshot = readPublicationSnapshot(required('CONTENT_SNAPSHOT_DIR'), process.env.PUBLICATION_SOURCE_POLICY === 'demo-publication-only' ? 'demo-publication-only' : undefined);
  expect(snapshot.content.media.length, 'no captured media').toBeGreaterThan(0);
  for (const media of snapshot.content.media) {
    expect(media.ref).toMatch(/^\/media\/[^\s]+$/);
    expect(media.ref.split('/')).not.toContain('..');
    expect(media.contentId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(readFromStore({ storeDir: join(required('CONTENT_SNAPSHOT_DIR'), 'media'), contentId: media.contentId }), media.ref).toMatchObject({ ok: true });
  }
});
it('recomputed snapshot identity is bound to the exact latest accepted journal state', async () => {
  const snapshot = readPublicationSnapshot(required('CONTENT_SNAPSHOT_DIR'), process.env.PUBLICATION_SOURCE_POLICY === 'demo-publication-only' ? 'demo-publication-only' : undefined);
  expect(snapshot.snapshotId).toBe(required('PUBLICATION_SNAPSHOT_ID'));
  if (process.env.PUBLICATION_SOURCE_POLICY === 'demo-publication-only') {
    const { verifyBundle } = await import('../../../scripts/lib/server-capture-bundle.mjs');
    const bundle = await verifyBundle(required('PUBLICATION_CAPTURE_BUNDLE'));
    expect(bundle.proof.captureId).toBe(required('PUBLICATION_CAPTURE_ID'));
    expect(isDeepStrictEqual(snapshot.captureProof, bundle.proof)).toBe(true);
    expect(snapshot).not.toHaveProperty('provenance');
  } else expect(snapshot.provenance).toEqual(await publicationObservation(snapshot, required('PUBLICATION_LEDGER_DIR')));
});
