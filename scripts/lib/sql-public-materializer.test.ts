import { describe, expect, it } from 'vitest';
import {
  mapSqlPublicContent,
  type SqlPublicSource,
} from './sql-public-content.js';
import {
  materializeSqlPublicContent,
  type SqlResolvedMedia,
  type SqlStrapiRestClient,
} from './sql-public-materializer.js';

const SOURCE_HASH = `sha256:${'a'.repeat(64)}`;

const SOURCE: SqlPublicSource = {
  sourceHash: SOURCE_HASH,
  Institutes: [
    { id: 1, name: 'Institute One', shortName: 'I1', description: 'Institute description', imageId: 'image-institute' },
    { id: 2, name: 'Institute Two', shortName: null, description: 'Institute Two description', imageId: null },
    { id: 3, name: 'Institute Three', shortName: null, description: 'Institute Three description', imageId: null },
  ],
  Programs: [
    { id: 11, status: 'active', name: 'Program One', slug: 'program-one', instituteId: 1, priority: 4, seoTitle: 'Program SEO', seoDescription: 'Program summary', content: 'Program description', imageId: 'image-program' },
    { id: 12, status: 'active', name: 'Program Two', slug: 'program-two', instituteId: 3, priority: 8, seoTitle: 'Program Two SEO', seoDescription: 'Program Two summary', content: 'Program Two description', imageId: null },
  ],
  Seminars: [
    { id: 21, status: 'active', name: 'Seminar One', slug: 'seminar-one', programId: 11, description: 'Seminar description', curriculum: 'CURRICULUM_SENTINEL', targetAudience: 'AUDIENCE_SENTINEL', learningProcess: 'LEARNING_PLAN_SENTINEL', certificates: 'PRIVATE_CERTIFICATE_SENTINEL', recommendations: 'RECOMMENDATIONS_SENTINEL', priority: 3, seoTitle: 'Seminar SEO', seoDescription: 'Seminar summary' },
  ],
  Teachers: [
    { id: 101, status: 'active', fullName: 'Teacher One', description: 'Teacher bio', imageId: 'image-teacher', priority: 5 },
    { id: 102, status: 'active', fullName: 'Teacher Two', description: '', imageId: null, priority: 6 },
  ],
  TeachersAndInstitutes: [
    { teacherId: 101, instituteId: 1 },
  ],
  SeminarsTeacher: [
    { seminarId: 21, teacherId: 101 },
    { seminarId: 21, teacherId: 102 },
  ],
  Events: [
    {
      id: 301, status: 'active', seminarId: 21, cityId: 7, imageId: 'image-event', teacherId: 101,
      oldPrice: 90, newPrice: 120, startAt: '2030-05-10T09:00:00.000Z', endAt: '2030-05-10T16:00:00.000Z',
      additionalText: 'EVENT_ADDITIONAL_SENTINEL', duration: '7 hours', description: 'Event description',
      registrationFormLink: 'https://synthetic.invalid/register', isFree: false, isEventCollection: true,
    },
  ],
  EventsAndTeachers: [
    { eventId: 301, teacherId: 101 },
    { eventId: 301, teacherId: 102 },
  ],
  Articles: [
    { id: 401, status: 'active', name: 'Article One', imageId: 'image-article', content: 'Article body', author: 'PRIVATE_AUTHOR_SENTINEL', priority: 11, seoTitle: 'Article SEO', seoDescription: 'Article summary', slug: 'article-one', createdAt: '2021-03-04T22:10:00.000Z', updatedAt: '2024-11-12T12:00:00.000Z' },
    { id: 402, status: 'active', name: 'Article Two', imageId: 'image-article-two', content: 'Article Two body', author: '', priority: 12, seoTitle: 'Article Two SEO', seoDescription: 'Article Two summary', slug: 'article-two', createdAt: '2022-08-09T00:00:00.000Z', updatedAt: '2024-12-01T00:00:00.000Z' },
  ],
};

