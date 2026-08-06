import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Целостность связи семинара с группой курсов.
//
// Дефект, ради которого гейт заведён: `refresh-catalog.ts` брал группу только из
// ответа API, и при неполном ответе `programById.get()` возвращал undefined. У
// существующего семинара тогда обнулялся `course_group_legacy_id`, а вместе с ним
// пересчитывались `legacy_id` и `legacy_url` — то есть менялся АДРЕС страницы, и
// статический маршрут исчезал из сборки. По объёму потеря одной программы из 26
// меньше любого разумного порога, поэтому блокировка по количеству этот случай не
// ловит принципиально.
const ENTITIES = join(import.meta.dirname, '..', '..', 'discovery', 'entities');
const load = <T>(file: string): T =>
  JSON.parse(readFileSync(join(ENTITIES, file), 'utf-8')) as T;

interface Seminar {
  slug: string;
  legacy_id: string;
  legacy_url: string;
  course_group_legacy_id: string | null;
}
interface Group {
  legacy_id: string;
}

describe('связь семинара с группой курсов', () => {
  const seminars = load<Seminar[]>('seminars.json');
  const groups = load<Group[]>('course_groups.json');

  it('данные непусты — иначе проверки ниже вакуумны', () => {
    expect(seminars.length, 'seminars.json пуст').toBeGreaterThan(0);
    expect(groups.length, 'course_groups.json пуст').toBeGreaterThan(0);
  });

  it('у каждого семинара есть группа', () => {
    const orphans = seminars.filter((s) => !s.course_group_legacy_id).map((s) => s.slug);
    expect(
      orphans.slice(0, 8),
      `семинаров без группы: ${orphans.length} — их адреса пересчитаются и маршруты исчезнут\n${orphans.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });

  it('группа каждого семинара существует в каталоге групп', () => {
    const known = new Set(groups.map((g) => g.legacy_id));
    const broken = seminars
      .filter((s) => s.course_group_legacy_id && !known.has(s.course_group_legacy_id))
      .map((s) => `${s.slug} → ${s.course_group_legacy_id}`);
    expect(
      broken.slice(0, 8),
      `семинаров со ссылкой на несуществующую группу: ${broken.length}\n${broken.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });

  // Адрес обязан быть выведен из связи: именно это ломалось при её обнулении.
  it('адрес семинара согласован с его группой', () => {
    // Сравниваем ПУТЬ, а не строку целиком: у части записей `legacy_url` сохранён
    // абсолютным адресом старого сайта, и это форма записи, а не разрыв связи.
    const pathOf = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '');
    const wrong = seminars
      .filter((s) => s.course_group_legacy_id)
      .filter((s) => pathOf(s.legacy_url) !== `/${s.course_group_legacy_id}/${s.slug}`)
      .map((s) => `${s.slug}: ${s.legacy_url} при группе ${s.course_group_legacy_id}`);
    expect(
      wrong.slice(0, 8),
      `адрес не соответствует связи с группой: ${wrong.length}\n${wrong.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });

  // Обновление каталога обязано подстраховывать связь прежними данными и падать,
  // если ответ API её не дал: без этого дефект возвращается при первом же неполном
  // ответе, а гейт по данным увидит его только после запуска обновления.
  it('обновление каталога страхует связь и блокирует запись при разрыве', () => {
    const script = readFileSync(
      join(import.meta.dirname, '..', 'scripts', 'refresh-catalog.ts'),
      'utf-8',
    );
    const code = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');

    expect(
      /groupPath\(program\)\s*\?\?\s*previousGroup/.test(code),
      'связь с группой не страхуется прежними данными — неполный ответ API обнулит адрес',
    ).toBe(true);
    expect(
      /brokenLinks\.length\s*>\s*0/.test(code) && /blockers\.push/.test(code),
      'разрыв связи не блокирует запись',
    ).toBe(true);
  });
});
