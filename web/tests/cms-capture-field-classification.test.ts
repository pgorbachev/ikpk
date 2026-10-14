import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIELD_MAP,
  SOURCE_TYPES,
  UNMAPPED_SCHEMA_FIELDS,
  filledUnshownContentFields,
  hasValue,
  missingSourceFields,
  unknownRecordFields,
  type CmsSchema,
} from '../scripts/lib/content-field-map.ts';

const ROOT = join(import.meta.dirname, '..', '..');

// Каждое поле записи CMS либо переносится картой, либо названо непереносимым с причиной. Иначе
// съём отказывает: так 13.10.2026 молча пропали фото (поле стало списком) — съём был зелёным.
describe('съём знает каждое поле записи CMS', () => {
  it('запись установленной CMS с непереносимыми полями — без неизвестных', () => {
    expect(
      unknownRecordFields('teachers', {
        id: 144, documentId: 'd', createdAt: '', updatedAt: '', publishedAt: '',
        legacy_id: '63', name: 'Имя', slug: '63', bio: '<p>б</p>', photo: [], order: 1,
        institute: null, seminars: [], trait: 'teacher',
      }),
    ).toEqual([]);
    expect(
      unknownRecordFields('seminars', {
        legacy_id: 'x', name: 'С', slug: 's', documents_state: 'unconfirmed', learning_plan: null,
        seo: { id: 1, seo_title: 't', seo_description: 'd', og_image: null, noindex: false },
      }),
    ).toEqual([]);
  });

  it('запись прежней схемы тоже без неизвестных', () => {
    expect(unknownRecordFields('seminars', { legacy_id: 'x', seminar_status: 'planned', price: 1, duration: '2 дня' })).toEqual([]);
  });

  it('неизвестное поле верхнего уровня названо', () => {
    expect(unknownRecordFields('teachers', { name: 'И', mystery: 1 })).toEqual(['teachers.mystery']);
  });

  it('неизвестное подполе seo названо', () => {
    expect(unknownRecordFields('articles', { seo: { id: 1, seo_title: 't', canonical: '/x' } })).toEqual(['articles.seo.canonical']);
  });

  it('поле, непереносимое у одного типа, у другого неизвестно', () => {
    expect(unknownRecordFields('articles', { trait: 'teacher' })).toEqual(['articles.trait']);
  });

  it('каждое поле схемы cms/ в репозитории либо в карте, либо названо непереносимым', () => {
    const undecided: string[] = [];
    for (const st of SOURCE_TYPES) {
      const file = join(ROOT, st.schema);
      expect(existsSync(file), st.schema).toBe(true);
      const schema = JSON.parse(readFileSync(file, 'utf-8')) as CmsSchema;
      const record = Object.fromEntries(Object.keys(schema.attributes).map((k) => [k, null]));
      undecided.push(...unknownRecordFields(st.type, record));
    }
    expect(undecided).toEqual([]);
  });

  it('непереносимое поле не дублирует поле карты', () => {
    const both = Object.entries(UNMAPPED_SCHEMA_FIELDS).flatMap(([type, fields]) =>
      Object.keys(fields).filter((f) => FIELD_MAP.some((e) => e.type === type && e.source.split('.')[0] === f)).map((f) => `${type}.${f}`),
    );
    expect(both).toEqual([]);
  });

  it('имя поля из прототипа объекта не проходит как решение', () => {
    expect(unknownRecordFields('teachers', { constructor: 1, toString: 2 })).toEqual(['teachers.constructor', 'teachers.toString']);
  });
});

describe('ключ-источник в ответе и заполненные поля, которые сайт не показывает', () => {
  const full = (over: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries([
      ...FIELD_MAP.filter((e) => e.type === 'seminars').map((e): [string, unknown] => [e.source.split('.')[0]!, null]),
      ...Object.entries(over),
    ]);

  it('отсутствие ключа-источника названо, а null и пустая коллекция — нет', () => {
    expect(missingSourceFields('seminars', full({}))).toEqual([]);
    expect(missingSourceFields('seminars', full({ teachers: [] }))).toEqual([]);
    const withoutTeachers = full({});
    delete withoutTeachers.teachers;
    expect(missingSourceFields('seminars', withoutTeachers)).toEqual(['seminars.teachers ← teachers']);
  });

  it('заполненное поле содержимого, которое сайт не показывает, названо', () => {
    expect(filledUnshownContentFields('seminars', { recommendations: '<p>Совет</p>', learning_plan: null, documents: [] })).toEqual(['seminars.recommendations']);
    expect(filledUnshownContentFields('seminars', { documents: [{ id: 1, title: 'Удостоверение' }] })).toEqual(['seminars.documents']);
  });

  it('служебная отметка о документах заполненным содержимым не считается', () => {
    expect(filledUnshownContentFields('seminars', { documents_state: 'unconfirmed', documents_confirmation_author: 'x' })).toEqual([]);
  });

  it('пустая строка и строка из пробелов — пустое значение', () => {
    expect(filledUnshownContentFields('seminars', { learning_mode: '', recommendations: '   ' })).toEqual([]);
  });

  it('исчезнувший вложенный ключ-источник назван обоими именами', () => {
    const rec = full({ seo: { id: 1, seo_description: 'd' } });
    expect(missingSourceFields('seminars', rec)).toEqual(['seminars.seo_title ← seo.seo_title']);
    expect(missingSourceFields('seminars', full({ seo: null }))).toEqual([]);
  });

  it('пустой rich-text и false — не данные', () => {
    expect(hasValue('<p></p>')).toBe(false);
    expect(hasValue('<p>&nbsp;</p>')).toBe(false);
    expect(hasValue(false)).toBe(false);
    expect(hasValue(true)).toBe(true);
    expect(hasValue('<p>x</p>')).toBe(true);
    expect(hasValue('<p>&#160;</p>')).toBe(false);
    // Картинка, встраивание или автоссылка без текста — данные: иначе такой «план» прошёл бы молча.
    expect(hasValue('<p><img src="/uploads/plan.png"></p>')).toBe(true);
    expect(hasValue('<iframe src="https://example.invalid/v"></iframe>')).toBe(true);
    expect(hasValue('<https://example.invalid/plan>')).toBe(true);
    for (const tag of ['<video src="v.mp4"></video>', '<audio src="a.mp3"></audio>', '<embed src="x">', '<object data="x"></object>', '<IMG SRC="x">']) {
      expect(hasValue(`<p>${tag}</p>`), tag).toBe(true);
    }
    expect(hasValue('<p>&#xa0;</p>')).toBe(false);
    // Граница слова: тег, лишь начинающийся с имени медиа-тега, — разметка, а не данные.
    expect(hasValue('<objective></objective><imgx></imgx><videos></videos>')).toBe(false);
  });

  it('подполе связи тоже сверяется с ответом', () => {
    const rec = full({ course_group: { id: 1, name: 'Программа' } });
    expect(missingSourceFields('seminars', rec)).toEqual(['seminars.course_group_legacy_id ← course_group.legacy_id']);
  });
});

