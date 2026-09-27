/**
 * Актуальность записи расписания для показа посетителю.
 *
 * Событие остаётся актуальным до своего ПОСЛЕДНЕГО дня, а не до первого: из 63
 * записей 60 многодневные, и фильтр по `startAt` убирал бы идущий семинар со
 * страницы уже на второй день обучения — человек, приехавший на трёхдневный курс,
 * не нашёл бы его в расписании.
 *
 * Тот же вывод для статуса семинара живёт в `web/scripts/lib/planned-seminars.ts`,
 * но там он нужен на этапе импорта данных, а здесь — на этапе сборки страниц.
 * Дублирование сознательное: `src/` не должен зависеть от `scripts/`, иначе
 * скрипты импорта попадают в клиентский граф сборки.
 *
 * Дата передаётся аргументом, а не берётся из `new Date()` внутри: иначе проверку
 * нельзя написать фикстурами, и она краснела бы от хода времени — так уже
 * случилось с гейтом `catalog-data`.
 */

export interface ScheduleWindowEntry {
  startAt?: string;
  endAt?: string;
  /**
   * Город события: в снимке — объект с именем, в схеме CMS может стать строкой, а в
   * данных встречается `null` (поле необязательное). Все три формы принимаются здесь, а
   * не приводятся у вызывающих: иначе тип этого модуля диктовал бы форму чужим снимкам.
   */
  city?: { name?: string } | string | null;
  /** Идентификатор записи: число в нынешнем материале, строка допустима схемой. */
  id?: number | string;
}

/** Последний день события как календарная дата `YYYY-MM-DD`. */
export function lastDay(entry: ScheduleWindowEntry): string {
  const start = entry.startAt ?? '';
  const end = entry.endAt ?? '';
  return (end > start ? end : start).slice(0, 10);
}

/**
 * Событие ещё не закончилось на дату `today` (календарная, `YYYY-MM-DD`).
 *
 * Сравниваются календарные даты, а не метки времени: `startAt` хранится с временем
 * 00:00, и сравнение полных метк выбрасывало событие из актуальных уже в первую
 * минуту дня проведения.
 */
export function isCurrentOrFuture(entry: ScheduleWindowEntry, today: string): boolean {
  return lastDay(entry) >= today;
}

/**
 * Событие ещё не началось на дату `today` (календарная, `YYYY-MM-DD`).
 *
 * Это другой вопрос, чем `isCurrentOrFuture`. Страница расписания держит идущий
 * семинар до последнего дня. Строка «Ближайший семинар» и список ближайших на
 * главной — про набор, на который ещё можно приехать к началу: живой ikpk.su
 * (`/api/public/events`) уже начавшиеся из этой выборки убирает.
 *
 * Сравнение живёт здесь, а не у вызывающего: гейт `schedule-window.test.ts`
 * запрещает фильтровать `src/` по `startAt` вне этого модуля.
 */
export function isUpcomingStart(entry: ScheduleWindowEntry, today: string): boolean {
  return (entry.startAt ?? '').slice(0, 10) >= today;
}

/** Календарная дата «сегодня» для вызывающего, которому нужен реальный день. */
export const calendarToday = (): string => new Date().toISOString().slice(0, 10);

/**
 * Ближайшее ещё не закончившееся событие из набора, или `undefined`.
 *
 * Дата аргументом по той же причине, что и в `isCurrentOrFuture`: вывод должен
 * проверяться фикстурами, а не зависеть от хода времени.
 *
 * **Идущее событие считается ближайшим** — право считаться запланированным даётся по
 * ПОСЛЕДНЕМУ дню. Это сознательно расходится с `home.ts`, где «ближайший семинар» на
 * главной считается по первому дню: там подписываются три ближайших СОБЫТИЯ, и уже идущее
 * среди них выглядело бы приглашением опоздать. Здесь предмет другой — чип отвечает на
 * вопрос «когда этот семинар», и его ответ обязан совпадать с первой строкой расписания на
 * странице самого семинара, которая берёт `isCurrentOrFuture`.
 *
 * **Порядок выбора задан требованием, а не удобством** (change
 * `cms-content-authoring-and-migration`, требование «Даты семинара выводятся из расписания»):
 * первый день → последний день → город лексикографически → идентификатор записи. Первыми
 * идут наблюдаемые поля: из двух событий одного дня раньше освобождается более короткое, а
 * город различает одновременные осмысленно для посетителя. Идентификатор — последний ключ и
 * служит только устойчивости: когда совпали и даты, и город, события для посетителя
 * неразличимы, и от правила требуется лишь чтобы две сборки одного состояния не разошлись.
 *
 * Сравнение идентификатора следует ТИПУ поля: число сравнивается как число, строка —
 * лексикографически. Безусловное лексикографическое сравнение поставило бы `10` раньше `9`.
 *
 * Город сравнивается посимвольно, а не `localeCompare`: результат обязан совпадать у двух
 * сборок одного состояния, а порядок `localeCompare` зависит от ICU машины, на которой шла
 * сборка. Для требования «две сборки не разошлись» это и есть предмет.
 */
export function nearestUpcoming<T extends ScheduleWindowEntry>(
  entries: readonly T[],
  today: string,
): T | undefined {
  // Запись без `startAt` отбрасывается: поле необязательно в схеме CMS, а без него
  // сортировка ставит запись первой, и подпись выходит «NaN undefined – 5 окт».
  // Два других потребителя расписания такую охрану уже имеют.
  const usable = entries.filter((entry) => Boolean(entry.startAt) && isCurrentOrFuture(entry, today));
  let best: T | undefined;
  for (const entry of usable) if (best === undefined || compareNearest(entry, best) < 0) best = entry;
  return best;
}

/** Первый день события как календарная дата: требование говорит о ДНЕ, а не о метке времени. */
const firstDay = (entry: ScheduleWindowEntry): string => (entry.startAt ?? '').slice(0, 10);

const cityName = (entry: ScheduleWindowEntry): string => {
  const city = entry.city;
  if (typeof city === 'string') return city;
  return city?.name ?? '';
};

function compareIdentifier(left: ScheduleWindowEntry, right: ScheduleWindowEntry): number {
  const a = left.id;
  const b = right.id;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Строгий порядок «ближайшего»: меньше — ближе. Экспортируется ради проверок. */
export function compareNearest(left: ScheduleWindowEntry, right: ScheduleWindowEntry): number {
  for (const key of [firstDay, lastDay, cityName]) {
    const a = key(left);
    const b = key(right);
    if (a !== b) return a < b ? -1 : 1;
  }
  return compareIdentifier(left, right);
}
