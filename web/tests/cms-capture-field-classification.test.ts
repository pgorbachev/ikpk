import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIELD_MAP,
  SOURCE_TYPES,
  UNMAPPED_SCHEMA_FIELDS,
  filledUnshownContentFields,
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
    Object.fromEntries(FIELD_MAP.filter((e) => e.type === 'seminars').map((e) => [e.source.split('.')[0]!, null]).concat(Object.entries(over)));

  it('отсутствие ключа-источника названо, а null и пустая коллекция — нет', () => {
    expect(missingSourceFields('seminars', full({}))).toEqual([]);
    expect(missingSourceFields('seminars', full({ teachers: [] }))).toEqual([]);
    const { teachers: _drop, ...without } = full({});
    expect(missingSourceFields('seminars', without)).toEqual(['seminars.teachers']);
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
});

