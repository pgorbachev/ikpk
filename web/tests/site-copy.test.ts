import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dist, walkHtml, readPage, allPages } from './helpers/dist-pages';
import { attr, byClass, findAll, hasClass, parseDocument, textOf, walk } from './helpers/dom';
import type { Element } from './helpers/dom';
import { getInstitutes, getScheduleEntries } from '../src/lib/data.js';

// ─── Тексты, которые видит посетитель ────────────────────────────────────────
//
// Предмет — семь пунктов списка заказчика после демо 2026-08-19: D2, D10, D11,
// D12, D13, D14, D21. Ненормативный вход — `docs/demo-2026-08-19-decisions.md`
// (разделы «Пункты, решённые без отдельного вопроса» и строка маршрутизации
// «D10, D11, D21»). Класс работы — дефект: поведение не меняется, сайт и так
// обязан показывать контакты и название, он делает это неполно. Поэтому каждый
// гейт написан ДО правки и предъявлен красным.
//
// Предмет проверок — собранный `dist`, потому что предмет требования — то, что
// видит посетитель. Разбор деревом (parse5), а не регулярками: приблизительный
// разбор в этом репозитории уже дважды давал обход гейта.

const CITY_PHONE = '646-54-50';
const CITY_TEL = 'tel:+78126465450';
const MOBILE_PHONE = '038-77-97';
const MOBILE_TEL = 'tel:+79810387797';

/** Все собранные страницы. Пустой список — «не смогла проверить», а не «дефектов нет». */
function pages(): { path: string; html: string }[] {
  const out = [...walkHtml()].map((file) => ({
    path: file.replace(dist, ''),
    html: readFileSync(file, 'utf-8'),
  }));
  expect(out.length, 'dist пуст или не собран — проверять нечего').toBeGreaterThan(100);
  return out;
}

function telHrefs(root: unknown): string[] {
  return [...walk(root)]
    .filter((n) => n.tagName === 'a')
    .map((n) => attr(n, 'href') ?? '')
    .filter((href) => href.startsWith('tel:'));
}

function only<T>(items: T[], what: string): T {
  expect(items.length, `ожидался ровно один ${what}, найдено ${items.length}`).toBe(1);
  return items[0];
}

/** Кнопки-ссылки поддерева. Строка на входе разбирается как целый документ. */
function buttonsIn(root: unknown): Element[] {
  const nodes = typeof root === 'string' ? walk(parseDocument(root)) : walk(root);
  return [...nodes].filter((el) => el.tagName === 'a' && hasClass(el, 'btn'));
}

/** Секция страницы по её заголовку h2 — ближайшая секция-предок этого заголовка. */
function sectionByHeading(html: string, heading: string): Element {
  const sections = findAll(html, (el) => el.tagName === 'section').filter((section) =>
    [...walk(section)].some((el) => el.tagName === 'h2' && textOf(el) === heading),
  );
  expect(sections.length, `секция с заголовком «${heading}» не найдена`).toBeGreaterThan(0);
  // Кандидаты бывают вложенными — внешняя секция содержит внутреннюю, и нужна
  // самая внутренняя. Но два НЕВЛОЖЕННЫХ кандидата — это неоднозначность, и молча
  // брать последний по документу нельзя: гейт проверил бы не то, что назван
  // проверять, и об этом никто бы не узнал.
  const outermost = sections.filter(
    (s) => !sections.some((other) => other !== s && [...walk(other)].includes(s)),
  );
  expect(
    outermost.length,
    `секций с заголовком «${heading}» несколько и они не вложены друг в друга — гейт неоднозначен`,
  ).toBe(1);
  return sections[sections.length - 1];
}

/** Блок карточки контактов по его подзаголовку («Медицинский центр» и т. п.). */
function contactBlockBySubtitle(html: string, subtitle: string): Element {
  const blocks = byClass(html, 'contact-shell-section').filter((block) =>
    [...walk(block)].some((el) => hasClass(el, 'contact-shell-subtitle') && textOf(el) === subtitle),
  );
  return only(blocks, `блок контактов «${subtitle}»`);
}


/** Разобранные блоки JSON-LD страницы. Текст скрипта берём сырым: `textOf` его пропускает. */
function jsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  for (const el of findAll(html, (e) => e.tagName === 'script' && attr(e, 'type') === 'application/ld+json')) {
    const raw = (el.childNodes[0] as { value?: string } | undefined)?.value ?? '';
    if (!raw.trim()) continue;
    out.push(JSON.parse(raw));
  }
  return out;
}

/** Все объекты дерева JSON — telephone может лежать и во вложенном contactPoint. */
function* jsonNodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const v of value) yield* jsonNodes(v);
  } else if (value && typeof value === 'object') {
    yield value as Record<string, unknown>;
    for (const v of Object.values(value as Record<string, unknown>)) yield* jsonNodes(v);
  }
}

