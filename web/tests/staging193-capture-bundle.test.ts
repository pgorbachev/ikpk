import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyStaging193Bundle } from '../../scripts/lib/staging193-capture-bundle.mjs';
import { loadCaptureSchemas, readPublishedSqlite } from '../../scripts/lib/server-capture-sqlite.mjs';
import { contentFingerprint, snapshotId } from '../scripts/lib/content-snapshot.ts';

const repoRoot = join(import.meta.dirname, '../..');
const schemaRoot = join(repoRoot, 'cms/src');
const temporaryRoots: string[] = [];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface FixtureAttribute {
  type: string;
}

interface FixtureSchema {
  collectionName: string;
  attributes: Record<string, FixtureAttribute>;
}

interface CapturedSeminar {
  teachers: { name: string }[];
  course_group: { slug: string };
  seo: { seo_title: string };
  documents: { document: string }[];
  image: { url: string }[];
}

interface VerifiedCaptureBundle {
  proof: { method: string };
  manifest: { schemaDigest: string };
  readback: { schemaDigest: string; collections: Record<string, unknown[]> };
  media: { url: string }[];
}

function fixtureDatabase(path: string, includeUnshownDocument = true): void {
  const schemas = loadCaptureSchemas(schemaRoot) as Record<string, FixtureSchema>;
  const db = new DatabaseSync(path);
  const snake = (value: string) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  for (const [uid, schema] of Object.entries(schemas)) {
    const scalar = Object.entries(schema.attributes).filter(([, attribute]) =>
      !['relation', 'media', 'component'].includes(attribute.type));
    const columns = scalar.map(([name, attribute]) =>
      `"${snake(name)}" ${['integer', 'boolean', 'decimal'].includes(attribute.type) ? 'NUMERIC' : 'TEXT'}`);
    const system = uid.startsWith('api::')
      ? ', document_id TEXT, created_at TEXT, updated_at TEXT, published_at TEXT, created_by_id INTEGER, updated_by_id INTEGER, locale TEXT'
      : '';
    db.exec(`CREATE TABLE "${schema.collectionName}" (id INTEGER PRIMARY KEY${system}, ${columns.join(',')})`);
    if (Object.values(schema.attributes).some((attribute) => attribute.type === 'component')) {
      db.exec(`CREATE TABLE "${schema.collectionName}_cmps" (id INTEGER PRIMARY KEY, entity_id INTEGER, cmp_id INTEGER, component_type TEXT, field TEXT, "order" REAL)`);
    }
  }
  // Join table names and directions are independently enumerated from Strapi's schema.
  for (const [table, left, right, order] of [
    ['course_groups_institute_lnk', 'course_group', 'institute', 'course_group'],
    ['seminars_course_group_lnk', 'seminar', 'course_group', 'seminar'],
    ['seminars_teachers_lnk', 'seminar', 'teacher', 'teacher'],
    ['teachers_institute_lnk', 'teacher', 'institute', null],
    ['schedule_entries_seminar_lnk', 'schedule_entry', 'seminar', 'schedule_entry'],
    ['schedule_entries_teachers_lnk', 'schedule_entry', 'teacher', 'teacher'],
    ['articles_categories_lnk', 'article', 'course_group', 'course_group'],
  ]) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, ${left}_id INTEGER, ${right}_id INTEGER${order ? `, ${order}_ord REAL` : ''}${table === 'seminars_teachers_lnk' ? ', seminar_ord REAL' : ''})`);
  }
  db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, document_id TEXT, url TEXT);
    CREATE TABLE files_related_mph (id INTEGER PRIMARY KEY, file_id INTEGER, related_id INTEGER, related_type TEXT, field TEXT, "order" REAL);
    INSERT INTO institutes (id, document_id, name, slug, published_at) VALUES (1,'inst','Institute','inst','2026-10-01');
    INSERT INTO course_groups (id, document_id, name, slug, legacy_id, published_at) VALUES (2,'group','Group','group','group','2026-10-01');
    INSERT INTO teachers (id, document_id, name, slug, trait, published_at) VALUES (3,'teacher','Teacher','teacher','teacher','2026-10-01'), (4,'teacher','Draft teacher','draft','teacher',NULL);
    INSERT INTO seminars (id, document_id, name, slug, description, published_at) VALUES (5,'seminar','Published','seminar','<a href="/uploads/form.pdf">PDF</a>','2026-10-01'), (6,'seminar','Draft','draft','draft bytes',NULL);
    INSERT INTO articles (id, document_id, title, slug, body, legacy_id, published_at) VALUES (7,'article','Article','article','Article body','article','2026-10-01');
    INSERT INTO course_groups_institute_lnk VALUES (1,2,1,1);
    INSERT INTO seminars_course_group_lnk VALUES (1,5,2,1);
    INSERT INTO seminars_teachers_lnk VALUES (1,5,3,1,1), (2,5,4,2,2);
    INSERT INTO components_shared_seos (id, seo_title, seo_description) VALUES (10,'Published SEO','Published seminar'), (11,'Draft SEO','Draft seminar'), (13,'Article SEO','Article description');
    INSERT INTO seminars_cmps VALUES (1,5,10,'shared.seo','seo',1), (2,6,11,'shared.seo','seo',1);
    INSERT INTO articles_cmps VALUES (1,7,13,'shared.seo','seo',1);
    INSERT INTO files VALUES (20,'photo','/uploads/photo.jpg');
    INSERT INTO files_related_mph VALUES (1,20,5,'api::seminar.seminar','image',1), (2,20,7,'api::article.article','image',1);
  `);
  if (includeUnshownDocument) {
    db.exec(`INSERT INTO components_seminar_document_records (id, document, issuer) VALUES (12,'Certificate','Issuer');
      INSERT INTO seminars_cmps VALUES (3,5,12,'seminar.document-record','documents',1);`);
  }
  db.close();
}

