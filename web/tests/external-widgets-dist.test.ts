import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { dist, walkHtml } from './helpers/dist-pages';
import { attr, textOf } from './helpers/dom';
import {
  REVIEWS_AVATAR_HOST,
  REVIEWS_ORG_ID,
  REVIEWS_WIDGET_HOST,
  SEL_AWARD_BADGE,
  SEL_CHAT_FACADE,
  SEL_CHAT_HOURS,
  SEL_CHAT_MOUNT,
  SEL_CHAT_TRIGGER,
  SEL_REVIEWS_SECTION,
  byDataName,
  chatLoaderHits,
  elements,
  hostAndPath,
  ratingSummaryHits,
  reviewsEmbedHits,
  subtree,
} from './helpers/external-widgets';

/**
 * Тесты по спеке change `external-widgets` — предмет БОЕВОЙ вывод сборки.
 *
 * Предмет один: демо-вывод здесь не читается, симметричные утверждения про него живут в
 * `tests/external-widgets-demo.test.ts`. Разведение обязательно, а не удобно:
 * `web/tests/demo-gate.test.ts:670` роняет прогон у файла, получившего оба вывода, и
 * причина не формальная — «встраиваний нет» и «встраивания есть» суть разные требования,
 * и файл с двумя предметами проверяет то, какой каталог ему достался.
 *
 * ПРИЗНАК ПРИСУТСТВИЯ ОДИН И ТОТ ЖЕ с демо-файлом и живёт в `helpers/external-widgets.ts`:
 * адрес самого встраивания в любом атрибуте, включая атрибуты данных. Спека требует
 * именно этого: два прочтения одного требования дали бы две проверки разной силы над
 * одним предметом, и расхождение не увидела бы ни одна.
 *
 * ── СТОРОЖ НЕПУСТОТЫ ────────────────────────────────────────────────────────
 * Большинство утверждений ниже — про ОТСУТСТВИЕ (сводки чисел, текстов отзывов, разметки
 * чата на 404, своей формы сбора данных). Все они тривиально верны на пустом предмете,
 * поэтому каждое из них стоит ПОСЛЕ доказательства непустоты: страницы читаются, секция
 * существует, встраивание на месте. Спека делает это отдельным требованием, а не
 * пожеланием.
 */

const PAGE_404 = '404.html';

/** Страницы вывода: адрес → разметка. Пустой набор — «не выполнено», а не «прошло». */
function outputPages(root: string = dist): Map<string, string> {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(
      `предмета проверки нет: каталога вывода '${root}' нет либо это не каталог. ` +
        'Пустой вывод считается «не выполнено», а не «нарушений нет». Собрать: npm run build',
    );
  const pages = new Map<string, string>();
  for (const file of walkHtml(root))
    pages.set(file.slice(root.length).replaceAll('\\', '/'), readFileSync(file, 'utf-8'));
  if (pages.size === 0)
    throw new Error(`предмета проверки нет: html-страниц в '${root}' нет`);
  return pages;
}

let pages: Map<string, string>;
let home: string;

beforeAll(() => {
  pages = outputPages();
  home = readFileSync(join(dist, 'index.html'), 'utf-8');
});

/** Секция отзывов на главной. Нет её — предмета нет, и это отказ, а не проход. */
function reviewsSection(): ReturnType<typeof byDataName>[number] {
  const found = byDataName(home, SEL_REVIEWS_SECTION);
  expect(
    found.length,
    `на главной нет элемента с '${SEL_REVIEWS_SECTION}' — предмета нет, и все утверждения ` +
      'об отсутствии внутри секции были бы тривиально зелёными',
  ).toBe(1);
  return found[0];
}

/** Адрес загрузчика чата, объявленный сборкой. Не объявлен — проверка непройдена. */
function declaredChatLoader(): string {
  // Адрес берётся ИЗ ВЫВОДА, а не из окружения этой проверки: предмет — та сборка,
  // которая уехала бы на боевой сайт, и её конфигурация видна только по выводу.
  // Носителем объявлен наш контейнер фасада: угадывать хост загрузчика нельзя —
  // спека прямо говорит, что где он живёт, НЕ ИЗВЕСТНО, и утверждать это запрещает.
  const hits = [...pages.values()].flatMap((html) =>
    byDataName(html, SEL_CHAT_FACADE).flatMap((el) =>
      el.attrs.map((a) => a.value).filter((v) => hostAndPath(v) !== null),
    ),
  );
  const uniq = [...new Set(hits)];
  expect(
    uniq.length,
    'в боевом выводе не объявлен адрес загрузчика чата. Спека: «сборка, которую читает ' +
      'симметричная проверка боевого вывода, собрана без адреса загрузчика — проверка ' +
      'считается непройденной, а не пройденной». Конфигурация обязана лежать там, где её ' +
      'читает проверка, а не только в окружении выкладки',
  ).toBe(1);
  return uniq[0];
}

