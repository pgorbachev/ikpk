/** Maps approved SQL source rows into public content DTOs and typed provenance. */

export interface SqlInstituteRow {
  id: number;
  name: string;
  shortName: string | null;
  description: string;
  imageId: string | null;
}

export interface SqlProgramRow {
  id: number;
  status: string;
  name: string;
  slug: string | null;
  instituteId: number;
  priority: number;
  seoTitle: string;
  seoDescription: string;
  content: string | null;
  imageId: string | null;
}

export interface SqlSeminarRow {
  id: number;
  status: string;
  name: string;
  slug: string | null;
  programId: number;
  description: string | null;
  curriculum: string | null;
  targetAudience: string | null;
  learningProcess: string | null;
  certificates: string | null;
  recommendations: string | null;
  priority: number;
  seoTitle: string;
  seoDescription: string;
}

export interface SqlTeacherRow {
  id: number;
  status: string;
  fullName: string;
  description: string;
  imageId: string | null;
  priority: number;
}

export interface SqlEventRow {
  id: number;
  status: string;
  seminarId: number;
  cityId: number;
  imageId: string | null;
  teacherId: number | null;
  oldPrice: number | null;
  newPrice: number;
  startAt: string;
  endAt: string;
  additionalText: string | null;
  duration: string | null;
  description: string | null;
  registrationFormLink: string | null;
  isFree: boolean;
  isEventCollection: boolean;
}

export interface SqlArticleRow {
  id: number;
  status: string;
  name: string;
  imageId: string | null;
  content: string;
  author: string;
  priority: number;
  seoTitle: string;
  seoDescription: string;
  slug: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SqlRowTimestamps { createdAt: string; updatedAt: string }

export interface SqlCitySourceRow extends SqlRowTimestamps { id: number; name: string; status: string }
export interface SqlFileBindingOrganizationInfoSourceRow extends SqlRowTimestamps {
  id: number; title: string | null; priority: number; fileId: string; organizationInfoId: number;
}
export interface SqlFileSourceRow extends SqlRowTimestamps {
  id: string; fileType: string | null; originalName: string | null; extension: string | null;
  url: string | null; status: string; privacy: string;
}
export interface SqlPublicDocumentEntity {
  sourceId: string;
  fileId: string;
  bindingSourceId: number;
  organizationInfoSourceId: number;
  title: string | null;
  priority: number;
  originalName: string | null;
  extension: string | null;
  fileType: string | null;
  url: string;
}
export interface SqlInstituteAdditionalInfoSourceRow extends SqlRowTimestamps {
  id: number; name: string | null; description: string | null; instituteId: number | null;
}
export interface SqlNewsSourceRow extends SqlRowTimestamps {
  id: number; name: string | null; description: string | null; imageId: string | null;
  status: string; link: string | null; priority: number;
}
export interface SqlOrganizationInfoSourceRow extends SqlRowTimestamps {
  id: number; name: string | null; priority: number; content: string | null; status: string;
}
export interface SqlPromotionSourceRow extends SqlRowTimestamps {
  id: number; name: string | null; description: string | null; imageId: string | null;
  link: string | null; status: string; priority: number; type: string | null;
}
export interface SqlVideoSourceRow extends SqlRowTimestamps {
  id: number; name: string | null; link: string | null; status: string;
  priority: number; imageId: string | null;
}

export interface SqlPublicSource {
  /** Hash of the pinned source artifact, supplied by its reader. */
  sourceHash: string;
  Institutes: SqlInstituteRow[];
  Programs: SqlProgramRow[];
  Seminars: SqlSeminarRow[];
  Teachers: SqlTeacherRow[];
  TeachersAndInstitutes: { teacherId: number; instituteId: number }[];
  SeminarsTeacher: { seminarId: number; teacherId: number }[];
  Events: SqlEventRow[];
  EventsAndTeachers: { eventId: number; teacherId: number }[];
  Articles: SqlArticleRow[];
  /** Added by the reviewed 17-table reader; optional for the approved six-collection mapper slice. */
  Cities?: SqlCitySourceRow[];
  FileBindingOrganizationInfo?: SqlFileBindingOrganizationInfoSourceRow[];
  Files?: SqlFileSourceRow[];
  InstituteAdditionalInfo?: SqlInstituteAdditionalInfoSourceRow[];
  News?: SqlNewsSourceRow[];
  OrganizationInfo?: SqlOrganizationInfoSourceRow[];
  Promotions?: SqlPromotionSourceRow[];
  Videos?: SqlVideoSourceRow[];
}

export interface SqlPublicContentOptions {
  /** Expected SHA-256 for the pinned baseline; mismatch must stop mapping. */
  expectedSourceHash: string;
  /** Existing accepted slug / legacy identity, keyed by source table and numeric SQL id. */
  acceptedLegacyIds: Partial<Record<
    'Institutes' | 'Programs' | 'Seminars' | 'Teachers' | 'Articles',
    Readonly<Record<number, string>>
  >>;
  /** Provisional, source-ID anchored labels; these are not owner approvals. */
  classificationCandidates?: {
    teachers?: { sourceId: number; trait: 'teacher' | 'method-author' }[];
    articles?: { sourceId: number; sourceProgramIds: number[] }[];
  };
}

export interface SqlPublicEntity {
  sourceId: number;
  legacy_id: string;
  [field: string]: unknown;
}

export interface SqlSluggedPublicEntity extends SqlPublicEntity {
  slug: string;
}

export interface SqlPublicContentResult {
  entities: {
    institutes: SqlSluggedPublicEntity[];
    programs: SqlSluggedPublicEntity[];
    seminars: SqlSluggedPublicEntity[];
    teachers: SqlSluggedPublicEntity[];
    events: SqlPublicEntity[];
    articles: SqlSluggedPublicEntity[];
    news?: SqlPublicEntity[];
    promotions?: SqlPublicEntity[];
    videos?: SqlSluggedPublicEntity[];
    organizationInfo?: SqlPublicEntity[];
    documents?: SqlPublicDocumentEntity[];
    instituteAdditionalInfo?: SqlPublicEntity[];
  };
  provenance: {
    sourceHash: string;
    sourceIdentity: { table: string; sourceId: number; targetSlug?: string; targetLegacyId: string }[];
    /** SQL playlist origin details retained for private audit, never emitted as public video fields. */
    videoMetadata: { sourceId: number; link: string | null; priority: number; imageId: string | null }[];
    exclusions: { table: string; sourceId: number | string; reason: string }[];
    rejectedRelations: { table: string; sourceId: number; relation: string; targetId: number; reason: string }[];
    classificationCandidates: {
      table: string;
      sourceId: number;
      sourceProgramId?: number;
      targetLegacyId?: string;
      value?: string;
      approval: 'pending';
    }[];
    sourceMetadata: (
      | {
          table: MappedTable;
          sourceId: number;
          field: 'certificates' | 'author' | 'priority' | 'teacherId';
          value: string | number | null;
        }
      | { table: 'News' | 'Promotions'; sourceId: number; field: 'createdAt'; value: string }
    )[];
  };
}

type MappedTable = 'Institutes' | 'Programs' | 'Seminars' | 'Teachers' | 'Events' | 'Articles';
type SourceTable = MappedTable | 'Cities' | 'News' | 'Promotions' | 'Videos' | 'OrganizationInfo' | 'FileBindingOrganizationInfo' | 'Files' | 'InstituteAdditionalInfo';

function invalid(table: SourceTable, id: number | string | undefined, field: string, reason: string): never {
  throw new Error(`Invalid SQL source ${table}${id === undefined ? '' : `#${id}`}: ${field} ${reason}`);
}

function requiredString(row: Record<string, unknown>, table: SourceTable, id: number | string, field: string, allowEmpty = false): string {
  const value = row[field];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) invalid(table, id, field, 'must be a non-empty string');
  return value;
}

function nullableString(row: Record<string, unknown>, table: SourceTable, id: number | string, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== 'string') invalid(table, id, field, 'must be a string or null');
  return value;
}