function sealedBundle(includeUnshownDocument = true): string {
  const root = mkdtempSync(join(tmpdir(), 'staging193-capture-'));
  temporaryRoots.push(root);
  const database = join(root, 'database.sqlite');
  fixtureDatabase(database, includeUnshownDocument);
  const mediaDir = join(root, 'media');
  mkdirSync(mediaDir);
  const photo = Buffer.from('photo bytes');
  const form = Buffer.from('%PDF bytes');
  writeFileSync(join(mediaDir, 'photo.jpg'), photo);
  writeFileSync(join(mediaDir, 'form.pdf'), form);
  const media = [
    { url: '/uploads/photo.jpg', file: 'media/photo.jpg', sha256: hash(photo), size: photo.length },
    { url: '/uploads/form.pdf', file: 'media/form.pdf', sha256: hash(form), size: form.length },
  ];
  const mediaPath = join(root, 'media-manifest.json');
  writeFileSync(mediaPath, `${JSON.stringify({ media })}\n`);
  const dbBytes = readFileSync(database);
  const mediaBytes = readFileSync(mediaPath);
  const manifest = {
    version: 1,
    host: '194.226.99.10',
    siteUrl: 'https://194.226.99.10',
    sourceId: 'demo193-cms',
    operationId: 'test-capture-1',
    sourceSha: 'a'.repeat(40),
    capturedAt: '2026-10-18T00:00:00.000Z',
    schemaDigest: readPublishedSqlite(database, schemaRoot).schemaDigest,
    databaseSha256: hash(dbBytes),
    mediaManifestSha256: hash(mediaBytes),
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  chmodSync(database, 0o440);
  chmodSync(mediaPath, 0o440);
  chmodSync(join(mediaDir, 'photo.jpg'), 0o440);
  chmodSync(join(mediaDir, 'form.pdf'), 0o440);
  chmodSync(mediaDir, 0o550);
  chmodSync(join(root, 'manifest.json'), 0o440);
  chmodSync(root, 0o550);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    chmodSync(root, 0o700);
    if (existsSync(join(root, 'media'))) chmodSync(join(root, 'media'), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('staging193 sealed SQLite capture', () => {
  it('resolves a draft-linked event teacher to its published version and keeps an unpublished-only teacher empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'event-teacher-capture-'));
    temporaryRoots.push(root);
    const database = join(root, 'database.sqlite');
    fixtureDatabase(database);
    const db = new DatabaseSync(database);
    db.exec(`INSERT INTO teachers (id, document_id, name, slug, trait, published_at)
        VALUES (5,'draft-only','Draft only','draft-only','teacher',NULL);
      INSERT INTO schedule_entries (id, document_id, name, city, start_at, end_at, entry_status, published_at)
        VALUES (40,'event-linked-draft','Event with published teacher','City','2099-03-17T00:00:00.000Z','2099-03-21T00:00:00.000Z','active','2026-10-01'),
               (41,'event-draft-only','Event with unpublished-only teacher','City','2099-03-17T00:00:00.000Z','2099-03-21T00:00:00.000Z','active','2026-10-01');
      INSERT INTO schedule_entries_teachers_lnk (id, schedule_entry_id, teacher_id, teacher_ord)
        VALUES (1,40,4,1), (2,41,5,1);`);
    db.close();

    const captured = readPublishedSqlite(database, schemaRoot) as unknown as {
      collections: Record<string, unknown[]>;
    };
    const events = captured.collections['schedule-entries'] as
      { documentId: string; teachers: { documentId: string; name: string }[] }[];
    expect(events.map((event) => [event.documentId, event.teachers.map((teacher) => [teacher.documentId, teacher.name])]))
      .toEqual([
        ['event-linked-draft', [['teacher', 'Teacher']]],
        ['event-draft-only', []],
      ]);
  });

  it('rejects a capture manifest from a different host or stale site URL', () => {
    for (const change of [{ host: '193.124.115.99' }, { siteUrl: 'https://193.124.115.99' }]) {
      const bundle = sealedBundle();
      const manifestPath = join(bundle, 'manifest.json');
      chmodSync(manifestPath, 0o640);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...change })}\n`);
      chmodSync(manifestPath, 0o440);
      expect(() => verifyStaging193Bundle(bundle, schemaRoot)).toThrow(/capture manifest identity is invalid/);
    }
  });

  it('preserves non-empty published relations, components, media, and excludes drafts', () => {
    const bundle = sealedBundle();
    const verified = verifyStaging193Bundle(bundle, schemaRoot) as unknown as VerifiedCaptureBundle;
    const collections = verified.readback.collections;
    const seminar = collections.seminars[0] as CapturedSeminar;
    expect(verified.proof.method).toBe('quiesced-sqlite-backup');
    expect(verified.readback.schemaDigest).toBe(verified.manifest.schemaDigest);
    expect(collections.seminars).toHaveLength(1);
    expect(seminar.teachers.map((teacher) => teacher.name)).toEqual(['Teacher']);
    expect(seminar.course_group.slug).toBe('group');
    expect(seminar.seo.seo_title).toBe('Published SEO');
    expect(seminar.documents[0].document).toBe('Certificate');
    expect(seminar.image[0].url).toBe('/uploads/photo.jpg');
    expect(verified.media.map((item) => item.url).sort()).toEqual(['/uploads/form.pdf', '/uploads/photo.jpg']);
  });

  it('verifies a previous-day snapshot against the real sealed bundle and preserves its identity and media', () => {
    const bundle = sealedBundle(false);
    const verified = verifyStaging193Bundle(bundle, schemaRoot);
    const snapshotRoot = mkdtempSync(join(tmpdir(), 'staging193-reused-snapshot-'));
    temporaryRoots.push(snapshotRoot);
    const capture = spawnSync(process.execPath, [
      '--experimental-strip-types', join(repoRoot, 'web/scripts/capture-content-snapshot.ts'),
      '--server-capture', bundle,
    ], { encoding: 'utf8', cwd: repoRoot, env: { ...process.env, CONTENT_SNAPSHOT_DIR: snapshotRoot } });
    expect(capture.status, capture.stderr).toBe(0);

    const snapshotPath = join(snapshotRoot, 'snapshot.json');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    snapshot.referenceDate = '2026-10-17';
    snapshot.fingerprint = contentFingerprint(snapshot.content);
    snapshot.snapshotId = snapshotId({ fingerprint: snapshot.fingerprint, referenceDate: snapshot.referenceDate });
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    const beforeSnapshot = readFileSync(snapshotPath);
    const beforeMedia = snapshot.content.media.map((item: { contentId: string }) => {
      const bytes = readFileSync(join(snapshotRoot, 'media', item.contentId));
      return { contentId: item.contentId, digest: hash(bytes), size: bytes.length };
    });
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', join(repoRoot, 'scripts/lib/verify-reused-staging193-snapshot.ts'),
      bundle, snapshotRoot, schemaRoot, verified.manifest.operationId, verified.manifest.sourceSha, snapshot.snapshotId,
    ], { encoding: 'utf8', cwd: repoRoot });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      snapshotId: snapshot.snapshotId, referenceDate: '2026-10-17',
      bundleDigest: verified.proof.bundleDigest,
    });
    expect(readFileSync(snapshotPath)).toEqual(beforeSnapshot);
    expect(snapshot.content.media.map((item: { contentId: string }) => {
      const bytes = readFileSync(join(snapshotRoot, 'media', item.contentId));
      return { contentId: item.contentId, digest: hash(bytes), size: bytes.length };
    })).toEqual(beforeMedia);
  });

  it('runs the packaged sealer against a real non-empty SQLite and media capture', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging193-sealer-'));
    temporaryRoots.push(root);
    const database = join(root, 'database.sqlite');
    fixtureDatabase(database);
    const mediaDir = join(root, 'media');
    mkdirSync(mediaDir);
    const photo = Buffer.from('photo bytes');
    const form = Buffer.from('%PDF bytes');
    writeFileSync(join(mediaDir, 'photo.jpg'), photo);
    writeFileSync(join(mediaDir, 'form.pdf'), form);
    writeFileSync(join(root, 'media-manifest.json'), `${JSON.stringify({ media: [
      { url: '/uploads/photo.jpg', file: 'media/photo.jpg', sha256: hash(photo), size: photo.length },
      { url: '/uploads/form.pdf', file: 'media/form.pdf', sha256: hash(form), size: form.length },
    ] })}\n`);

    const result = spawnSync(process.execPath, [
      join(repoRoot, 'scripts/lib/seal-staging193-capture.mjs'), root, 'sealer-test', 'a'.repeat(40), schemaRoot,
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const verified = verifyStaging193Bundle(root, schemaRoot) as unknown as VerifiedCaptureBundle;
    const collections = verified.readback.collections;
    const seminar = collections.seminars[0] as CapturedSeminar;
    expect(collections.seminars).toHaveLength(1);
    expect(seminar.teachers.map((teacher) => teacher.name)).toEqual(['Teacher']);
    expect(seminar.image[0].url).toBe('/uploads/photo.jpg');
    expect(verified.media.map((item) => item.url).sort()).toEqual(['/uploads/form.pdf', '/uploads/photo.jpg']);
  });

  it('refuses a database whose sealed bytes changed after manifest construction', () => {
    const bundle = sealedBundle();
    chmodSync(bundle, 0o750);
    chmodSync(join(bundle, 'database.sqlite'), 0o640);
    writeFileSync(join(bundle, 'database.sqlite'), 'tampered');
    chmodSync(join(bundle, 'database.sqlite'), 0o440);
    chmodSync(bundle, 0o550);
    expect(() => verifyStaging193Bundle(bundle, schemaRoot)).toThrow(/digest mismatch/);
  });

  it('refuses SQLite sidecars beside the sealed database image', () => {
    const bundle = sealedBundle();
    chmodSync(bundle, 0o750);
    writeFileSync(join(bundle, 'database.sqlite-wal'), 'uncheckpointed bytes');
    chmodSync(bundle, 0o550);
    expect(() => verifyStaging193Bundle(bundle, schemaRoot)).toThrow(/unexpected sidecar/);
  });

  it('refuses a referenced upload missing from the sealed media inventory', () => {
    const bundle = sealedBundle();
    chmodSync(bundle, 0o750);
    chmodSync(join(bundle, 'media-manifest.json'), 0o640);
    const mediaBytes = Buffer.from('{"media":[]}\n');
    writeFileSync(join(bundle, 'media-manifest.json'), mediaBytes);
    chmodSync(join(bundle, 'media-manifest.json'), 0o440);
    chmodSync(join(bundle, 'manifest.json'), 0o640);
    const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
    manifest.mediaManifestSha256 = hash(mediaBytes);
    writeFileSync(join(bundle, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    chmodSync(join(bundle, 'manifest.json'), 0o440);
    chmodSync(bundle, 0o550);
    expect(() => verifyStaging193Bundle(bundle, schemaRoot)).toThrow(/referenced media missing/);
  });
});
