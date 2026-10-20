import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import ScheduleEventCard from '../src/components/schedule/ScheduleEventCard.astro';
import SeminarSchedulePanel from '../src/components/seminars/SeminarSchedulePanel.astro';
import { getScheduleEntries } from '../src/lib/data';

describe('подпись записи соответствует формату конкретной встречи', () => {
  it.each([
    ['Онлайн', 'Записаться на вебинар'],
    ['Москва', 'Записаться на семинар'],
    ['Уточняется', 'Записаться на семинар'],
  ])('карточка расписания: %s → %s', async (cityName, label) => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(ScheduleEventCard, {
      props: {
        title: 'Тестовая встреча', titleHref: '/test', teacherLabel: 'Преподаватель:',
        teacherName: 'Преподаватель', instituteName: 'ИКПК', programName: 'Программа',
        dateLabel: '20.11.2026', cityName, priceLabel: 'Бесплатно',
        registrationHref: '/registration',
      },
    });
    const cta = html.match(/<a\b[^>]*href="\/registration"[^>]*>([\s\S]*?)<\/a>/)?.[1];
    expect(cta?.trim()).toBe(label);
  });

  it('страница встречи: смешанные даты сохраняют собственный формат записи', async () => {
    const entry = getScheduleEntries()[0];
    const rows = ['Онлайн', 'Москва'].map((name, index) => ({
      entry: { ...entry, id: index + 1, city: { id: index + 1, name } },
      teachers: [],
    }));
    const container = await AstroContainer.create();
    const html = await container.renderToString(SeminarSchedulePanel, { props: { rows } });
    const labels = [...html.matchAll(/<a\b[^>]*class="seminar-register-link"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((match) => match[1].trim());
    expect(labels).toEqual(['Записаться на вебинар', 'Записаться на семинар']);
  });
});
