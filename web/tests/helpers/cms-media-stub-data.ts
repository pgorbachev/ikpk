// Данные заглушки системы управления для проверок медиа-конвейера
// (спека `cms-media-pipeline` change `cms-content-authoring-and-migration`).
//
// Отдельно от `cms-media-pipeline-contract.ts`: тот файл объявляет ИМЕНА и формы будущего
// контракта, этот — только тестовые данные. Смешивать нельзя: при переносе реализацией
// правится первый файл, а второй остаётся как есть.

import { CMS_UPLOADS_PREFIX } from './cms-media-pipeline-contract';
import type { StubCollection, StubUpload } from './cms-live-snapshot-capture-contract';

/**
 * Медиазапись Strapi. `url` — относительный путь каталога загрузок: именно его снятие снимка
 * обязано превратить в скачанные байты, а не переписать в ссылку.
 */
export function stubMedia(n: number): Record<string, unknown> {
  return {
    id: n,
    documentId: `media-${n}`,
    name: `img-${n}.webp`,
    url: `${CMS_UPLOADS_PREFIX}img-${n}.webp`,
    ext: '.webp',
    mime: 'image/webp',
    hash: `img_${n}`,
  };
}

/**
 * Байты файла заглушки. У каждого файла своё содержимое — иначе идентификаторы содержимого
 * совпадут и проверка «у каждого файла свои байты» станет вакуумной.
 */
export function stubUploadBytes(n: number): Buffer {
  return Buffer.from(`bytes-of-image-${n}${'.'.repeat(n)}`, 'utf-8');
}

/** Сколько РАЗНЫХ файлов лежит в каталоге загрузок заглушки. */
export const MEDIA_FILE_COUNT = 6;

/** Каталог загрузок заглушки. */
export function stubUploads(over: Record<string, StubUpload> = {}): Record<string, StubUpload> {
  const uploads: Record<string, StubUpload> = {};
  for (let n = 1; n <= MEDIA_FILE_COUNT; n += 1) {
    uploads[`${CMS_UPLOADS_PREFIX}img-${n}.webp`] = { bytes: stubUploadBytes(n) };
  }
  return { ...uploads, ...over };
}

const seo = (name: string): Record<string, unknown> => ({
  id: 1,
  seo_title: `${name}: title`,
  seo_description: `${name}: description`,
});

/**
 * Слуг и легаси-идентификатор НАМЕРЕННО совпадают: контракт связей сверяет то слуги, то
 * легаси-идентификаторы, и совпадение оставляет проверку про медиа, а не про выбор ключа.
 */
const key = (prefix: string): string => `${prefix}-001`;

const base = (prefix: string, name: string): Record<string, unknown> => ({
  id: 1,
  documentId: `${prefix}-doc-1`,
  name,
  slug: key(prefix),
  legacy_id: key(prefix),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  publishedAt: '2026-02-01T00:00:00.000Z',
});

const relRef = (prefix: string, name: string): Record<string, unknown> => ({
  id: 1,
  documentId: `${prefix}-doc-1`,
  name,
  slug: key(prefix),
  legacy_id: key(prefix),
});

/** Внешняя ссылка в теле статьи: предмет сценария «внешние ссылки в содержимом сохраняются». */
export const EXTERNAL_LINK_IN_BODY = 'https://example.invalid/external-article';

/**
 * Наименьший набор, проходящий контракт снимка: по одной записи каждого типа и шесть
 * медиафайлов. Малый намеренно — предмет здесь медиа, а не мощность выдачи: обход страниц
 * проверяется своим набором (`web/tests/cms-live-snapshot-capture.test.ts`).
 */
export function mediaDataset(over: Record<string, StubCollection> = {}): Record<string, StubCollection> {
  return {
    institutes: {
      records: [
        {
          ...base('inst', 'Institute'),
          shortName: 'I',
          description: '<p>about institute</p>',
          image: stubMedia(1),
          order: 0,
          seo: seo('Institute'),
        },
      ],
    },
    'course-groups': {
      records: [
        {
          ...base('cg', 'Program'),
          description: '<p>about program</p>',
          image: stubMedia(2),
          institute: relRef('inst', 'Institute'),
          seo: seo('Program'),
        },
      ],
    },
    seminars: {
      records: [
        {
          ...base('sem', 'Seminar'),
          description: '<p>about seminar</p>',
          full_text: '<p>details</p>',
          image: stubMedia(3),
          price: 1000,
          duration: '2 days',
          status: 'active',
          course_group: relRef('cg', 'Program'),
          teachers: [relRef('teach', 'Teacher')],
          seo: seo('Seminar'),
        },
      ],
    },
    teachers: {
      records: [
        {
          ...base('teach', 'Teacher'),
          photo: stubMedia(4),
          bio: '<p>biography</p>',
          institute: relRef('inst', 'Institute'),
        },
      ],
    },
    articles: {
      records: [
        {
          ...base('art', 'Article'),
          title: 'Article',
          body: `<p>body with <a href="${EXTERNAL_LINK_IN_BODY}">external link</a></p>`,
          image: stubMedia(5),
          published_date: '2026-01-15T00:00:00.000Z',
          seo: seo('Article'),
        },
      ],
    },
    'schedule-entries': {
      records: [
        {
          ...base('ev', 'Event'),
          startAt: '2026-09-01T00:00:00.000Z',
          endAt: '2026-09-02T00:00:00.000Z',
          city: 'Saint Petersburg',
          price: 5000,
          oldPrice: 6000,
          isFree: false,
          status: 'active',
          registrationFormLink: 'https://example.invalid/form',
          description: '<p>event description</p>',
          additionalText: '<p>addendum</p>',
          duration: '2 days',
          seminar: relRef('sem', 'Seminar'),
          teachers: [{ id: 1, fullName: 'Teacher' }],
        },
      ],
    },
    'news-items': {
      records: [
        {
          ...base('news', 'News'),
          description: '<p>news</p>',
          image: stubMedia(6),
          link: 'https://example.invalid',
          priority: 0,
        },
      ],
    },
    promotions: {
      records: [
        {
          ...base('promo', 'Promotion'),
          description: '<p>promotion</p>',
          // Тот же файл, что у новости: повторная ссылка на одно содержимое обязана дать ОДНУ
          // запись хранилища, а не две (идемпотентность по содержимому).
          image: stubMedia(6),
          link: 'https://example.invalid',
          priority: 0,
          active: true,
        },
      ],
    },
    pages: {
      records: [
        {
          ...base('page', 'Page'),
          title: 'Page',
          body: '<p>page body</p>',
          seo: seo('Page'),
        },
      ],
    },
    'video-playlists': {
      records: [
        {
          ...base('vp', 'Playlist'),
          videos: [{ url: 'https://example.invalid/v' }],
          seo: seo('Playlist'),
        },
      ],
    },
    ...over,
  };
}
