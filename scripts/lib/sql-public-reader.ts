/** Native psql source reader for the reviewed public SQL projection. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type {
  SqlArticleRow,
  SqlEventRow,
  SqlInstituteRow,
  SqlProgramRow,
  SqlPublicSource,
  SqlSeminarRow,
  SqlTeacherRow,
} from './sql-public-content';

type WithSqlTimestamps<Row> = Row & { createdAt: string; updatedAt: string };

export interface SqlPublicReaderConnection {
  /** Trusted PostgreSQL Unix-socket directory; no password is accepted by this API. */
  unixSocketPath: string;
  port: number;
  database: string;
  user: string;
}

export interface SqlPublicPsqlInvocation {
  command: 'psql';
  args: readonly string[];
  connection: Readonly<SqlPublicReaderConnection>;
}

export type SqlPublicPsqlRunner = (invocation: SqlPublicPsqlInvocation) => Promise<string>;

export interface SqlPublicReaderOptions {
  dumpPath: string;
  /** Raw, lowercase 64-character SHA-256 hex digest for the immutable dump artifact. */
  expectedDumpHash: string;
  connection: SqlPublicReaderConnection;
  /** Test seam only; production uses the native `psql` executable. */
  runPsql?: SqlPublicPsqlRunner;
}

type SqlNullableText = string | null;
type SqlNullableInteger = number | null;

export interface SqlCitySourceRow {
  createdAt: string;
  updatedAt: string;
  id: number;
  name: string;
  status: string;
}

export interface SqlFileBindingOrganizationInfoSourceRow {
  createdAt: string;
  updatedAt: string;
  id: number;
  title: SqlNullableText;
  priority: number;
  fileId: string;
  organizationInfoId: number;
}

export interface SqlFileSourceRow {
  createdAt: string;
  updatedAt: string;
  id: string;
  fileType: string | null;
  originalName: SqlNullableText;
  extension: SqlNullableText;
  url: SqlNullableText;
  status: string;
  privacy: string;
}

export interface SqlInstituteAdditionalInfoSourceRow {
  createdAt: string;
  updatedAt: string;
  id: number;
  name: SqlNullableText;
  description: SqlNullableText;
  instituteId: SqlNullableInteger;
}

export interface SqlNewsSourceRow {
  createdAt: string;
  updatedAt: string;
  id: number;
  name: SqlNullableText;
  description: SqlNullableText;
  imageId: string | null;
  status: string;
  link: SqlNullableText;
  priority: number;
}

export interface SqlOrganizationInfoSourceRow {
  createdAt: string;
  updatedAt: string;
  id: number;
  name: SqlNullableText;
  priority: number;
  content: SqlNullableText;
  status: string;
}

export interface SqlPromotionSourceRow {
  createdAt: string;
  updatedAt: string;
  id: number;
  name: SqlNullableText;
  description: SqlNullableText;
  imageId: string | null;
  link: SqlNullableText;
  status: string;
  priority: number;
  type: SqlNullableText;
}

export interface SqlVideoSourceRow {
  createdAt: string;
  updatedAt: string;
  id: number;
  name: SqlNullableText;
  link: SqlNullableText;
  status: string;
  priority: number;
  imageId: string | null;
}

/** Private source DTO: includes all 17 reviewed tables and remains compatible with the mapper. */
export interface SqlPublicReaderResult extends SqlPublicSource {
  Institutes: WithSqlTimestamps<SqlInstituteRow>[];
  Programs: WithSqlTimestamps<SqlProgramRow>[];
  Seminars: WithSqlTimestamps<SqlSeminarRow>[];
  Teachers: WithSqlTimestamps<SqlTeacherRow>[];
  Events: WithSqlTimestamps<SqlEventRow>[];
  Articles: SqlArticleRow[];
  TeachersAndInstitutes: WithSqlTimestamps<{ teacherId: number; instituteId: number }>[];
  SeminarsTeacher: WithSqlTimestamps<{ seminarId: number; teacherId: number }>[];
  EventsAndTeachers: WithSqlTimestamps<{ eventId: number; teacherId: number }>[];
  Cities: SqlCitySourceRow[];
  FileBindingOrganizationInfo: SqlFileBindingOrganizationInfoSourceRow[];
  Files: SqlFileSourceRow[];
  InstituteAdditionalInfo: SqlInstituteAdditionalInfoSourceRow[];
  News: SqlNewsSourceRow[];
  OrganizationInfo: SqlOrganizationInfoSourceRow[];
  Promotions: SqlPromotionSourceRow[];
  Videos: SqlVideoSourceRow[];
}