const MAPPED_FROM_SQL = mapSqlPublicContent(SOURCE, {
  expectedSourceHash: SOURCE_HASH,
  acceptedLegacyIds: {
    Institutes: { 1: 'institutes/one', 2: 'institutes/two', 3: 'institutes/three' },
    Programs: { 11: 'program-one', 12: 'program-two' },
    Seminars: { 21: 'seminar-one' },
    Articles: { 401: 'article-one', 402: 'article-two' },
  },
  classificationCandidates: {
    teachers: [{ sourceId: 101, trait: 'method-author' }],
    articles: [{ sourceId: 401, sourceProgramIds: [11] }],
  },
});

// Synthetic accepted supplements make this rehearsal-shaped DTO publishable without importing
// private source rows: institute slug/order/SEO are supplied by the accepted supplement contract,
// while event city/name/status are explicit phase projections. No production values are implied.
const MAPPED = structuredClone(MAPPED_FROM_SQL);
for (const [index, institute] of MAPPED.entities.institutes.entries()) {
  institute.order = index + 1;
  institute.seo = { seo_title: `Synthetic Institute SEO ${index + 1}`, seo_description: `Synthetic Institute summary ${index + 1}` };
}
MAPPED.entities.events[0]!.name = 'Synthetic Event One';
MAPPED.entities.events[0]!.city = 'Synthetic City';
MAPPED.entities.events[0]!.entry_status = 'active';

type Collection = 'institutes' | 'course-groups' | 'teachers' | 'seminars' | 'schedule-entries' | 'articles';
type StoredDocument = Record<string, unknown> & { id: number; documentId: string; publishedAt: string | null };

const ALLOWED_FIELDS: Record<Collection, ReadonlySet<string>> = {
  institutes: new Set(['name', 'slug', 'shortName', 'description', 'image', 'order', 'legacy_id', 'seo']),
  'course-groups': new Set(['name', 'slug', 'description', 'image', 'legacy_id', 'institute', 'seo', 'order', 'is_article_category']),
  teachers: new Set(['name', 'slug', 'trait', 'order', 'institute', 'photo', 'bio', 'legacy_id']),
  seminars: new Set(['name', 'slug', 'description', 'full_text', 'legacy_id', 'course_group', 'teachers', 'seo', 'order', 'learning_plan', 'learning_mode', 'recommendations', 'documents_state']),
  'schedule-entries': new Set(['name', 'admin_label', 'startAt', 'endAt', 'city', 'price', 'oldPrice', 'isFree', 'entry_status', 'registrationFormLink', 'description', 'additionalText', 'duration', 'legacy_id', 'seminar', 'teachers', 'image', 'isEventCollection']),
  articles: new Set(['title', 'slug', 'body', 'image', 'published_date', 'legacy_id', 'seo', 'categories']),
};

class SyntheticStrapiTarget implements SqlStrapiRestClient {
  readonly documents = new Map<Collection, StoredDocument[]>();
  readonly requests: { method: string; path: string; body?: unknown }[] = [];
  readonly mediaById = new Map<number, SqlResolvedMedia>();
  private nextId = 1;
  private readonly nonce: string;

  constructor(nonce: string) {
    this.nonce = nonce;
  }

  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    this.requests.push({ method, path, body });
    const url = new URL(path, 'http://synthetic-cms.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] === 'admin' || path.includes('/actions/publish')) {
      throw new Error(`synthetic target rejects non-public Content API route ${path}`);
    }
    const collection = parts[1] as Collection;
    if (!Object.hasOwn(ALLOWED_FIELDS, collection)) throw new Error(`unknown Content API collection ${collection}`);
    const items = this.documents.get(collection) ?? [];
    this.documents.set(collection, items);

    if (method === 'GET') {
      const legacyId = url.searchParams.get('filters[legacy_id][$eq]');
      const status = url.searchParams.get('status') ?? 'published';
      const byStatus = items.filter((entry) => status === 'draft'
        ? entry.publishedAt === null
        : typeof entry.publishedAt === 'string');
      if (parts.length === 3) {
        return { data: byStatus.find((entry) => entry.documentId === parts[2]) ?? null };
      }
      return { data: legacyId ? byStatus.filter((entry) => entry.legacy_id === legacyId) : byStatus };
    }

