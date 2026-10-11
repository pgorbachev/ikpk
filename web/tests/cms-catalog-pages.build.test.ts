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
 * сайт собирается сегодня (`resolveSnapshotDir`), — переключение источника им не
 * требуется. Ограничение соседнего change касается ВЫКЛАДКИ новых адресов и содержимого
 * из системы управления, а не сборки. Сценарии, которым действительно нужен CMS-контент,
 * перечислены в конце файла.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'parse5';
import { dist } from './helpers/dist-pages';
import { readSnapshotFile, resolveSnapshotDir } from '../scripts/lib/snapshot-paths';

const WEB = join(import.meta.dirname, '..');
const ROOT = join(WEB, '..');

// Тот же снимок, из которого собрана проверяемая сборка (спека `cms-content-source`:
// контент читается только через снимок, а не из материала переноса).
const entity = <T>(file: string): T => {
  const type = file.replace(/\.json$/, '');
  const records = readSnapshotFile(resolveSnapshotDir(WEB, ROOT)).content.types[type];
  expect(records, `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в снимке нет типа ${type}`).toBeDefined();
  return records as T;
};

const page = (path: string): string | undefined => {
  for (const candidate of [join(dist, path, 'index.html'), join(dist, `${path}.html`)]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf-8');
  }
  return undefined;
};

type HtmlNode = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
};