const TABLE_COLUMNS = {
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

type ReaderTable = keyof typeof TABLE_COLUMNS;

const NULLABLE_COLUMNS: Partial<Record<ReaderTable, readonly string[]>> = {
  Articles: ['imageId', 'slug'],
  Events: ['imageId', 'teacherId', 'oldPrice', 'additionalText', 'duration', 'description', 'registrationFormLink'],
  FileBindingOrganizationInfo: ['title'],
  Files: ['fileType', 'originalName', 'extension', 'url'],
  InstituteAdditionalInfo: ['name', 'description', 'instituteId'],
  Institutes: ['imageId', 'shortName'],
  News: ['name', 'description', 'imageId', 'link'],
  OrganizationInfo: ['name', 'content'],
  Programs: ['imageId', 'slug', 'content'],
  Promotions: ['name', 'description', 'imageId', 'link', 'type'],
  Seminars: ['description', 'curriculum', 'targetAudience', 'learningProcess', 'certificates', 'recommendations', 'slug'],
  Teachers: ['imageId'],
  Videos: ['name', 'link', 'imageId'],
};

const execFileAsync = promisify(execFile);
const MAX_PSQL_OUTPUT_BYTES = 64 * 1024 * 1024;

function buildSql(): string {
  const collections = Object.entries(TABLE_COLUMNS).map(([table, columns]) => {
    const projection = columns.map((column) => `"${column}"`).join(', ');
    const publicFilesPredicate = table === 'Files' ? ` WHERE "privacy" = 'public'` : '';
    return `'${table}', COALESCE((SELECT json_agg(r) FROM (SELECT ${projection} FROM "public"."${table}"${publicFilesPredicate} ORDER BY "id") AS r), '[]'::json)`;
  });

  return [
    'BEGIN READ ONLY;',
    'SET LOCAL default_transaction_read_only = on;',
    `SELECT json_build_object(${collections.join(', ')});`,
    'ROLLBACK;',
  ].join('\n');
}

async function runNativePsql(invocation: SqlPublicPsqlInvocation): Promise<string> {
  const result = await execFileAsync(invocation.command, [...invocation.args], {
    encoding: 'utf8',
    maxBuffer: MAX_PSQL_OUTPUT_BYTES,
  });
  return result.stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(value);
}

function validateColumnValue(table: ReaderTable, column: string, value: unknown): boolean {
  if (value === null) return (NULLABLE_COLUMNS[table] ?? []).includes(column);
  if (column === 'createdAt' || column === 'updatedAt') return typeof value === 'string' && isTimestamp(value);
  if (column === 'startAt' || column === 'endAt') return typeof value === 'string' && isDate(value);
  if (column === 'isFree' || column === 'isEventCollection') return typeof value === 'boolean';
  if (column === 'imageId' || column === 'fileId' || (table === 'Files' && column === 'id')) return typeof value === 'string';
  if (column === 'oldPrice' || column === 'newPrice' || column === 'priority' || column === 'id' || column.endsWith('Id')) {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === 'string';
}

function validateSource(value: unknown): asserts value is Omit<SqlPublicReaderResult, 'sourceHash'> {
  if (!isRecord(value)) throw new Error('Invalid source');
  const expectedTables = Object.keys(TABLE_COLUMNS).sort();
  if (Object.keys(value).sort().join('\0') !== expectedTables.join('\0')) throw new Error('Invalid source');

  for (const table of expectedTables as ReaderTable[]) {
    const rows = value[table];
    if (!Array.isArray(rows)) throw new Error('Invalid source');
    const expectedColumns = TABLE_COLUMNS[table];
    for (const row of rows) {
      if (!isRecord(row) || Object.keys(row).sort().join('\0') !== [...expectedColumns].sort().join('\0')) {
        throw new Error('Invalid source');
      }
      for (const column of expectedColumns) {
        if (!validateColumnValue(table, column, row[column])) throw new Error('Invalid source');
      }
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function genericReadError(): Error {
  return new Error('Unable to read SQL public source');
}

/** Reads only the reviewed public source projection in one native read-only transaction. */
export async function readSqlPublicSource(options: SqlPublicReaderOptions): Promise<SqlPublicReaderResult> {
  if (typeof options.expectedDumpHash !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedDumpHash)) {
    throw new Error('Expected dump hash must be 64 hexadecimal characters');
  }

  let dumpBytes: Buffer;
  try {
    dumpBytes = await readFile(options.dumpPath);
  } catch {
    throw genericReadError();
  }
  const actualHash = sha256(dumpBytes);
  if (actualHash !== options.expectedDumpHash) {
    throw new Error('SQL baseline hash does not match the expected SHA-256');
  }

  const connection = Object.freeze({ ...options.connection });
  const sql = buildSql();
  const invocation: SqlPublicPsqlInvocation = {
    command: 'psql',
    args: [
      '-X', '-w', '-h', connection.unixSocketPath, '-p', String(connection.port),
      '-U', connection.user, '-d', connection.database, '-A', '-t', '-q', '-v',
      'ON_ERROR_STOP=1', '-c', sql,
    ],
    connection,
  };

  let stdout: string;
  try {
    stdout = options.runPsql ? await options.runPsql(invocation) : await runNativePsql(invocation);
  } catch {
    throw genericReadError();
  }

  try {
    const afterHash = sha256(await readFile(options.dumpPath));
    if (afterHash !== actualHash) throw new Error('SQL source changed during read');
  } catch (error) {
    if (error instanceof Error && error.message === 'SQL source changed during read') throw error;
    throw genericReadError();
  }

  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    validateSource(parsed);
    return { sourceHash: `sha256:${actualHash}`, ...parsed };
  } catch {
    throw genericReadError();
  }
}