function recordId(row: { id: number }, table: SourceTable): number {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) invalid(table, row.id, 'id', 'must be a positive integer');
  return row.id;
}

function requireUniqueIds(rows: { id: number }[], table: SourceTable): void {
  const ids = new Set<number>();
  for (const row of rows) {
    const id = recordId(row, table);
    if (ids.has(id)) invalid(table, id, 'id', 'is duplicated');
    ids.add(id);
  }
}

function optionalRows<T>(rows: T[] | undefined, table: SourceTable): T[] {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new Error(`Invalid SQL source ${table}: rows must be an array`);
  return rows;
}

function activeRows<T extends { id: number; status: string }>(
  rows: T[],
  table: SourceTable,
  exclusions: SqlPublicContentResult['provenance']['exclusions'],
): T[] {
  const active: T[] = [];
  for (const row of rows) {
    const id = recordId(row, table);
    const status = requiredString(row as unknown as Record<string, unknown>, table, id, 'status');
    if (status === 'active') {
      active.push(row);
    } else if (status === 'deleted') {
      exclusions.push({ table, sourceId: id, reason: 'status is not active' });
    } else {
      invalid(table, id, 'status', `has unsupported value ${JSON.stringify(status)}`);
    }
  }
  return active;
}

function requireUniqueStringIds(rows: { id: string }[], table: SourceTable): void {
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id.trim() === '') invalid(table, row.id, 'id', 'must be a non-empty string');
    if (ids.has(row.id)) invalid(table, row.id, 'id', 'is duplicated');
    ids.add(row.id);
  }
}

function acceptedId(
  accepted: SqlPublicContentOptions['acceptedLegacyIds'],
  table: 'Institutes' | 'Programs' | 'Seminars' | 'Articles',
  id: number,
): string {
  const value = accepted[table]?.[id];
  if (typeof value !== 'string' || !value.trim()) invalid(table, id, 'acceptedLegacyIds', 'has no accepted target identity');
  return value;
}

function requireUniqueTargets(
  accepted: SqlPublicContentOptions['acceptedLegacyIds'],
  table: 'Institutes' | 'Programs' | 'Seminars' | 'Articles',
): void {
  const seen = new Map<string, number>();
  for (const [idText, value] of Object.entries(accepted[table] ?? {})) {
    const id = Number(idText);
    if (typeof value !== 'string' || !value.trim()) invalid(table, id, 'acceptedLegacyIds', 'has no accepted target identity');
    const previousId = seen.get(value);
    if (previousId !== undefined) invalid(table, id, `acceptedLegacyIds`, `duplicates target identity for source record #${previousId}`);
    seen.set(value, id);
  }
}

