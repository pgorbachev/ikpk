import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mapSqlPublicContent, type SqlPublicContentOptions, type SqlPublicSource } from './sql-public-content';

const SOURCE_HASH = `sha256:${createHash('sha256').update('synthetic-public-source-v1').digest('hex')}`;

const source: SqlPublicSource = {
  sourceHash: SOURCE_HASH,
  Institutes: [
    { id: 1, name: 'ИКПК', shortName: 'ИКПК', description: 'Институт 1', imageId: 'file-i1' },
    { id: 2, name: 'Апледжера', shortName: 'ИА', description: 'Институт 2', imageId: 'file-i2' },
    { id: 3, name: 'Барраль', shortName: null, description: 'Институт 3', imageId: 'file-i3' },
  ],
  Programs: [
    {
      id: 150, status: 'active', name: 'Программа SQL', slug: 'prikladnaya-kineziologiya', instituteId: 1,
      priority: 10, seoTitle: 'Программа', seoDescription: 'Описание', content: 'Текст программы', imageId: 'file-p150',
    },
    {
      id: 151, status: 'deleted', name: 'Удалённая программа', slug: 'deleted-program', instituteId: 1,
      priority: 20, seoTitle: '', seoDescription: '', content: null, imageId: null,
    },
  ],
  Seminars: [
    {
      id: 244, status: 'active', name: 'Семинар SQL', slug: 'cst-1', programId: 150,
      description: 'Описание семинара', curriculum: 'РЕЖИМ: 36 часов',
      targetAudience: 'ЦЕЛЕВАЯ АУДИТОРИЯ: практикующие специалисты',
      learningProcess: 'ПЛАН: теория и практика', certificates: 'CERTIFICATE METADATA SENTINEL',
      recommendations: 'РЕКОМЕНДАЦИИ: базовый курс',
      priority: 5, seoTitle: 'CST-1', seoDescription: 'SEO CST-1',
    },
    {
      id: 245, status: 'deleted', name: 'Удалённый семинар', slug: 'deleted-seminar', programId: 150,
      description: null, curriculum: null, targetAudience: null, learningProcess: null,
      certificates: null, recommendations: null, priority: 6, seoTitle: '', seoDescription: '',
    },
  ],
  Teachers: [
    { id: 88, status: 'active', fullName: 'Преподаватель 88', description: 'Биография', imageId: 'file-t88', priority: 1 },
    { id: 89, status: 'active', fullName: 'Преподаватель 89', description: 'Биография', imageId: null, priority: 2 },
    { id: 83, status: 'deleted', fullName: 'Удалённый преподаватель 83', description: 'Не публиковать', imageId: null, priority: 3 },
  ],
  TeachersAndInstitutes: [
    { teacherId: 88, instituteId: 2 },
    { teacherId: 89, instituteId: 1 },
    { teacherId: 83, instituteId: 1 },
  ],
  SeminarsTeacher: [
    { seminarId: 244, teacherId: 88 },
    { seminarId: 244, teacherId: 83 },
  ],
  Events: [
    {
      id: 7001, status: 'active', seminarId: 244, cityId: 2, imageId: 'file-e7001', teacherId: 88,
      oldPrice: null, newPrice: 1200, startAt: '2020-01-10', endAt: '2020-01-11',
      additionalText: 'Проведён в прошлом', duration: '2 дня', description: null,
      registrationFormLink: null, isFree: false, isEventCollection: true,
    },
    {
      id: 7002, status: 'active', seminarId: 245, cityId: 2, imageId: null, teacherId: null,
      oldPrice: null, newPrice: 0, startAt: '2027-01-10', endAt: '2027-01-11',
      additionalText: null, duration: null, description: null, registrationFormLink: null,
      isFree: true, isEventCollection: false,
    },
  ],
  EventsAndTeachers: [
    { eventId: 7001, teacherId: 89 },
    { eventId: 7001, teacherId: 83 },
  ],
  Articles: [
    {
      id: 510, status: 'active', name: 'Статья SQL', imageId: null,
      content: '<p>CONTENT COLUMN SENTINEL</p>', author: 'SQL автор', priority: 9, seoTitle: 'Статья', seoDescription: 'Описание статьи',
      slug: 'statya-sql', createdAt: '2026-01-05T23:45:00', updatedAt: '2026-10-10T14:00:00',
    },
    {
      id: 511, status: 'deleted', name: 'Удалённая статья', imageId: null,
      content: '', author: 'Не публиковать', priority: 10, seoTitle: '', seoDescription: '',
      slug: 'deleted-article', createdAt: '2025-02-03T08:00:00', updatedAt: '2025-02-04T08:00:00',
    },
  ],
};