// ─── Секция отзывов: место и охват ───────────────────────────────────────────

describe('боевой вывод: материал на месте', () => {
  it('в выводе есть собранные страницы сайта', () => {
    expect(pages.size, `в '${dist}' нет html-страниц`).toBeGreaterThan(50);
    const real = [...pages.values()].filter((html) => /<html[^>]*lang="ru"/.test(html));
    expect(
      real.length,
      'ни одна страница не похожа на собранную страницу сайта — утверждения об ' +
        'отсутствии ниже были бы тривиально зелёными',
    ).toBeGreaterThan(50);
  });

  it('утверждение отсутствия на пустом предмете считается НЕпройденным', () => {
    // Сторож проверяется вызовом, а не чтением кода: на пустом каталоге перечисление
    // страниц обязано падать. Иначе «предмета нет» неотличимо от «нарушений нет» —
    // класс дефекта, из-за которого требование о непустоте вообще существует.
    const empty = mkdtempSync(join(tmpdir(), 'ikpk-widgets-empty-'));
    expect(() => outputPages(empty)).toThrow(/предмета проверки нет/);

    const filled = mkdtempSync(join(tmpdir(), 'ikpk-widgets-filled-'));
    mkdirSync(join(filled, 'x'), { recursive: true });
    writeFileSync(join(filled, 'x', 'index.html'), '<!doctype html><html lang="ru"></html>');
    expect(outputPages(filled).size, 'на непустом каталоге сторож тоже падает — он падает всегда').toBe(1);
  });
});

describe('отзывы показываются секцией главной и только там', () => {
  it('секция отзывов стоит после блока преподавателей', () => {
    const section = reviewsSection();
    const all = elements(home);
    const teachers = all.find((el) => (attr(el, 'class') ?? '').split(/\s+/).includes('teachers'));
    expect(
      teachers,
      'на главной не найден блок преподавателей — относительно чего проверять порядок',
    ).toBeTruthy();
    expect(
      all.indexOf(section) > all.indexOf(teachers!),
      'секция отзывов стоит НЕ после блока преподавателей',
    ).toBe(true);
  });

  it('на других страницах встраивания отзывов нет', () => {
    // Непустота доказана отдельно: на главной встраивание есть (тест ниже). Без этого
    // «на остальных нет» верно и когда его нет вообще нигде.
    expect(reviewsEmbedHits(home).length, 'на главной встраивания отзывов нет — предмета нет').toBeGreaterThan(0);
    const offenders = [...pages.entries()]
      .filter(([path]) => path !== '/index.html')
      .filter(([, html]) => reviewsEmbedHits(html).length > 0)
      .map(([path]) => path);
    expect(offenders.slice(0, 10), `встраивание отзывов вне главной: ${offenders.length} страниц`).toEqual([]);
  });

  it('отдельной страницы отзывов не существует', () => {
    const suspects = [...pages.keys()].filter((p) => /\/otzyv|\/reviews|\/otzivy/i.test(p));
    expect(suspects, `собрана отдельная страница отзывов: ${suspects.join(', ')}`).toEqual([]);
  });
});

