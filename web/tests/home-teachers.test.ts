import { describe, it, expect } from 'vitest';
import { getSeminars, getTeachers, getCourseGroups } from '../src/lib/data.js';
import { findTeacherForSeminar, seminarTeacherLabel } from '../src/lib/home.js';

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
