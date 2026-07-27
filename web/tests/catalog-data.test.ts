import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ENTITIES = join(import.meta.dirname, '..', '..', 'discovery', 'entities');
const load = <T>(f: string): T => JSON.parse(readFileSync(join(ENTITIES, f), 'utf-8')) as T;

interface Seminar {
  slug: string;
  name: string;
  status: string;
  description_html: string;
  order?: number;
}
interface Entry {
  status?: string;
  startAt?: string;
  endAt?: string;
  seminar?: { slug?: string } | null;
}

const seminars = load<Seminar[]>('seminars.json');
const schedule = load<Entry[]>('schedule_entries.json');

const section = (html: string, title: string): string => {
  const m = html.match(new RegExp(`<h2>${title}</h2>([\\s\\S]*?)(?=<h2>|$)`));
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

describe('данные каталога', () => {
  // Имена полей в API обманчивы: curriculum содержит РЕЖИМ обучения
  // («2 дня с 10:00 до 18:00», «объём 36 часов»), а learningProcess — учебный
  // план с темами. Первая версия импорта подписала их наоборот, и 11 семинаров
  // получили под «Учебным планом» одну строку про длительность.
  // Фикстура с ОБОИМИ непустыми полями: именно так выглядит прежний дефект в
  // общем виде. Проверка по реальным данным ловила лишь частный случай — когда
  // «Как проходит обучение» пусто, — и перестановку двух заполненных полей
  // пропускала.
  it('секции подписаны по смыслу, а не по имени поля API', async () => {
    const { sectionsHtml, SECTION_TITLES } = await import('../scripts/lib/seminar-sections');

    const fixture = {
      // как в живом API: curriculum — режим, learningProcess — план
      curriculum: '<p>Объем программы: 36 академических часов. 3 дня с 10:00 до 18:00.</p>',
      learningProcess: '<p><b>Теория</b></p><p>1. История развития прикладной кинезиологии.</p>',
      certificates: '<p>Удостоверение о повышении квалификации.</p>',
      recommendations: '<p>Рекомендуется книга.</p>',
    };

    const html = sectionsHtml(fixture);
    const plan = section(html, SECTION_TITLES.plan);
    const process = section(html, SECTION_TITLES.process);

    expect(plan, 'под «Учебным планом» должны быть темы').toMatch(/История развития/);
    expect(process, 'под «Как проходит обучение» — режим и объём').toMatch(/академических часов/);
    expect(plan, 'в «Учебном плане» не должно быть режима').not.toMatch(/академических часов/);
    expect(process, 'в «Как проходит обучение» не должно быть тем').not.toMatch(/История развития/);
  });

  // Дополнительно — по реальным данным: под «Учебным планом» не должно
  // оказаться одной строки про длительность.
  it('в текущих данных под «Учебным планом» не режим обучения', () => {
    const swapped: string[] = [];
    for (const s of seminars) {
      const plan = section(s.description_html, 'Учебный план');
      const looksLikeSchedule =
        plan.length > 0 &&
        plan.length < 200 &&
        /(\d+\s*(дня|дней|день)|академических часов|\d{1,2}:\d{2})/i.test(plan);
      if (looksLikeSchedule) swapped.push(`${s.slug}: «${plan.slice(0, 60)}»`);
    }
    expect(
      swapped.slice(0, 5),
      `под «Учебным планом» режим обучения (${swapped.length}):\n${swapped.slice(0, 5).join('\n')}`,
    ).toEqual([]);
  });

  // Поле events у семинара означает, что событие когда-либо существовало,
  // включая прошедшие. Статус по нему давал 107 «запланированных» при 47
  // реально имеющих будущие даты: человек идёт искать даты, которых нет.
  it('статус «запланирован» соответствует будущим датам в расписании', () => {
    // Календарные даты, а не полные метки: startAt хранится с временем 00:00, и
    // сравнение с текущим моментом выбрасывало семинар из «запланированных» уже
    // в первую минуту дня проведения. Учитываем последний день многодневного
    // обучения — таких событий 60 из 63.
    const today = new Date().toISOString().slice(0, 10);
    const lastDay = (e: Entry): string =>
      ((e.endAt ?? '') > (e.startAt ?? '') ? e.endAt! : (e.startAt ?? '')).slice(0, 10);

    const withFuture = new Set(
      schedule
        .filter((e) => e.status === 'active' && lastDay(e) >= today && e.seminar?.slug)
        .map((e) => e.seminar!.slug!),
    );

    const planned = seminars.filter((s) => s.status === 'planned').map((s) => s.slug);
    const falsePositives = planned.filter((slug) => !withFuture.has(slug));

    expect(
      falsePositives.slice(0, 5),
      `помечены запланированными без будущих дат (${falsePositives.length} из ${planned.length}):\n${falsePositives.slice(0, 5).join('\n')}`,
    ).toEqual([]);
  });

  it('порядок следования снят с живого сайта', () => {
    const withoutOrder = seminars.filter((s) => s.order === undefined);
    // без order остаются только записи, исчезнувшие с живого и сохранённые осознанно
    expect(withoutOrder.length).toBeLessThanOrEqual(2);
  });
});

// ── Служебные заголовки укладываются в бюджет поиска ────────────────────────
// Гейт «непустой title» пропускал слишком длинные: первая версия шаблона
// собирала 73–143 символа из полного названия института, и сниппет обрезался бы
// в выдаче. Проверяем НАШ шаблон, а не унаследованные seo-заголовки заказчика:
// те доходят до 223 символов, но переписывать их — вопрос к заказчику.
describe('служебные заголовки', () => {
  it('шаблонные заголовок и описание укладываются в бюджет', async () => {
    const { seminarTitleFallback, seminarDescriptionFallback, TITLE_BUDGET, DESCRIPTION_BUDGET } =
      await import('../src/lib/seo-fallback');

    const institutes = load<Array<{ slug: string; name: string }>>('institutes.json');
    const groups = load<Array<{ legacy_id: string; name: string }>>('course_groups.json');
    const byId = new Map(groups.map((g) => [g.legacy_id, g.name]));

    const tooLong: string[] = [];
    for (const s of seminars as Array<Seminar & { course_group_legacy_id?: string; institute_legacy_id?: string }>) {
      const inst = institutes.find((i) => i.slug === s.institute_legacy_id) ?? institutes[0];
      const group = byId.get(s.course_group_legacy_id ?? '') ?? '';

      const title = seminarTitleFallback(s.name, inst.slug, inst.name);
      const description = seminarDescriptionFallback(s.name, group, inst.slug, inst.name);

      if (title.length > TITLE_BUDGET) tooLong.push(`title ${title.length}: ${s.slug}`);
      if (description.length > DESCRIPTION_BUDGET) {
        tooLong.push(`description ${description.length}: ${s.slug}`);
      }
    }

    expect(
      tooLong.slice(0, 5),
      `шаблон вышел за бюджет (${tooLong.length}):\n${tooLong.slice(0, 5).join('\n')}`,
    ).toEqual([]);
  });
});
