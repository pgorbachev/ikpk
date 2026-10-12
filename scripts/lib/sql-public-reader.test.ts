import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSqlPublicSource,
  type SqlPublicPsqlRunner,
} from './sql-public-reader';
import type { SqlPublicSource } from './sql-public-content';

const PUBLIC_COLUMNS = {
  Articles: ['createdAt', 'updatedAt', 'id', 'name', 'imageId', 'content', 'status', 'author', 'priority', 'seoTitle', 'seoDescription', 'slug'],
  Cities: ['createdAt', 'updatedAt', 'id', 'name', 'status'],
  Events: ['createdAt', 'updatedAt', 'id', 'imageId', 'seminarId', 'teacherId', 'cityId', 'oldPrice', 'newPrice', 'startAt', 'endAt', 'additionalText', 'status', 'duration', 'isFree', 'isEventCollection', 'description', 'registrationFormLink'],
  EventsAndTeachers: ['createdAt', 'updatedAt', 'id', 'eventId', 'teacherId'],
  FileBindingOrganizationInfo: ['createdAt', 'updatedAt', 'id', 'title', 'priority', 'fileId', 'organizationInfoId'],
  Files: ['createdAt', 'updatedAt', 'id', 'fileType', 'originalName', 'extension', 'url', 'status', 'privacy'],
  InstituteAdditionalInfo: ['createdAt', 'updatedAt', 'id', 'name', 'description', 'instituteId'],
  Institutes: ['createdAt', 'updatedAt', 'id', 'name', 'imageId', 'description', 'shortName'],
  News: ['createdAt', 'updatedAt', 'id', 'name', 'description', 'imageId', 'status', 'link', 'priority'],
  OrganizationInfo: ['createdAt', 'updatedAt', 'id', 'name', 'priority', 'content', 'status'],
  Programs: ['createdAt', 'updatedAt', 'id', 'name', 'imageId', 'instituteId', 'status', 'priority', 'seoTitle', 'seoDescription', 'slug', 'content'],
  Promotions: ['createdAt', 'updatedAt', 'id', 'name', 'description', 'imageId', 'link', 'status', 'priority', 'type'],
  Seminars: ['createdAt', 'updatedAt', 'id', 'name', 'programId', 'description', 'curriculum', 'targetAudience', 'learningProcess', 'certificates', 'status', 'recommendations', 'priority', 'seoTitle', 'seoDescription', 'slug'],
  SeminarsTeacher: ['createdAt', 'updatedAt', 'id', 'seminarId', 'teacherId'],
  Teachers: ['createdAt', 'updatedAt', 'id', 'fullName', 'description', 'imageId', 'status', 'priority'],
  TeachersAndInstitutes: ['createdAt', 'updatedAt', 'id', 'teacherId', 'instituteId'],
  Videos: ['createdAt', 'updatedAt', 'id', 'name', 'link', 'status', 'priority', 'imageId'],
} as const;

const CONNECTION = {
  unixSocketPath: '/tmp/synthetic-postgres-socket',
  port: 5432,
  database: 'synthetic_public_source',
  user: 'synthetic_readonly_user',
} as const;

const SCHEMA_NULLABLE_FIELDS = [
  { table: 'Articles', column: 'imageId' },
  { table: 'Articles', column: 'slug' },
  { table: 'Events', column: 'imageId' },
  { table: 'Events', column: 'teacherId' },
  { table: 'Events', column: 'oldPrice' },
  { table: 'Events', column: 'additionalText' },
  { table: 'Events', column: 'duration' },
  { table: 'Events', column: 'description' },
  { table: 'Events', column: 'registrationFormLink' },
  { table: 'Files', column: 'fileType' },
  { table: 'Institutes', column: 'shortName' },
  { table: 'News', column: 'imageId' },
  { table: 'News', column: 'link' },
  { table: 'Programs', column: 'content' },
  { table: 'Programs', column: 'imageId' },
  { table: 'Programs', column: 'slug' },
  { table: 'Promotions', column: 'imageId' },
  { table: 'Promotions', column: 'link' },
  { table: 'Seminars', column: 'certificates' },
  { table: 'Seminars', column: 'curriculum' },
  { table: 'Seminars', column: 'description' },
  { table: 'Seminars', column: 'learningProcess' },
  { table: 'Seminars', column: 'recommendations' },
  { table: 'Seminars', column: 'slug' },
  { table: 'Seminars', column: 'targetAudience' },
  { table: 'Teachers', column: 'imageId' },
  { table: 'Videos', column: 'imageId' },
] as const;

