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
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
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
        if (href?.startsWith('/specialisty/')) links.set(href, textOf(anchor).trim());
      }
    }
    groups.set(label, links);
  }
  return groups;
}

const METHOD_AUTHOR_IDS = new Set(['80', '79', '77', '74', '71', '70', '69', '68', '67', '66', '65']);

function pedagogicalStaffSection(html: string): string | undefined {
  const root = parse(html) as unknown as HtmlNode;
  const heading = descendants(root, (node) => node.tagName === 'summary')
    .find((node) => textOf(node).includes('Руководство. Педагогический (научно-педагогический) состав'));
  if (!heading) return undefined;
  // The page restores the CMS panel as a <details> block; scope the assertion to that panel.
  let current = heading as HtmlNode & { parentNode?: HtmlNode & { parentNode?: HtmlNode } };
  while (current.parentNode && current.tagName !== 'details') current = current.parentNode as typeof current;
  return textOf(current);
}

async function runNode(scriptArgs: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...scriptArgs], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-30_000); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-30_000); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
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
      /автор\w*\s+методик/i.test(html!),
      'в каталоге специалистов не названа группа «автор методики»',
    ).toBe(true);
  });

  it('D10: каждая персона показана под группой, совпадающей с её первичным trait', () => {
    const html = page('specialisty');
    expect(html, 'каталога /specialisty в сборке нет').toBeDefined();
    const people = entity<{ legacy_id: string | number; slug: string; name: string }[]>('teachers.json');
    expect(people.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: персон в снимке нет').toBeGreaterThan(0);
    for (const id of METHOD_AUTHOR_IDS) {
      expect(people.some((person) => String(person.legacy_id) === id), `в снимке нет принятого автора методики ${id}`).toBe(true);
    }

    const groups = specialistLinksByGroup(html!);
    const expectedTeachers = people.filter((person) => !METHOD_AUTHOR_IDS.has(String(person.legacy_id)));
    const expectedAuthors = people.filter((person) => METHOD_AUTHOR_IDS.has(String(person.legacy_id)));
    for (const person of expectedTeachers) {
      expect(groups.get('Преподаватели')?.get(`/specialisty/${person.slug}`), `${person.name} не показан как преподаватель`).toBe(person.name);
    }
    for (const person of expectedAuthors) {
      expect(groups.get('Авторы методик')?.get(`/specialisty/${person.slug}`), `${person.name} не показан как автор методики`).toBe(person.name);
    }
    expect(groups.get('Преподаватели')?.size).toBe(expectedTeachers.length);
    expect(groups.get('Авторы методик')?.size).toBe(expectedAuthors.length);
  });

  it('D10: live capture переносит trait CMS-персоны в тип teachers снимка', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ikpk-d4-live-snapshot-'));
    const cmsRecords: Record<string, Record<string, unknown>[]> = {
      institutes: [{ id: 1, documentId: 'inst-1', legacy_id: 'inst-1', name: 'Институт', slug: 'inst-1', shortName: 'ИКПК' }],
      'course-groups': [{ id: 2, documentId: 'group-1', legacy_id: 'group-1', name: 'Программа', slug: 'group-1', institute: { id: 1, documentId: 'inst-1', legacy_id: 'inst-1', name: 'Институт', slug: 'inst-1' } }],
      seminars: [{ id: 3, documentId: 'seminar-1', legacy_id: 'seminar-1', name: 'Семинар', slug: 'seminar-1', course_group: { id: 2, documentId: 'group-1', legacy_id: 'group-1', slug: 'group-1' } }],
      teachers: [{ id: 4, documentId: 'person-80', legacy_id: '80', name: 'Fabio Burigana', slug: '80', trait: 'method-author', institute: { id: 1, documentId: 'inst-1', legacy_id: 'inst-1', name: 'Институт', slug: 'inst-1' } }],
      articles: [{ id: 5, documentId: 'article-1', legacy_id: 'article-1', title: 'Статья', slug: 'article-1', body: '<p>Текст</p>', seo: { seo_title: 'Статья', seo_description: 'Описание' }, image: { id: 9, documentId: 'image-1', url: '/uploads/d4-test.png' } }],
      'schedule-entries': [],
      'news-items': [],
      promotions: [],
      pages: [],
      'video-playlists': [],
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        const endpoint = url.pathname.slice('/api/'.length);
        return jsonResponse(res, { data: cmsRecords[endpoint] ?? [], meta: { pagination: { page: 1, pageCount: 1 } } });
      }
      if (url.pathname === '/uploads/d4-test.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }
      res.writeHead(404).end();
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('mock CMS не получил TCP-порт');
      const result = await runNode(['scripts/capture-content-snapshot.ts'], WEB, {
        ...process.env,
        CMS_URL: `http://127.0.0.1:${address.port}`,
        CONTENT_SNAPSHOT_DIR: tempDir,
      });
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      const snapshot = JSON.parse(readFileSync(join(tempDir, 'snapshot.json'), 'utf8')) as { content: { types: Record<string, { trait?: string }[]> } };
      expect(snapshot.content.types.teachers, 'в live-снимке нет типа teachers').toEqual([
        expect.objectContaining({ legacy_id: '80', trait: 'method-author' }),
      ]);
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 70_000);
});

function jsonResponse(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

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
    const roster = pedagogicalStaffSection(html!);
    expect(roster, 'в странице нет панели «Руководство. Педагогический состав»').toBeDefined();
    const people = entity<{ legacy_id: string | number; slug: string; name: string }[]>('teachers.json');
    const teacher = people.find((person) => !METHOD_AUTHOR_IDS.has(String(person.legacy_id)));
    const authors = people.filter((person) => METHOD_AUTHOR_IDS.has(String(person.legacy_id)));
    expect(teacher, 'в снимке нет преподавателя для непустой контрольной записи').toBeDefined();
    expect(roster, 'панель не содержит ни одной персоны: фильтр нельзя проверить на непустом составе').toContain(teacher!.name);
    for (const author of authors) {
      expect(roster, `автор методики ${author.name} попал в педагогический состав`).not.toContain(author.name);
    }
  });
});

describe('D10: состав института строится по relation', () => {
  it('персона со связью попадает в институт, legacy-only персона не попадает', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'ikpk-d4-institute-relation-'));
    const previousSnapshotDir = process.env.CONTENT_SNAPSHOT_DIR;
    const snapshot = {
      referenceDate: '2026-10-11',
      content: {
        types: {
          teachers: [
            { legacy_id: 'linked', slug: 'linked', name: 'Связанный преподаватель', institutes: [{ legacy_id: 'inst-a' }] },
            { legacy_id: 'legacy-only', slug: 'legacy-only', name: 'Только легаси', institute_legacy_id: 'inst-a' },
            { legacy_id: 'other', slug: 'other', name: 'Другой институт', institutes: [{ legacy_id: 'inst-b' }] },
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
 *  - «в сведениях об образовательной организации только преподаватели» — признака
 *     персоны в файловом снимке нет вовсе, поэтому проверка на нём была бы вакуумной;
 *  - «содержимое каждой секции соответствует своему полю» и «секция документов построена
 *     из структурных полей» — полей нет в снимке;
 *  - «на странице программы показано ближайшее событие», «на странице семинара
 *     перечислены все три», «показано „уточняйте у менеджера“ с телефоном» — состав
 *     данных проверен в `tests/cms-order-and-dates.test.ts`.
 */
