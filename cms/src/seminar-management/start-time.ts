import { createHash } from 'node:crypto';

export interface StartTimeEntry {
  startAt?: unknown;
  startsAtInstant?: unknown;
  startTimeZone?: unknown;
  startTimeConfirmed?: unknown;
  startTimeConfirmation?: unknown;
  entry_status?: unknown;
  status?: unknown;
}

const EXPLICIT_INSTANT = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function validDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export function instantOf(value: unknown): Date | null {
  if (typeof value !== 'string' || !EXPLICIT_INSTANT.test(value) || !validDay(value.slice(0, 10))) return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

export function dayInZone(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Keep the existing public calendar normalization, independently of the input zone. */
export function displayedStartDay(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (validDay(value)) return value;
  const instant = instantOf(value);
  return instant ? dayInZone(instant, 'Europe/Moscow') : '';
}

export function validStartZone(value: unknown): value is string {
  // Intl also accepts fixed offsets on newer Node versions; the contract requires an IANA name.
  if (value === 'UTC') return true;
  if (typeof value !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export function startTimeFieldsError(entry: StartTimeEntry): string | null {
  const day = displayedStartDay(entry.startAt);
  if (!day) return 'Укажите корректную календарную дату начала.';
  const instant = instantOf(entry.startsAtInstant);
  if (!instant) return 'Укажите точный момент начала с явным UTC-смещением.';
  if (!validStartZone(entry.startTimeZone)) return 'Укажите зону IANA, например Europe/Moscow.';
  const localDay = dayInZone(instant, entry.startTimeZone);
  if (day !== localDay) return `Дата начала ${day} не совпадает с местной датой ${localDay} в ${entry.startTimeZone}.`;
  return null;
}

/** Server-generated proof binds confirmation to the complete normalized tuple. */
export function startTimeFingerprint(entry: StartTimeEntry): string | null {
  if (startTimeFieldsError(entry)) return null;
  return createHash('sha256').update(JSON.stringify([
    displayedStartDay(entry.startAt), instantOf(entry.startsAtInstant)!.toISOString(), entry.startTimeZone,
  ])).digest('hex');
}

export function startTimePublicationError(entry: StartTimeEntry, today: string): string | null {
  if ((entry.entry_status ?? entry.status) !== 'active') return null;
  const day = displayedStartDay(entry.startAt);
  if (day && day < today) return null;
  const error = startTimeFieldsError(entry);
  if (error) return error;
  if (entry.startTimeConfirmed !== true || entry.startTimeConfirmation !== startTimeFingerprint(entry)) {
    const local = new Intl.DateTimeFormat('ru-RU', {
      timeZone: entry.startTimeZone as string, dateStyle: 'short', timeStyle: 'short',
    }).format(instantOf(entry.startsAtInstant)!);
    return `Подтвердите начало ${local} (${entry.startTimeZone}). После изменения даты, момента или зоны сохраните запись и подтвердите время заново.`;
  }
  return null;
}

/** A changed tuple cannot inherit a checked box sent by the edit form. */
export function applyStartTimeConfirmation(data: Record<string, unknown>, existing: StartTimeEntry | null): void {
  const merged = { ...existing, ...data };
  const changed = existing && ['startAt', 'startsAtInstant', 'startTimeZone'].some(
    (key) => Object.prototype.hasOwnProperty.call(data, key) && data[key] !== existing[key as keyof StartTimeEntry],
  );
  const explicitlyConfirmed = data.startTimeConfirmed === true;
  const fingerprint = startTimeFingerprint(merged);
  const preserved = existing?.startTimeConfirmed === true && existing.startTimeConfirmation === fingerprint;
  const confirmed = !changed && Boolean(fingerprint) && (explicitlyConfirmed || (data.startTimeConfirmed === undefined && preserved));
  data.startTimeConfirmed = confirmed;
  data.startTimeConfirmation = confirmed ? fingerprint : null;
}
