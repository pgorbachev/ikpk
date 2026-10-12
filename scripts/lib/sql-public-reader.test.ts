import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSqlPublicSource,
  type SqlPublicPsqlInvocation,
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
  return JSON.stringify({ ownProperties, cause: record.cause, stderr: record.stderr, stack: error.stack });
}

function selectedTableQuery(sql: string, table: keyof typeof PUBLIC_COLUMNS): { columns: string[]; tail: string } {
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = sql.replace(/\s+/g, ' ');
  const match = normalized.match(new RegExp(
    `'${escapedTable}', COALESCE\\(\\(SELECT json_agg\\(r\\) FROM \\(SELECT ([\\s\\S]{1,2048}?) FROM "public"\\."${escapedTable}"([\\s\\S]{0,512}?)\\) AS r\\), '\\[\\]'::json\\)`,
    'i',
  ));
  if (!match) return { columns: [], tail: '' };
  return { columns: match[1].split(',').map((column) => column.trim()), tail: match[2] };
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
    const runPsql = vi.fn(async (_invocation: SqlPublicPsqlInvocation) => JSON.stringify(expected));

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
    const runPsql = vi.fn(async (_invocation: SqlPublicPsqlInvocation) => JSON.stringify(syntheticCollections()));

    await expect(readSqlPublicSource(testOptions('0'.repeat(64), runPsql)))
      .rejects.toThrow('SQL baseline hash does not match the expected SHA-256');
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('requires the caller hash to be raw 64-character SHA-256 hex', async () => {
    const runPsql = vi.fn(async (_invocation: SqlPublicPsqlInvocation) => JSON.stringify(syntheticCollections()));

    await expect(readSqlPublicSource(testOptions(`sha256:${'0'.repeat(64)}`, runPsql)))
      .rejects.toThrow('Expected dump hash must be 64 hexadecimal characters');
    expect(runPsql).not.toHaveBeenCalled();
  });

  it('uses one native, read-only psql invocation with explicit reviewed identifiers only', async () => {
    const runPsql = vi.fn(async (_invocation: SqlPublicPsqlInvocation) => JSON.stringify(syntheticCollections()));

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
      expect(query.tail).toMatch(/ORDER BY "id"/i);
    }
    expect(selectedTableQuery(sql, 'Files').tail).toMatch(/WHERE "privacy" = 'public'/i);
    expect(invocation.args).not.toContain('--password');
    expect(JSON.stringify(invocation)).not.toMatch(/password|PGPASSWORD/i);
  });

  it('rejects unexpected source tables or columns without leaking their contents', async () => {
    const marker = 'SYNTHETIC_PRIVATE_COLUMN_SENTINEL';
    const unexpected = syntheticCollections();
    unexpected.Users = [{ email: marker }];
    unexpected.Files[0].ownerId = marker;
    unexpected.Files[0].storageId = marker;
    const runPsql = vi.fn(async (_invocation: SqlPublicPsqlInvocation) => JSON.stringify(unexpected));
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

  it('rechecks the dump hash after psql finishes and rejects mutation during the read', async () => {
    const runPsql = vi.fn(async (_invocation: SqlPublicPsqlInvocation) => {
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
    const runPsql = vi.fn(async (_invocation: SqlPublicPsqlInvocation): Promise<string> => { throw failure; });
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
    const runPsql = vi.fn(async (_invocation: SqlPublicPsqlInvocation) => `not-json ${rawMarker}`);
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
