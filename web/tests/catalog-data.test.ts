import { describe, it, expect } from 'vitest';
import { loadPinnedType } from './helpers/pinned-snapshot';

const load = <T>(f: string): T => {
  const type = f.replace(/\.json$/, '');
  return loadPinnedType<T>(type);
};

interface Seminar {
  slug: string;
  name: string;
  status: string;
  description_html: string;
  order?: number;
}

const seminars = load<Seminar[]>('seminars.json');

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

  // Соответствие поля `status` будущим датам расписания здесь БОЛЬШЕ НЕ
  // проверяется, и это не упущение.
  //
  // Проверка сравнивала снимок данных с текущей календарной датой, поэтому
  // краснела от простого хода времени: 2026-08-03 она упала на семинаре
  // `mezhseminarskaya-vstrecha-praktikum-dlya-specialistov-kst`, чья
  // единственная дата прошла 29 июля. Код был исправен — устарел снимок.
  // Гейт, который не отличает дефект от календаря, обесценивает красный прогон.
  //
  // Сам вывод (прошедшее событие не делает семинар запланированным) проверяется
  // фикстурами с фиксированной датой в `planned-seminars.test.ts`. Поле `status`
  // в снимке при этом ничего на страницах не определяет: тип `Seminar` во
  // фронтенде его не содержит, а расписание и карточка семинара считают
  // актуальность от даты сборки.

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