function textOf(node: HtmlNode): string {
  return `${node.value ?? ''}${(node.childNodes ?? []).map(textOf).join('')}`;
}

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function descendants(node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode[] {
  const found = predicate(node) ? [node] : [];
  for (const child of node.childNodes ?? []) found.push(...descendants(child, predicate));
  return found;
}

function specialistLinksByGroup(html: string): Map<string, Map<string, string>> {
  const root = parse(html) as unknown as HtmlNode;
  const groups = new Map<string, Map<string, string>>();
  const headings = descendants(root, (node) => node.tagName === 'h2');
  for (const heading of headings) {
    const label = textOf(heading).trim();
    if (label !== 'Преподаватели' && label !== 'Авторы методик') continue;
    const parent = heading as HtmlNode & { parentNode?: HtmlNode & { childNodes?: HtmlNode[] } };
    const siblings = parent.parentNode?.childNodes ?? [];
    const headingIndex = siblings.indexOf(heading);
    const links = new Map<string, string>();
    for (const sibling of siblings.slice(headingIndex + 1)) {
      if (sibling.tagName === 'h2') break;
      for (const anchor of descendants(sibling, (node) => node.tagName === 'a')) {
        const href = anchor.attrs?.find((attribute) => attribute.name === 'href')?.value;
        if (href?.startsWith('/specialisty/')) {
          const name = descendants(anchor, (node) => node.tagName === 'h3')[0];
          links.set(href, name ? textOf(name).trim() : textOf(anchor).trim());
        }
      }
    }
    groups.set(label, links);
  }
  return groups;
}

function pedagogicalStaffRoster(html: string): string | undefined {
  const root = parse(html) as unknown as HtmlNode;
  const roster = descendants(root, (node) => attribute(node, 'data-pedagogical-staff') !== undefined)[0];
  return roster ? textOf(roster) : undefined;
}

function linksInside(html: string, marker: string): Map<string, string> {
  const root = parse(html) as unknown as HtmlNode;
  const section = descendants(root, (node) => attribute(node, marker) !== undefined)[0];
  const links = new Map<string, string>();
  if (!section) return links;
  for (const anchor of descendants(section, (node) => node.tagName === 'a')) {
    const href = attribute(anchor, 'href');
    if (href?.startsWith('/specialisty/')) links.set(href, textOf(anchor).trim());
  }
  return links;
}

function expectSnapshotTraitsMatchRenderedPeople(
  teachers: { legacy_id: string | number; name: string; slug: string; trait?: string }[],
  catalogHtml: string,
  rosterHtml: string,
): void {
  const valid = teachers.filter((teacher) => teacher.trait === 'teacher' || teacher.trait === 'method-author');
  const staff = valid.filter((teacher) => teacher.trait === 'teacher');
  const authors = valid.filter((teacher) => teacher.trait === 'method-author');
  expect(valid, 'у персоны отсутствует допустимый trait').toHaveLength(teachers.length);

  const cards = specialistLinksByGroup(catalogHtml);
  for (const [label, people] of [['Преподаватели', staff], ['Авторы методик', authors]] as const) {
    const actual = cards.get(label) ?? new Map<string, string>();
    if (people.length > 0) {
      expect(actual.size, `в HTML каталога нет карточек группы «${label}»`).toBeGreaterThan(0);
    }
    expect([...actual.keys()].sort(), `набор карточек «${label}» расходится с trait снимка`).toEqual(
      people.map((teacher) => `/specialisty/${teacher.slug}`).sort(),
    );
  }

  const roster = linksInside(rosterHtml, 'data-pedagogical-staff');
  expect([...roster.keys()].sort(), 'состав страницы сведений расходится с teacher trait').toEqual(
    staff.map((teacher) => `/specialisty/${teacher.slug}`).sort(),
  );
}

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
      html!.includes('Авторы методик'),
      'в каталоге специалистов не названа группа «автор методики»',
    ).toBe(true);
  });

  it('D10: список специалистов называет обе группы', () => {
    const html = page('specialisty');
    expect(html, 'каталога /specialisty в сборке нет').toBeDefined();
    const groups = specialistLinksByGroup(html!);
    expect(groups.has('Преподаватели')).toBe(true);
    expect(groups.has('Авторы методик')).toBe(true);
  });

  it('каталог и roster совпадают с trait персон в выбранном снимке', () => {
    const html = page('specialisty');
    expect(html, 'каталога /specialisty в сборке нет').toBeDefined();
    const teachers = entity<{ legacy_id: string | number; name: string; slug: string; trait?: string }[]>('teachers.json');
    expect(teachers.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: в снимке нет персон').toBeGreaterThan(0);
    const staffHtml = page('svedeniya-ob-obrazovatelnoy-organizatsii');
    expect(staffHtml, 'HTML страницы сведений об организации отсутствует').toBeDefined();
    expect(pedagogicalStaffRoster(staffHtml!), 'HTML страницы сведений не содержит roster')
      .toContain('Педагогический состав');
    expectSnapshotTraitsMatchRenderedPeople(teachers, html!, staffHtml!);
  });

  it('31 live entries и admin reclassification не возвращают классификацию импорта в build acceptance', () => {
    const people = Array.from({ length: 31 }, (_, index) => ({
      legacy_id: String(index + 1),
      slug: `person-${index + 1}`,
      name: `Специалист ${index + 1}`,
      trait: index < 11 ? 'method-author' : 'teacher',
    }));
    people[10]!.trait = 'teacher';
    people[11]!.trait = 'method-author';
    const html = `<section><h2>Преподаватели</h2><div>${people.filter((person) => person.trait === 'teacher').map((person) => `<a href="/specialisty/${person.slug}"><h3>${person.name}</h3></a>`).join('')}</div><h2>Авторы методик</h2><div>${people.filter((person) => person.trait === 'method-author').map((person) => `<a href="/specialisty/${person.slug}"><h3>${person.name}</h3></a>`).join('')}</div></section>`;
    const roster = `<section data-pedagogical-staff><h2>Педагогический состав</h2><ul>${people.filter((person) => person.trait === 'teacher').map((person) => `<li><a href="/specialisty/${person.slug}">${person.name}</a></li>`).join('')}</ul></section>`;

    expectSnapshotTraitsMatchRenderedPeople(people, html, roster);
  });

  it('optional institute relation не формирует адрес /undefined/prepodavatel', async () => {
    const { teacherPageHref } = await import('../src/lib/data.js');
    expect(teacherPageHref({ slug: 'person-without-institute', institute_legacy_id: undefined })).toBeNull();
    expect(teacherPageHref({ slug: 'cms-person', institute_legacy_id: 'new-inst' }))
      .toBe('/new-inst/prepodavatel/cms-person');
    const invalid = spawnSync(
      'rg',
      ['-n', '-g', '*.html', '-e', 'href="/(?:undefined|null)/prepodavatel/'],
      { cwd: dist, encoding: 'utf-8' },
    );
    expect(invalid.status, invalid.stderr || invalid.stdout).toBe(1);
  });

  it('D10: saved trait places a teacher in the roster and excludes a method author', async () => {
    const { groupTeachersByTrait, pedagogicalStaff } = await import('../src/lib/data.js');
    const people = [
      { legacy_id: 'teacher-1', legacy_url: '/teacher-1', name: 'Преподаватель для проверки', slug: 'teacher-1', trait: 'teacher' as const, bio_html: '', bio_text: '', photo: '' },
      { legacy_id: 'author-1', legacy_url: '/author-1', name: 'Автор методик для проверки', slug: 'author-1', trait: 'method-author' as const, bio_html: '', bio_text: '', photo: '' },
    ];
    const groups = groupTeachersByTrait(people);
    expect(groups.teacher.map((person) => person.name)).toEqual(['Преподаватель для проверки']);
    expect(groups['method-author'].map((person) => person.name)).toEqual(['Автор методик для проверки']);
    const roster = pedagogicalStaff(people);
    expect(roster.map((person) => person.name)).toContain('Преподаватель для проверки');
    expect(roster.map((person) => person.name)).not.toContain('Автор методик для проверки');
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
      // Признак — вызов `getPages()`, которая отдаёт записи статических страниц из снимка
      // (`web/src/lib/data.ts`). Прежний признак — слова `static_pages` в тексте файла —
      // совпадал с КОММЕНТАРИЕМ маршрута и пропадал вместе с ним.
      return /\bgetPages\s*\(/.test(source);
    });
    expect(
      fromStaticPages,
      `маршрута, порождающего статическую страницу из данных, нет: ${dynamic.join(', ') || 'динамических маршрутов нет вовсе'} — ` +
        'запись сохранится, а страницы не появится',
    ).not.toEqual([]);
  });
});

