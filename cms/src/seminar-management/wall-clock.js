/**
 * Поле datetime в Strapi — мгновение. Форма показывает его в зоне браузера и
 * до этой правки отправляла toISOString(): день редактора из строки пропадал.
 * Подпись читает календарный день, записанный в строке. Явный сдвиг (`+02:00`) —
 * день, который выбрал редактор. `Z` и Date — уже нормализованное мгновение,
 * его день не переносится в именованную зону.
 */

const OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?([+-]\d{2}:\d{2})$/;
const UTC_Z = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

export function hasExplicitOffset(value) {
  return typeof value === 'string' && OFFSET.test(value.trim());
}

export function calendarDateParts(value) {
  if (typeof value === 'string') {
    const match = OFFSET.exec(value.trim()) || UTC_Z.exec(value.trim());
    if (match) {
      return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    }
  }
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** Строка для сохранения: локальные компоненты Date и сдвиг этой же даты, не `Z`. */
export function toWallClockISO(date) {
  const pad = (part) => String(part).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}