function seoFields(title: string, description: string): Record<string, string> | undefined {
  const seo: Record<string, string> = {};
  if (title.trim()) seo.seo_title = title;
  if (description.trim()) seo.seo_description = description;
  return Object.keys(seo).length ? seo : undefined;
}

function publicationDate(value: unknown, table: 'Articles' | 'News' | 'Promotions', id: number): string {
  if (typeof value !== 'string') return invalid(table, id, 'createdAt', 'must contain a valid SQL date');
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)?)?$/.exec(value);
  if (!match) return invalid(table, id, 'createdAt', 'must contain a valid SQL date');
  const day = match[1];
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== day) {
    return invalid(table, id, 'createdAt', 'must contain a valid SQL date');
  }
  return `${day}T00:00:00.000Z`;
}

function publicationTimestamp(value: unknown, table: 'News' | 'Promotions', id: number): string {
  if (typeof value !== 'string') return invalid(table, id, 'createdAt', 'must contain a valid timezone-less SQL timestamp');
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?)?$/.exec(value);
  if (!match) return invalid(table, id, 'createdAt', 'must contain a valid timezone-less SQL timestamp');

  const day = match[1];
  const parsedDay = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsedDay.valueOf()) || parsedDay.toISOString().slice(0, 10) !== day) {
    return invalid(table, id, 'createdAt', 'must contain a valid SQL calendar date');
  }

  const hour = match[2] ?? '00';
  const minute = match[3] ?? '00';
  const second = match[4] ?? '00';
  const milliseconds = (match[5] ?? '').slice(0, 3).padEnd(3, '0');
  const timestamp = `${day}T${hour}:${minute}:${second}.${milliseconds}Z`;
  const parsedTimestamp = new Date(timestamp);
  if (Number.isNaN(parsedTimestamp.valueOf()) || parsedTimestamp.toISOString() !== timestamp) {
    return invalid(table, id, 'createdAt', 'must contain a valid SQL clock time');
  }
  return timestamp;
}

function mapAudience(audience: string | null): string | undefined {
  if (audience === null || !audience.trim()) return undefined;
  return `<h2>Целевая аудитория</h2>\n${audience}`;
}

function sortSourceRows<T extends { sourceId: number }>(rows: T[]): T[] {
  return rows.sort((left, right) => left.sourceId - right.sourceId);
}

function sortProvenanceRows<T extends { table: string; sourceId: number | string }>(rows: T[]): T[] {
  return rows.sort((left, right) => {
    const byTable = left.table.localeCompare(right.table);
    if (byTable) return byTable;
    if (typeof left.sourceId === 'number' && typeof right.sourceId === 'number') return left.sourceId - right.sourceId;
    return String(left.sourceId).localeCompare(String(right.sourceId), undefined, { numeric: true });
  });
}

