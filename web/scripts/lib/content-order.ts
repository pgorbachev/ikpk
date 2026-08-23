/**
 * Порядок следования записей, заданный явным полем `order`, а не именем,
 * идентификатором или порядком, в котором записи вернуло хранилище.
 *
 * Отсутствующее значение уходит в конец; при равных значениях (включая два
 * отсутствующих) вторичный ключ — идентификатор, сравнение лексикографическое,
 * что делает результат независимым от порядка входа.
 */

export interface OrderedItem {
  identifier: string;
  order?: number | null;
}

export function byExplicitOrder<T extends OrderedItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const orderA = a.order ?? Number.POSITIVE_INFINITY;
    const orderB = b.order ?? Number.POSITIVE_INFINITY;
    if (orderA !== orderB) return orderA - orderB;
    if (a.identifier < b.identifier) return -1;
    if (a.identifier > b.identifier) return 1;
    return 0;
  });
}