// ─── D12: два номера везде, где сайт показывает свой телефон ─────────────────

describe('D12 — сайт показывает оба номера телефона', () => {
  it('подвал каждой страницы даёт обе ссылки tel:', () => {
    const offenders: string[] = [];
    for (const { path, html } of pages()) {
      const blocks = byClass(html, 'footer-contacts');
      if (blocks.length !== 1) {
        offenders.push(`${path}: блоков .footer-contacts ${blocks.length}, ожидался 1`);
        continue;
      }
      const hrefs = telHrefs(blocks[0]);
      if (!hrefs.includes(CITY_TEL) || !hrefs.includes(MOBILE_TEL)) {
        offenders.push(`${path}: в подвале tel-ссылки ${JSON.stringify(hrefs)}`);
      }
    }
    expect(offenders.slice(0, 5), offenders.slice(0, 5).join('\n')).toEqual([]);
  });

  it('шапка даёт оба номера и в строке действий, и в мобильном меню', () => {
    // Привязка к МЕСТУ, а не к счёту: пара «мобильных не меньше, чем городских»
    // формально проходится, если положить мобильный дважды в десктопную строку и
    // не положить в drawer — на телефоне второго номера при этом не будет.
    const offenders: string[] = [];
    for (const { path, html } of pages()) {
      // Именно шапка сайта: <header> встречается и внутри контента страниц.
      const headers = byClass(html, 'topnav');
      if (headers.length !== 1) {
        offenders.push(`${path}: шапок .topnav ${headers.length}, ожидалась 1`);
        continue;
      }
      const places: [string, string][] = [
        ['строка действий', 'topnav-phones'],
        ['мобильное меню', 'topnav-drawer'],
      ];
      for (const [name, className] of places) {
        const blocks = [...walk(headers[0])].filter((el) => hasClass(el, className));
        if (blocks.length !== 1) {
          offenders.push(`${path}: блоков «${name}» (.${className}) ${blocks.length}, ожидался 1`);
          continue;
        }
        const hrefs = telHrefs(blocks[0]);
        if (!hrefs.includes(CITY_TEL) || !hrefs.includes(MOBILE_TEL)) {
          offenders.push(`${path}: в «${name}» tel-ссылки ${JSON.stringify(hrefs)}`);
        }
      }
    }
    expect(offenders.slice(0, 5), offenders.slice(0, 5).join('\n')).toEqual([]);
  });

  it('итоговая полоса главной показывает оба номера', () => {
    const band = only(byClass(readPage('/'), 'cta-band-actions'), 'блок .cta-band-actions');
    const text = textOf(band);
    expect(text, 'в полосе нет городского номера').toContain(CITY_PHONE);
    expect(text, 'в полосе нет мобильного номера').toContain(MOBILE_PHONE);
    expect(telHrefs(band)).toEqual(expect.arrayContaining([CITY_TEL, MOBILE_TEL]));
  });

  // Признак — «блок карточки контактов показывает городской номер», а не список
  // блоков. Прежняя редакция проверяла ПЕРВЫЙ блок и потому не видела реквизиты,
  // где остался один номер (находка владельца). Перечисление частных случаев
  // отстаёт от предмета молча — здесь предмет задан общим признаком.
  //
  // Явно объявленное исключение: содержимое CMS. На
  // `/svedeniya-ob-obrazovatelnoy-organizatsii` городской номер встречается ещё
  // четыре раза — в таблице сведений и в трёх персональных строках поимённо
  // названных сотрудников. Это не наша разметка, а тело страницы из CMS, и
  // мобильный Веры в строке чужого сотрудника был бы неверен. Правка идёт
  // change'ем по контенту, а не этой пачкой. Признак ниже ограничен карточкой
  // контактов сознательно, и ограничение названо, а не подразумевается.
  it('каждый блок карточки контактов с городским номером даёт и мобильный', () => {
    const offenders: string[] = [];
    for (const { path, html } of pages()) {
      for (const [i, block] of byClass(html, 'contact-shell-section').entries()) {
        const text = textOf(block);
        if (!text.includes(CITY_PHONE)) continue;
        if (!text.includes(MOBILE_PHONE)) {
          offenders.push(`${path}: блок карточки контактов №${i + 1} — «${text.slice(0, 90)}…»`);
        }
      }
    }
    expect(offenders.slice(0, 5), offenders.slice(0, 5).join('\n')).toEqual([]);
  });

  it('первый блок карточки контактов даёт оба номера института', () => {
    const html = readPage('/kontakty/');
    const blocks = byClass(html, 'contact-shell-section');
    expect(blocks.length, 'карточка контактов не разобралась').toBeGreaterThan(2);
    const hrefs = telHrefs(blocks[0]);
    expect(hrefs, 'в блоке института не обе tel-ссылки').toEqual(
      expect.arrayContaining([CITY_TEL, MOBILE_TEL]),
    );
    expect(textOf(blocks[0])).toContain(MOBILE_PHONE);
  });

  it('страница оплаты зовёт по обоим номерам', () => {
    const block = only(byClass(readPage('/oplata/'), 'payment-highlight-text'), 'блок связи на /oplata');
    expect(telHrefs(block), 'на /oplata не обе tel-ссылки').toEqual(
      expect.arrayContaining([CITY_TEL, MOBILE_TEL]),
    );
    expect(textOf(block)).toContain(MOBILE_PHONE);
  });

  it('страница сотрудничества зовёт по обоим номерам', () => {
    const block = only(
      byClass(readPage('/sotrudnichestvo-s-nami/'), 'cta-contacts'),
      'блок контактов на /sotrudnichestvo-s-nami',
    );
    expect(telHrefs(block), 'на /sotrudnichestvo-s-nami не обе tel-ссылки').toEqual(
      expect.arrayContaining([CITY_TEL, MOBILE_TEL]),
    );
    expect(textOf(block)).toContain(MOBILE_PHONE);
  });

  it('структурированные данные называют оба номера там, где вообще называют телефон', () => {
    // Разметка страницы и её же машинное описание не должны расходиться: /kontakty
    // показывает два номера, а JSON-LD объявлял один. Признак — наличие поля
    // `telephone`, а не список страниц: появится новое место — попадёт под гейт само.
    const offenders: string[] = [];
    let declared = 0;
    for (const { path, html } of pages()) {
      for (const block of jsonLd(html)) {
        for (const node of jsonNodes(block)) {
          if (!('telephone' in node)) continue;
          declared += 1;
          const list = (Array.isArray(node.telephone) ? node.telephone : [node.telephone]).map(String);
          const digits = list.map((v) => v.replace(/[^\d+]/g, ''));
          if (!digits.includes('+78126465450') || !digits.includes('+79810387797')) {
            offenders.push(`${path}: telephone=${JSON.stringify(node.telephone)}`);
          }
        }
      }
    }
    expect(declared, 'ни одна страница не объявляет telephone — гейт измерил бы пустоту').toBeGreaterThan(0);
    expect(offenders.slice(0, 5), offenders.slice(0, 5).join('\n')).toEqual([]);
  });
});

