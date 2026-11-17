import { describe, expect, it } from 'vitest';
import { resolveTeacherReference, teacherPageHref } from '../src/lib/data.js';
import type { Teacher } from '../src/lib/data.js';

const teacher = (overrides: Partial<Teacher> = {}): Teacher => ({
  documentId: 'teacher-a',
  legacy_id: 'old-a',
  legacy_url: '/teachers/old-a',
  slug: 'same-name-a',
  name: 'Одинаковое имя',
  institute_legacy_id: 'institute',
  bio_html: '',
  bio_text: '',
  photo: '',
  ...overrides,
});

describe('resolveTeacherReference', () => {
  it('uses exact documentId as the authoritative identity, even with duplicate names', () => {
    const first = teacher();
    const second = teacher({ documentId: 'teacher-b', legacy_id: 'old-b', slug: 'same-name-b' });
    expect(resolveTeacherReference({ documentId: 'teacher-b', id: 'old-a' }, [first, second])).toBe(second);
    expect(teacherPageHref(resolveTeacherReference({ documentId: 'teacher-b', id: 'old-a' }, [first, second])))
      .toBe('/institute/prepodavatel/same-name-b');
    const newTeacher = teacher({ documentId: 'teacher-new', legacy_id: undefined, legacy_url: undefined, slug: 'new-teacher' });
    expect(teacherPageHref(resolveTeacherReference({ documentId: 'teacher-new', id: 'teacher-new' }, [newTeacher])))
      .toBe('/institute/prepodavatel/new-teacher');
  });

  it('does not fall back when documentId is missing from the target set or ambiguous', () => {
    const first = teacher();
    expect(resolveTeacherReference({ documentId: 'unknown', id: 'old-a' }, [first])).toBeUndefined();
    expect(resolveTeacherReference({ documentId: ' ', id: 'old-a' }, [first])).toBeUndefined();
    expect(resolveTeacherReference({ documentId: 'teacher-a', id: 'old-a' }, [first, teacher()])).toBeUndefined();
  });

  it('supports old pinned snapshots by a unique legacy_id only', () => {
    const first = teacher({ documentId: undefined });
    expect(resolveTeacherReference({ id: 'old-a' }, [first])).toBe(first);
    expect(resolveTeacherReference({ id: 'old-a' }, [first, teacher({ documentId: undefined })])).toBeUndefined();
    expect(resolveTeacherReference({ id: 'missing' }, [first])).toBeUndefined();
  });
});
