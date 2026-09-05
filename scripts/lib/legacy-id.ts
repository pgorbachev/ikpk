/**
 * Приведение `legacy_id` к строке на границе отправки в Strapi.
 *
 * Схемы объявляют `legacy_id` строкой, а discovery-данные держат его и числом
 * (28 преподавателей из 29). Отправка числа даёт HTTP 400 `must be a string type`
 * на каждой такой записи — 28 потерянных преподавателей за прогон.
 *
 * Приведение делается в ОДНОМ месте — в функции отправки, — а не в каждом из
 * десяти построителей данных: перечень построителей растёт, и следующий забудут.
 */
export function normalizeLegacyId(value: unknown): string {
  if (value === null || value === undefined) {
    throw new Error('legacy_id отсутствует: запись без него неотличима от новой при повторном импорте');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`legacy_id недопустимого типа ${typeof value}: ${JSON.stringify(value)}`);
}
