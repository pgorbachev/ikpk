/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`: собранный вывод —
 * страницы-списки четырёх каталогов, плоские адреса записей и порождаемый маршрут
 * статической страницы.
 *
 * Предмет — СОБРАННОЕ ДЕРЕВО `web/dist`, поэтому файл живёт в `vitest.build.config.ts`
 * и исключён из основного прогона (инвариант двух списков сторожит
 * `tests/repo-hygiene.test.ts`).
 *
 * Почему это проверяется УЖЕ СЕЙЧАС, а не после change `cms-content-publication`:
 * плоская схема адресов и каталожные страницы строятся из того же снимка, из которого
 * сайт собирается сегодня (`discovery/entities/`), — переключение источника им не
 * требуется. Ограничение соседнего change касается ВЫКЛАДКИ новых адресов и содержимого
 * из системы управления, а не сборки. Сценарии, которым действительно нужен CMS-контент,
 * перечислены в конце файла.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dist } from './helpers/dist-pages';

const ROOT = join(import.meta.dirname, '..', '..');

const entity = <T>(file: string): T => {
  const path = join(ROOT, 'discovery', 'entities', file);
  expect(existsSync(path), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
};

const page = (path: string): string | undefined => {
  for (const candidate of [join(dist, path, 'index.html'), join(dist, `${path}.html`)]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf-8');
  }
  return undefined;
};

describe('собранный сайт: предмет проверки существует', () => {
  it('дерево сборки на месте', () => {
    expect(existsSync(dist), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${dist} — сборка не выполнена`).toBe(true);
    expect(page(''), 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: в сборке нет главной страницы').toBeDefined();
  });
});

