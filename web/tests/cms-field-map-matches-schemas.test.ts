import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIELD_MAP,
  checkFieldMapAgainstSchema,
  type CmsSchema,
} from '../scripts/lib/content-field-map.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const API = join(ROOT, 'cms', 'src', 'api');

// Зарезервированные Strapi имена проверяются НЕ здесь, а в
// `cms/tests/reserved-attribute-names.test.js`: там признак берётся у самого Strapi, и пакет
// доступен без обходных путей. Держать вторую копию той же проверки в `web` значило бы завести
// два списка, которые разойдутся. Предмет этого файла — согласованность карты полей со схемами.

// Тип снимка → каталог типа содержимого CMS (множественное против единственного).
const TYPE_DIR: Record<string, string> = {
  institutes: 'institute',
  course_groups: 'course-group',
  seminars: 'seminar',
  teachers: 'teacher',
  articles: 'article',
  schedule_entries: 'schedule-entry',
  news: 'news-item',
  promotions: 'promotion',
  static_pages: 'page',
  video_playlists: 'video-playlist',
};

/** Схемы, ключом — ТИП СНИМКА: именно так их ждёт `checkFieldMapAgainstSchema`. */
function schemasBySnapshotType(): Record<string, CmsSchema> {
  const out: Record<string, CmsSchema> = {};
  for (const [type, dir] of Object.entries(TYPE_DIR)) {
    const file = join(API, dir, 'content-types', dir, 'schema.json');
    if (existsSync(file)) out[type] = JSON.parse(readFileSync(file, 'utf-8')) as CmsSchema;
  }
  return out;
}

/** Компоненты нужны, чтобы проверялись и подполя вида `seo.seo_title`, а не только корни. */
function components(): Record<string, CmsSchema> {
  const out: Record<string, CmsSchema> = {};
  const dir = join(ROOT, 'cms', 'src', 'components');
  if (!existsSync(dir)) return out;
  for (const group of readdirSync(dir)) {
    const groupDir = join(dir, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const file of readdirSync(groupDir)) {
      if (!file.endsWith('.json')) continue;
      out[`${group}.${file.replace(/\.json$/, '')}`] = JSON.parse(
        readFileSync(join(groupDir, file), 'utf-8'),
      ) as CmsSchema;
    }
  }
  return out;
}

describe('карта полей снимка согласована со схемами CMS', () => {
  // Каждый тип карты обязан разрешиться в схему. Прежде здесь стоял `continue`, и опечатка
  // в TYPE_DIR молча выключала проверку для целого типа: замена `seminars: 'seminar'` на
  // `'seminarXX'` оставляла все тесты зелёными — ровно тот случай, когда «не смогла
  // проверить» выдаётся за «нарушений нет».
  it('каждый тип карты полей разрешается в схему CMS', () => {
    const schemas = schemasBySnapshotType();
    const unresolved = [...new Set(FIELD_MAP.map((e) => e.type))].filter((t) => !schemas[t]);
    expect(
      unresolved,
      'тип карты полей не сопоставлен ни одной схеме: проверка источников для него ' +
        'не выполняется вовсе, а выглядит пройденной',
    ).toEqual([]);
  });

  // Сверку делает ТОТ ЖЕ `checkFieldMapAgainstSchema`, который зовёт съём снимка
  // (`web/scripts/capture-content-snapshot.ts`). Своя реализация здесь уже была и была
  // слабее: она смотрела только первый сегмент источника, поэтому исчезнувшее подполе
  // компонента (`seo.seo_title`) ловилось на съёме и пропускалось тестом. Две реализации
  // одной проверки неизбежно расходятся — и разошлись.
  it('ни один объявленный источник не исчез из схемы', () => {
    const schemas = schemasBySnapshotType();
    expect(Object.keys(schemas).length, 'схем не прочитано — проверка вакуумна').toBeGreaterThan(5);

    const result = checkFieldMapAgainstSchema({ map: FIELD_MAP, schemas, components: components() });
    expect(
      result.missingSources,
      'источник объявлен, но такого атрибута в схеме CMS нет: съём молча получит undefined',
    ).toEqual([]);
  });
});
