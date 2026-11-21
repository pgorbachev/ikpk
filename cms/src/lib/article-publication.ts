const MOSCOW = 'Europe/Moscow';

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function articleSlug(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) return '';
  const transliterated = [...title.toLowerCase()].map((character) => CYRILLIC[character] ?? character).join('');
  return transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
    .replace(/-+$/g, '') || 'article';
}

function moscowParts(date: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: MOSCOW,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
}

export function moscowCalendarDate(value: unknown): string {
  if (typeof value !== 'string' && !(value instanceof Date)) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = moscowParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Encode a calendar day at Moscow noon to avoid historical midnight DST gaps in the datetime column. */
export function moscowCalendarDateISO(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error('ожидалась календарная дата ГГГГ-ММ-ДД');
  const [year, month, date] = match.slice(1).map(Number);
  const utcNoon = Date.UTC(year, month - 1, date, 12);
  const actual = moscowParts(new Date(utcNoon));
  const actualMoscowTime = Date.UTC(
    Number(actual.year), Number(actual.month) - 1, Number(actual.day),
    Number(actual.hour), Number(actual.minute), Number(actual.second),
  );
  const intendedNoon = Date.UTC(year, month - 1, date, 12);
  return new Date(utcNoon + intendedNoon - actualMoscowTime).toISOString();
}

export function todayInMoscow(now = new Date()): string {
  return moscowCalendarDate(now);
}