const options: SqlPublicContentOptions = {
  expectedSourceHash: SOURCE_HASH,
  acceptedLegacyIds: {
    Institutes: { 1: 'institut-klinicheskoy-prikladnoy-kineziologii', 2: 'institut-apledzhera', 3: 'institut-baralya' },
    Programs: { 150: 'institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya' },
    Seminars: { 244: 'institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/cst-1' },
    Articles: { 510: 'statya-sql' },
  },
  classificationCandidates: {
    teachers: [{ sourceId: 88, trait: 'teacher' }],
    articles: [{ sourceId: 510, sourceProgramIds: [150] }],
  },
};

const run = () => mapSqlPublicContent(source, options);

describe('synthetic SQL public content mapper', () => {
  it('keeps the three explicitly selected institutes and filters other content by literal status active', () => {
    const result = run();

    expect(result.entities.institutes.map((item) => item.sourceId)).toEqual([1, 2, 3]);
    expect(result.entities.programs.map((item) => item.sourceId)).toEqual([150]);
    expect(result.entities.seminars.map((item) => item.sourceId)).toEqual([244]);
    expect(result.entities.teachers.map((item) => item.sourceId)).toEqual([88, 89]);
    expect(result.entities.articles.map((item) => item.sourceId)).toEqual([510]);
  });

  it('preserves SQL source identity separately from accepted target legacy IDs', () => {
    const result = run();
    const teacher = result.entities.teachers.find((item) => item.sourceId === 88);
    const program = result.entities.programs.find((item) => item.sourceId === 150);

    expect(teacher?.slug).toBe('88');
    expect(teacher?.legacy_id).toBe('88');
    expect(program?.legacy_id).toBe(options.acceptedLegacyIds.Programs?.[150]);
    expect(program?.slug).toBe('prikladnaya-kineziologiya');
    expect(program?.is_article_category).toBe(true);
    expect(result.provenance.sourceIdentity).toContainEqual({
      table: 'Teachers', sourceId: 88, targetSlug: '88', targetLegacyId: '88',
    });
    expect(result.provenance.sourceIdentity).toContainEqual({
      table: 'Programs', sourceId: 150, targetSlug: 'prikladnaya-kineziologiya',
      targetLegacyId: 'institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya',
    });
  });

  it('maps SQL priority to public order for programs, teachers, and seminars while keeping article priority private', () => {
    const result = run();
    const program = result.entities.programs.find((item) => item.sourceId === 150);
    const teacher88 = result.entities.teachers.find((item) => item.sourceId === 88);
    const teacher89 = result.entities.teachers.find((item) => item.sourceId === 89);
    const seminar = result.entities.seminars.find((item) => item.sourceId === 244);
    const article = result.entities.articles.find((item) => item.sourceId === 510);

    expect(program?.order).toBe(10);
    expect(teacher88?.order).toBe(1);
    expect(teacher89?.order).toBe(2);
    expect(seminar?.order).toBe(5);
    expect(article?.order).toBeUndefined();
    expect(result.provenance.sourceMetadata).toContainEqual({
      table: 'Articles', sourceId: 510, field: 'priority', value: 9,
    });
  });

  it('retains past events but excludes active events whose parent seminar is deleted', () => {
    const result = run();

    expect(result.entities.events.map((item) => item.sourceId)).toEqual([7001]);
    expect(result.provenance.exclusions).toContainEqual({
      table: 'Events', sourceId: 7002, reason: 'parent seminar 245 is not active',
    });
  });

  it('uses EventsAndTeachers as the event teacher relation without unioning scalar teacherId', () => {
    const result = run();
    const event = result.entities.events.find((item) => item.sourceId === 7001);

    expect(event?.primaryTeachers).toEqual(['89']);
    expect(event?.primaryTeachers).not.toContain('88');
    expect(event?.slug).toBeUndefined();
    expect(result.provenance.rejectedRelations).toContainEqual({
      table: 'EventsAndTeachers', sourceId: 7001, relation: 'teacherId', targetId: 83,
      reason: 'teacher is not active',
    });
  });

  it('retains a conflicting event scalar teacherId as private source metadata', () => {
    const result = run();
    const event = result.entities.events.find((item) => item.sourceId === 7001);

    expect(event?.primaryTeachers).toEqual(['89']);
    expect(event?.primaryTeachers).not.toContain('88');
    expect(result.provenance.sourceMetadata).toContainEqual({
      table: 'Events', sourceId: 7001, field: 'teacherId', value: 88,
    });
  });

  it('keeps SeminarsTeacher links and audits deleted teacher edges', () => {
    const result = run();
    const seminar = result.entities.seminars.find((item) => item.sourceId === 244);

    expect(seminar?.directTeachers).toEqual(['88']);
    expect(result.provenance.rejectedRelations).toContainEqual({
      table: 'SeminarsTeacher', sourceId: 244, relation: 'teacherId', targetId: 83,
      reason: 'teacher is not active',
    });
  });

  it('preserves event-specific image and collection flag', () => {
    const event = run().entities.events.find((item) => item.sourceId === 7001);
    expect(event?.imageId).toBe('file-e7001');
    expect(event?.isEventCollection).toBe(true);
  });

  it('maps curriculum and learningProcess distinctly, preserves recommendations, and keeps certificates private metadata', () => {
    const seminar = run().entities.seminars.find((item) => item.sourceId === 244);

    expect(seminar?.learning_mode).toBe('РЕЖИМ: 36 часов');
    expect(seminar?.learning_plan).toBe('ПЛАН: теория и практика');
    expect(seminar?.recommendations).toBe('РЕКОМЕНДАЦИИ: базовый курс');
    expect(String(seminar?.full_text)).toContain('ЦЕЛЕВАЯ АУДИТОРИЯ: практикующие специалисты');
    expect(String(seminar?.full_text).match(/ЦЕЛЕВАЯ АУДИТОРИЯ: практикующие специалисты/g)).toHaveLength(1);
    expect(String(seminar?.full_text)).not.toContain('РЕКОМЕНДАЦИИ: базовый курс');
    expect(seminar?.documents_state).toBe('unconfirmed');
    expect(JSON.stringify(seminar)).not.toContain('CERTIFICATE METADATA SENTINEL');
    expect(run().provenance.sourceMetadata).toContainEqual({
      table: 'Seminars', sourceId: 244, field: 'certificates', value: 'CERTIFICATE METADATA SENTINEL',
    });
  });

  it('uses the approved SQL createdAt day for articles and never falls back to updatedAt', () => {
    const article = run().entities.articles.find((item) => item.sourceId === 510);

    expect(article?.published_date).toBe('2026-01-05T00:00:00.000Z');
    expect(article?.published_date).not.toBe('2026-10-10');
  });

  it('preserves SQL Articles.content through the CMS article body mapping', () => {
    const article = run().entities.articles.find((item) => item.sourceId === 510);

    expect(article, 'active SQL article was not mapped').toBeDefined();
    expect(JSON.stringify(article)).toContain('CONTENT COLUMN SENTINEL');
  });

  it('keeps classification labels tied to source IDs and explicitly pending owner confirmation', () => {
    const candidates = run().provenance.classificationCandidates;

    expect(candidates).toContainEqual({ table: 'Teachers', sourceId: 88, value: 'teacher', approval: 'pending' });
    expect(candidates).toContainEqual({
      table: 'Articles', sourceId: 510, sourceProgramId: 150,
      targetLegacyId: options.acceptedLegacyIds.Programs?.[150], approval: 'pending',
    });
    expect(candidates.every((candidate) => candidate.approval === 'pending')).toBe(true);
  });

  it('rejects an invalid createdAt instead of silently substituting updatedAt', () => {
    const invalidSource: SqlPublicSource = {
      ...source,
      Articles: source.Articles.map((article) => article.id === 510 ? { ...article, createdAt: 'not-a-date' } : article),
    };

    expect(() => mapSqlPublicContent(invalidSource, options)).toThrow(/createdAt.*510|510.*createdAt/i);
  });

  it('carries the pinned source hash and produces deterministic public collections and provenance', () => {
    const first = run();
    const second = run();

    expect(first.provenance.sourceHash).toBe(SOURCE_HASH);
    expect(second).toEqual(first);
  });

  it('stops when the source hash differs from the pinned baseline hash', () => {
    const changedHash = `sha256:${createHash('sha256').update('synthetic-public-source-v2').digest('hex')}`;
    expect(() => mapSqlPublicContent({ ...source, sourceHash: changedHash }, options))
      .toThrow(/hash|source|baseline/i);
  });

  it('does not emit private source junk or log private values', () => {
    const privateJunk = 'synthetic-private-token-must-not-leak';
    const unsafeInput = {
      ...source,
      Users: [{ id: 44, email: 'private@example.test', password: privateJunk }],
      Payments: [{ id: 55, token: privateJunk }],
      Registrations: [{ id: 66, email: 'private@example.test' }],
      Tokens: [{ id: 77, token: privateJunk }],
    } as SqlPublicSource;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = mapSqlPublicContent(unsafeInput, options);
      const emitted = JSON.stringify(result) + log.mock.calls.flat().join('') + warn.mock.calls.flat().join('') + error.mock.calls.flat().join('');
      expect(emitted, 'privacy check is vacuous without mapped source identity').toContain('"sourceId":88');
      expect(emitted).not.toContain(privateJunk);
      expect(emitted).not.toContain('private@example.test');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('excludes a known public but unlinked file without promoting it to a public entity or document', () => {
    const unlinkedSource: SqlPublicSource = {
      ...source,
      Files: [{
        id: 'file-unlinked', fileType: 'application/pdf', originalName: 'unlinked-private-name.pdf',
        extension: 'pdf', url: '/private/unlinked-private-name.pdf', status: 'unlinked', privacy: 'public',
        createdAt: '2026-10-12T00:00:00', updatedAt: '2026-10-12T00:00:00',
      }],
    };

    const result = mapSqlPublicContent(unlinkedSource, options);

    expect(result.entities.documents).toEqual([]);
    expect(JSON.stringify(result.entities)).not.toContain('file-unlinked');
    expect(JSON.stringify(result.entities)).not.toContain('unlinked-private-name.pdf');
    expect(result.provenance.exclusions).toContainEqual({
      table: 'Files', sourceId: 'file-unlinked', reason: 'status is not active',
    });
  });

  it('fails closed for an unknown file status', () => {
    const unknownStatusSource: SqlPublicSource = {
      ...source,
      Files: [{
        id: 'file-unknown-status', fileType: 'application/pdf', originalName: 'unknown.pdf',
        extension: 'pdf', url: '/private/unknown.pdf', status: 'unknown-status', privacy: 'public',
        createdAt: '2026-10-12T00:00:00', updatedAt: '2026-10-12T00:00:00',
      }],
    };

    expect(() => mapSqlPublicContent(unknownStatusSource, options))
      .toThrow(/Files#file-unknown-status: status has unsupported value "unknown-status"/);
  });

  it('does not bind an unlinked public PDF to an active organization section', () => {
    const unlinkedBindingSource: SqlPublicSource = {
      ...source,
      OrganizationInfo: [{
        id: 901, name: 'Сведения', priority: 1, content: 'Описание', status: 'active',
        createdAt: '2026-10-12T00:00:00', updatedAt: '2026-10-12T00:00:00',
      }],
      Files: [{
        id: 'file-unlinked', fileType: 'application/pdf', originalName: 'unlinked.pdf',
        extension: 'pdf', url: '/public/unlinked.pdf', status: 'unlinked', privacy: 'public',
        createdAt: '2026-10-12T00:00:00', updatedAt: '2026-10-12T00:00:00',
      }],
      FileBindingOrganizationInfo: [{
        id: 902, title: 'Документ', priority: 1, fileId: 'file-unlinked', organizationInfoId: 901,
        createdAt: '2026-10-12T00:00:00', updatedAt: '2026-10-12T00:00:00',
      }],
    };

    expect(() => mapSqlPublicContent(unlinkedBindingSource, options))
      .toThrow(/FileBindingOrganizationInfo#902: fileId does not resolve to an active file \(file-unlinked\)/);
  });
});