// ─── D13: мобильный в контактах медцентра ───────────────────────────────────

describe('D13 — контакты медцентра содержат второй мобильный', () => {
  it('в блоке «Медицинский центр» есть мобильный номер отдельной ссылкой', () => {
    const clinic = contactBlockBySubtitle(readPage('/kontakty/'), 'Медицинский центр');
    expect(telHrefs(clinic), 'в блоке медцентра нет ссылки на мобильный').toContain(MOBILE_TEL);
    expect(textOf(clinic), 'в блоке медцентра не виден мобильный номер').toContain(MOBILE_PHONE);
  });
});

// ─── D14: часы менеджера с оговоркой про семинары ───────────────────────────

describe('D14 — часы показаны как часы менеджера, а не как часы института', () => {
  it('каждый блок часов работы называет менеджера и оговаривает семинары', () => {
    const found: string[] = [];
    for (const { path, html } of pages()) {
      for (const el of findAll(html, (e) => attr(e, 'data-hours') === 'manager')) {
        const text = textOf(el);
        found.push(`${path}: ${text}`);
        expect(text, `${path}: в блоке часов нет самих часов`).toMatch(/10:00.*18:00/);
        expect(text, `${path}: часы не названы часами менеджера`).toMatch(/менеджер/i);
        expect(text, `${path}: нет оговорки про семинары в выходные`).toMatch(/семинар/i);
      }
    }
    // Блоков ровно два — /kontakty и /oplata. Ноль означал бы, что признак снят
    // вместе с оговоркой и гейт стал бы зелёным на пустом месте.
    expect(found.length, `блоков часов найдено ${found.length}:\n${found.join('\n')}`).toBe(2);
  });

  it('на странице контактов оговорка стоит в том же блоке, что и часы', () => {
    const html = readPage('/kontakty/');
    const blocks = byClass(html, 'contact-shell-section');
    const withHours = blocks.filter((b) =>
      [...walk(b)].some((el) => attr(el, 'data-hours') === 'manager'),
    );
    const block = only(withHours, 'блок карточки контактов с часами работы');
    expect(textOf(block), 'оговорка не попала в блок с часами').toMatch(/семинар/i);
  });
});

