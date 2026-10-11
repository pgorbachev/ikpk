import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Неизвестное значение порядка даёт порядок по умолчанию (новые раньше), а не пустой
 * список. Правило живёт в скрипте страницы каталога; тест исполняет ровно те две строки,
 * которые там стоят, а не копию рядом.
 */
const source = readFileSync(new URL('../src/pages/statyi/index.astro', import.meta.url), 'utf8');
const rule = source.match(
  /if \(activeSort === 'date_asc'\) return leftDate - rightDate;\s*return rightDate - leftDate;/,
);

const compare = new Function(
  'activeSort',
  'leftDate',
  'rightDate',
  `${rule?.[0] ?? 'throw new Error("правила сортировки в странице каталога нет")'}`,
) as (sort: string, left: number, right: number) => number;

describe('неизвестный порядок каталога статей', () => {
  it('правило в странице есть и оно одно', () => {
    expect(rule, 'в скрипте каталога нет ветви date_asc с запасным порядком по умолчанию').not.toBeNull();
    const copies = source.match(/return rightDate - leftDate/g) ?? [];
    expect(copies).toHaveLength(1);
  });

  it('всё, кроме возрастания даты, сортирует от новых к старым', () => {
    const older = 1;
    const newer = 2;
    expect(compare('date_asc', older, newer)).toBeLessThan(0);
    expect(compare('date_desc', older, newer)).toBeGreaterThan(0);
    expect(compare('title_asc', older, newer)).toBeGreaterThan(0);
    expect(compare('', older, newer)).toBeGreaterThan(0);
  });
});
