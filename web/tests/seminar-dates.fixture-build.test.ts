import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attr, findAll, textOf, walk } from './helpers/dom';
import { MANAGER_PHONE, MANAGER_PHONE_HREF } from '../src/lib/navigation';
import { buildSeminarDatesFixture } from './helpers/seminar-dates-fixture';

let fixture: ReturnType<typeof buildSeminarDatesFixture>;
afterAll(() => fixture?.close());

const readBuiltPage = (outDir: string, path: string): string =>
  readFileSync(join(outDir, path, 'index.html'), 'utf8');

const normalizedText = (value: unknown): string => textOf(value).replace(/\s+/g, ' ').trim();

const within = (node: unknown, predicate: Parameters<typeof findAll>[1]) =>
  [...walk(node)].filter(predicate);

const cardFor = (html: string, title: string) =>
  findAll(html, (el) => attr(el, 'data-testid') === 'course-group-seminar-card').find((card) =>
    [...walk(card)].some((child) => child.tagName === 'h2' && normalizedText(child) === title),
  );

describe('controlled schedule fixture is reflected in built program and seminar pages', () => {
  it(
    'offers only unstarted sessions and retains the manager contact when no future date exists',
    () => {
      fixture = buildSeminarDatesFixture();
      const { pages, outDir } = fixture;
      const programPath = `/${pages.institute.slug}/${pages.group.slug}`;
      const plannedPath = `${programPath}/${pages.planned.slug}`;
      const emptyPath = `${programPath}/${pages.empty.slug}`;
      const program = readBuiltPage(outDir, programPath);
      const plannedPage = readBuiltPage(outDir, plannedPath);
      const emptyPage = readBuiltPage(outDir, emptyPath);
      const home = readBuiltPage(outDir, '/');
      const schedule = readBuiltPage(outDir, '/raspisanie-i-tseny');
      const plannedCard = cardFor(program, pages.planned.name);
      const emptyCard = cardFor(program, pages.empty.name);

      const hero = findAll(home, (el) => attr(el, 'class')?.split(/\s+/).includes('hero-d-next') ?? false);
      expect(hero).toHaveLength(1);
      expect(attr(hero[0], 'href')).toBe(plannedPath);
      const heroTitle = within(hero[0], (el) => attr(el, 'class')?.split(/\s+/).includes('hero-d-next-title') ?? false);
      expect(heroTitle).toHaveLength(1);
      expect(normalizedText(heroTitle[0]).length).toBeGreaterThan(0);

      const scheduleCards = findAll(schedule, (el) => attr(el, 'data-testid') === 'schedule-card');
      expect(scheduleCards.length).toBeGreaterThan(0);
      const scheduleActions = scheduleCards.flatMap((card) =>
        within(card, (el) => el.tagName === 'a' && attr(el, 'class')?.split(/\s+/).includes('btn-primary') === true)
          .map(normalizedText),
      );
      expect(scheduleActions).toContain('Записаться на семинар');
      expect(scheduleActions).not.toContain('Зарегистрироваться');
      const detailActions = findAll(plannedPage, (el) => el.tagName === 'a' && attr(el, 'class')?.split(/\s+/).includes('seminar-register-link') === true)
        .map(normalizedText);
      expect(detailActions).toContain('Записаться на семинар');
      expect(detailActions).not.toContain('Зарегистрироваться');

      expect(plannedCard, 'program output must contain the controlled seminar card').toBeTruthy();
      expect(emptyCard, 'program output must contain the controlled empty seminar card').toBeTruthy();

      const nearest = within(plannedCard!, (el) => attr(el, 'data-testid') === 'seminar-nearest-date');
      expect(nearest.map(normalizedText)).toEqual(['15 сен']);
      expect(within(plannedCard!, (el) => attr(el, 'data-testid') === 'seminar-date-fallback' && attr(el, 'hidden') === null)).toHaveLength(0);
      expect([...walk(plannedCard!)].some((el) => attr(el, 'href') === MANAGER_PHONE_HREF && attr(el, 'hidden') === null)).toBe(false);

      const rows = findAll(plannedPage, (el) => attr(el, 'data-seminar-schedule-card') !== null);
      const rowText = rows.map(normalizedText);
      expect(rows).toHaveLength(3);
      expect(rowText.some((text) => text.includes('Москва'))).toBe(false);
      expect(rowText.some((text) => text.includes('Дальний конец'))).toBe(false);
      expect(rowText.some((text) => text.includes('Поздний старт'))).toBe(true);
      expect(rowText.some((text) => text.includes('ОТМЕНЕНО') || text.includes('ИСТЕКЛО'))).toBe(false);
      expect(findAll(plannedPage, (el) => attr(el, 'data-testid') === 'seminar-schedule-empty' && attr(el, 'hidden') === null)).toHaveLength(0);

      const emptyDateFallback = within(emptyCard!, (el) => attr(el, 'data-testid') === 'seminar-date-fallback' && attr(el, 'hidden') === null);
      expect(emptyDateFallback.map(normalizedText)).toEqual(['Даты пока не назначены']);
      expect(within(emptyCard!, (el) => attr(el, 'data-testid') === 'seminar-nearest-date' && attr(el, 'hidden') === null)).toHaveLength(0);
      const emptyCardPhone = within(emptyCard!, (el) => attr(el, 'href') === MANAGER_PHONE_HREF)[0];
      expect(emptyCardPhone && normalizedText(emptyCardPhone)).toContain(MANAGER_PHONE);

      const emptyPanel = findAll(emptyPage, (el) => attr(el, 'data-testid') === 'seminar-schedule-empty');
      expect(emptyPanel).toHaveLength(1);
      expect(normalizedText(emptyPanel[0])).toContain(MANAGER_PHONE);
      expect([...walk(emptyPanel[0])].some((el) => attr(el, 'href') === MANAGER_PHONE_HREF)).toBe(true);
      expect(findAll(emptyPage, (el) => attr(el, 'data-seminar-schedule-card') !== null)).toHaveLength(0);
    },
    150_000,
  );
});