export function mapSqlPublicContent(source: SqlPublicSource, options: SqlPublicContentOptions): SqlPublicContentResult {
  if (!/^sha256:[a-f\d]{64}$/i.test(options.expectedSourceHash)) {
    throw new Error('Invalid expected SQL source hash: expected sha256 and 64 hexadecimal characters');
  }
  if (source.sourceHash !== options.expectedSourceHash) throw new Error('SQL source hash does not match the pinned baseline');

  const instituteIds = Object.keys(options.acceptedLegacyIds.Institutes ?? {}).map(Number).sort((a, b) => a - b);
  if (instituteIds.join(',') !== '1,2,3') {
    throw new Error('Invalid SQL source Institutes: acceptedLegacyIds must select source IDs 1, 2, and 3');
  }
  for (const table of ['Institutes', 'Programs', 'Seminars', 'Articles'] as const) requireUniqueTargets(options.acceptedLegacyIds, table);

  const tables: [MappedTable, { id: number }[]][] = [
    ['Institutes', source.Institutes], ['Programs', source.Programs], ['Seminars', source.Seminars],
    ['Teachers', source.Teachers], ['Events', source.Events], ['Articles', source.Articles],
  ];
  for (const [table, rows] of tables) {
    if (!Array.isArray(rows)) throw new Error(`Invalid SQL source ${table}: rows must be an array`);
    requireUniqueIds(rows, table);
  }
  for (const [name, rows] of [
    ['TeachersAndInstitutes', source.TeachersAndInstitutes],
    ['SeminarsTeacher', source.SeminarsTeacher],
    ['EventsAndTeachers', source.EventsAndTeachers],
  ] as const) {
    if (!Array.isArray(rows)) throw new Error(`Invalid SQL source ${name}: rows must be an array`);
    for (const relation of rows) {
      if (!Number.isSafeInteger(relation.teacherId) || relation.teacherId <= 0) {
        throw new Error(`Invalid SQL source ${name}: teacherId must be a positive integer`);
      }
      const parentId = 'instituteId' in relation ? relation.instituteId : 'seminarId' in relation ? relation.seminarId : relation.eventId;
      if (!Number.isSafeInteger(parentId) || parentId <= 0) throw new Error(`Invalid SQL source ${name}: parent ID must be a positive integer`);
    }
  }

  const provenance: SqlPublicContentResult['provenance'] = {
    sourceHash: source.sourceHash,
    sourceIdentity: [], exclusions: [], rejectedRelations: [], classificationCandidates: [], sourceMetadata: [], videoMetadata: [],
  };
  const addIdentity = (table: MappedTable, id: number, targetLegacyId: string, targetSlug?: string): void => {
    provenance.sourceIdentity.push({ table, sourceId: id, ...(targetSlug === undefined ? {} : { targetSlug }), targetLegacyId });
  };
  const addMetadata = (
    table: MappedTable, id: number, field: 'certificates' | 'author' | 'priority' | 'teacherId', value: string | number | null,
  ): void => { provenance.sourceMetadata.push({ table, sourceId: id, field, value }); };

  const selectedInstitutes = source.Institutes.filter((row) => Object.hasOwn(options.acceptedLegacyIds.Institutes ?? {}, row.id));
  for (const id of Object.keys(options.acceptedLegacyIds.Institutes ?? {})) {
    if (!source.Institutes.some((row) => row.id === Number(id))) invalid('Institutes', Number(id), 'source row', 'is missing for an accepted target identity');
  }
  const institutes = selectedInstitutes.map((row) => {
    const id = recordId(row, 'Institutes');
    const raw = row as unknown as Record<string, unknown>;
    const legacyId = acceptedId(options.acceptedLegacyIds, 'Institutes', id);
    const slug = legacyId.split('/').at(-1)!;
    const name = requiredString(raw, 'Institutes', id, 'name');
    const shortName = nullableString(raw, 'Institutes', id, 'shortName');
    const description = requiredString(raw, 'Institutes', id, 'description', true);
    const imageId = nullableString(raw, 'Institutes', id, 'imageId');
    addIdentity('Institutes', id, legacyId, slug);
    return { sourceId: id, legacy_id: legacyId, slug, name, shortName, description, imageId };
  });
  const instituteLegacyIds = new Map(institutes.map((item) => [item.sourceId, item.legacy_id]));

  const exclusions = provenance.exclusions;
  const cityRows = optionalRows(source.Cities, 'Cities');
  requireUniqueIds(cityRows, 'Cities');
  const activeCities = activeRows(cityRows, 'Cities', exclusions);
  const cityNames = new Map(activeCities.map((row) => [row.id, requiredString(row as unknown as Record<string, unknown>, 'Cities', row.id, 'name')]));

  const newsRows = optionalRows(source.News, 'News');
  requireUniqueIds(newsRows, 'News');
  const activeNews = activeRows(newsRows, 'News', exclusions);
  const promotionRows = optionalRows(source.Promotions, 'Promotions');
  requireUniqueIds(promotionRows, 'Promotions');
  const activePromotions = activeRows(promotionRows, 'Promotions', exclusions);
  const videoRows = optionalRows(source.Videos, 'Videos');
  requireUniqueIds(videoRows, 'Videos');
  const activeVideos = activeRows(videoRows, 'Videos', exclusions);
  const organizationInfoRows = optionalRows(source.OrganizationInfo, 'OrganizationInfo');
  requireUniqueIds(organizationInfoRows, 'OrganizationInfo');
  const activeOrganizationInfo = activeRows(organizationInfoRows, 'OrganizationInfo', exclusions);
  const instituteAdditionalInfoRows = optionalRows(source.InstituteAdditionalInfo, 'InstituteAdditionalInfo');
  requireUniqueIds(instituteAdditionalInfoRows, 'InstituteAdditionalInfo');

  const bindingRows = optionalRows(source.FileBindingOrganizationInfo, 'FileBindingOrganizationInfo');
  requireUniqueIds(bindingRows, 'FileBindingOrganizationInfo');
  const fileRows = optionalRows(source.Files, 'Files');
  requireUniqueStringIds(fileRows, 'Files');
  for (const file of fileRows) {
    if (file.status !== 'active' && file.status !== 'disabled' && file.status !== 'unlinked') {
      invalid('Files', file.id, 'status', `has unsupported value ${JSON.stringify(file.status)}`);
    }
    if (file.privacy !== 'public' && file.privacy !== 'private') invalid('Files', file.id, 'privacy', `has unsupported value ${JSON.stringify(file.privacy)}`);
    if (file.status !== 'active') exclusions.push({ table: 'Files', sourceId: file.id, reason: 'status is not active' });
    if (file.privacy === 'private') exclusions.push({ table: 'Files', sourceId: file.id, reason: 'privacy is not public' });
  }

  const news = activeNews.map((row) => {
    const id = recordId(row, 'News');
    if (!Number.isFinite(row.priority)) invalid('News', id, 'priority', 'must be numeric');
    const date = publicationTimestamp(row.createdAt, 'News', id);
    provenance.sourceMetadata.push({ table: 'News', sourceId: id, field: 'createdAt', value: row.createdAt });
    return {
      sourceId: id, legacy_id: String(id), name: requiredString(row as unknown as Record<string, unknown>, 'News', id, 'name'),
      description: nullableString(row as unknown as Record<string, unknown>, 'News', id, 'description'),
      imageId: nullableString(row as unknown as Record<string, unknown>, 'News', id, 'imageId'),
      date,
      link: nullableString(row as unknown as Record<string, unknown>, 'News', id, 'link'), priority: row.priority,
    };
  });

  const promotions = activePromotions.map((row) => {
    const id = recordId(row, 'Promotions');
    if (!Number.isFinite(row.priority)) invalid('Promotions', id, 'priority', 'must be numeric');
    if (row.type !== 'SHOP' && row.type !== 'INSTITUTE') invalid('Promotions', id, 'type', 'must be SHOP or INSTITUTE');
    const date = publicationTimestamp(row.createdAt, 'Promotions', id);
    provenance.sourceMetadata.push({ table: 'Promotions', sourceId: id, field: 'createdAt', value: row.createdAt });
    return {
      sourceId: id, legacy_id: String(id), name: requiredString(row as unknown as Record<string, unknown>, 'Promotions', id, 'name'),
      description: nullableString(row as unknown as Record<string, unknown>, 'Promotions', id, 'description'),
      imageId: nullableString(row as unknown as Record<string, unknown>, 'Promotions', id, 'imageId'),
      date,
      link: nullableString(row as unknown as Record<string, unknown>, 'Promotions', id, 'link'),
      priority: row.priority, type: row.type, active: true,
    };
  });

  const approvedVideoIds = new Set([31, 32, 33, 34, 36, 37]);
  if (source.Videos !== undefined) {
    const unexpected = activeVideos.find((row) => !approvedVideoIds.has(row.id));
    if (unexpected) invalid('Videos', unexpected.id, 'id', 'is not an approved playlist');
    const activeVideoIds = new Set(activeVideos.map((row) => row.id));
    for (const id of [...approvedVideoIds].sort((left, right) => left - right)) {
      if (!activeVideoIds.has(id)) invalid('Videos', id, 'id', 'is missing an active playlist');
    }
  }
  const videos = activeVideos.map((row) => {
    const id = recordId(row, 'Videos');
    if (!Number.isFinite(row.priority)) invalid('Videos', id, 'priority', 'must be numeric');
    return { sourceId: id, legacy_id: `video/pleylist/${id}`, slug: String(id), title: requiredString(row as unknown as Record<string, unknown>, 'Videos', id, 'name') };
  });
  provenance.videoMetadata = activeVideos.map((row) => {
    const id = recordId(row, 'Videos');
    if (!Number.isFinite(row.priority)) invalid('Videos', id, 'priority', 'must be numeric');
    return {
      sourceId: id,
      link: nullableString(row as unknown as Record<string, unknown>, 'Videos', id, 'link'),
      priority: row.priority,
      imageId: nullableString(row as unknown as Record<string, unknown>, 'Videos', id, 'imageId'),
    };
  }).sort((left, right) => left.sourceId - right.sourceId);

  const organizationInfo = activeOrganizationInfo.map((row) => {
    const id = recordId(row, 'OrganizationInfo');
    if (!Number.isFinite(row.priority)) invalid('OrganizationInfo', id, 'priority', 'must be numeric');
    return {
      sourceId: id, legacy_id: String(id), name: requiredString(row as unknown as Record<string, unknown>, 'OrganizationInfo', id, 'name'),
      content: nullableString(row as unknown as Record<string, unknown>, 'OrganizationInfo', id, 'content'), priority: row.priority,
    };
  }).sort((left, right) => left.priority - right.priority || left.sourceId - right.sourceId);

  const selectedInstituteIds = new Set(institutes.map((row) => row.sourceId));
  const instituteAdditionalInfo = instituteAdditionalInfoRows.map((row) => {
    const id = recordId(row, 'InstituteAdditionalInfo');
    if (!Number.isSafeInteger(row.instituteId) || row.instituteId === null || row.instituteId <= 0 || !selectedInstituteIds.has(row.instituteId)) {
      invalid('InstituteAdditionalInfo', id, 'instituteId', 'does not resolve to a selected institute');
    }
    return {
      sourceId: id, legacy_id: String(id),
      name: nullableString(row as unknown as Record<string, unknown>, 'InstituteAdditionalInfo', id, 'name'),
      description: nullableString(row as unknown as Record<string, unknown>, 'InstituteAdditionalInfo', id, 'description'),
      instituteId: row.instituteId,
    };
  });

  const organizationInfoIds = new Set(activeOrganizationInfo.map((row) => row.id));
  const filesById = new Map(fileRows.map((row) => [row.id, row]));
  const documents = bindingRows.map((binding) => {
    const bindingId = recordId(binding, 'FileBindingOrganizationInfo');
    if (!Number.isFinite(binding.priority)) invalid('FileBindingOrganizationInfo', bindingId, 'priority', 'must be numeric');
    const title = nullableString(binding as unknown as Record<string, unknown>, 'FileBindingOrganizationInfo', bindingId, 'title');
    const fileId = requiredString(binding as unknown as Record<string, unknown>, 'FileBindingOrganizationInfo', bindingId, 'fileId');
    if (!Number.isSafeInteger(binding.organizationInfoId) || binding.organizationInfoId <= 0 || !organizationInfoIds.has(binding.organizationInfoId)) {
      invalid('FileBindingOrganizationInfo', bindingId, 'organizationInfoId', 'does not resolve to an active organization section');
    }
    const file = filesById.get(fileId);
    if (!file) invalid('FileBindingOrganizationInfo', bindingId, 'fileId', `does not resolve to a file (${fileId})`);
    if (file.status !== 'active') invalid('FileBindingOrganizationInfo', bindingId, 'fileId', `does not resolve to an active file (${fileId})`);
    if (file.privacy !== 'public') invalid('FileBindingOrganizationInfo', bindingId, 'fileId', `does not resolve to a public file (${fileId})`);
    if (file.fileType !== 'application/pdf' || file.extension?.toLowerCase() !== 'pdf') {
      invalid('FileBindingOrganizationInfo', bindingId, 'fileId', `does not resolve to an approved PDF (${fileId})`);
    }
    return {
      sourceId: file.id, fileId: file.id, bindingSourceId: bindingId, organizationInfoSourceId: binding.organizationInfoId,
      title, priority: binding.priority,
      originalName: requiredString(file as unknown as Record<string, unknown>, 'Files', file.id, 'originalName'),
      extension: requiredString(file as unknown as Record<string, unknown>, 'Files', file.id, 'extension'),
      fileType: requiredString(file as unknown as Record<string, unknown>, 'Files', file.id, 'fileType'),
      url: requiredString(file as unknown as Record<string, unknown>, 'Files', file.id, 'url'),
    };
  }).sort((left, right) => left.priority - right.priority || left.bindingSourceId - right.bindingSourceId);
  const activePrograms = source.Programs.filter((row) => {
    const id = recordId(row, 'Programs');
    const status = requiredString(row as unknown as Record<string, unknown>, 'Programs', id, 'status');
    if (status === 'active') return true;
    exclusions.push({ table: 'Programs', sourceId: id, reason: 'status is not active' });
    return false;
  });
  const programs = activePrograms.map((row) => {
    const id = recordId(row, 'Programs');
    const raw = row as unknown as Record<string, unknown>;
    const slug = requiredString(raw, 'Programs', id, 'slug');
    const instituteLegacyId = instituteLegacyIds.get(row.instituteId);
    if (!instituteLegacyId) invalid('Programs', id, 'instituteId', 'does not resolve to a selected institute');
    const legacyId = acceptedId(options.acceptedLegacyIds, 'Programs', id);
    const name = requiredString(raw, 'Programs', id, 'name');
    const description = nullableString(raw, 'Programs', id, 'content');
    const imageId = nullableString(raw, 'Programs', id, 'imageId');
    const seo = seoFields(requiredString(raw, 'Programs', id, 'seoTitle', true), requiredString(raw, 'Programs', id, 'seoDescription', true));
    if (typeof row.priority !== 'number' || !Number.isFinite(row.priority)) invalid('Programs', id, 'priority', 'must be numeric');
    addMetadata('Programs', id, 'priority', row.priority);
    addIdentity('Programs', id, legacyId, slug);
    return { sourceId: id, legacy_id: legacyId, slug, name, description, imageId, order: row.priority, institute_legacy_id: instituteLegacyId, is_article_category: true, ...(seo ? { seo } : {}) };
  });
  const programLegacyIds = new Map(programs.map((item) => [item.sourceId, item.legacy_id]));

  const activeTeachers = source.Teachers.filter((row) => {
    const id = recordId(row, 'Teachers');
    const status = requiredString(row as unknown as Record<string, unknown>, 'Teachers', id, 'status');
    if (status === 'active') return true;
    exclusions.push({ table: 'Teachers', sourceId: id, reason: 'status is not active' });
    return false;
  });
  const activeTeacherIds = new Set(activeTeachers.map((row) => row.id));
  const teacherInstituteLinks = new Map<number, number[]>();
  for (const relation of source.TeachersAndInstitutes) {
    if (!activeTeacherIds.has(relation.teacherId)) continue;
    const links = teacherInstituteLinks.get(relation.teacherId) ?? [];
    links.push(relation.instituteId);
    teacherInstituteLinks.set(relation.teacherId, links);
  }
  const teachers = activeTeachers.map((row) => {
    const id = recordId(row, 'Teachers');
    const raw = row as unknown as Record<string, unknown>;
    const name = requiredString(raw, 'Teachers', id, 'fullName');
    const bio = requiredString(raw, 'Teachers', id, 'description', true);
    const imageId = nullableString(raw, 'Teachers', id, 'imageId');
    const links = teacherInstituteLinks.get(id) ?? [];
    if (links.length > 1) invalid('Teachers', id, 'TeachersAndInstitutes', 'must contain at most one institute relation');
    let instituteLegacyId: string | undefined;
    if (links.length === 1) {
      instituteLegacyId = instituteLegacyIds.get(links[0]);
      if (!instituteLegacyId) invalid('Teachers', id, 'TeachersAndInstitutes', 'does not resolve to a selected institute');
    }
    if (typeof row.priority !== 'number' || !Number.isFinite(row.priority)) invalid('Teachers', id, 'priority', 'must be numeric');
    addMetadata('Teachers', id, 'priority', row.priority);
    const targetId = String(id);
    addIdentity('Teachers', id, targetId, targetId);
    return { sourceId: id, legacy_id: targetId, slug: targetId, name, bio, imageId, order: row.priority, ...(instituteLegacyId ? { institute_legacy_id: instituteLegacyId } : {}) };
  });
  const activeTeacherSet = new Set(teachers.map((item) => item.sourceId));

  const seminarTeacherLinks = new Map<number, number[]>();
  for (const relation of source.SeminarsTeacher) {
    const links = seminarTeacherLinks.get(relation.seminarId) ?? [];
    links.push(relation.teacherId);
    seminarTeacherLinks.set(relation.seminarId, links);
  }
  const activeSeminars = source.Seminars.filter((row) => {
    const id = recordId(row, 'Seminars');
    const status = requiredString(row as unknown as Record<string, unknown>, 'Seminars', id, 'status');
    if (status === 'active') return true;
    exclusions.push({ table: 'Seminars', sourceId: id, reason: 'status is not active' });
    return false;
  });
  const seminars = activeSeminars.map((row) => {
    const id = recordId(row, 'Seminars');
    const raw = row as unknown as Record<string, unknown>;
    const slug = requiredString(raw, 'Seminars', id, 'slug');
    const programLegacyId = programLegacyIds.get(row.programId);
    if (!programLegacyId) invalid('Seminars', id, 'programId', 'does not resolve to an active program');
    const legacyId = acceptedId(options.acceptedLegacyIds, 'Seminars', id);
    const directTeachers = [...new Set((seminarTeacherLinks.get(id) ?? []).filter((teacherId) => {
      if (activeTeacherSet.has(teacherId)) return true;
      provenance.rejectedRelations.push({ table: 'SeminarsTeacher', sourceId: id, relation: 'teacherId', targetId: teacherId, reason: 'teacher is not active' });
      return false;
    }).map(String))].sort((a, b) => Number(a) - Number(b));
    const curriculum = nullableString(raw, 'Seminars', id, 'curriculum');
    const audience = nullableString(raw, 'Seminars', id, 'targetAudience');
    const learningProcess = nullableString(raw, 'Seminars', id, 'learningProcess');
    const recommendations = nullableString(raw, 'Seminars', id, 'recommendations');
    const certificates = nullableString(raw, 'Seminars', id, 'certificates');
    const seo = seoFields(requiredString(raw, 'Seminars', id, 'seoTitle', true), requiredString(raw, 'Seminars', id, 'seoDescription', true));
    const fullText = mapAudience(audience);
    if (typeof row.priority !== 'number' || !Number.isFinite(row.priority)) invalid('Seminars', id, 'priority', 'must be numeric');
    addMetadata('Seminars', id, 'priority', row.priority);
    if (certificates !== null) addMetadata('Seminars', id, 'certificates', certificates);
    addIdentity('Seminars', id, legacyId, slug);
    return {
      sourceId: id, legacy_id: legacyId, slug,
      name: requiredString(raw, 'Seminars', id, 'name'),
      description: nullableString(raw, 'Seminars', id, 'description'),
      course_group_legacy_id: programLegacyId, directTeachers,
      ...(fullText ? { full_text: fullText } : {}),
      ...(curriculum === null ? {} : { learning_mode: curriculum }),
      ...(learningProcess === null ? {} : { learning_plan: learningProcess }),
      ...(recommendations === null ? {} : { recommendations }),
      documents_state: 'unconfirmed', order: row.priority, ...(seo ? { seo } : {}),
    };
  });
  const seminarById = new Map(source.Seminars.map((row) => [row.id, row]));
  const activeSeminarSet = new Set(seminars.map((item) => item.sourceId));

  const eventTeacherLinks = new Map<number, number[]>();
  for (const relation of source.EventsAndTeachers) {
    const links = eventTeacherLinks.get(relation.eventId) ?? [];
    links.push(relation.teacherId);
    eventTeacherLinks.set(relation.eventId, links);
  }
  const events = source.Events.flatMap((row) => {
    const id = recordId(row, 'Events');
    const status = requiredString(row as unknown as Record<string, unknown>, 'Events', id, 'status');
    if (status !== 'active') {
      exclusions.push({ table: 'Events', sourceId: id, reason: 'status is not active' });
      return [];
    }
    if (!seminarById.has(row.seminarId)) invalid('Events', id, 'seminarId', 'does not resolve to a source seminar');
    if (!activeSeminarSet.has(row.seminarId)) {
      exclusions.push({ table: 'Events', sourceId: id, reason: `parent seminar ${row.seminarId} is not active` });
      return [];
    }
    const raw = row as unknown as Record<string, unknown>;
    if (typeof row.startAt !== 'string' || !row.startAt || typeof row.endAt !== 'string' || !row.endAt) invalid('Events', id, 'startAt/endAt', 'must be non-empty SQL values');
    if (typeof row.cityId !== 'number' || !Number.isSafeInteger(row.cityId) || row.cityId <= 0) invalid('Events', id, 'cityId', 'must be a positive integer');
    if (typeof row.newPrice !== 'number' || !Number.isFinite(row.newPrice)) invalid('Events', id, 'newPrice', 'must be numeric');
    if (typeof row.isFree !== 'boolean' || typeof row.isEventCollection !== 'boolean') invalid('Events', id, 'flags', 'must be boolean');
    if (row.teacherId !== null && (!Number.isSafeInteger(row.teacherId) || row.teacherId <= 0)) invalid('Events', id, 'teacherId', 'must be a positive integer or null');
    if (row.teacherId !== null) addMetadata('Events', id, 'teacherId', row.teacherId);
    const primaryTeachers = [...new Set((eventTeacherLinks.get(id) ?? []).filter((teacherId) => {
      if (activeTeacherSet.has(teacherId)) return true;
      provenance.rejectedRelations.push({ table: 'EventsAndTeachers', sourceId: id, relation: 'teacherId', targetId: teacherId, reason: 'teacher is not active' });
      return false;
    }).map(String))].sort((a, b) => Number(a) - Number(b));
    const legacyId = String(id);
    addIdentity('Events', id, legacyId);
    const city = cityNames.get(row.cityId);
    if (source.Cities !== undefined && city === undefined) invalid('Events', id, 'cityId', `does not resolve to an active city (${row.cityId})`);
    return [{
      sourceId: id, legacy_id: legacyId, seminar_legacy_id: acceptedId(options.acceptedLegacyIds, 'Seminars', row.seminarId),
      ...(source.Cities === undefined ? { cityId: row.cityId } : { city }),
      imageId: nullableString(raw, 'Events', id, 'imageId'), oldPrice: row.oldPrice, newPrice: row.newPrice,
      startAt: row.startAt, endAt: row.endAt,
      additionalText: nullableString(raw, 'Events', id, 'additionalText'), duration: nullableString(raw, 'Events', id, 'duration'),
      description: nullableString(raw, 'Events', id, 'description'),
      registrationFormLink: nullableString(raw, 'Events', id, 'registrationFormLink'),
      isFree: row.isFree, isEventCollection: row.isEventCollection, primaryTeachers,
    }];
  });

  const activeArticles = source.Articles.filter((row) => {
    const id = recordId(row, 'Articles');
    const status = requiredString(row as unknown as Record<string, unknown>, 'Articles', id, 'status');
    if (status === 'active') return true;
    exclusions.push({ table: 'Articles', sourceId: id, reason: 'status is not active' });
    return false;
  });
  const articles = activeArticles.map((row) => {
    const id = recordId(row, 'Articles');
    const raw = row as unknown as Record<string, unknown>;
    const slug = requiredString(raw, 'Articles', id, 'slug');
    const legacyId = acceptedId(options.acceptedLegacyIds, 'Articles', id);
    const title = requiredString(raw, 'Articles', id, 'name');
    const body = requiredString(raw, 'Articles', id, 'content', true);
    const publishedDate = publicationDate(row.createdAt, 'Articles', id);
    const imageId = nullableString(raw, 'Articles', id, 'imageId');
    const seo = seoFields(requiredString(raw, 'Articles', id, 'seoTitle', true), requiredString(raw, 'Articles', id, 'seoDescription', true));
    if (typeof row.priority !== 'number' || !Number.isFinite(row.priority)) invalid('Articles', id, 'priority', 'must be numeric');
    addMetadata('Articles', id, 'priority', row.priority);
    addMetadata('Articles', id, 'author', requiredString(raw, 'Articles', id, 'author', true));
    addIdentity('Articles', id, legacyId, slug);
    return { sourceId: id, legacy_id: legacyId, slug, title, body, imageId, published_date: publishedDate, ...(seo ? { seo } : {}) };
  });

  for (const candidate of options.classificationCandidates?.teachers ?? []) {
    if (!activeTeacherSet.has(candidate.sourceId)) invalid('Teachers', candidate.sourceId, 'classification candidate', 'does not reference an active teacher');
    provenance.classificationCandidates.push({ table: 'Teachers', sourceId: candidate.sourceId, value: candidate.trait, approval: 'pending' });
  }
  const activeArticleIds = new Set(articles.map((item) => item.sourceId));
  for (const candidate of options.classificationCandidates?.articles ?? []) {
    if (!activeArticleIds.has(candidate.sourceId)) invalid('Articles', candidate.sourceId, 'classification candidate', 'does not reference an active article');
    if (!Array.isArray(candidate.sourceProgramIds) || candidate.sourceProgramIds.length === 0) invalid('Articles', candidate.sourceId, 'sourceProgramIds', 'must identify an active program');
    for (const programId of [...new Set(candidate.sourceProgramIds)].sort((a, b) => a - b)) {
      const legacyId = programLegacyIds.get(programId);
      if (!legacyId) invalid('Articles', candidate.sourceId, 'sourceProgramIds', 'contains a program without an active target identity');
      provenance.classificationCandidates.push({ table: 'Articles', sourceId: candidate.sourceId, sourceProgramId: programId, targetLegacyId: legacyId, approval: 'pending' });
    }
  }

  return {
    entities: {
      institutes: sortSourceRows(institutes), programs: sortSourceRows(programs), seminars: sortSourceRows(seminars),
      teachers: sortSourceRows(teachers), events: sortSourceRows(events), articles: sortSourceRows(articles),
      news: news.sort((left, right) => left.priority - right.priority || left.sourceId - right.sourceId),
      promotions: promotions.sort((left, right) => left.priority - right.priority || left.sourceId - right.sourceId),
      videos: sortSourceRows(videos), organizationInfo, documents,
      instituteAdditionalInfo: sortSourceRows(instituteAdditionalInfo),
    },
    provenance: {
      ...provenance,
      sourceIdentity: provenance.sourceIdentity.sort((a, b) => a.table.localeCompare(b.table) || a.sourceId - b.sourceId),
      exclusions: sortProvenanceRows(provenance.exclusions),
      rejectedRelations: provenance.rejectedRelations.sort((a, b) => a.table.localeCompare(b.table) || a.sourceId - b.sourceId || a.targetId - b.targetId),
      classificationCandidates: provenance.classificationCandidates.sort((a, b) => a.table.localeCompare(b.table) || a.sourceId - b.sourceId || (a.sourceProgramId ?? 0) - (b.sourceProgramId ?? 0)),
      sourceMetadata: provenance.sourceMetadata.sort((a, b) => a.table.localeCompare(b.table) || a.sourceId - b.sourceId || a.field.localeCompare(b.field)),
    },
  };
}