describe('отзывы выводит официальный виджет, а не мы и не посредник', () => {
  it('единственный внешний адрес секции — официальный виджет Яндекс.Карт', () => {
    const section = reviewsSection();
    const foreign = subtree(section)
      .flatMap((el) => el.attrs.map((a) => ({ tag: el.tagName, name: a.name, value: a.value })))
      .map((a) => ({ ...a, parsed: hostAndPath(a.value) }))
      .filter((a) => a.parsed !== null)
      .filter((a) => a.parsed!.host !== REVIEWS_WIDGET_HOST && !a.parsed!.host.endsWith(`.${REVIEWS_WIDGET_HOST}`));
    expect(
      foreign.map((a) => `${a.tag}[${a.name}] → ${a.value}`),
      'в секции отзывов есть внешний адрес не на официальном виджете',
    ).toEqual([]);
  });

  it('скриптов сторонних сервисов отзывов среди загружаемых нет', () => {
    // Непустота: секция обязана существовать. Утверждение «посредника нет» тривиально
    // верно на странице без секции отзывов вообще.
    reviewsSection();
    // Признак — ХОСТ загружаемого скрипта, а не имя сервиса: перечень имён посредников
    // отставал бы от предмета молча. Разрешены только наши собственные адреса и хосты
    // уже принятой аналитики.
    const allowed = new Set(['mc.yandex.ru', 'top-fwz1.mail.ru']);
    const offenders = elements(home)
      .filter((el) => el.tagName === 'script')
      .map((el) => attr(el, 'src'))
      .filter((src): src is string => src !== null)
      .map((src) => ({ src, parsed: hostAndPath(src) }))
      .filter((x) => x.parsed !== null && !allowed.has(x.parsed.host))
      .map((x) => x.src);
    expect(offenders, `сторонний скрипт на главной: ${offenders.join(', ')}`).toEqual([]);
  });

  it('виджет запрошен в форме с комментариями', () => {
    const hits = reviewsEmbedHits(home);
    expect(hits.length, 'встраивания виджета отзывов на главной нет').toBeGreaterThan(0);
    const withComments = hits.filter(({ value }) => /(^|[?&])comments(=|&|$)/.test(value));
    expect(
      withComments.length,
      `адрес встраивания не запрашивает форму с комментариями: ${hits.map((h) => h.value).join(', ')}`,
    ).toBeGreaterThan(0);
  });

  it('адрес встраивания адресует организацию идентификатором', () => {
    const hits = reviewsEmbedHits(home);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits)
      expect(hit.value, `адрес '${hit.value}' не содержит идентификатора организации`).toContain(
        REVIEWS_ORG_ID,
      );
  });

  it('ссылок на фотографии авторов отзывов в выводе нет', () => {
    // Непустота: без секции переносить нечего, и утверждение тривиально верно.
    reviewsSection();
    // Механическая часть требования «тексты и авторы отзывов к нам не перенесены».
    // Хост аватаров измерен в proposal.md; его появление в НАШЕЙ разметке означает,
    // что чужие фотографии скопированы к нам.
    const offenders = [...pages.entries()]
      .filter(([, html]) => html.includes(REVIEWS_AVATAR_HOST))
      .map(([path]) => path);
    expect(offenders.slice(0, 10), `ссылки на аватары авторов: ${offenders.length} страниц`).toEqual([]);
  });

  it('в секции отзывов нет ни одной картинки помимо знаков наград', () => {
    // Вторая механическая часть того же требования: фотография автора — это <img>
    // внутри секции. Знаки наград — наши, они объявлены своим атрибутом и исключены
    // поимённо, а не по признаку «маленькая картинка».
    const section = reviewsSection();
    const images = subtree(section)
      .filter((el) => el.tagName === 'img')
      .filter((el) => subtreeHasBadgeAncestor(section, el) === false);
    expect(
      images.map((el) => attr(el, 'src') ?? '(без src)'),
      'в секции отзывов есть картинка вне знака награды — чужая фотография?',
    ).toEqual([]);
  });
});

/** Лежит ли элемент внутри знака награды. */
function subtreeHasBadgeAncestor(
  section: ReturnType<typeof byDataName>[number],
  target: ReturnType<typeof byDataName>[number],
): boolean {
  for (const badge of subtree(section).filter((el) => attr(el, SEL_AWARD_BADGE) !== null))
    if (subtree(badge).includes(target)) return true;
  return false;
}

