import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Переписывание ссылок на CRM-формы, ВШИТЫХ В КОНТЕНТ, в демо-режиме.
 *
 * Зачем отдельный файл. Раньше этот путь проверялся только косвенно — через
 * `demo-output.test.ts` на собранном `dist-demo`. Находка независимого ревью (F7):
 * такой проверке хватало ОДНОЙ контентной ссылки на весь сайт, и та приходила из
 * датированных данных семинаров (`discovery/entities/seminars.json`, вебинар КСТ).
 * Уйдёт вебинар из расписания — контентный путь останется без покрытия молча, а
 * проверка при этом останется зелёной. Это ровно «признак проверки не должен зависеть
 * от предмета»: здесь он зависел от содержимого чужих данных.
 *
 * Поэтому предмет берётся фикстурами, а не сборкой, и режим задаётся явно.
 */

const CUSTOMER = 'https://b24-cbqwqo.bitrix24site.ru';
const SECOND = 'https://b24-kbo5ls.bitrix24site.ru';

let cleanBodyHtml: (html: string, opts?: unknown) => unknown;
let htmlOf: (v: unknown) => string;
let demoModeActive: boolean;

beforeAll(async () => {
  vi.stubEnv('DEMO_FORMS', 'stub');
  vi.resetModules();
  const forms = await import('../src/lib/forms.js');
  demoModeActive = forms.isDemoForms;
  const cleaner = await import('../src/lib/html-cleaner.js');
  const helper = await import('./helpers/rich-content-safety/html-of.js');
  cleanBodyHtml = cleaner.cleanBodyHtml as typeof cleanBodyHtml;
  htmlOf = helper.htmlOf as typeof htmlOf;
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const clean = (html: string): string => htmlOf(cleanBodyHtml(html));

describe('контентные ссылки на CRM: демо-режим действительно включён', () => {
  // Сторож всего файла: если подмена окружения не сработала, `isDemoForms` останется
  // false, переписывания не будет вовсе, и все проверки ниже стали бы бессмысленными —
  // причём часть из них (утверждающие отсутствие) прошла бы зелёной.
  it('isDemoForms === true, иначе проверки ниже ничего не значат', () => {
    expect(
      demoModeActive,
      'подмена DEMO_FORMS не дошла до модуля forms — переписывания не происходит',
    ).toBe(true);
  });
});

describe('контентные ссылки на CRM заказчика заменяются заглушкой', () => {
  const cases: [string, string][] = [
    ['первый портал', `<p><a href="${CUSTOMER}/crm_form_ve1op/">Записаться</a></p>`],
    ['второй портал', `<p><a href="${SECOND}/crm_form_iciwb/">Записаться</a></p>`],
    ['путь без crm_form', `<p><a href="${CUSTOMER}/news/">Подписаться</a></p>`],
    ['одинарные кавычки', `<p><a href='${CUSTOMER}/crm_form_ve1op/'>Записаться</a></p>`],
    ['пробелы вокруг =', `<p><a href = "${CUSTOMER}/news/">Подписаться</a></p>`],
    ['верхний регистр хоста', `<p><a href="https://B24-CBQWQO.BITRIX24SITE.RU/news/">x</a></p>`],
    ['портальный домен bitrix24.ru', `<p><a href="https://b24-x.bitrix24.ru/pub/form/1_a/">x</a></p>`],
  ];

  for (const [what, input] of cases) {
    it(`${what} — адреса портала в выводе не остаётся`, () => {
      const out = clean(input);
      expect(
        /bitrix24(site)?\.ru/i.test(out),
        `ссылка на портал уцелела в выводе: ${out}`,
      ).toBe(false);
      expect(out, 'ссылка не заменена заглушкой').toContain('/demo-zayavka');
    });
  }

  it('подпись ссылки не теряется при замене', () => {
    const out = clean(`<p><a href="${CUSTOMER}/crm_form_ve1op/">Записаться на семинар</a></p>`);
    expect(out).toContain('Записаться на семинар');
  });

  it('target на локальную заглушку снимается — новый таб для своей страницы не нужен', () => {
    const out = clean(
      `<p><a href="${CUSTOMER}/crm_form_ve1op/" target="_blank">Записаться</a></p>`,
    );
    expect(out).not.toContain('target=');
  });

  it('посторонние ссылки не трогаются', () => {
    const out = clean('<p><a href="/kontakty">Контакты</a><a href="https://example.org/">x</a></p>');
    expect(out).toContain('/kontakty');
    expect(out).toContain('https://example.org/');
    expect(out).not.toContain('/demo-zayavka');
  });

  // Находка владельца на 3604de4 (P2): признак сопоставлялся с ПОДСТРОКОЙ по всему URL,
  // поэтому чужая ссылка с адресом портала в query-параметре подменялась заглушкой.
  // Это зеркало находки F3 в гейте деплоя — там я этот класс закрыла, а в самом
  // переписывателе оставила, расширив ему домен. Проверять надо hostname.
  const foreign: [string, string][] = [
    ['адрес портала в query', 'https://example.org/go?to=bitrix24.ru'],
    ['адрес портала во фрагменте', 'https://example.org/page#bitrix24site.ru'],
    ['адрес портала в пути', 'https://example.org/bitrix24site.ru/x'],
    ['похожий домен-приманка', 'https://bitrix24site.ru.evil.example/x'],
  ];

  for (const [what, url] of foreign) {
    it(`чужая ссылка не подменяется заглушкой: ${what}`, () => {
      const out = clean(`<p><a href="${url}">x</a></p>`);
      expect(out, `подменена чужая ссылка ${url}`).not.toContain('/demo-zayavka');
      expect(out).toContain(url);
    });
  }
});
