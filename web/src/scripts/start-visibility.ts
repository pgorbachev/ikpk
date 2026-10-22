import { isBeforeStart, type ScheduleWindowEntry } from '../lib/schedule-window';

type Candidate = ScheduleWindowEntry & {
  title?: string; href?: string; dateLabel?: string; cityName?: string; priceLabel?: string;
};

/** One clock for all dated offers. Schedule filters consume availability, never time. */
export function initStartVisibility(): void {
  const offers = Array.from(document.querySelectorAll<HTMLElement>('[data-start-offer]'));
  const heroes = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-start-hero]'))
    .map((element) => ({ element, entries: JSON.parse(element.dataset.startHero!) as Candidate[] }));
  const dates = Array.from(document.querySelectorAll<HTMLElement>('[data-start-nearest]'))
    .map((element) => ({ element, entries: JSON.parse(element.dataset.startNearest!) as Candidate[] }));
  if (!offers.length && !heroes.length && !dates.length) return;
  const entryFor = (element: HTMLElement): ScheduleWindowEntry => ({
    startsAtInstant: element.dataset.startsAtInstant,
    startTimeZone: element.dataset.startTimeZone,
    startTimeConfirmed: element.dataset.startTimeConfirmed === 'true',
  });
  const entries = [...offers.map(entryFor), ...heroes.flatMap(({ entries }) => entries), ...dates.flatMap(({ entries }) => entries)];
  let timer: ReturnType<typeof setTimeout>;
  const refresh = () => {
    clearTimeout(timer);
    const now = Date.now();
    for (const element of offers) {
      const available = isBeforeStart(entryFor(element), now);
      element.dataset.startAvailable = String(available);
      // Pagination owns the final hidden state of schedule cards.
      if (!element.hasAttribute('data-schedule-item')) element.hidden = !available;
    }
    for (const list of document.querySelectorAll<HTMLElement>('[data-start-list]')) {
      const available = Array.from(list.querySelectorAll<HTMLElement>('[data-start-offer]'))
        .filter((element) => element.dataset.startAvailable === 'true');
      const limit = Number(list.dataset.startLimit) || Infinity;
      available.forEach((element, index) => { element.hidden = index >= limit; });
      const empty = list.querySelector<HTMLElement>('[data-start-empty]');
      if (empty) empty.hidden = available.length > 0;
      else list.hidden = available.length === 0;
    }
    for (const { element, entries } of heroes) {
      const next = entries.find((entry) => isBeforeStart(entry, now));
      element.hidden = !next;
      const upcomingAction = element.closest('.hero-d')?.querySelector<HTMLElement>('[data-start-upcoming-action]');
      if (upcomingAction) upcomingAction.hidden = !next;
      if (next) {
        element.href = next.href!;
        element.querySelector<HTMLElement>('.hero-d-next-title')!.textContent = next.title!;
        element.querySelector<HTMLElement>('.hero-d-next-value')!.textContent =
          [next.dateLabel, next.cityName, next.priceLabel].filter(Boolean).join(' · ');
      }
    }
    for (const { element, entries } of dates) {
      const next = entries.find((entry) => isBeforeStart(entry, now));
      element.hidden = !next;
      element.textContent = next?.dateLabel ?? '';
      const card = element.closest('[data-testid="course-group-seminar-card"]');
      card?.querySelectorAll<HTMLElement>('[data-start-empty]').forEach((fallback) => { fallback.hidden = Boolean(next); });
      const action = card?.querySelector<HTMLAnchorElement>('.course-group-seminar-cta');
      if (action) {
        action.textContent = next ? 'Записаться на семинар' : 'Подробнее о семинаре';
        action.removeAttribute('aria-label');
      }
    }
    document.dispatchEvent(new Event('seminar-offers-updated'));
    const future = entries.map((entry) => Date.parse(entry.startsAtInstant ?? '')).filter((start) => start > now);
    if (future.length) timer = setTimeout(refresh, Math.min(Math.min(...future) - now, 2_147_483_647));
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  refresh();
}