// ─── D2: название семинара в блоке «Ближайший семинар» ──────────────────────

describe('D2 — блок «Ближайший семинар» на главной выводит название', () => {
  it('название взято из данных расписания и относится к тому же семинару, что ссылка', () => {
    const home = readPage('/');
    const block = only(byClass(home, 'hero-d-next'), 'блок «Ближайший семинар» на главной');
    const titleEl = only(
      [...walk(block)].filter((el) => hasClass(el, 'hero-d-next-title')),
      'элемент с названием семинара внутри блока',
    );
    const shown = textOf(titleEl);
    expect(shown.length, 'название семинара пустое').toBeGreaterThan(0);

    const href = attr(block, 'href') ?? '';
    const slugByInstitute = new Map(getInstitutes().map((i) => [i.name, i.slug]));
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const names = getScheduleEntries()
      .filter(
        (e) =>
          `/${slugByInstitute.get(e.institute.name)}/${e.program.slug}/${e.seminar.slug}` === href,
      )
      .map((e) => norm(e.name));
    expect(names, `ссылка ${href} не разрешается ни в одну запись расписания`).not.toEqual([]);
    expect(names, `показано «${shown}», а по ссылке ведут ${JSON.stringify(names)}`).toContain(
      norm(shown),
    );
  });
});

// ─── D10, D11: подписи кнопок ───────────────────────────────────────────────

describe('D10 — на главной зовут «Выбрать программу», а не «Записаться»', () => {
  it('ни одна кнопка главной не начинается со слова «Записаться»', () => {
    const buttons = buttonsIn(readPage('/'));
    expect(buttons.length, 'на главной не нашлось кнопок — разбор сломан').toBeGreaterThan(3);
    const offenders = buttons.map(textOf).filter((t) => /^Записаться/i.test(t));
    expect(offenders, `остались кнопки: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('CTA шапки и мобильного меню называются «Выбрать программу»', () => {
    const home = readPage('/');
    for (const marker of ['header', 'drawer']) {
      const cta = only(
        findAll(home, (el) => attr(el, 'data-cta') === marker),
        `CTA data-cta="${marker}"`,
      );
      expect(textOf(cta), `подпись CTA «${marker}»`).toBe('Выбрать программу');
    }
  });

  it('кнопки секций «Наши преимущества» и «Наш подход к обучению» зовут выбрать программу', () => {
    const home = readPage('/');
    for (const heading of ['Наши преимущества', 'Наш подход к обучению']) {
      const labels = buttonsIn(sectionByHeading(home, heading)).map(textOf);
      expect(labels.length, `в секции «${heading}» нет кнопок`).toBeGreaterThan(0);
      expect(labels, `подписи кнопок секции «${heading}»`).toContain('Выбрать программу');
    }
  });
});

describe('D11 — на /raspisanie-i-tseny кнопка называется «Записаться на семинар»', () => {
  it('карточки расписания больше не зовут «Зарегистрироваться»', () => {
    const html = readPage('/raspisanie-i-tseny/');
    const cards = findAll(html, (el) => attr(el, 'data-testid') === 'schedule-card');
    expect(cards.length, 'карточек расписания не найдено').toBeGreaterThan(5);
    const labels = new Set(cards.flatMap((card) => buttonsIn(card).map(textOf)));
    expect([...labels], 'осталась старая подпись').not.toContain('Зарегистрироваться');
    expect([...labels], 'новой подписи нет ни на одной карточке').toContain('Записаться на семинар');
  });
});

// ─── D21: заголовок секции ──────────────────────────────────────────────────

describe('D21 — секция новостей на главной называется «Предложения»', () => {
  it('заголовок сменился, старого на главной не осталось', () => {
    const headings = findAll(readPage('/'), (el) => el.tagName === 'h2').map(textOf);
    expect(headings.length, 'на главной не нашлось ни одного h2').toBeGreaterThan(3);
    expect(headings, 'нет заголовка «Предложения»').toContain('Предложения');
    expect(headings, 'заголовок «Новости» остался').not.toContain('Новости');
  });

  it('«Акции и скидки» осталась отдельной страницей и с предложениями не слита', () => {
    expect(allPages(), 'страница акций исчезла').toContain('/aktsii-i-skidki/');
    const promo = readPage('/aktsii-i-skidki/');
    const h1 = only(findAll(promo, (el) => el.tagName === 'h1'), '<h1> на /aktsii-i-skidki');
    expect(textOf(h1)).toMatch(/Акции и скидки/i);
    const homeHeadings = findAll(readPage('/'), (el) => el.tagName === 'h2').map(textOf);
    expect(homeHeadings, 'акции переехали в секцию главной').not.toContain('Акции и скидки');
  });
});
