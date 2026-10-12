import { describe, expect, it } from 'vitest';
import { mapSqlPublicContent, type SqlPublicSource } from './sql-public-content.js';
import { materializeSqlPublicContent, type SqlMaterializerInput, type SqlMaterializerOptions, type SqlStrapiRestClient } from './sql-public-materializer.js';

type PublicationValidator = (input: { type: string; record: Record<string, unknown> }) => { ok: boolean; missing: string[]; message: string };
const { checkPublication } = await import(new URL('../../cms/src/lib/publication-validation.ts', import.meta.url).href) as { checkPublication: PublicationValidator };

const SOURCE_HASH = `sha256:${'a'.repeat(64)}`;
const timestamps = { createdAt: '2026-10-12T00:00:00', updatedAt: '2026-10-12T00:00:00' };
const playlistIds = [31, 32, 33, 34, 36, 37];

const source: SqlPublicSource = {
  sourceHash: SOURCE_HASH,
  Institutes: [1, 2, 3].map((id) => ({ id, name: `Institute ${id}`, shortName: null, description: `Institute ${id} body`, imageId: null })),
  Programs: [{ id: 11, status: 'active', name: 'Program', slug: 'program-sql', instituteId: 1, priority: 1, seoTitle: 'Program SEO', seoDescription: 'Program summary', content: 'Program body', imageId: null }],
  Seminars: [{ id: 21, status: 'active', name: 'Seminar', slug: 'seminar-sql', programId: 11, description: 'Seminar body', curriculum: null, targetAudience: null, learningProcess: null, certificates: null, recommendations: null, priority: 1, seoTitle: 'Seminar SEO', seoDescription: 'Seminar summary' }],
  Teachers: [{ id: 101, status: 'active', fullName: 'Teacher', description: 'Teacher bio', imageId: null, priority: 1 }],
  TeachersAndInstitutes: [{ teacherId: 101, instituteId: 1 }],
  SeminarsTeacher: [{ seminarId: 21, teacherId: 101 }],
  Events: [{ id: 301, status: 'active', seminarId: 21, cityId: 71, imageId: null, teacherId: 101, oldPrice: null, newPrice: 120, startAt: '2030-05-10T09:00:00.000Z', endAt: '2030-05-10T16:00:00.000Z', additionalText: 'Event details', duration: '7 hours', description: 'Event body', registrationFormLink: 'https://synthetic.invalid/register', isFree: false, isEventCollection: true }],
  EventsAndTeachers: [{ eventId: 301, teacherId: 101 }],
  Articles: [{ id: 401, status: 'active', name: 'Article', imageId: 'article-image', content: 'Article body', author: 'private author provenance', priority: 1, seoTitle: 'Article SEO', seoDescription: 'Article summary', slug: 'article-sql', createdAt: '2021-03-04T22:10:00', updatedAt: '2024-11-12T12:00:00' }],
  Cities: [{ ...timestamps, id: 71, name: 'Synthetic City', status: 'active' }],
  News: [{ ...timestamps, id: 801, name: 'Synthetic news', description: '<p>News body exact</p>', imageId: 'news-image', status: 'active', link: 'https://synthetic.invalid/news', priority: 8, createdAt: '2026-10-10T23:30:00.123456' }],
  Promotions: [
    { ...timestamps, id: 901, name: 'Shop offer', description: '<p>Shop body exact</p>', imageId: 'shop-image', link: 'https://synthetic.invalid/shop', status: 'active', priority: 2, type: 'SHOP', createdAt: '2026-10-11T00:30:00.654321' },
    { ...timestamps, id: 902, name: 'Institute offer', description: '<p>Institute body exact</p>', imageId: null, link: 'https://synthetic.invalid/institute', status: 'active', priority: 3, type: 'INSTITUTE', createdAt: '2026-10-12T09:15:00' },
  ],
  Videos: playlistIds.map((id) => ({ ...timestamps, id, name: `Playlist ${id}`, link: `https://private.synthetic.invalid/watch/${id}`, status: 'active', priority: id, imageId: `private-image-${id}` })),
};

