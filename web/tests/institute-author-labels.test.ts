import { describe, expect, it } from 'vitest';
import { institutePeopleSectionLabel, pedagogicalStaff, personRoleLabels, type Teacher } from '../src/lib/data.js';

const teacher = (legacyId: number, institute: string, trait: Teacher['trait']): Teacher => ({
  legacy_id: String(legacyId),
  legacy_url: `/${legacyId}`,
  name: `Персона ${legacyId}`,
  slug: String(legacyId),
  trait,
  institute_legacy_id: institute,
  bio_html: '',
  bio_text: '',
  photo: '',
});

describe('owner-approved institute author labels', () => {
  it.each(['institut-apledzhera', 'institut-barralya'])('labels %s institute people as method authors', (slug) => {
    expect(institutePeopleSectionLabel(slug)).toBe('Авторы методик');
  });

  it.each(['63', '64'])('profile %s uses author labels while keeping the established profile route', (legacyId) => {
    const labels = personRoleLabels('method-author');
    expect(labels).toEqual({
      title: 'автор методики',
      breadcrumb: 'Авторы методик',
      about: 'Об авторе методики',
    });
    expect(`/${'institut-apledzhera'}/prepodavatel/${legacyId}`).toBe(`/institut-apledzhera/prepodavatel/${legacyId}`);
  });

  it('keeps other institute profiles and the education roster labeled as teachers', () => {
    expect(institutePeopleSectionLabel('institut-klinicheskoy-prikladnoy-kineziologii')).toBe('Преподаватели');
    expect(personRoleLabels('teacher')).toEqual({
      title: 'преподаватель',
      breadcrumb: 'Преподаватели',
      about: 'О преподавателе',
    });
    const roster = [
      ...Array.from({ length: 16 }, (_, index) => teacher(index + 1, 'institut-klinicheskoy-prikladnoy-kineziologii', 'teacher')),
      ...Array.from({ length: 15 }, (_, index) => teacher(index + 101, 'institut-apledzhera', 'method-author')),
    ];
    expect(pedagogicalStaff(roster).map((person) => person.legacy_id)).toEqual(
      Array.from({ length: 16 }, (_, index) => String(index + 1)),
    );
  });
});
