// Знак награды сторонней площадки: показывается только при полном и подтверждённом
// объявлении, а не по умолчанию.
//
// Спека change `external-widgets`: два независимых утверждения о себе сходятся к
// слабейшему подтверждённому — год действия должен СОВПАДАТЬ с годом сборки (не «не
// позже»), а само награждение и право размещать чужую марку должны быть подтверждены
// отдельными полями данных, не процессом. Год сборки передаётся значением: функция,
// читающая момент показа, приглашала бы проверять зависимость, которой в требовании
// нет — состав знаков от часа показа не зависит вовсе.

/** Ключ года сборки. Отсутствует — берётся год системных часов; задан, но негоден —
 *  отказ: опечатка в настройке не должна тихо подставить текущий год. */
const BUILD_YEAR_KEY = 'BUILD_YEAR';

const YEAR_PATTERN = /^\d{4}$/;

/** Год сборки: `BUILD_YEAR` окружения, тем же приёмом двух источников, что
 *  `chatLoaderConfig()` (`web/src/lib/external-widgets.ts`). */
export function buildYear(): number {
  const fromMeta = (import.meta as ImportMeta & { env?: { BUILD_YEAR?: unknown } }).env?.BUILD_YEAR;
  const raw = fromMeta ?? (typeof process !== 'undefined' ? process.env[BUILD_YEAR_KEY] : undefined);
  if (raw === undefined) return new Date().getFullYear();
  const value = String(raw).trim();
  if (!YEAR_PATTERN.test(value))
    throw new Error(`недопустимое значение ${BUILD_YEAR_KEY}=${JSON.stringify(raw)}`);
  return Number(value);
}

/** Объявление знака награды в данных — источник, свидетельство награждения и
 *  свидетельство права размещать марку по отдельности: сборка не читает документ
 *  приёмки, поэтому без полей данных различить «подтверждено» от «не проверено» нечем. */
export interface BadgeDeclaration {
  id: string;
  label?: string;
  /** Год действия знака. Сверяется с годом сборки, а не с системными часами. */
  year: number;
  /** Карточка организации в сервисе, выдавшем знак. Пусто — источник не объявлен. */
  sourceUrl?: string | null;
  /** Чем подтверждено само награждение. Пусто — награждение не подтверждено. */
  awardEvidence?: string | null;
  /** Чем подтверждено право размещать марку. Пусто — право не объявлено. */
  markUsageEvidence?: string | null;
}

function isDeclared(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Знаки, которые страница вправе показать: все четыре поля объявлены и год действия
 * равен году сборки — строгое равенство, не «не позже». Год сборки — аргумент, а не
 * системные часы: результат не зависит ни от того, когда функция вызвана, ни от часа
 * показа страницы посетителю.
 */
export function visibleAwardBadges(
  declared: readonly BadgeDeclaration[],
  buildYearValue: number,
): BadgeDeclaration[] {
  return declared.filter(
    (badge) =>
      badge.year === buildYearValue &&
      isDeclared(badge.sourceUrl) &&
      isDeclared(badge.awardEvidence) &&
      isDeclared(badge.markUsageEvidence),
  );
}

/**
 * Знаки, объявленные в данных сайта. Пусто: право размещать чужую марку ещё не
 * проверено (`tasks.md`, задача 1.3) — без поля `markUsageEvidence` знак не может
 * законно показаться, и объявлять запись без него означало бы обещать проверку,
 * которой не было.
 */
export const DECLARED_AWARD_BADGES: BadgeDeclaration[] = [];