describe('рейтинг и число отзывов существуют только внутри виджета', () => {
  it('своей сводки чисел на главной нет', () => {
    reviewsSection();
    const hits = ratingSummaryHits(home);
    expect(
      hits,
      'на главной есть число в связке со словом «отзыв», «оцен» или «рейтинг» — ' +
        'два источника одних чисел расходятся молча',
    ).toEqual([]);
  });

  it('признак ловит сводку с числами, ОТЛИЧНЫМИ от сегодняшних', () => {
    // Храповик: проверка, знающая сегодняшние 4,9 / 33 / 66, зелена в день, когда
    // кто-то вставит сводку с другими числами. Признак обязан ловить любую.
    for (const markup of [
      '<p>Рейтинг <b>3,1</b> на Яндекс.Картах</p>',
      '<p>7 отзывов</p>',
      '<div><span>5,0</span> <span>оценок: 12</span></div>',
    ])
      expect(ratingSummaryHits(markup), `признак не увидел сводку: ${markup}`).not.toEqual([]);
  });

  it('признак не задевает телефоны, цены и даты', () => {
    // Обратная сторона того же: «десятичная дробь» задела бы всё это, а признак
    // назван спекой именно как связка со словом.
    for (const markup of [
      '<p>+7 (812) 000-00-00</p>',
      '<p>Стоимость 24 000 ₽</p>',
      '<p>12 сентября 2026</p>',
      '<h2>Отзывы</h2>',
    ])
      expect(ratingSummaryHits(markup), `ложное срабатывание: ${markup}`).toEqual([]);
  });
});

describe('без скриптов секция даёт ссылку, а не встраивание', () => {
  it('в статической разметке секции нет iframe, а в noscript есть ссылка на отзывы организации', () => {
    const section = reviewsSection();
    const iframes = subtree(section).filter((el) => el.tagName === 'iframe');
    expect(
      iframes.length,
      'в статической разметке секции есть iframe — ленивого встраивания нет, ' +
        'и чужой счётчик грузится у каждого посетителя',
    ).toBe(0);

    const noscripts = subtree(section).filter((el) => el.tagName === 'noscript');
    expect(noscripts.length, 'в секции отзывов нет ветки <noscript>').toBeGreaterThan(0);
    const inNoscript = noscripts.flatMap((el) => subtree(el));
    expect(
      inNoscript.filter((el) => el.tagName === 'iframe'),
      'в <noscript> лежит iframe: у карты так сделано осознанно, для отзывов это ' +
        'загрузило бы чужой счётчик безусловно и без ленивого порога',
    ).toEqual([]);
    const links = inNoscript
      .filter((el) => el.tagName === 'a')
      .map((el) => attr(el, 'href') ?? '')
      .filter((href) => {
        const parsed = hostAndPath(href);
        return parsed !== null && parsed.host.endsWith(REVIEWS_WIDGET_HOST);
      });
    expect(links, 'в <noscript> нет ссылки на отзывы организации на Яндекс.Картах').not.toEqual([]);
  });
});

// ─── Чат: 404, стили, конфигурация ───────────────────────────────────────────

