import { describe, it, expect } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import ScheduleFilters from '../src/components/schedule/ScheduleFilters.astro';
import type { MonthOption } from '../src/lib/schedule-months';

// ─── Рендер шаблона панели фильтров при данных, которых в снапшоте не бывает ───
// Спецификация: openspec/specs/schedule-month-filter/spec.md,
// требование «Контрол месяца не обещает того, чего не делает» (пустой список оставляет
// контрол выключенным, но НЕ убирает его из разметки).
//
// Почему это нельзя проверить ни dist-гейтом, ни браузерной проверкой:
//   dist  — показывает единственное состояние данных, а месяцев в снапшоте всегда больше
//           нуля (`monthOptions()` в dist-гейте прямо требует хотя бы одного);
//   браузер — `@month-empty-list` монтирует СВОЮ разметку и измеряет поведение скрипта,
//           то есть про шаблон не говорит ничего.
// Мутация «обернуть блок месяца в `{months.length > 0 && (…)}`» до этого файла не
// краснила ни в одном гейте.
//
// Цена ошибки названа в самой спеке: ранний выход скрипта управления гасит ВСЕ фильтры,
// если не находит своих элементов, поэтому исчезнувший контрол месяца увёл бы с собой
// поиск, институт, программу и город.

const PROPS = {
  institutes: [{ label: 'Институт Апледжера', value: 'institut-apledzhera' }],
  programs: [{ instituteSlug: 'institut-apledzhera', name: 'КСТ', slug: 'kst' }],
  cities: ['Москва'],
};

const render = async (months: MonthOption[]): Promise<string> => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(ScheduleFilters, { props: { ...PROPS, months } });
  // Пустой вывод сделал бы любые проверки ниже вакуумными.
  expect(html.length, 'компонент отрендерился пустым — проверять нечего').toBeGreaterThan(100);
  return html;
};

/** Открывающий тег контрола по признаку фильтра. */
const control = (html: string, name: string): string | undefined =>
  html.match(new RegExp(`<select\\b[^>]*\\bdata-schedule-filter="${name}"[^>]*>`, 'i'))?.[0];

describe('панель фильтров: контрол месяца в разметке', () => {
  it('пустой список месяцев не убирает контрол и не уносит остальные фильтры', async () => {
    const html = await render([]);

    const month = control(html, 'month');
    expect(month, 'при пустом списке месяцев контрол исчез из разметки').toBeTruthy();
    expect(month, 'контрол месяца без пустого списка приезжает включённым').toMatch(/\bdisabled\b/);

    // Соседи обязаны остаться: их потеря — тот самый способ, которым исчезнувший контрол
    // гасит панель целиком.
    for (const name of ['institute', 'program', 'city']) {
      expect(control(html, name), `фильтр ${name} исчез вместе с пустым списком месяцев`).toBeTruthy();
    }
    expect(html, 'поиск исчез вместе с пустым списком месяцев').toContain('data-schedule-search');

    // Ни одного пункта-месяца быть не должно: пустой список — это пустой список.
    expect(
      [...html.matchAll(/<option value="\d{4}-\d{2}"/g)].length,
      'при пустом списке месяцев в контроле есть пункты',
    ).toBe(0);
  });

  it('непустой список даёт пункты — иначе пустой случай не с чем сравнить', async () => {
    const html = await render([
      { key: '2026-11', count: 12 },
      { key: '2027-01', count: 3 },
    ]);

    expect(control(html, 'month'), 'контрол месяца не отрендерился').toBeTruthy();
    expect([...html.matchAll(/<option value="\d{4}-\d{2}"/g)].map((m) => m[0]).length).toBe(2);
    expect(html).toContain('Ноябрь 2026 (12)');
  });
});