const SCHEMA_NOT_NULL_FIELDS = [
  { table: 'FileBindingOrganizationInfo', column: 'title' },
  { table: 'Files', column: 'extension' },
  { table: 'Files', column: 'originalName' },
  { table: 'Files', column: 'url' },
  { table: 'InstituteAdditionalInfo', column: 'description' },
  { table: 'InstituteAdditionalInfo', column: 'instituteId' },
  { table: 'InstituteAdditionalInfo', column: 'name' },
  { table: 'Institutes', column: 'imageId' },
  { table: 'News', column: 'description' },
  { table: 'News', column: 'name' },
  { table: 'OrganizationInfo', column: 'content' },
  { table: 'OrganizationInfo', column: 'name' },
  { table: 'Promotions', column: 'description' },
  { table: 'Promotions', column: 'name' },
  { table: 'Promotions', column: 'type' },
  { table: 'Videos', column: 'link' },
  { table: 'Videos', column: 'name' },
] as const;

let ownedTempDir: string;
let dumpPath: string;

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function syntheticRow(table: keyof typeof PUBLIC_COLUMNS): Record<string, unknown> {
  const row = Object.fromEntries(PUBLIC_COLUMNS[table].map((column) => {
    if (column === 'createdAt' || column === 'updatedAt') return [column, '2026-10-12 23:59:59.987654'];
    if (column === 'startAt' || column === 'endAt') return [column, '2026-10-12'];
    if (column === 'id') return [column, table === 'Files' ? '00000000-0000-4000-8000-000000000001' : 101];
    if (column === 'imageId' || column === 'fileId') return [column, '00000000-0000-4000-8000-000000000002'];
    if (column.endsWith('Id') || column === 'priority' || column === 'oldPrice' || column === 'newPrice') return [column, 202];
    if (column === 'isFree' || column === 'isEventCollection') return [column, true];
    if (column === 'status') return [column, table === 'Files' ? 'active' : 'deleted'];
    if (column === 'privacy') return [column, 'public'];
    if (column === 'fileType') return [column, null];
    return [column, `SYNTHETIC_${table}_${column}`];
  }));
  return row;
}

function syntheticCollections(): Record<string, Record<string, unknown>[]> {
  const collections = Object.fromEntries(Object.keys(PUBLIC_COLUMNS).map((table) => [table, [syntheticRow(table as keyof typeof PUBLIC_COLUMNS)]]));
  collections.Articles[0].createdAt = '2026-10-12 23:59:59.987654';
  collections.Files.push({
    ...syntheticRow('Files'),
    id: '00000000-0000-4000-8000-000000000003',
    status: 'unlinked',
  });
  return collections;
}

function errorFootprint(error: Error): string {
  const record = error as Error & { cause?: unknown; stderr?: unknown };
  const ownProperties = Object.getOwnPropertyNames(error).map((key) => [key, (error as unknown as Record<string, unknown>)[key]]);
  return JSON.stringify({ serialized: JSON.stringify(error), ownProperties, cause: record.cause, stderr: record.stderr, stack: error.stack });
}

function selectedTableQuery(sql: string, table: keyof typeof PUBLIC_COLUMNS): { columns: string[]; tail: string } {
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = sql.replace(/\s+/g, ' ');
  const match = normalized.match(new RegExp(
    `'${escapedTable}', COALESCE\\(\\(SELECT json_agg\\(r\\) FROM \\(SELECT ([\\s\\S]{1,2048}?) FROM "public"\\."${escapedTable}"([\\s\\S]{0,512}?)\\) AS r\\), '\\[\\]'::json\\)`,
    'i',
  ));
  if (!match) return { columns: [], tail: '' };
  return { columns: match[1].split(',').map((column) => column.trim()), tail: match[2].trim() };
}

function testOptions(expectedDumpHash: string, runPsql: SqlPublicPsqlRunner) {
  return { dumpPath, expectedDumpHash, connection: { ...CONNECTION }, runPsql };
}

