import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEDIA_IMPORT_METADATA_KEY,
  mergeMediaImportIdentity,
  sourceIdentityFromProviderMetadata,
} from './media-import-identity';

const firstHash = 'a'.repeat(64);
const secondHash = 'b'.repeat(64);
const storedHash = 'c'.repeat(64);

test('stores source hashes in file provider metadata without changing editorial fields', () => {
  const original = { storage: 'kept', other: { value: 1 } };
  const updated = mergeMediaImportIdentity(original, 'https://images.example.test/a.png', {
    version: 1,
    sha256: firstHash,
    storedSha256: storedHash,
  });

  assert.deepEqual(original, { storage: 'kept', other: { value: 1 } });
  assert.equal(updated.storage, 'kept');
  assert.equal(sourceIdentityFromProviderMetadata(updated, 'https://images.example.test/a.png')?.sha256, firstHash);
  assert.equal(sourceIdentityFromProviderMetadata(updated, 'https://images.example.test/a.png')?.storedSha256, storedHash);
  assert.equal(updated.alternativeText, undefined);
  assert.equal(updated.caption, undefined);
  assert.equal(updated.name, undefined);
});

test('keeps independent source identities for a reused file and updates only the matching source', () => {
  const original = mergeMediaImportIdentity({}, 'https://images.example.test/a.png', { version: 1, sha256: firstHash, storedSha256: storedHash });
  const withSecond = mergeMediaImportIdentity(original, 'https://images.example.test/b.png', { version: 1, sha256: secondHash, storedSha256: storedHash });
  const changedFirst = mergeMediaImportIdentity(withSecond, 'https://images.example.test/a.png', { version: 1, sha256: secondHash, storedSha256: storedHash });

  assert.equal(sourceIdentityFromProviderMetadata(changedFirst, 'https://images.example.test/a.png')?.sha256, secondHash);
  assert.equal(sourceIdentityFromProviderMetadata(changedFirst, 'https://images.example.test/b.png')?.sha256, secondHash);
});

test('records the exact entity slot used for one-time legacy relation adoption', () => {
  const updated = mergeMediaImportIdentity({}, 'https://images.example.test/a.png', {
    version: 1,
    sha256: firstHash,
    storedSha256: storedHash,
    adoptedFrom: 'articles:legacy-42:image:0',
  });
  const entry = (updated[MEDIA_IMPORT_METADATA_KEY] as { sources: Record<string, { adoptedFrom?: string }> }).sources[
    'https://images.example.test/a.png'
  ];

  assert.equal(entry.adoptedFrom, 'articles:legacy-42:image:0');
});

test('rejects malformed source hashes and unapproved source identities', () => {
  assert.throws(() => mergeMediaImportIdentity({}, 'https://images.example.test/a.png', { version: 1, sha256: 'bad', storedSha256: storedHash }));
  assert.throws(() => mergeMediaImportIdentity({}, '/etc/passwd', { version: 1, sha256: firstHash, storedSha256: storedHash }));
});

test('bounds source URL length and identity count while preserving a same-URL update', () => {
  assert.throws(() => mergeMediaImportIdentity({}, `https://images.example.test/${'a'.repeat(2048)}`, {
    version: 1, sha256: firstHash, storedSha256: storedHash,
  }));
  let metadata: Record<string, unknown> = {};
  for (let index = 0; index < 200; index += 1) {
    metadata = mergeMediaImportIdentity(metadata, `https://images.example.test/${index}.png`, {
      version: 1, sha256: firstHash, storedSha256: storedHash,
    });
  }
  assert.throws(() => mergeMediaImportIdentity(metadata, 'https://images.example.test/overflow.png', {
    version: 1, sha256: firstHash, storedSha256: storedHash,
  }));
  assert.doesNotThrow(() => mergeMediaImportIdentity(metadata, 'https://images.example.test/0.png', {
    version: 1, sha256: secondHash, storedSha256: storedHash,
  }));
});