    if (method === 'POST' && parts.length === 2) {
      if (url.searchParams.get('status') !== 'draft') throw new Error('synthetic Content API creates must start as drafts');
      const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      this.assertAllowedFields(collection, data);
      const next = this.nextId++;
      const entry: StoredDocument = {
        ...data,
        id: next,
        documentId: `${this.nonce}-${collection}-${next}`,
        publishedAt: null,
      };
      items.push(entry);
      return { data: entry };
    }

    const documentId = parts[2];
    const entry = items.find((item) => item.documentId === documentId);
    if (!entry) throw new Error(`synthetic target has no ${collection}/${documentId}`);

    if (method === 'PUT') {
      const status = url.searchParams.get('status');
      const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      this.assertAllowedFields(collection, data);
      for (const [field, value] of Object.entries(data)) {
        if (['institute', 'course_group', 'teachers', 'seminar', 'categories'].includes(field)) {
          this.applyRelation(entry, field, value);
        } else {
          entry[field] = value;
        }
      }
      if (status === 'published') {
        this.assertPublishable(collection, entry);
        entry.publishedAt = '2030-01-01T00:00:00.000Z';
      } else if (status !== 'draft') {
        throw new Error(`synthetic Content API update requires explicit draft or published status: ${path}`);
      }
      return { data: entry };
    }

    throw new Error(`unexpected synthetic Strapi request ${method} ${path}`);
  }

  private assertAllowedFields(collection: Collection, data: Record<string, unknown>): void {
    const unexpected = Object.keys(data).filter((field) => !ALLOWED_FIELDS[collection].has(field));
    if (unexpected.length) throw new Error(`unexpected ${collection} attributes: ${unexpected.join(', ')}`);
  }

  private assertPublishable(collection: Collection, data: Record<string, unknown>): void {
    const required: Record<Collection, string[]> = {
      institutes: ['name', 'slug', 'description', 'order', 'seo'],
      'course-groups': ['name', 'slug', 'institute', 'seo'],
      teachers: ['name', 'slug', 'trait'],
      seminars: ['name', 'slug', 'course_group', 'description', 'seo', 'documents_state'],
      'schedule-entries': ['seminar', 'startAt', 'endAt', 'city', 'entry_status'],
      articles: ['title', 'slug', 'body', 'seo', 'image', 'published_date', 'categories'],
    };
    const missing = required[collection].filter((field) => {
      const value = data[field];
      if (field === 'seo') {
        const seo = value as { seo_title?: unknown; seo_description?: unknown } | undefined;
        return !seo?.seo_title || !seo.seo_description;
      }
      return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    });
    if (missing.length) throw new Error(`synthetic ${collection} cannot publish without ${missing.join(', ')}`);
  }

  private applyRelation(entry: StoredDocument, field: string, value: unknown): void {
    if (value === null) {
      entry[field] = [];
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`synthetic relation ${field} requires set/connect/disconnect operation`);
    }
    const operation = value as { set?: unknown; connect?: unknown; disconnect?: unknown };
    const current = relationDocumentIds(entry[field]);
    if ('set' in operation) {
      entry[field] = relationRefs(operation.set);
      return;
    }
    let next = current;
    if (operation.disconnect === true) next = [];
    else if (operation.disconnect !== undefined && operation.disconnect !== false && operation.disconnect !== null) {
      const removed = new Set(relationDocumentIds(operation.disconnect));
      next = next.filter((id) => !removed.has(id));
    }
    if ('connect' in operation) {
      for (const id of relationDocumentIds(operation.connect)) if (!next.includes(id)) next.push(id);
    }
    entry[field] = relationRefs(next);
  }
}

class SyntheticMediaResolver {
  readonly uploads = new Map<SyntheticStrapiTarget, Map<string, SqlResolvedMedia>>();
  failures = new Set<string>();
  hashMismatches = new Set<string>();
  private nextId = 900;

