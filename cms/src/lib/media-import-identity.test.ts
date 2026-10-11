import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEDIA_IMPORT_METADATA_KEY,
  mergeMediaImportIdentity,
  sourceIdentityFromProviderMetadata,
} from './media-import-identity';

const firstHash = 'a'.repeat(64);
const secondHash = 'b'.repeat(64);

test('stores source hashes in file provider metadata without changing editorial fields', () => {
  const original = { storage: 'kept', other: { value: 1 } };
  const updated = mergeMediaImportIdentity(original, 'https://images.example.test/a.png', {
    sha256: firstHash,
  });

  assert.deepEqual(original, { storage: 'kept', other: { value: 1 } });
  assert.equal(updated.storage, 'kept');
  assert.equal(sourceIdentityFromProviderMetadata(updated, 'https://images.example.test/a.png')?.sha256, firstHash);
  assert.equal(updated.alternativeText, undefined);
  assert.equal(updated.caption, undefined);
  assert.equal(updated.name, undefined);
});

test('keeps independent source identities for a reused file and updates only the matching source', () => {
  const original = mergeMediaImportIdentity({}, 'https://images.example.test/a.png', { sha256: firstHash });
  const withSecond = mergeMediaImportIdentity(original, 'https://images.example.test/b.png', { sha256: secondHash });
  const changedFirst = mergeMediaImportIdentity(withSecond, 'https://images.example.test/a.png', { sha256: secondHash });

  assert.equal(sourceIdentityFromProviderMetadata(changedFirst, 'https://images.example.test/a.png')?.sha256, secondHash);
  assert.equal(sourceIdentityFromProviderMetadata(changedFirst, 'https://images.example.test/b.png')?.sha256, secondHash);
});

test('records the exact entity slot used for one-time legacy relation adoption', () => {
  const updated = mergeMediaImportIdentity({}, 'https://images.example.test/a.png', {
    sha256: firstHash,
    adoptedFrom: 'articles:legacy-42:image:0',
  });
  const entry = (updated[MEDIA_IMPORT_METADATA_KEY] as { sources: Record<string, { adoptedFrom?: string }> }).sources[
    'https://images.example.test/a.png'
  ];

  assert.equal(entry.adoptedFrom, 'articles:legacy-42:image:0');
});

test('rejects malformed source hashes and unapproved source identities', () => {
  assert.throws(() => mergeMediaImportIdentity({}, 'https://images.example.test/a.png', { sha256: 'bad' }));
  assert.throws(() => mergeMediaImportIdentity({}, '/etc/passwd', { sha256: firstHash }));
});
