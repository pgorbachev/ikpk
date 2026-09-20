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

// Strapi 5 держит `status` за собой: это статус документа (draft/published). Тип
// содержимого, объявивший СВОЙ атрибут `status`, становится нередактируемым — поле
// зажато между двумя проверками, и ни одно значение не проходит обе. Измерено на
// стенде через тот же API, которым пользуется админка:
//
//   status=active     → 400 «Invalid status»                              (служебный)
//   status=draft      → 400 «must be one of: active, cancelled, completed» (свой enum)
//   status=published  → то же
//
// Импорт при этом работал: он пишет через публичный REST `/api/...`, где проверки
// статуса документа нет. Поэтому данные выглядели исправными, а редактор не мог
// сохранить ни одной записи — расхождение, которое не видно ни по данным, ни по сборке.
const RESERVED = ['status', 'documentId', 'locale', 'localizations', 'publishedAt', 'createdBy', 'updatedBy'];

describe('схемы CMS не используют зарезервированные Strapi имена', () => {
  it('ни один тип содержимого не объявляет атрибут с зарезервированным именем', () => {
    const offenders: string[] = [];
    for (const [type, attrs] of schemas()) {
      for (const name of Object.keys(attrs)) {
        if (RESERVED.includes(name)) offenders.push(`${type}.${name}`);
      }
    }
    expect(
      offenders,
      'такой атрибут нельзя ни сохранить, ни отредактировать через админку: ' +
        'Strapi 5 занимает это имя под статус документа',
    ).toEqual([]);
  });

  it('проверка вообще что-то видит — схемы прочитаны', () => {
    // Ноль схем означал бы «проверить не удалось», а не «нарушений нет».
    expect(schemas().size).toBeGreaterThan(5);
  });
});

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

  it('каждый объявленный источник существует атрибутом в схеме своего типа', () => {
    const all = schemas();
    const missing: string[] = [];
    for (const entry of FIELD_MAP) {
      const dir = TYPE_DIR[entry.type];
      const attrs = dir ? all.get(dir) : undefined;
      if (!attrs) continue; // тип без схемы проверяется отдельным тестом выше
      const root = entry.source.split('.')[0];
      if (!(root in attrs)) missing.push(`${entry.type}.${entry.field} ← ${entry.source}`);
    }
    expect(
      missing,
      'источник объявлен, но такого атрибута в схеме CMS нет: съём молча получит undefined',
    ).toEqual([]);
  });
});