describe('чат-виджет присутствует на страницах сайта, кроме 404', () => {
  it('встраивание чата есть в боевом выводе', () => {
    const loader = declaredChatLoader();
    const carrying = [...pages.entries()].filter(([, html]) => chatLoaderHits(html, loader).length > 0);
    expect(
      carrying.length,
      'ни одна страница боевого вывода не несёт встраивания чата',
    ).toBeGreaterThan(50);
  });

  it('кнопка вызова и точка монтирования объявлены нашими именами', () => {
    expect(byDataName(home, SEL_CHAT_FACADE).length, 'на главной нет фасада чата').toBe(1);
    expect(byDataName(home, SEL_CHAT_TRIGGER).length, 'на главной нет нашей кнопки вызова').toBe(1);
    expect(byDataName(home, SEL_CHAT_MOUNT).length, 'на главной нет объявленной точки монтирования').toBe(1);
  });

  it('страница 404 не несёт разметки чата', () => {
    // Непустота: фасад есть на главной (тест выше). Иначе «на 404 его нет» верно и
    // когда его нет вовсе.
    expect(byDataName(home, SEL_CHAT_FACADE).length, 'фасада нет и на главной — предмета нет').toBe(1);
    const html = pages.get(`/${PAGE_404}`);
    expect(html, 'в выводе нет страницы 404 — проверять нечего').toBeTruthy();
    for (const name of [SEL_CHAT_FACADE, SEL_CHAT_TRIGGER, SEL_CHAT_MOUNT, SEL_CHAT_HOURS])
      expect(
        byDataName(html!, name).map((el) => el.tagName),
        `на 404 есть '${name}': её байтовый запас меньше килобайта, и перерасход ` +
          'останавливает публикацию боевого сайта',
      ).toEqual([]);
  });

  it('стили фасада приходят внешней ссылкой, а не компонентным <style> на 404', () => {
    // Исключения из рендера НЕдостаточно: стили компонента попадают в инлайновый CSS
    // страницы независимо от условного рендера — так прямо сказано в
    // `web/tests/seo-package.test.ts:256`, `стили эмитятся независимо от условного рендера`.
    const html = pages.get(`/${PAGE_404}`);
    expect(html, 'в выводе нет страницы 404').toBeTruthy();
    const inlineStyles = elements(html!)
      .filter((el) => el.tagName === 'style')
      .map((el) => textOf(el))
      .join('\n');
    expect(
      /chat-facade/.test(inlineStyles),
      'стили фасада чата инлайнятся в страницу 404, где компонента нет: значит они ' +
        'лежат в компонентном <style>, а обязаны — в общем внешнем стиле',
    ).toBe(false);

    const external = elements(html!)
      .filter((el) => el.tagName === 'link' && (attr(el, 'rel') ?? '') === 'stylesheet')
      .map((el) => attr(el, 'href') ?? '')
      .filter((href) => href.startsWith('/'));
    expect(external.length, 'на 404 нет ни одной внешней ссылки на стиль').toBeGreaterThan(0);
    const combined = external
      .map((href) => join(dist, href.replace(/^\//, '')))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, 'utf-8'))
      .join('\n');
    expect(
      /chat-facade/.test(combined),
      'стилей фасада чата нет и во внешнем стиле — значит их нет нигде, и предыдущее ' +
        'утверждение было тривиально верным',
    ).toBe(true);
  });

  it('наши элементы не несут инлайновых обработчиков событий', () => {
    // Класс `event-handler` сверки исполняемого вывода. Предмет — НАШИ элементы:
    // фасад чата, секция отзывов и всё внутри них.
    const ours = [
      ...byDataName(home, SEL_REVIEWS_SECTION).flatMap((el) => subtree(el)),
      ...byDataName(home, SEL_CHAT_FACADE).flatMap((el) => subtree(el)),
    ];
    expect(ours.length, 'ни секции отзывов, ни фасада чата на главной нет — предмета нет').toBeGreaterThan(0);
    const offenders = ours.flatMap((el) =>
      el.attrs.filter((a) => /^on[a-z]+$/i.test(a.name)).map((a) => `${el.tagName}[${a.name}]`),
    );
    expect(offenders, `инлайновые обработчики в наших элементах: ${offenders.join(', ')}`).toEqual([]);
  });

  it('адрес загрузчика записан СО СХЕМОЙ', () => {
    // Наше правило, а не следствие чужого гейта: класс `protocol-relative` сверки
    // исполняемого вывода срабатывает только для закрытого перечня атрибутов адреса
    // (`web/tests/helpers/rich-content-safety/hazard-scan.ts:125`, `if (URL_ATTRS.has(name)`),
    // и `data-*` в него не входит.
    const loader = declaredChatLoader();
    expect(
      /^https?:\/\//.test(loader),
      `адрес загрузчика '${loader}' записан без схемы: эту форму в атрибуте данных ` +
        'сверка исполняемого вывода не покрывает вовсе',
    ).toBe(true);
  });
});

describe('данные посетителя в чате собирает виджет, а не мы', () => {
  it('своей формы сбора данных для чата нет', () => {
    const facades = byDataName(home, SEL_CHAT_FACADE);
    expect(facades.length, 'фасада чата на главной нет — предмета нет').toBe(1);
    const inside = subtree(facades[0]);
    const collectors = inside
      .filter((el) => ['form', 'input', 'textarea', 'select'].includes(el.tagName))
      // Кнопка вызова — не сбор данных; `<input type=hidden>` тоже собирает, поэтому
      // тип не разбирается вовсе: любой ввод внутри фасада — это своя форма.
      .map((el) => el.tagName);
    expect(
      collectors,
      `внутри фасада чата есть свои поля ввода (${collectors.join(', ')}): согласие и сбор ` +
        'данных обязан брать виджет, а не мы',
    ).toEqual([]);
  });

  it('ссылка на документ о персональных данных достижима со страницы с чатом', () => {
    const loader = declaredChatLoader();
    const withChat = [...pages.entries()].filter(([, html]) => chatLoaderHits(html, loader).length > 0);
    expect(withChat.length, 'страниц с чатом нет — предмета нет').toBeGreaterThan(0);
    const without = withChat
      .filter(([, html]) =>
        elements(html)
          .filter((el) => el.tagName === 'a')
          .every((el) => !(attr(el, 'href') ?? '').includes('/terms/')),
      )
      .map(([path]) => path);
    expect(without.slice(0, 10), `страницы с чатом без ссылки на документ: ${without.length}`).toEqual([]);
  });
});

// ─── Структура заголовков ────────────────────────────────────────────────────

/**
 * Иерархия заголовков: ровно один H1, первый заголовок — H1, уровни без пропусков.
 *
 * Правило то же, что у `web/tests/seo-package.test.ts:203`, `exactly one H1`, и это
 * НАЗВАННОЕ совпадение, а не второй, независимый гейт: AGENTS.md требует, чтобы две
 * проверки над одним предметом сходились либо расхождение было названо. Здесь предмет
 * шире (страницы с новыми блоками) и добавлены фикстуры — сам критерий тот же.
 */
function headingProblems(html: string): string[] {
  const levels = elements(html)
    .filter((el) => /^h[1-6]$/.test(el.tagName))
    .map((el) => Number(el.tagName.slice(1)));
  const problems: string[] = [];
  const h1 = levels.filter((l) => l === 1).length;
  if (h1 !== 1) problems.push(`заголовков первого уровня ${h1}, а не один`);
  if (levels.length > 0 && levels[0] !== 1) problems.push(`первый заголовок — h${levels[0]}, а не h1`);
  let prev = 0;
  for (const level of levels) {
    if (level > prev && level - prev > 1) problems.push(`пропуск уровня перед h${level}`);
    prev = level;
  }
  return problems;
}

describe('заголовки новых блоков не ломают структуру страницы', () => {
  it('признак ловит пропуск уровня', () => {
    expect(
      headingProblems('<h1>a</h1><h2>b</h2><h4>отзывы</h4>'),
      'пропуск уровня признаком не увиден',
    ).not.toEqual([]);
  });

  it('признак ловит заголовок раньше первого уровня', () => {
    expect(
      headingProblems('<h2>отзывы</h2><h1>a</h1>'),
      'заголовок раньше h1 признаком не увиден',
    ).not.toEqual([]);
  });

  it('признак не краснит на исправной иерархии', () => {
    expect(headingProblems('<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>')).toEqual([]);
  });

  it('страницы с новыми блоками структуру не ломают', () => {
    reviewsSection();
    const loader = declaredChatLoader();
    const subject = [...pages.entries()].filter(
      ([path, html]) => path === '/index.html' || chatLoaderHits(html, loader).length > 0,
    );
    expect(subject.length, 'страниц с новыми блоками нет — предмета нет').toBeGreaterThan(0);
    const offenders = subject
      .map(([path, html]) => ({ path, problems: headingProblems(html) }))
      .filter((x) => x.problems.length > 0)
      .map((x) => `${x.path}: ${x.problems.join('; ')}`);
    expect(offenders.slice(0, 10), offenders.join('\n')).toEqual([]);
  });
});

// ─── Бюджеты: то, что можно проверить по конфигурации, а не измерением ───────

describe('бюджеты производительности обязательны на всех четырёх шаблонах', () => {
  // Само ИЗМЕРЕНИЕ идёт обязательным контекстом `Lighthouse budgets` и здесь не
  // повторяется — повторить его в vitest нечем. Проверяемое по репозиторию: состав
  // шаблонов и то, что пороги не ослаблены. Сценарий «Бюджеты выдержаны на всех
  // шаблонах» закрывается этой парой: конфигурация + чужой обязательный гейт.
  it('в конфигурации ровно четыре шаблона и пороги не ослаблены', () => {
    const file = join(dirname(dist), 'lighthouserc.cjs');
    expect(existsSync(file), `нет ${file}`).toBe(true);
    const rc = readFileSync(file, 'utf-8');
    const urls = [...rc.matchAll(/'http:\/\/localhost[^']*'/g)].map((m) => m[0]);
    expect(urls.length, 'шаблонов в конфигурации бюджетов не четыре').toBe(4);
    expect(rc).toContain("'total-blocking-time': ['error', { maxNumericValue: 200");
    expect(rc).toContain("'cumulative-layout-shift': ['error', { maxNumericValue: 0.1");
    expect(rc).toContain("'categories:accessibility': ['error', { minScore: 0.9");
  });
});