  async resolve(sourceImageId: string, target: SqlStrapiRestClient): Promise<SqlResolvedMedia> {
    if (!(target instanceof SyntheticStrapiTarget)) throw new Error('unexpected target implementation');
    if (this.failures.has(sourceImageId)) throw new Error(`offline for ${sourceImageId}`);
    if (this.hashMismatches.has(sourceImageId)) throw new Error('source or stored hash verification failed');
    let targetMedia = this.uploads.get(target);
    if (!targetMedia) {
      targetMedia = new Map();
      this.uploads.set(target, targetMedia);
    }
    const existing = targetMedia.get(sourceImageId);
    if (existing) return existing;
    const digest = String(sourceImageId.length).padStart(2, '0').repeat(32);
    const result = {
      id: this.nextId++,
      sourceHash: digest,
      // A verified image transform can change bytes; the boundary verifies each hash against
      // its own bytes rather than requiring source and stored hashes to match each other.
      storedHash: 'b'.repeat(64),
      sourceIdentity: `private-sql-image:${sourceImageId}`,
    };
    targetMedia.set(sourceImageId, result);
    target.mediaById.set(result.id, result);
    return result;
  }
}

const CLASSIFICATION = {
  status: 'pending-confirmation' as const,
  teachers: [
    { sourceId: 101, trait: 'method-author' as const },
    { sourceId: 102, trait: 'teacher' as const },
  ],
  articles: [
    { sourceId: 401, sourceProgramIds: [11, 12] },
    { sourceId: 402, sourceProgramIds: [12] },
  ],
};

function options(target: SyntheticStrapiTarget, media: SyntheticMediaResolver) {
  return { target, media, classification: CLASSIFICATION };
}

function collection(target: SyntheticStrapiTarget, name: Collection): StoredDocument[] {
  return target.documents.get(name) ?? [];
}

function oneByLegacyId(target: SyntheticStrapiTarget, name: Collection, legacyId: string): StoredDocument {
  const entry = collection(target, name).find((item) => item.legacy_id === legacyId);
  if (!entry) throw new Error(`missing synthetic ${name}/${legacyId}`);
  return entry;
}

function connectedDocumentIds(value: unknown): string[] {
  return relationDocumentIds(value);
}

function relationDocumentIds(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(relationDocumentIds);
  if (!value || typeof value !== 'object') return [];
  if ('set' in value) return relationDocumentIds((value as { set?: unknown }).set);
  if ('connect' in value) return relationDocumentIds((value as { connect?: unknown }).connect);
  if ('documentId' in value) return [String((value as { documentId: unknown }).documentId)];
  if ('id' in value) return [String((value as { id: unknown }).id)];
  return [];
}

function relationRefs(value: unknown): { documentId: string }[] {
  return relationDocumentIds(value).map((documentId) => ({ documentId }));
}

function isSetOperation(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'set' in value);
}

function identityFor(target: SyntheticStrapiTarget, collectionName: Collection, documentId: string): string | undefined {
  return collection(target, collectionName).find((entry) => entry.documentId === documentId)?.legacy_id as string | undefined;
}

function canonicalTarget(target: SyntheticStrapiTarget): unknown {
  const names: Collection[] = ['institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles'];
  return names.map((name) => [name, collection(target, name).map((entry) => {
    const value: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(entry)) {
      if (['id', 'documentId', 'publishedAt'].includes(field)) continue;
      if (field === 'image' || field === 'photo') {
        const ids = connectedMediaIds(item);
        value[field] = ids.map((id) => {
          const resolved = target.mediaById.get(id);
          return resolved && {
            sourceIdentity: resolved.sourceIdentity,
            sourceHash: resolved.sourceHash,
            storedHash: resolved.storedHash,
          };
        });
      } else if (field === 'institute') {
        const ids = connectedDocumentIds(item);
        value[field] = ids.map((id) => identityFor(target, 'institutes', id));
      } else if (field === 'course_group') {
        const ids = connectedDocumentIds(item);
        value[field] = ids.map((id) => identityFor(target, 'course-groups', id));
      } else if (field === 'teachers') {
        const ids = connectedDocumentIds(item);
        const targetCollection: Collection = name === 'schedule-entries' ? 'teachers' : 'teachers';
        value[field] = ids.map((id) => identityFor(target, targetCollection, id));
      } else if (field === 'seminar') {
        const ids = connectedDocumentIds(item);
        value[field] = ids.map((id) => identityFor(target, 'seminars', id));
      } else if (field === 'categories') {
        const ids = connectedDocumentIds(item);
        value[field] = ids.map((id) => identityFor(target, 'course-groups', id));
      } else {
        value[field] = item;
      }
    }
    return value;
  })]);
}

