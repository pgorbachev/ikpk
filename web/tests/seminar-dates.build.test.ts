import { describe, it, expect } from 'vitest';
import { readPage } from './helpers/dist-pages';
import { attr, findAll, textOf, walk } from './helpers/dom';
import {
  getCourseGroups,
  getInstitutes,
  getScheduleEntries,
  getSeminars,
  getSnapshotReferenceDate,
} from '../src/lib/data.js';

/**
 * Страница программы показывает по каждому семинару ближайшую дату, а при её отсутствии —
 * телефон менеджера (решение Q11 разбора демо 2026-08-19).
 *
 * Предмет — СОБРАННЫЙ вывод, а не компонент: проверка компонента подтвердила бы, что
 * карточка умеет показать переданную дату, и промолчала бы, если страница её не передаёт.
 * Этот класс ложного зелёного в репозитории уже был (гейт на JSON-LD не заметил отката
 * проводки), поэтому проверяется вывод целиком.
 *
 * Ожидание считается ЗДЕСЬ по данным, а не берётся у кода страницы: сверка вывода с тем же
 * выражением, которым он получен, подтверждает лишь то, что выражение одно и то же.
 */

// Намеренный дубль таблицы месяцев из `src/lib/home.ts`: независимый пересчёт на то и
// независимый, что не импортирует форматтер, чей вывод проверяет.
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const MOBILE_HREF = 'tel:+79810387797';
const MAIN_HREF = 'tel:+78126465450';

const norm = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Элементы ВНУТРИ карточки, а не по всей странице: иначе чужая дата закрывает пропущенную. */
const inCard = (card: Parameters<typeof textOf>[0], testid: string) =>
  [...walk(card)].filter((el) => attr(el, 'data-testid') === testid);

const lastDay = (entry: { startAt?: string; endAt?: string }): string => {
  const start = entry.startAt ?? '';
  const end = entry.endAt ?? '';
  return (end > start ? end : start).slice(0, 10);
};

describe('страница программы: ближайшая дата по каждому семинару', () => {
  const today = getSnapshotReferenceDate();
  const institutes = getInstitutes();
  const groups = getCourseGroups();
  const entries = getScheduleEntries().filter((entry) => entry.status === 'active');

  let withDate = 0;
  let withFallback = 0;

  it('у семинара с запланированной датой стоит она, у остального — телефон менеджера', () => {
    const problems: string[] = [];

    for (const group of groups) {
      const institute = institutes.find((i) => i.slug === group.institute_legacy_id);
      if (!institute) continue;
      const html = readPage(`/${institute.slug}/${group.slug}`);
      const cards = findAll(html, (el) => attr(el, 'data-testid') === 'course-group-seminar-card');
      const seminars = getSeminars(group.legacy_id);
      if (seminars.length === 0) continue;

      expect(cards.length, `${group.slug}: карточек в выводе ${cards.length}, семинаров ${seminars.length}`)
        .toBe(seminars.length);

      for (const seminar of seminars) {
        const card = cards.find((el) => norm(textOf(el)).includes(norm(seminar.name)));
        if (!card) {
          problems.push(`${group.slug}/${seminar.slug}: карточка семинара не найдена в выводе`);
          continue;
        }
        const cardText = norm(textOf(card));
        const nearest = entries
          .filter((entry) => entry.seminar?.slug === seminar.slug && lastDay(entry) >= today)
          .sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''))[0];

        if (nearest) {
          withDate += 1;
          const start = new Date(nearest.startAt);
          const expected = `${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]}`;
          const shown = inCard(card, 'seminar-nearest-date').map((el) => norm(textOf(el)));
          if (!shown.some((text) => text.includes(String(start.getUTCDate())) && text.includes(MONTHS[start.getUTCMonth()]))) {
            problems.push(
              `${group.slug}/${seminar.slug}: ожидалась ближайшая дата «${expected}», в карточке: ${shown.join(' | ') || '(элемента даты нет)'}`,
            );
          }
        } else {
          withFallback += 1;
          const hasFallback = inCard(card, 'seminar-date-fallback').length > 0;
          const hasPhone = [...walk(card)].some((el) => attr(el, 'href') === MOBILE_HREF);
          if (!hasFallback || !hasPhone) {
            problems.push(
              `${group.slug}/${seminar.slug}: запланированного нет, ожидались отметка и телефон менеджера; ` +
                `отметка ${hasFallback ? 'есть' : 'нет'}, телефон ${hasPhone ? 'есть' : 'нет'}. Текст карточки: ${cardText.slice(0, 120)}`,
            );
          }
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });

  // Проверка обязана отличать «дефектов нет» от «проверять было нечего»: если данные
  // сместятся так, что одна из двух ветвей перестанет встречаться, молчание про неё
  // читалось бы как её исправность.
  it('в выводе представлены обе ветви — и с датой, и без', () => {
    expect(withDate, 'ни одного семинара с запланированной датой — ветвь не проверена').toBeGreaterThan(0);
    expect(withFallback, 'ни одного семинара без дат — ветвь фолбэка не проверена').toBeGreaterThan(0);
  });
});

describe('страница семинара: пустое расписание называет телефон менеджера', () => {
  const today = getSnapshotReferenceDate();
  const institutes = getInstitutes();
  const groups = getCourseGroups();
  const entries = getScheduleEntries().filter((entry) => entry.status === 'active');

  // Та же ветвь требования Q11, что и на странице программы: отсутствие запланированного
  // не оставляет посетителя без следующего шага. Облик взят из мокапа, выбранного
  // владельцем 23.08.2026 (docs/design/mockups/demo-followups/, вариант C для страницы
  // семинара): «Даты пока не назначены» и оба телефона.
  it('без запланированного — «Даты пока не назначены» и оба телефона, без прежней фразы', () => {
    const problems: string[] = [];
    let checked = 0;

    for (const group of groups) {
      const institute = institutes.find((i) => i.slug === group.institute_legacy_id);
      if (!institute) continue;
      for (const seminar of getSeminars(group.legacy_id)) {
        const upcoming = entries.some(
          (entry) => entry.seminar?.slug === seminar.slug && lastDay(entry) >= today,
        );
        if (upcoming) continue;
        checked += 1;
        const route = `/${institute.slug}/${group.slug}/${seminar.slug}`;
        const html = readPage(route);
        const panel = findAll(html, (el) => attr(el, 'data-testid') === 'seminar-schedule-empty')[0];
        if (!panel) {
          problems.push(`${route}: блока пустого расписания нет в выводе`);
          continue;
        }
        const text = norm(textOf(panel));
        const phones = [...walk(panel)].map((el) => attr(el, 'href')).filter(Boolean);
        if (!text.includes('Даты пока не назначены')) {
          problems.push(`${route}: ожидалось «Даты пока не назначены», в блоке: ${text.slice(0, 90)}`);
        }
        if (text.includes('К сожалению, данный курс')) {
          problems.push(`${route}: прежняя фраза без телефона осталась`);
        }
        for (const href of [MAIN_HREF, MOBILE_HREF]) {
          if (!phones.includes(href)) problems.push(`${route}: нет ссылки ${href}`);
        }
      }
    }

    expect(checked, 'ни одного семинара без запланированных дат — ветвь не проверена').toBeGreaterThan(0);
    expect(problems, problems.slice(0, 20).join('\n')).toEqual([]);
  });
});