const BASE_MAPPED = mapSqlPublicContent(source, {
  expectedSourceHash: SOURCE_HASH,
  acceptedLegacyIds: {
    Institutes: { 1: 'institutes/one', 2: 'institutes/two', 3: 'institutes/three' },
    Programs: { 11: 'program-one' }, Seminars: { 21: 'seminar-one' }, Articles: { 401: 'article-one' },
  },
  classificationCandidates: {
    teachers: [{ sourceId: 101, trait: 'method-author' }],
    articles: [{ sourceId: 401, sourceProgramIds: [11] }],
  },
});

type PageDto = { title: string; slug: string; body: string; legacy_id: string; seo: { seo_title: string; seo_description: string } };
type VideoCmsDto = { name: string; slug: string; legacy_id: string; videos: unknown[] | null; seo: { seo_title: string; seo_description: string } };
type AuxMapped = Omit<SqlMaterializerInput, 'entities'> & {
  entities: Omit<SqlMaterializerInput['entities'], 'videos' | 'pages'> & { videos?: VideoCmsDto[]; pages?: PageDto[] };
};

function mappedContent(): AuxMapped {
  const mapped = structuredClone(BASE_MAPPED) as AuxMapped;
  mapped.entities.institutes.forEach((institute, index) => {
    institute.order = index + 1;
    institute.seo = { seo_title: `Institute SEO ${index + 1}`, seo_description: `Institute summary ${index + 1}` };
  });
  const event = mapped.entities.events[0]!;
  event.name = 'Synthetic event';
  event.city = 'Synthetic City';
  event.entry_status = 'active';
  const sourceVideos = BASE_MAPPED.entities.videos ?? [];
  mapped.entities.videos = playlistIds.map((sourceId) => {
    const sourceVideo = sourceVideos.find((video) => video.sourceId === sourceId)!;
    const { slug, legacy_id } = sourceVideo;
    const title = String(sourceVideo.title);
    return {
      name: title,
      slug,
      legacy_id,
      videos: null,
      seo: { seo_title: `${title} SEO`, seo_description: `${title} summary` },
    };
  });
  mapped.entities.pages = [{
    legacy_id: 'pages/about',
    title: 'About exact title',
    slug: 'about-sql',
    body: '<h2>About</h2><p>Exact page body</p>',
    seo: { seo_title: 'About SEO exact', seo_description: 'About SEO summary exact' },
  }];
  return mapped;
}

function materializeComposed(mapped: AuxMapped, target: NativeStrapiTarget) {
  return materializeSqlPublicContent(mapped, optionsFor(target));
}

type Collection = 'institutes' | 'course-groups' | 'teachers' | 'seminars' | 'schedule-entries' | 'articles' | 'news-items' | 'promotions' | 'video-playlists' | 'pages';
type StoredDocument = Record<string, unknown> & { id: number; documentId: string; publishedAt: string | null };

const AUX_FIELDS: Partial<Record<Collection, ReadonlySet<string>>> = {
  'news-items': new Set(['name', 'description', 'date', 'image', 'link', 'priority', 'legacy_id']),
  promotions: new Set(['name', 'description', 'date', 'type', 'image', 'link', 'priority', 'active', 'legacy_id']),
  'video-playlists': new Set(['name', 'slug', 'videos', 'legacy_id', 'seo']),
  pages: new Set(['title', 'slug', 'body', 'legacy_id', 'seo']),
};