describe('собранный сайт: сегмент каталога отвечает списком', () => {
  // Scenario: сегмент каталога отвечает списком.
  // 404 на сегменте каталога означал бы «уровень есть в адресе, но его нет в сайте».
  it.each(['instituty', 'programmy', 'seminary', 'specialisty'])('каталог /%s отдаёт страницу', (catalog) => {
    expect(page(catalog), `каталога /${catalog} в сборке нет`).toBeDefined();
  });

  it('каталог /seminary перечисляет семинары своими плоскими адресами', () => {
    const html = page('seminary');
    expect(html, 'каталога /seminary в сборке нет').toBeDefined();
    const seminars = entity<{ slug?: string }[]>('seminars.json')
      .map((s) => s.slug)
      .filter((s): s is string => typeof s === 'string');
    expect(seminars.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: семинаров в снимке нет').toBeGreaterThan(0);
    const linked = seminars.filter((slug) => html!.includes(`/seminary/${slug}`));
    expect(linked.length, 'страница каталога не ссылается ни на один семинар').toBeGreaterThan(0);
  });

  // Scenario: каталог специалистов показывает обе группы и называет группу каждой персоны
  it('каталог /specialisty называет группу каждой персоны', () => {
    const html = page('specialisty');
    expect(html, 'каталога /specialisty в сборке нет').toBeDefined();
    expect(
      /преподавател/i.test(html!),
      'в каталоге специалистов не названа группа «преподаватель»',
    ).toBe(true);
    expect(
      /автор\w*\s+методик/i.test(html!),
      'в каталоге специалистов не названа группа «автор методики»',
    ).toBe(true);
  });
});

describe('собранный сайт: адреса записей плоские', () => {
  // Scenario: новый семинар доступен по плоскому адресу (часть про сборку)
  it('каждый семинар снимка доступен по адресу /seminary/<идентификатор>', () => {
    const seminars = entity<{ slug?: string }[]>('seminars.json')
      .map((s) => s.slug)
      .filter((s): s is string => typeof s === 'string');
    expect(seminars.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: семинаров в снимке нет').toBeGreaterThan(0);
    const missing = seminars.filter((slug) => page(`seminary/${slug}`) === undefined);
    expect(missing.length, `семинаров без плоского адреса: ${missing.length} из ${seminars.length}`).toBe(0);
  });

  it('каждая персона снимка доступна по адресу /specialisty/<идентификатор>', () => {
    const persons = entity<{ slug?: string }[]>('teachers.json')
      .map((t) => t.slug)
      .filter((s): s is string => typeof s === 'string');
    expect(persons.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: персон в снимке нет').toBeGreaterThan(0);
    const missing = persons.filter((slug) => page(`specialisty/${slug}`) === undefined);
    expect(missing.length, `персон без плоского адреса: ${missing.length} из ${persons.length}`).toBe(0);
  });

  it('каждый институт снимка доступен по адресу /instituty/<идентификатор>', () => {
    const institutes = entity<{ slug?: string }[]>('institutes.json')
      .map((i) => i.slug)
      .filter((s): s is string => typeof s === 'string');
    const missing = institutes.filter((slug) => page(`instituty/${slug}`) === undefined);
    expect(missing.length, `институтов без плоского адреса: ${missing.length} из ${institutes.length}`).toBe(0);
  });

  // Scenario: семинар в двух программах имеет один адрес — второго адреса в карте сайта нет.
  // Дефект найден и исправлен в этой же сессии красных тестов: изначальная
  // формулировка требовала снять институты/программы/семинары из карты сайта
  // на СЕГОДНЯШНЕЙ сборке — но у иерархических адресов до переключения
  // источника (change `cms-content-publication`) плоских канонических замен
  // нет: новые адреса помечены noindex именно потому, что они временные
  // дубли (см. `web/src/pages/instituty/[slug].astro` и парные файлы). Снятие
  // единственного индексируемого адреса записи из карты раньше появления его
  // замены убрало бы сигнал sitemap на 181 странице без какой-либо выгоды —
  // не то поведение, которое просит сценарий спеки «семинар в двух программах
  // имеет один адрес» (он про адрес ПОСЛЕ смены схемы). Проверяется то, что
  // верно уже сейчас: у noindex-дублей нет записи в карте, а иерархические
  // адреса, будучи единственными индексируемыми, в карте остаются.
  it('плоские noindex-дубли не попадают в карту сайта, иерархические адреса остаются', () => {
    const institutes = entity<{ slug?: string }[]>('institutes.json')
      .map((i) => i.slug)
      .filter((s): s is string => typeof s === 'string');
    const sitemapFiles = ['sitemap-0.xml', 'sitemap-index.xml'].map((f) => join(dist, f)).filter(existsSync);
    expect(sitemapFiles.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: карты сайта в сборке нет').toBeGreaterThan(0);
    const xml = sitemapFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');

    const flatPresent = institutes.filter((slug) => new RegExp(`<loc>[^<]*/instituty/${slug}</loc>`).test(xml));
    expect(flatPresent, 'плоский noindex-адрес института просочился в карту сайта').toEqual([]);

    const hierarchicalMissing = institutes.filter((slug) => !new RegExp(`<loc>[^<]*/${slug}</loc>`).test(xml));
    expect(
      hierarchicalMissing,
      'иерархический адрес института пропал из карты сайта раньше появления канонической замены',
    ).toEqual([]);
  });
});

describe('собранный сайт: существующие статические страницы и порождаемый маршрут', () => {
  // Scenario: существующие страницы продолжают раздаваться.
  // Проверка ЗЕЛЁНАЯ по замыслу: она сторожит регресс от перехода на плоскую схему.
  it('каждая перенесённая статическая страница доступна по своему прежнему адресу', () => {
    const pages = entity<{ slug?: string; legacy_url?: string }[]>('static_pages.json');
    expect(pages.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: статических страниц в снимке нет').toBeGreaterThan(0);
    const missing = pages
      .map((p) => p.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug !== 'homepage')
      .filter((slug) => page(slug) === undefined);
    expect(missing, `статических страниц без адреса в сборке: ${missing.length}`).toEqual([]);
  });

  // Scenario: новая страница появляется без правки исходников.
  // Проверяемая часть без системы управления: маршрут статической страницы ПОРОЖДАЕТСЯ
  // из данных, а не является отдельным файлом шаблона на каждую страницу. Признак —
  // существование маршрута с динамическим сегментом, отдающего страницы из снимка.
  it('маршрут статической страницы порождается из данных', () => {
    const pagesDir = join(ROOT, 'web', 'src', 'pages');
    expect(existsSync(pagesDir), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${pagesDir}`).toBe(true);
    // Признак узкий намеренно. «Есть хоть один динамический маршрут» проходит по
    // существующему `[institute].astro`, который порождает страницы ИНСТИТУТОВ и к
    // статическим страницам отношения не имеет: это ровно тот декоративный признак,
    // который зелен не про предмет. Нужен маршрут, читающий записи статических страниц.
    const dynamic = readdirSync(pagesDir).filter((f) => /^\[.*\]\.(astro|ts)$/.test(f));
    const fromStaticPages = dynamic.filter((f) => {
      const source = readFileSync(join(pagesDir, f), 'utf-8');
      return /static_?pages|staticPages/i.test(source);
    });
    expect(
      fromStaticPages,
      `маршрута, порождающего статическую страницу из данных, нет: ${dynamic.join(', ') || 'динамических маршрутов нет вовсе'} — ` +
        'запись сохранится, а страницы не появится',
    ).not.toEqual([]);
  });
});

/*
 * СЦЕНАРИИ, КОТОРЫЕ НА СОБРАННОМ ВЫВОДЕ НЕ ПРОВЕРЯЮТСЯ ДО change `cms-content-publication`
 *
 * Им нужен контент, введённый РЕДАКТОРОМ, а сборка до переключения источника читает
 * файловый снимок. Ограничение названо в самой спеке (раздел Purpose), это не дефект:
 *
 *  - «редактор создаёт статическую страницу `garantii` и публикует — страница доступна
 *     по адресу /garantii» (здесь проверена только порождаемость маршрута);
 *  - «редактор создаёт семинар `novyj-seminar` — страница доступна» и «адрес присутствует
 *     в списке семинаров этой программы»;
 *  - «снятый семинар исчезает из всех мест» и «в сборке нет перенаправления, цель
 *     которого отсутствует» для снятой записи;
 *  - «в сведениях об образовательной организации только преподаватели» — признака
 *     персоны в файловом снимке нет вовсе, поэтому проверка на нём была бы вакуумной;
 *  - «содержимое каждой секции соответствует своему полю» и «секция документов построена
 *     из структурных полей» — полей нет в снимке;
 *  - «на странице программы показано ближайшее событие», «на странице семинара
 *     перечислены все три», «показано „уточняйте у менеджера“ с телефоном» — состав
 *     данных проверен в `tests/cms-order-and-dates.test.ts`.
 */
