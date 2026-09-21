import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIELD_MAP } from '../scripts/lib/content-field-map.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const API = join(ROOT, 'cms', 'src', 'api');

/** Схемы типов содержимого CMS: имя типа → атрибуты. */
function schemas(): Map<string, Record<string, { type?: string }>> {
  const out = new Map<string, Record<string, { type?: string }>>();
  for (const dir of readdirSync(API, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const ct = join(API, dir.name, 'content-types', dir.name, 'schema.json');
    try {
      const parsed = JSON.parse(readFileSync(ct, 'utf-8')) as {
        attributes?: Record<string, { type?: string }>;
      };
      if (parsed.attributes) out.set(dir.name, parsed.attributes);
    } catch {
      // типа без схемы не бывает; отсутствие файла — не предмет этой проверки
    }
  }
  return out;
}

// Зарезервированные Strapi имена проверяются НЕ здесь, а в `cms/tests/reserved-attribute-names.test.js`:
// там признак берётся у самого Strapi из его же конструктора типов, а пакет доступен без
// обходных путей. Держать вторую копию той же проверки в `web` значило бы завести два списка,
// которые разойдутся. Предмет этого файла — согласованность карты полей снимка со схемами.

describe('карта полей снимка согласована со схемами CMS', () => {
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

  // Каждый тип карты обязан разрешиться в схему. Прежде здесь стоял `continue`, и
  // опечатка в TYPE_DIR молча выключала проверку для целого типа: замена
  // `seminars: 'seminar'` на `'seminarXX'` оставляла все три теста зелёными —
  // ровно тот случай, когда «не смогла проверить» выдаётся за «нарушений нет».
  it('каждый тип карты полей разрешается в схему CMS', () => {
    const all = schemas();
    const unresolved = [...new Set(FIELD_MAP.map((e) => e.type))].filter((type) => {
      const dir = TYPE_DIR[type];
      return !dir || !all.get(dir);
    });
    expect(
      unresolved,
      'тип карты полей не сопоставлен ни одной схеме: проверка источников для него ' +
        'не выполняется вовсе, а выглядит пройденной',
    ).toEqual([]);
  });

  it('каждый объявленный источник существует атрибутом в схеме своего типа', () => {
    const all = schemas();
    const missing: string[] = [];
    for (const entry of FIELD_MAP) {
      const dir = TYPE_DIR[entry.type];
      const attrs = dir ? all.get(dir) : undefined;
      if (!attrs) continue; // отсутствие сопоставления ловит тест выше
      const root = entry.source.split('.')[0];
      if (!(root in attrs)) missing.push(`${entry.type}.${entry.field} ← ${entry.source}`);
    }
    expect(
      missing,
      'источник объявлен, но такого атрибута в схеме CMS нет: съём молча получит undefined',
    ).toEqual([]);
  });
});