function publicationRecord(collection: Collection, entity: StoredDocument): { type: string; record: Record<string, unknown> } {
  const seo = entity.seo as Record<string, unknown> | undefined;
  const commonSeo = { seo_title: seo?.seo_title, seo_description: seo?.seo_description };
  switch (collection) {
    case 'institutes': return { type: 'institute', record: { name: entity.name, identifier: entity.slug, description: entity.description, order: entity.order, ...commonSeo } };
    case 'course-groups': return { type: 'course-group', record: { name: entity.name, identifier: entity.slug, institute: entity.institute, description: entity.description, ...commonSeo } };
    case 'teachers': return { type: 'person', record: { name: entity.name, identifier: entity.slug, trait: entity.trait } };
    case 'seminars': return { type: 'seminar', record: { name: entity.name, identifier: entity.slug, course_group: entity.course_group, description: entity.description, documentsState: entity.documents_state, ...commonSeo } };
    case 'schedule-entries': return { type: 'schedule-entry', record: { seminar: entity.seminar, startAt: entity.startAt, endAt: entity.endAt, city: entity.city, status: entity.entry_status } };
    case 'articles': return { type: 'article', record: { title: entity.title, identifier: entity.slug, body: entity.body, image: entity.image, published_at: entity.published_date, categories: entity.categories, ...commonSeo } };
    case 'news-items': return { type: 'news-item', record: { title: entity.name, date: entity.date, body: entity.description } };
    case 'promotions': return { type: 'promotion', record: { title: entity.name, date: entity.date, body: entity.description } };
    case 'video-playlists': return { type: 'video-playlist', record: { title: entity.name, identifier: entity.slug } };
    case 'pages': return { type: 'static-page', record: { title: entity.title, identifier: entity.slug, body: entity.body, ...commonSeo } };
  }
}

class NativeStrapiTarget implements SqlStrapiRestClient {
  readonly documents = new Map<Collection, StoredDocument[]>();
  readonly requests: { method: string; path: string; body?: unknown }[] = [];
  private nextId = 1;

  async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    this.requests.push({ method, path, body });
    const url = new URL(path, 'http://strapi.synthetic.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts.length < 2) throw new Error(`unexpected Content API route ${path}`);
    const collection = parts[1] as Collection;
    const entries = this.documents.get(collection) ?? [];
    this.documents.set(collection, entries);
    const status = url.searchParams.get('status') ?? 'published';
    const visible = entries.filter((entry) => status === 'draft' ? entry.publishedAt === null : Boolean(entry.publishedAt));

    if (method === 'GET') {
      const documentId = parts[2];
      if (documentId) return { data: visible.find((entry) => entry.documentId === documentId) ?? null };
      const legacyId = url.searchParams.get('filters[legacy_id][$eq]');
      return { data: legacyId ? visible.filter((entry) => entry.legacy_id === legacyId) : visible };
    }

    const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
    this.assertAuxFields(collection, data);
    if (method === 'POST') {
      if (status !== 'draft') throw new Error('Strapi Content API creates must start as drafts');
      this.assertUnique(collection, entries, data);
      const id = this.nextId++;
      const entry: StoredDocument = { ...data, id, documentId: `strapi-${collection}-${id}`, publishedAt: null };
      entries.push(entry);
      return { data: entry };
    }

    const entry = entries.find((candidate) => candidate.documentId === parts[2]);
    if (!entry) throw new Error(`missing ${collection}/${parts[2]}`);
    Object.assign(entry, data);
    if (status === 'published') {
      const verdict = publicationRecord(collection, entry);
      const check = checkPublication(verdict);
      if (!check.ok) throw new Error(`${collection}/${String(entry.legacy_id)} lifecycle: ${check.message}`);
      entry.publishedAt = '2030-01-01T00:00:00.000Z';
    } else if (status !== 'draft') {
      throw new Error(`Strapi Content API update requires explicit status: ${path}`);
    }
    return { data: entry };
  }

  published(collection: Collection): StoredDocument[] {
    return (this.documents.get(collection) ?? []).filter((entry) => typeof entry.publishedAt === 'string');
  }

  private assertAuxFields(collection: Collection, data: Record<string, unknown>): void {
    const allowed = AUX_FIELDS[collection];
    if (!allowed) return;
    const unexpected = Object.keys(data).filter((field) => !allowed.has(field));
    if (unexpected.length) throw new Error(`unknown ${collection} attributes: ${unexpected.join(', ')}`);
    if (['news-items', 'promotions'].includes(collection) && data.image !== null && data.image !== undefined && typeof data.image !== 'number') {
      throw new Error(`${collection}.image must use the schema's single numeric media ID`);
    }
  }