function connectedMediaIds(value: unknown): number[] {
  if (!value || typeof value !== 'object' || !('connect' in value)) return [];
  const connect = (value as { connect?: unknown }).connect;
  if (!Array.isArray(connect)) return [];
  return connect.filter((id): id is number => Number.isSafeInteger(id));
}

describe('materializeSqlPublicContent', () => {
  it('preserves nullable SQL program descriptions accepted by the CMS schema', async () => {
    const target = new SyntheticStrapiTarget('nullable-program-description');
    const media = new SyntheticMediaResolver();
    const mapped = structuredClone(MAPPED);
    mapped.entities.programs[0]!.description = null;

    await materializeSqlPublicContent(mapped, options(target, media));

    expect(oneByLegacyId(target, 'course-groups', 'program-one').description).toBeNull();
  });

  it('writes all mapped public fields, resolves source IDs to document IDs, and links relations after parent writes', async () => {
    const target = new SyntheticStrapiTarget('target-a');
    const media = new SyntheticMediaResolver();

    await materializeSqlPublicContent(MAPPED, options(target, media));

    const institute = oneByLegacyId(target, 'institutes', 'institutes/one');
    const program = oneByLegacyId(target, 'course-groups', 'program-one');
    const teacher = oneByLegacyId(target, 'teachers', '101');
    const seminar = oneByLegacyId(target, 'seminars', 'seminar-one');
    const event = oneByLegacyId(target, 'schedule-entries', '301');
    const article = oneByLegacyId(target, 'articles', 'article-one');

    expect(institute).toMatchObject({ name: 'Institute One', slug: 'one', shortName: 'I1', description: 'Institute description' });
    expect(program).toMatchObject({ name: 'Program One', slug: 'program-one', description: 'Program description', order: 4, is_article_category: true });
    expect(teacher).toMatchObject({ name: 'Teacher One', slug: '101', bio: 'Teacher bio', trait: 'method-author', order: 5 });
    expect(seminar).toMatchObject({
      name: 'Seminar One', slug: 'seminar-one', description: 'Seminar description', documents_state: 'unconfirmed', order: 3,
      full_text: '<h2>Целевая аудитория</h2>\nAUDIENCE_SENTINEL',
      learning_mode: 'CURRICULUM_SENTINEL', learning_plan: 'LEARNING_PLAN_SENTINEL', recommendations: 'RECOMMENDATIONS_SENTINEL',
    });
    expect(event).toMatchObject({
      legacy_id: '301', name: 'Synthetic Event One', city: 'Synthetic City', entry_status: 'active', oldPrice: 90, price: 120,
      startAt: '2030-05-10T09:00:00.000Z', endAt: '2030-05-10T16:00:00.000Z',
      isFree: false, isEventCollection: true, duration: '7 hours',
    });
    expect(article).toMatchObject({ title: 'Article One', slug: 'article-one', body: 'Article body', published_date: '2021-03-04T00:00:00.000Z' });
    expect(article).not.toHaveProperty('published_at');

    expect(connectedDocumentIds(teacher.institute)).toEqual([oneByLegacyId(target, 'institutes', 'institutes/one').documentId]);
    expect(connectedDocumentIds(program.institute)).toEqual([institute.documentId]);
    expect(connectedDocumentIds(seminar.course_group)).toEqual([program.documentId]);
    expect(connectedDocumentIds(seminar.teachers)).toEqual([
      oneByLegacyId(target, 'teachers', '101').documentId,
      oneByLegacyId(target, 'teachers', '102').documentId,
    ]);
    expect(connectedDocumentIds(event.seminar)).toEqual([seminar.documentId]);
    expect(connectedDocumentIds(event.teachers)).toEqual([
      oneByLegacyId(target, 'teachers', '101').documentId,
      oneByLegacyId(target, 'teachers', '102').documentId,
    ]);
    expect(connectedDocumentIds(article.categories)).toEqual([
      oneByLegacyId(target, 'course-groups', 'program-one').documentId,
      oneByLegacyId(target, 'course-groups', 'program-two').documentId,
    ]);

    expect(institute.image).toEqual({ connect: [expect.any(Number)] });
    expect(program.image).toEqual({ connect: [expect.any(Number)] });
    expect(teacher.photo).toEqual({ connect: [expect.any(Number)] });
    expect(event.image).toEqual({ connect: [expect.any(Number)] });
    expect(article.image).toEqual({ connect: [expect.any(Number)] });
    expect(article.publishedAt).toEqual(expect.any(String));
    for (const name of ['institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles'] as const) {
      expect(collection(target, name).every((entry) => typeof entry.publishedAt === 'string')).toBe(true);
      for (const entry of collection(target, name)) {
        expect(entry).not.toHaveProperty('sourceId');
        expect(entry).not.toHaveProperty('imageId');
      }
    }
    const publicPayload = JSON.stringify(target.requests);
    expect(publicPayload).not.toContain('PRIVATE_AUTHOR_SENTINEL');
    expect(publicPayload).not.toContain('PRIVATE_CERTIFICATE_SENTINEL');
    expect(publicPayload).not.toContain('pending-confirmation');
    expect(publicPayload).not.toContain('sourceIdentity');
    expect(publicPayload).not.toContain('image-event');

    const firstRelationWrite = target.requests.findIndex(({ method, body }) => {
      if (method !== 'PUT') return false;
      const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      return ['institute', 'course_group', 'teachers', 'seminar', 'categories'].some((field) => field in data);
    });
    const lastParentCreate = Math.max(...target.requests.flatMap(({ method, path }, index) =>
      method === 'POST' && ['/api/institutes', '/api/course-groups', '/api/teachers'].includes(new URL(path, 'http://synthetic.invalid').pathname) ? [index] : [],
    ));
    const lastEntityCreate = Math.max(...target.requests.flatMap(({ method, path }, index) =>
      method === 'POST' && ['/api/institutes', '/api/course-groups', '/api/teachers', '/api/seminars', '/api/schedule-entries', '/api/articles'].includes(new URL(path, 'http://synthetic.invalid').pathname) ? [index] : [],
    ));
    const lastRelationWrite = Math.max(...target.requests.flatMap(({ method, body }, index) => {
      if (method !== 'PUT') return [];
      const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      return ['institute', 'course_group', 'teachers', 'seminar', 'categories'].some((field) => field in data) ? [index] : [];
    }));
    const firstPublish = target.requests.findIndex(({ method, path }) => method === 'PUT' && new URL(path, 'http://synthetic.invalid').searchParams.get('status') === 'published');
    expect(lastParentCreate).toBeLessThan(lastEntityCreate);
    expect(firstRelationWrite).toBeGreaterThan(lastEntityCreate);
    expect(firstPublish).toBeGreaterThan(lastRelationWrite);
    expect(lastRelationWrite).toBeLessThan(firstPublish);
    expect(target.requests.filter(({ method }) => method === 'POST').every(({ path }) => new URL(path, 'http://synthetic.invalid').searchParams.get('status') === 'draft')).toBe(true);
    expect(target.requests.filter(({ method, body }) => method === 'PUT' && Object.keys(((body as { data?: Record<string, unknown> } | undefined)?.data ?? {})).some((field) => ['institute', 'course_group', 'teachers', 'seminar', 'categories'].includes(field)))
      .every(({ path }) => new URL(path, 'http://synthetic.invalid').searchParams.get('status') === 'draft')).toBe(true);
    expect(target.requests.some(({ path }) => path.includes('/admin') || path.includes('/actions/publish'))).toBe(false);
    const manyToManyWrites = target.requests.flatMap(({ method, body }) => {
      if (method !== 'PUT') return [];
      const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      return ['teachers', 'categories'].flatMap((field) => field in data ? [data[field]] : []);
    });
    expect(manyToManyWrites.length).toBeGreaterThan(0);
    expect(manyToManyWrites.every(isSetOperation)).toBe(true);
    for (const name of ['institutes', 'course-groups', 'teachers', 'seminars', 'schedule-entries', 'articles'] as const) {
      for (const entry of collection(target, name)) {
        expect(target.requests.some(({ method, path }) => method === 'GET'
          && new URL(path, 'http://synthetic.invalid').pathname === `/api/${name}/${entry.documentId}`
          && new URL(path, 'http://synthetic.invalid').searchParams.get('status') === 'published')).toBe(true);
      }
    }
  });

  it('requires source-ID anchored classification coverage without requiring owner approval', async () => {
    const target = new SyntheticStrapiTarget('classification-target');
    const media = new SyntheticMediaResolver();
    const incomplete = {
      ...CLASSIFICATION,
      teachers: CLASSIFICATION.teachers.slice(0, 1),
    };

    await expect(materializeSqlPublicContent(MAPPED, { target, media, classification: incomplete })).rejects.toThrow(/Teachers#102.*classification/i);
    expect(target.requests).toHaveLength(0);
  });

  it('fails closed with the owning record when required media cannot be resolved', async () => {
    const target = new SyntheticStrapiTarget('offline-target');
    const media = new SyntheticMediaResolver();
    media.failures.add('image-event');

    await expect(materializeSqlPublicContent(MAPPED, options(target, media))).rejects.toThrow(/Events#301.*image/i);
    expect(collection(target, 'schedule-entries')).toHaveLength(0);
    expect(JSON.stringify(target.requests)).not.toContain('private-sql-image:');
  });

  it('does not publish a record missing a required public field', async () => {
    const target = new SyntheticStrapiTarget('missing-field-target');
    const media = new SyntheticMediaResolver();
    const missingArticleBody = structuredClone(MAPPED);
    missingArticleBody.entities.articles[0]!.body = '';

    await expect(materializeSqlPublicContent(missingArticleBody, options(target, media)))
      .rejects.toThrow(/Articles#401.*body/i);
    expect(collection(target, 'articles').every((entry) => entry.publishedAt === null)).toBe(true);
  });

  it('rejects a missing required relation or media hash mismatch with source record context', async () => {
    const missingRelationTarget = new SyntheticStrapiTarget('missing-relation-target');
    const missingRelationMedia = new SyntheticMediaResolver();
    const mappedWithMissingProgram = structuredClone(MAPPED);
    mappedWithMissingProgram.entities.seminars[0]!.course_group_legacy_id = 'missing-program';
    await expect(materializeSqlPublicContent(mappedWithMissingProgram, options(missingRelationTarget, missingRelationMedia)))
      .rejects.toThrow(/Seminars#21.*course_group/i);

    const hashTarget = new SyntheticStrapiTarget('hash-mismatch-target');
    const mismatchedMedia = new SyntheticMediaResolver();
    mismatchedMedia.hashMismatches.add('image-event');
    await expect(materializeSqlPublicContent(MAPPED, options(hashTarget, mismatchedMedia)))
      .rejects.toThrow(/Events#301.*hash/i);
  });

  it('replaces stale relation sets when the same mapped source is rerun', async () => {
    const target = new SyntheticStrapiTarget('relation-rerun-target');
    const media = new SyntheticMediaResolver();

    await materializeSqlPublicContent(MAPPED, options(target, media));

    // Model target-side drift from an older/human-edited state. The mapped SQL fixture stays
    // immutable: a rerun of this same projection must replace full M2M sets and clear an
    // optional institute relation that is absent from the source-linked DTO.
    oneByLegacyId(target, 'seminars', 'seminar-one').teachers = [
      ...relationRefs(connectedDocumentIds(oneByLegacyId(target, 'seminars', 'seminar-one').teachers)),
      { documentId: 'stale-target-teacher' },
    ];
    oneByLegacyId(target, 'schedule-entries', '301').teachers = [
      ...relationRefs(connectedDocumentIds(oneByLegacyId(target, 'schedule-entries', '301').teachers)),
      { documentId: 'stale-target-teacher' },
    ];
    oneByLegacyId(target, 'articles', 'article-one').categories = [
      ...relationRefs(connectedDocumentIds(oneByLegacyId(target, 'articles', 'article-one').categories)),
      { documentId: 'stale-target-category' },
    ];
    oneByLegacyId(target, 'teachers', '102').institute = [
      { documentId: oneByLegacyId(target, 'institutes', 'institutes/one').documentId },
    ];

    const beforeRerun = target.requests.length;
    await materializeSqlPublicContent(MAPPED, options(target, media));

    expect.soft(connectedDocumentIds(oneByLegacyId(target, 'seminars', 'seminar-one').teachers)).toEqual([
      oneByLegacyId(target, 'teachers', '101').documentId,
      oneByLegacyId(target, 'teachers', '102').documentId,
    ]);
    expect.soft(connectedDocumentIds(oneByLegacyId(target, 'schedule-entries', '301').teachers)).toEqual([
      oneByLegacyId(target, 'teachers', '101').documentId,
      oneByLegacyId(target, 'teachers', '102').documentId,
    ]);
    expect.soft(connectedDocumentIds(oneByLegacyId(target, 'articles', 'article-one').categories)).toEqual([
      oneByLegacyId(target, 'course-groups', 'program-one').documentId,
      oneByLegacyId(target, 'course-groups', 'program-two').documentId,
    ]);
    expect.soft(connectedDocumentIds(oneByLegacyId(target, 'teachers', '102').institute)).toEqual([]);

    const rerunWrites = target.requests.slice(beforeRerun);
    const setFields = rerunWrites.flatMap(({ method, body }) => {
      if (method !== 'PUT') return [];
      const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      return ['teachers', 'categories'].flatMap((field) => field in data ? [data[field]] : []);
    });
    expect.soft(setFields.length).toBeGreaterThan(0);
    expect.soft(setFields.every(isSetOperation)).toBe(true);
    expect.soft(rerunWrites.some(({ method, body }) => method === 'PUT'
      && (body as { data?: Record<string, unknown> } | undefined)?.data?.institute === null)).toBe(true);
  });

  it('produces equivalent canonical content in independent targets and is repeatable within one target', async () => {
    const first = new SyntheticStrapiTarget('first');
    const second = new SyntheticStrapiTarget('second');
    const media = new SyntheticMediaResolver();

    await materializeSqlPublicContent(MAPPED, options(first, media));
    await materializeSqlPublicContent(MAPPED, options(second, media));
    const firstDocumentIds = collection(first, 'articles').map((entry) => entry.documentId);
    const firstMediaIds = [...(media.uploads.get(first)?.values() ?? [])].map(({ id }) => id);
    const firstMediaCount = firstMediaIds.length;
    const firstCounts = [...first.documents].map(([name, entries]) => [name, entries.length]);
    const firstCanonical = canonicalTarget(first);
    const secondCanonical = canonicalTarget(second);

    expect(firstDocumentIds).not.toEqual(collection(second, 'articles').map((entry) => entry.documentId));
    expect(firstMediaIds).not.toEqual([...(media.uploads.get(second)?.values() ?? [])].map(({ id }) => id));
    expect(firstCanonical).toEqual(secondCanonical);

    await materializeSqlPublicContent(MAPPED, options(first, media));
    expect([...first.documents].map(([name, entries]) => [name, entries.length])).toEqual(firstCounts);
    expect(collection(first, 'articles').map((entry) => entry.documentId)).toEqual(firstDocumentIds);
    expect(media.uploads.get(first)?.size).toBe(firstMediaCount);
  });

  it('accepts a verified media transform whose stored hash differs from its source hash', async () => {
    const target = new SyntheticStrapiTarget('transformed-media-target');
    const media = new SyntheticMediaResolver();

    await materializeSqlPublicContent(MAPPED, options(target, media));

    expect(collection(target, 'schedule-entries')).toHaveLength(1);
    const resolvedEvent = [...(media.uploads.get(target)?.values() ?? [])]
      .find(({ sourceIdentity }) => sourceIdentity === 'private-sql-image:image-event');
    expect(resolvedEvent).toBeDefined();
    expect(resolvedEvent?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(resolvedEvent?.storedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(resolvedEvent?.storedHash).not.toBe(resolvedEvent?.sourceHash);
  });
});
