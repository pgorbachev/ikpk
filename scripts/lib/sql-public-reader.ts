/** Native psql source-reader contract. The implementation is intentionally pending RED. */

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
  fileType: string;
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

/** RED scaffolding only: no dump hashing, SQL construction, psql invocation, or parsing yet. */
export async function readSqlPublicSource(_options: SqlPublicReaderOptions): Promise<SqlPublicReaderResult> {
  return {
    sourceHash: '',
    Institutes: [],
    Programs: [],
    Seminars: [],
    Teachers: [],
    TeachersAndInstitutes: [],
    SeminarsTeacher: [],
    Events: [],
    EventsAndTeachers: [],
    Articles: [],
    Cities: [],
    FileBindingOrganizationInfo: [],
    Files: [],
    InstituteAdditionalInfo: [],
    News: [],
    OrganizationInfo: [],
    Promotions: [],
    Videos: [],
  };
}