  private assertUnique(collection: Collection, entries: StoredDocument[], data: Record<string, unknown>): void {
    if (!AUX_FIELDS[collection]) return;
    if (entries.some((entry) => entry.legacy_id === data.legacy_id)) throw new Error(`${collection} duplicate legacy_id ${String(data.legacy_id)}`);
    if (['pages', 'video-playlists'].includes(collection) && entries.some((entry) => entry.slug === data.slug)) {
      throw new Error(`${collection} duplicate slug ${String(data.slug)}`);
    }
  }
}

function optionsFor(target: NativeStrapiTarget): SqlMaterializerOptions {
  let nextMediaId = 2000;
  return {
    target,
    media: {
      async resolve(sourceImageId) {
        return {
          id: nextMediaId++,
          sourceHash: 'a'.repeat(64),
          storedHash: 'b'.repeat(64),
          sourceIdentity: `synthetic:${sourceImageId}`,
        };
      },
    },
    classification: {
      status: 'pending-confirmation',
      teachers: [{ sourceId: 101, trait: 'method-author' }],
      articles: [{ sourceId: 401, sourceProgramIds: [11] }],
    },
  };
}

describe('materializeSqlPublicContent auxiliary CMS collections', () => {
  it('writes news and both promotion types with exact SQL timestamps and native single-media IDs', async () => {
    const mapped = mappedContent();
    const target = new NativeStrapiTarget();

    await materializeComposed(mapped, target);

    const news = target.published('news-items');
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      legacy_id: '801', name: 'Synthetic news', description: '<p>News body exact</p>',
      date: '2026-10-10T23:30:00.123Z',
      link: 'https://synthetic.invalid/news', priority: 8, publishedAt: expect.any(String),
    });
    expect(typeof news[0]!.image).toBe('number');

    const promotions = target.published('promotions');
    expect(promotions).toHaveLength(2);
    expect(promotions.map(({ legacy_id, date, type }) => ({ legacy_id, date, type }))).toEqual([
      { legacy_id: '901', date: '2026-10-11T00:30:00.654Z', type: 'SHOP' },
      { legacy_id: '902', date: '2026-10-12T09:15:00.000Z', type: 'INSTITUTE' },
    ]);
    expect(promotions[0]).toMatchObject({ name: 'Shop offer', description: '<p>Shop body exact</p>', active: true });
    expect(typeof promotions[0]!.image).toBe('number');
    for (const collection of ['news-items', 'promotions'] as const) {
      for (const document of target.published(collection)) expect(checkPublication(publicationRecord(collection, document))).toMatchObject({ ok: true });
      expect(target.requests.some(({ method, path }) => method === 'PUT' && path.startsWith(`/api/${collection}/`) && path.endsWith('?status=published'))).toBe(true);
    }
  });

  it('passes the mapped playlist name, supplemented identity and SEO without SQL provenance fields', async () => {
    const mapped = mappedContent();
    const target = new NativeStrapiTarget();
    expect(mapped.entities.videos?.[0]).toMatchObject({ name: 'Playlist 31', slug: '31', legacy_id: 'video/pleylist/31', videos: null });
    expect(mapped.provenance.videoMetadata[0]).toMatchObject({ sourceId: 31, link: 'https://private.synthetic.invalid/watch/31', priority: 31, imageId: 'private-image-31' });

    await materializeComposed(mapped, target);

    const videos = target.published('video-playlists');
    expect(videos).toHaveLength(6);
    expect(videos[0]).toMatchObject({ name: 'Playlist 31', slug: '31', legacy_id: 'video/pleylist/31', seo: { seo_title: 'Playlist 31 SEO', seo_description: 'Playlist 31 summary' }, publishedAt: expect.any(String) });
    for (const field of ['sourceId', 'title', 'link', 'priority', 'imageId', 'sourceHash', 'sourceIdentity']) expect(videos[0]).not.toHaveProperty(field);
    const videoRequests = target.requests.filter((request) => request.path.includes('/api/video-playlists'));
    expect(JSON.stringify(videoRequests)).not.toContain('private.synthetic.invalid');
    expect(checkPublication(publicationRecord('video-playlists', videos[0]!))).toMatchObject({ ok: true });
    expect(target.requests.some(({ method, path }) => method === 'PUT' && path.startsWith('/api/video-playlists/') && path.endsWith('?status=published'))).toBe(true);
  });

  it('writes exact page body, SEO, legacy identity and slug through draft publication readback', async () => {
    const mapped = mappedContent();
    const target = new NativeStrapiTarget();

    await materializeComposed(mapped, target);

    const pages = target.published('pages');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      legacy_id: 'pages/about', title: 'About exact title', slug: 'about-sql',
      body: '<h2>About</h2><p>Exact page body</p>',
      seo: { seo_title: 'About SEO exact', seo_description: 'About SEO summary exact' },
      publishedAt: expect.any(String),
    });
    expect(pages[0]).not.toHaveProperty('sourceId');
    expect(checkPublication(publicationRecord('pages', pages[0]!))).toMatchObject({ ok: true });
    expect(target.requests.some(({ method, path }) => method === 'POST' && path === '/api/pages?status=draft')).toBe(true);
    expect(target.requests.some(({ method, path }) => method === 'PUT' && path.startsWith('/api/pages/') && path.endsWith('?status=published'))).toBe(true);
  });

  it('reuses exact auxiliary identities on the same target and clears stale optional news media', async () => {
    const target = new NativeStrapiTarget();
    const first = mappedContent();
    await materializeComposed(first, target);
    const identities = Object.fromEntries((['news-items', 'promotions', 'video-playlists', 'pages'] as const)
      .map((collection) => [collection, target.published(collection).map(({ documentId }) => documentId)]));

    const repeated = mappedContent();
    repeated.entities.news![0]!.imageId = null;
    await materializeComposed(repeated, target);

    expect(target.published('news-items')).toHaveLength(1);
    expect(target.published('news-items')[0]).toMatchObject({ legacy_id: '801', image: null, date: '2026-10-10T23:30:00.123Z' });
    expect(target.published('pages')).toHaveLength(1);
    expect(target.published('pages')[0]).toMatchObject({ legacy_id: 'pages/about', body: '<h2>About</h2><p>Exact page body</p>' });
    expect(target.published('promotions')).toHaveLength(2);
    expect(target.published('video-playlists')).toHaveLength(6);
    for (const collection of ['news-items', 'promotions', 'video-playlists', 'pages'] as const) {
      expect(target.published(collection).map(({ documentId }) => documentId)).toEqual(identities[collection]);
    }
  });

  it('fails closed before any write when auxiliary legacy IDs collide in their owning collection', async () => {
    const mapped = mappedContent();
    mapped.entities.pages!.push({ ...mapped.entities.pages![0]!, slug: 'about-copy' });
    const target = new NativeStrapiTarget();

    await expect(materializeComposed(mapped, target)).rejects.toThrow(/pages.*legacy_id.*pages\/about/i);
    expect(target.requests.some(({ method }) => method !== 'GET')).toBe(false);
  });

  it('fails closed before any write when auxiliary page slugs collide and names the owning legacy ID', async () => {
    const mapped = mappedContent();
    mapped.entities.pages!.push({ ...mapped.entities.pages![0]!, legacy_id: 'pages/other', title: 'Other page' });
    const target = new NativeStrapiTarget();

    await expect(materializeComposed(mapped, target)).rejects.toThrow(/pages.*slug.*pages\/other/i);
    expect(target.requests.some(({ method }) => method !== 'GET')).toBe(false);
  });
});
