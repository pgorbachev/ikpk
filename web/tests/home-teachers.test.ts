import { describe, it, expect } from 'vitest';
import { getSeminars, getTeachers, getCourseGroups, pedagogicalStaff } from '../src/lib/data.js';
import { findTeacherForSeminar, selectHomepagePeople, seminarTeacherLabel } from '../src/lib/home.js';

describe('findTeacherForSeminar', () => {
  it('берёт преподавателя из seminar.teachers, а не первого с фото у института', () => {
    const pelvic = getSeminars().find((s) => /тазов/i.test(s.name));
    expect(pelvic, 'в каталоге нет семинара про тазовый регион').toBeTruthy();
    const label = seminarTeacherLabel(pelvic!.teachers);
    expect(label).toMatch(/Шадрин/);

    const resolved = findTeacherForSeminar(pelvic!.teachers, getTeachers());
    expect(resolved?.name).toMatch(/Шадрин/);

    const cg = getCourseGroups().find((c) => c.legacy_id === pelvic!.course_group_legacy_id)!;
    const instituteFirstPhoto = getTeachers().find(
      (t) => t.institute_legacy_id === cg.institute_legacy_id && t.photo
    );
    // Именно этот фолбэк и давал подмену на демо.
    expect(instituteFirstPhoto?.name).not.toMatch(/Шадрин/);
    expect(resolved!.legacy_id).not.toBe(instituteFirstPhoto!.legacy_id);
  });

  it('пустой список → undefined, без подстановки чужого', () => {
    expect(findTeacherForSeminar([], getTeachers())).toBeUndefined();
    expect(findTeacherForSeminar(undefined, getTeachers())).toBeUndefined();
    expect(seminarTeacherLabel([])).toBe('');
  });
});

describe('selectHomepagePeople', () => {
  const people = [
    ...Array.from({ length: 9 }, (_, index) => ({
      legacy_id: `teacher-${index + 1}`,
      legacy_url: '',
      slug: `teacher-${index + 1}`,
      name: `Преподаватель ${index + 1}`,
      trait: 'teacher' as const,
      bio_html: '',
      bio_text: '',
      photo: `/teacher-${index + 1}.jpg`,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      legacy_id: `author-${index + 1}`,
      legacy_url: '',
      slug: `author-${index + 1}`,
      name: `Автор ${index + 1}`,
      trait: 'method-author' as const,
      bio_html: '',
      bio_text: '',
      photo: `/author-${index + 1}.jpg`,
    })),
  ];

  it('keeps eight cards and gives both roles an ordered share of the visible selection', () => {
    const selected = selectHomepagePeople(people);

    expect(selected).toHaveLength(8);
    expect(selected.slice(0, 4).map((person) => person.legacy_id)).toEqual([
      'teacher-1', 'teacher-2', 'teacher-3', 'teacher-4',
    ]);
    expect(selected.slice(4).map((person) => person.legacy_id)).toEqual([
      'author-1', 'author-2', 'author-3', 'author-4',
    ]);
  });

  it('does not let trait-less legacy people consume the teacher quota', () => {
    const legacyPerson = { ...people[0]!, legacy_id: 'legacy-person', trait: undefined };
    const selected = selectHomepagePeople([legacyPerson, ...people]);

    expect(selected.slice(0, 4).map((person) => person.legacy_id)).toEqual([
      'teacher-1', 'teacher-2', 'teacher-3', 'teacher-4',
    ]);
    expect(selected.slice(4).map((person) => person.legacy_id)).toEqual([
      'author-1', 'author-2', 'author-3', 'author-4',
    ]);
  });

  it('fills from the longer role when the other role is short and deduplicates shared IDs', () => {
    const short = [
      { ...people[0]!, legacy_id: 'same-id' },
      ...Array.from({ length: 9 }, (_, index) => ({
        ...people[9]!,
        legacy_id: index === 0 ? 'same-id' : `author-extra-${index}`,
      })),
    ];

    const selected = selectHomepagePeople(short);

    expect(selected).toHaveLength(8);
    expect(new Set(selected.map((person) => person.legacy_id)).size).toBe(8);
    expect(selected.filter((person) => person.trait === 'method-author')).toHaveLength(7);
    expect(pedagogicalStaff(selected).every((person) => person.trait === 'teacher')).toBe(true);
  });
});
