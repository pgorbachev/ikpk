import { describe, it, expect } from 'vitest';
import { getSeminars, getTeachers, getCourseGroups } from '../src/lib/data.js';
import { findTeacherForSeminar, selectHomepagePeopleByRole, seminarTeacherLabel } from '../src/lib/home.js';

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

describe('selectHomepagePeopleByRole', () => {
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

  it('keeps up to eight source-ordered people in each independent role list', () => {
    const selected = selectHomepagePeopleByRole(people);

    expect(selected.teachers.map((person) => person.legacy_id)).toEqual(
      people.slice(0, 8).map((person) => person.legacy_id),
    );
    expect(selected.methodAuthors.map((person) => person.legacy_id)).toEqual(
      people.slice(9, 17).map((person) => person.legacy_id),
    );
  });

  it('does not let one role fill a short list from the other', () => {
    const selected = selectHomepagePeopleByRole([...people.slice(0, 2), ...people.slice(9)]);

    expect(selected.teachers.map((person) => person.legacy_id)).toEqual(['teacher-1', 'teacher-2']);
    expect(selected.methodAuthors.map((person) => person.legacy_id)).toEqual([
      'author-1', 'author-2', 'author-3', 'author-4', 'author-5',
    ]);
  });

  it('deduplicates repeated identities without changing either role order', () => {
    const repeated = [...people];
    repeated.splice(1, 0, { ...people[0]!, name: 'Duplicate teacher' });
    repeated.splice(repeated.length - 1, 0, { ...people[9]!, name: 'Duplicate author' });
    const selected = selectHomepagePeopleByRole([
      ...repeated,
    ]);

    expect(selected.teachers).toHaveLength(8);
    expect(selected.methodAuthors).toHaveLength(5);
    expect(new Set(selected.teachers.map((person) => person.legacy_id)).size).toBe(8);
    expect(new Set(selected.methodAuthors.map((person) => person.legacy_id)).size).toBe(5);
    expect(selected.teachers.at(-1)?.name).toBe('Преподаватель 8');
    expect(selected.methodAuthors.at(-1)?.name).toBe('Автор 5');
  });
});