describe('D10: страница сведений об образовательной организации', () => {
  it('педагогический состав содержит преподавателя и не содержит авторов методик', () => {
    const html = page('svedeniya-ob-obrazovatelnoy-organizatsii');
    expect(html, 'страницы сведений об образовательной организации в сборке нет').toBeDefined();
    expect(pedagogicalStaffRoster(html!), 'на странице нет отдельного семантического состава педагогических работников').toContain('Педагогический состав');
  });
});

describe('D10: состав института строится по relation', () => {
  it('D10: membership института фильтруется relation-derived snapshot field', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'ikpk-d4-institute-relation-'));
    const previousSnapshotDir = process.env.CONTENT_SNAPSHOT_DIR;
    const snapshot = {
      referenceDate: '2026-10-11',
      content: {
        types: {
          teachers: [
            { legacy_id: 'linked', slug: 'linked', name: 'Связанный преподаватель', institute_legacy_id: 'inst-a' },
            { legacy_id: 'other', slug: 'other', name: 'Другой институт', institute_legacy_id: 'inst-b' },
          ],
        },
      },
    };
    writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
    process.env.CONTENT_SNAPSHOT_DIR = snapshotDir;
    try {
      const { getTeachers } = await import('../src/lib/data.js');
      expect(getTeachers('inst-a').map((teacher) => teacher.legacy_id),
        'страница института должна читать membership relation и игнорировать legacy-поле')
        .toEqual(['linked']);
    } finally {
      if (previousSnapshotDir === undefined) delete process.env.CONTENT_SNAPSHOT_DIR;
      else process.env.CONTENT_SNAPSHOT_DIR = previousSnapshotDir;
      rmSync(snapshotDir, { recursive: true, force: true });
    }
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
 *  - «в сведениях об образовательной организации только преподаватели» — проверяется
 *     выше по trait в выбранном снимке, включая точное равенство состава roster;
 *  - «содержимое каждой секции соответствует своему полю» и «секция документов построена
 *     из структурных полей» — полей нет в снимке;
 *  - «на странице программы показано ближайшее событие», «на странице семинара
 *     перечислены все три», «показано „уточняйте у менеджера“ с телефоном» — состав
 *     данных проверен в `tests/cms-order-and-dates.test.ts`.
 */