describe('native SQL public source reader contract', () => {
  beforeEach(async () => {
    ownedTempDir = await mkdtemp(join(tmpdir(), 'ikpk-sql-public-reader-'));
    dumpPath = join(ownedTempDir, 'synthetic-dump-marker.bin');
    await writeFile(dumpPath, 'SYNTHETIC DUMP ARTIFACT MARKER; this is not SQL', { mode: 0o600 });
  });

  afterEach(async () => {
    await rm(ownedTempDir, { recursive: true, force: true });
  });

  it('hashes the actual dump bytes and returns all 17 exact public collections in the mapper source DTO', async () => {
    const dumpBytes = await readFile(dumpPath);
    const expected = syntheticCollections();
    const runPsql = vi.fn(async () => JSON.stringify(expected));

    const result = await readSqlPublicSource(testOptions(sha256Hex(dumpBytes), runPsql));

    const mapperSource: SqlPublicSource = result;

    expect(result.sourceHash).toBe(`sha256:${sha256Hex(dumpBytes)}`);
    expect(Object.keys(PUBLIC_COLUMNS)).toHaveLength(17);
    expect(Object.keys(result).sort()).toEqual(['sourceHash', ...Object.keys(PUBLIC_COLUMNS)].sort());
    for (const [table, columns] of Object.entries(PUBLIC_COLUMNS)) {
      expect(result[table as keyof typeof result]).toEqual(expected[table]);
      expect(Object.keys(expected[table][0]).sort()).toEqual([...columns].sort());
    }
    expect(mapperSource.Articles).toEqual(expected.Articles);
    expect(result.Articles[0].createdAt).toBe('2026-10-12 23:59:59.987654');
    expect(result.Files.map((file) => file.status)).toEqual(['active', 'unlinked']);
    expect(result.Files.every((file) => file.privacy === 'public')).toBe(true);
    expect(runPsql).toHaveBeenCalledOnce();
  });

  it('rejects a baseline hash mismatch before starting any native psql process', async () => {
    const runPsql = vi.fn(async () => JSON.stringify(syntheticCollections()));

    await expect(readSqlPublicSource(testOptions('0'.repeat(64), runPsql)))
      .rejects.toThrow('SQL baseline hash does not match the expected SHA-256');
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('requires the caller hash to be raw 64-character SHA-256 hex', async () => {
    const runPsql = vi.fn(async () => JSON.stringify(syntheticCollections()));

    await expect(readSqlPublicSource(testOptions(`sha256:${'0'.repeat(64)}`, runPsql)))
      .rejects.toThrow('Expected dump hash must be 64 hexadecimal characters');
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('uses one native, read-only psql invocation with explicit reviewed identifiers only', async () => {
    const runPsql = vi.fn<SqlPublicPsqlRunner>(async () => JSON.stringify(syntheticCollections()));

    await readSqlPublicSource(testOptions(sha256Hex(await readFile(dumpPath)), runPsql));

    expect(runPsql).toHaveBeenCalledOnce();
    const invocation = runPsql.mock.calls[0][0];
    const sql = invocation.args[invocation.args.indexOf('-c') + 1] ?? '';
    expect(invocation.command).toBe('psql');
    expect(invocation.connection).toEqual(CONNECTION);
    expect(sql).toMatch(/BEGIN\s+READ\s+ONLY/i);
    expect(sql).toMatch(/SET\s+LOCAL\s+default_transaction_read_only\s*=\s*on/i);
    expect(sql).toMatch(/ROLLBACK/i);
    expect(sql).not.toMatch(/\bSELECT\s+\*/i);
    expect(sql).not.toMatch(/\b(?:pg_dumpall|Users|Payments|Registrations|Tokens|AuthTokens)\b/i);
    expect(sql).not.toMatch(/\b(?:ownerId|storageId)\b/i);
    expect(sql).not.toMatch(/\bstatus\s*=\s*'active'/i);
    for (const [table, columns] of Object.entries(PUBLIC_COLUMNS)) {
      const query = selectedTableQuery(sql, table as keyof typeof PUBLIC_COLUMNS);
      expect(query.columns).toEqual(columns.map((column) => `"${column}"`));
      expect(query.tail).toBe(table === 'Files'
        ? `WHERE "privacy" = 'public' ORDER BY "id"`
        : `ORDER BY "id"`);
    }
    expect(invocation.args).not.toContain('--password');
    expect(JSON.stringify(invocation)).not.toMatch(/password|PGPASSWORD/i);
  });

  it.each([
    {
      name: 'postgres URI',
      database: 'postgres://reader:SYNTHETIC_SECRET_SENTINEL@other-host/other-db',
    },
    {
      name: 'postgresql URI',
      database: 'postgresql://reader:SYNTHETIC_SECRET_SENTINEL@other-host/other-db',
    },
    {
      name: 'keyword conninfo',
      database: 'host=other dbname=x user=y password=SYNTHETIC_SECRET_SENTINEL',
    },
  ])('rejects $name in database before invoking psql without leaking connection details', async ({ database }) => {
    const runPsql = vi.fn<SqlPublicPsqlRunner>(async () => JSON.stringify(syntheticCollections()));
    const options = {
      ...testOptions(sha256Hex(await readFile(dumpPath)), runPsql),
      connection: { ...CONNECTION, database },
    };
    const result = await readSqlPublicSource(options).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(Error);
    expect(runPsql).not.toHaveBeenCalled();
    if (result instanceof Error) {
      expect(errorFootprint(result)).not.toContain(database);
      expect(errorFootprint(result)).not.toContain('SYNTHETIC_SECRET_SENTINEL');
    }
  });

  it.each([
    {
      name: 'unexpected Users table',
      inject: (collections: Record<string, Record<string, unknown>[]>, marker: string) => {
        collections.Users = [{ email: marker }];
      },
    },
    {
      name: 'Files.ownerId column',
      inject: (collections: Record<string, Record<string, unknown>[]>, marker: string) => {
        collections.Files[0].ownerId = marker;
      },
    },
    {
      name: 'Files.storageId column',
      inject: (collections: Record<string, Record<string, unknown>[]>, marker: string) => {
        collections.Files[0].storageId = marker;
      },
    },
  ])('rejects $name without leaking its contents', async ({ inject }) => {
    const marker = 'SYNTHETIC_PRIVATE_COLUMN_SENTINEL';
    const unexpected = syntheticCollections();
    inject(unexpected, marker);
    const runPsql = vi.fn(async () => JSON.stringify(unexpected));
    const result = await readSqlPublicSource(testOptions(sha256Hex(await readFile(dumpPath)), runPsql)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toBe('Unable to read SQL public source');
      expect(errorFootprint(result)).not.toContain(marker);
    }
  });

  it.each(SCHEMA_NOT_NULL_FIELDS.map(({ table, column }) => [table, column] as const))(
    'rejects NULL for source NOT NULL field %s.%s',
    async (table, column) => {
      const unexpected = syntheticCollections();
      unexpected[table][0][column] = null;
      const runPsql = vi.fn<SqlPublicPsqlRunner>(async () => JSON.stringify(unexpected));
      const result = await readSqlPublicSource(testOptions(sha256Hex(await readFile(dumpPath)), runPsql)).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(result).toBeInstanceOf(Error);
      expect(runPsql).toHaveBeenCalledOnce();
      if (result instanceof Error) {
        expect(result.message).toBe('Unable to read SQL public source');
      }
    },
  );

  it.each(SCHEMA_NULLABLE_FIELDS.map(({ table, column }) => [table, column] as const))(
    'accepts NULL for source nullable field %s.%s',
    async (table, column) => {
      const expected = syntheticCollections();
      expected[table][0][column] = null;
      const runPsql = vi.fn<SqlPublicPsqlRunner>(async () => JSON.stringify(expected));

      const result = await readSqlPublicSource(testOptions(sha256Hex(await readFile(dumpPath)), runPsql));

      expect((result[table][0] as unknown as Record<string, unknown>)[column]).toBeNull();
      expect(runPsql).toHaveBeenCalledOnce();
    },
  );

  it('rechecks the dump hash after psql finishes and rejects mutation during the read', async () => {
    const runPsql = vi.fn(async () => {
      await writeFile(dumpPath, 'SYNTHETIC MUTATED DUMP SENTINEL');
      return JSON.stringify(syntheticCollections());
    });

    await expect(readSqlPublicSource(testOptions(sha256Hex(await readFile(dumpPath)), runPsql)))
      .rejects.toThrow('SQL source changed during read');
    expect(runPsql).toHaveBeenCalledOnce();
  });

  it('does not expose psql stderr, secret markers, or raw dump content in a bounded failure', async () => {
    const secretMarker = 'SYNTHETIC_SECRET_MARKER_MUST_NOT_ESCAPE';
    const failure = Object.assign(new Error(`psql failed ${secretMarker}`), { stderr: `stderr ${secretMarker}` });
    const runPsql = vi.fn(async (): Promise<string> => { throw failure; });
    const result = await readSqlPublicSource(testOptions(sha256Hex(await readFile(dumpPath)), runPsql)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toBe('Unable to read SQL public source');
      expect(errorFootprint(result)).not.toContain(secretMarker);
    }
  });

  it('does not include raw malformed psql output in a parser failure', async () => {
    const rawMarker = 'SYNTHETIC_RAW_OUTPUT_SENTINEL';
    const runPsql = vi.fn(async () => `not-json ${rawMarker}`);
    const result = await readSqlPublicSource(testOptions(sha256Hex(await readFile(dumpPath)), runPsql)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toBe('Unable to read SQL public source');
      expect(errorFootprint(result)).not.toContain(rawMarker);
    }
  });
});
