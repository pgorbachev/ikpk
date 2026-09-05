import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { dist, walkHtml } from './helpers/dist-pages';
import { attr, textOf } from './helpers/dom';
import {
  CHAT_STATE_NAMES,
  MANAGER_HOURS_ATTR,
  MANAGER_HOURS_VALUE,
  PAGES_WITH_MANAGER_HOURS,
  REVIEWS_AVATAR_HOST,
  REVIEWS_ORG_ID,
  REVIEWS_WIDGET_HOST,
  SEL_AWARD_BADGE,
  SEL_CHAT_FACADE,
  SEL_CHAT_MOUNT,
  SEL_CHAT_TRIGGER,
  SEL_REVIEWS_SECTION,
  byDataName,
  chatLoaderSuspects,
  elements,
  hostAndPath,
  hoursStripText,
  ratingSummaryHits,
  reviewsEmbedHits,
  subtree,
  telLinks,
  type ChatLoaderConfig,
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
 * ── ЧТО ЗДЕСЬ ЕСТЬ, А ЧТО В ФАЙЛЕ ПРОБНЫХ СБОРОК ────────────────────────────
 * У боевой сборки ОДНО состояние конфигурации — то, которое объявлено в дереве. Значит
 * утверждения об облике страницы в состоянии 1 и в состоянии 2 не могут иметь предмет
 * в одном и том же прогоне: спека объявляет публикуемыми оба, и требовать любого из них
 * от единственной сборки значило бы вернуть шаблон «законное состояние и зелёный гейт
 * недостижимы одновременно».
 *
 * Поэтому здесь остаётся то, что от состояния НЕ зависит (секция отзывов, сводка чисел,
 * иерархия заголовков, телефоны в подвале), плюс СИММЕТРИЧНАЯ проверка: сошлось ли
 * объявление с выводом — она осмысленна в любом состоянии. Облик страницы в каждом из
 * трёх состояний проверяется по пробным сборкам —
 * `tests/external-widgets-config-probe.test.ts`.
 *
 * ── СТОРОЖ НЕПУСТОТЫ ────────────────────────────────────────────────────────
 * Большинство утверждений ниже — про ОТСУТСТВИЕ (сводки чисел, фотографий авторов,
 * разметки чата на 404). Все они тривиально верны на пустом предмете, поэтому каждое из
 * них стоит ПОСЛЕ доказательства непустоты: страницы читаются, секция существует.
 * Спека делает это отдельным требованием, а не пожеланием.
 */

const PAGE_404 = '404.html';
const CONFIG_MODULE = '../src/lib/external-widgets';

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

// ─── Симметричная проверка: объявление против вывода ─────────────────────────

/**
 * Вердикт симметричной проверки боевого вывода.
 *
 * Функция ЧИСТАЯ и проверяется фикстурами, а не только реальностью. Причина ровно та же,
 * по которой спека развела исходы поимённо: у боевой сборки одно состояние, значит на
 * настоящем выводе исполняется одна ветвь из трёх, а остальные две остались бы без
 * построимого красного состояния. На фикстурах красное состояние есть у каждой.
 *
 * Три исхода, и они РАЗЛИЧНЫ: пройдена, не пройдена по расхождению, не пройдена по
 * причине «измерить не удалось». Склейка последних двух — та же ошибка, что склейка
 * второго состояния конфигурации с третьим: «нечего сверять» не равно «сошлось» и не
 * равно «разошлось».
 */
export type SymmetricVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'mismatch'; readonly reason: string }
  | { readonly ok: false; readonly kind: 'unmeasurable'; readonly reason: string };

export function symmetricVerdict(
  config: ChatLoaderConfig,
  carrying: readonly string[],
): SymmetricVerdict {
  if (config.state === 'unspecified')
    return {
      ok: false,
      kind: 'unmeasurable',
      reason:
        'конфигурация не несёт ни адреса загрузчика, ни явного объявления его отсутствия: ' +
        'измерить не удалось. Отсутствие предмета — непройденная проверка, а не разрешение ' +
        'её пропустить',
    };
  if (config.state === 'address')
    return carrying.length > 0
      ? { ok: true }
      : {
          ok: false,
          kind: 'mismatch',
          reason:
            `конфигурация несёт адрес загрузчика '${config.src}', а вывод встраивания чата не ` +
            'несёт ни на одной странице: боевая выкладка уехала бы без чата',
        };
  return carrying.length === 0
    ? { ok: true }
    : {
        ok: false,
        kind: 'mismatch',
        reason:
          'конфигурация объявила отсутствие адреса, а вывод встраивание чата несёт на ' +
          `${carrying.length} страницах: ${carrying.slice(0, 5).join(', ')}`,
      };
}

/** Объявленная конфигурация. Нет модуля — «проверить не удалось», а не «прошло». */
async function declaredConfig(): Promise<ChatLoaderConfig> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(CONFIG_MODULE)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `модуля конфигурации нет либо он не загружается: ${(error as Error).message}. ` +
        'Спека требует объявить конфигурацию там, где её читает проверка: значение, ' +
        'живущее только в окружении выкладки, оставляет симметричную проверку без предмета',
      { cause: error },
    );
  }
  const read = mod.chatLoaderConfig as undefined | (() => ChatLoaderConfig);
  if (typeof read !== 'function')
    throw new Error('модуль не экспортирует chatLoaderConfig() — конфигурацию читать нечем');
  return read();
}

/**
 * Страницы, несущие адрес загрузчика чата.
 *
 * Признак — по НАЗНАЧЕНИЮ носителя, а не по домену. Иначе симметричная проверка считала бы
 * чат присутствующим из-за 393 законных ссылок форм заявки на портале заказчика — измерено
 * на боевом выводе, и все 393 суть `a[href]`. Это ровно та ошибка, которой посвящено
 * отдельное требование этой спеки: различать ссылку формы и загрузчик по назначению.
 */
function pagesCarryingChat(): string[] {
  return [...pages.entries()].filter(([, html]) => chatLoaderSuspects(html).length > 0).map(([p]) => p);
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
    // ПУТЕЙ ОТКАЗА ДВА, И ПРОВЕРЯЮТСЯ ОБА. Это не педантизм: негативная мутация,
    // убравшая только отказ «каталога нет», прогон НЕ покраснила — второй путь («ноль
    // страниц») подхватил пустой каталог, и мутация прошла, НЕ УБРАВ ПРЕДМЕТ. Различать
    // «гейт декоративен» и «мутация не удалась» обязательно, а покрывает оба пути только
    // проверка каждого входа поимённо. После этой правки краснеют оба пути — измерено.
    const missing = join(tmpdir(), 'ikpk-widgets-no-such-dir-нет');
    expect(existsSync(missing), 'каталог-проба неожиданно существует').toBe(false);
    expect(() => outputPages(missing), 'на ОТСУТСТВУЮЩЕМ каталоге сторож не упал').toThrow(
      /предмета проверки нет/,
    );

    const asFile = join(mkdtempSync(join(tmpdir(), 'ikpk-widgets-file-')), 'not-a-dir');
    writeFileSync(asFile, 'x');
    expect(() => outputPages(asFile), 'на пути-ФАЙЛЕ сторож не упал').toThrow(/предмета проверки нет/);

    const empty = mkdtempSync(join(tmpdir(), 'ikpk-widgets-empty-'));
    expect(() => outputPages(empty), 'на ПУСТОМ каталоге сторож не упал').toThrow(
      /предмета проверки нет/,
    );

    const filled = mkdtempSync(join(tmpdir(), 'ikpk-widgets-filled-'));
    mkdirSync(join(filled, 'x'), { recursive: true });
    writeFileSync(join(filled, 'x', 'index.html'), '<!doctype html><html lang="ru"></html>');
    expect(outputPages(filled).size, 'на непустом каталоге сторож тоже падает — он падает всегда').toBe(1);
  });
});

describe('отзывы показываются секцией главной и только там', () => {
  it('секция отзывов стоит после блока преподавателей', () => {
    // Не переиспользовать section из reviewsSection(): она разбирает `home` СВОИМ
    // вызовом parseDocument, а indexOf ниже сравнивает объекты по ссылке — с узлом из
    // не того дерева indexOf всегда даёт -1, и тест краснеет независимо от порядка
    // секций. Проверка непустоты (ровно один элемент) остаётся за reviewsSection().
    reviewsSection();
    const all = elements(home);
    const section = all.find((el) => attr(el, SEL_REVIEWS_SECTION) !== null);
    const teachers = all.find((el) => (attr(el, 'class') ?? '').split(/\s+/).includes('teachers'));
    expect(
      section,
      'секция отзывов не найдена внутри общего обхода документа',
    ).toBeTruthy();
    expect(
      teachers,
      'на главной не найден блок преподавателей — относительно чего проверять порядок',
    ).toBeTruthy();
    expect(
      all.indexOf(section!) > all.indexOf(teachers!),
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

  it('встраивание отзывов есть в боевом выводе', () => {
    // Симметричная проверка к «на демо встраиваний нет»: без неё то утверждение
    // выполняется и в случае, когда встраиваний нет НИГДЕ, то есть гейт зелен на
    // сломанном продукте.
    expect(
      reviewsEmbedHits(home).length,
      'на главной боевого вывода встраивания виджета отзывов нет',
    ).toBeGreaterThan(0);
  });
});

describe('знаки наград соответствуют утверждённому мокапу', () => {
  it('каждый показанный знак несёт сервисную иконку, название и отдельную подпись источника', () => {
    const section = reviewsSection();
    const badges = subtree(section).filter((el) => attr(el, SEL_AWARD_BADGE) !== null);
    expect(
      badges.length,
      'на главной нет показанного знака — проверка его структуры была бы вакуумна',
    ).toBeGreaterThan(0);

    for (const badge of badges) {
      const inside = subtree(badge);
      const icons = inside.filter((el) => attr(el, 'data-award-icon') !== null);
      const titles = inside.filter((el) => attr(el, 'data-award-title') !== null);
      const sources = inside.filter((el) => attr(el, 'data-award-source') !== null);
      expect(icons, 'у знака нет ровно одной сервисной иконки').toHaveLength(1);
      expect(titles, 'название знака не выделено в отдельный элемент').toHaveLength(1);
      expect(sources, 'источник знака не выделен в отдельный элемент').toHaveLength(1);
      expect(textOf(titles[0]), 'название знака пусто').not.toBe('');
      expect(textOf(sources[0]), 'подпись источника пустая').not.toBe('');
    }
  });
});

describe('отзывы выводит официальный виджет, а не мы и не посредник', () => {
  it('единственный внешний адрес, с которого секция ЗАГРУЖАЕТ, — официальный виджет', () => {
    // Предмет — ЗАГРУЗКА, а не «любой внешний адрес», и оговорка нормативна: секция
    // несёт ещё и ссылку на отзывы организации, а в ветке без скриптов и в демо-выводе
    // она вообще единственное, что там есть. Прежняя редакция этой проверки запрещала
    // любой внешний адрес в секции и тем краснела бы на законной ссылке — и на ссылке
    // источника знака награды.
    const section = reviewsSection();
    const LOADING_ATTRS = new Set(['src', 'srcset', 'data-src', 'data-reviews-embed', 'poster']);
    const loading = subtree(section)
      .flatMap((el) =>
        el.attrs
          .filter((a) => LOADING_ATTRS.has(a.name) || /(^|-)src(set)?$/.test(a.name))
          .map((a) => ({ tag: el.tagName, name: a.name, value: a.value })),
      )
      .map((a) => ({ ...a, parsed: hostAndPath(a.value) }))
      .filter((a) => a.parsed !== null);
    expect(
      loading.length,
      'секция ничего не загружает ни с одного внешнего адреса — предмета нет: ленивое ' +
        'встраивание обязано нести адрес виджета в атрибуте данных',
    ).toBeGreaterThan(0);
    const foreign = loading.filter(
      (a) => a.parsed!.host !== REVIEWS_WIDGET_HOST && !a.parsed!.host.endsWith(`.${REVIEWS_WIDGET_HOST}`),
    );
    expect(
      foreign.map((a) => `${a.tag}[${a.name}] → ${a.value}`),
      'секция загружает что-то не с официального виджета Яндекс.Карт',
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
    // Механическая часть требования о фотографиях. Хост аватаров измерен в
    // proposal.md; его появление в НАШЕЙ разметке означает, что чужие фотографии
    // скопированы к нам.
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

// ─── Симметричная проверка боевого вывода ────────────────────────────────────

describe('симметричная проверка боевого вывода различает три состояния конфигурации', () => {
  const ADDR: ChatLoaderConfig = { state: 'address', src: 'https://cdn.example.invalid/loader.js' };
  const NONE: ChatLoaderConfig = { state: 'declared-absent' };
  const NOTHING: ChatLoaderConfig = { state: 'unspecified' };

  it('адрес задан и вывод несёт — пройдена', () => {
    expect(symmetricVerdict(ADDR, ['/index.html']).ok).toBe(true);
  });

  it('адрес задан, а вывод не несёт — непройдена, несоответствие названо', () => {
    const verdict = symmetricVerdict(ADDR, []);
    expect(verdict.ok, 'вывод без чата при заданном адресе прошёл молча').toBe(false);
    expect(verdict.ok === false && verdict.kind).toBe('mismatch');
  });

  it('отсутствие объявлено явно и вывод не несёт — ПРОЙДЕНА', () => {
    // Исход назван спекой отдельно: без него реализация, останавливающая проверку в
    // этом состоянии, удовлетворяла бы всем отрицательным сценариям и не краснила ни
    // одного, а состояние объявлено публикуемым.
    expect(
      symmetricVerdict(NONE, []).ok,
      'объявленное отсутствие с согласным выводом объявлено непройденным: законное ' +
        'публикуемое состояние и зелёный гейт снова недостижимы одновременно',
    ).toBe(true);
  });

  it('объявление отсутствия разошлось с выводом — непройдена, расхождение названо', () => {
    const verdict = symmetricVerdict(NONE, ['/index.html', '/statyi/index.html']);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.kind).toBe('mismatch');
    expect(verdict.ok === false && verdict.reason).toMatch(/объявила отсутствие/);
  });

  it('не объявлено ничего — непройдена с причиной «измерить не удалось», а не «сошлось»', () => {
    // Третий исход РАЗЛИЧЁН со вторым: «нечего сверять» не равно «разошлось». Пустое
    // значение и отсутствие ключа — одно и то же состояние, и оба дают этот исход.
    for (const carrying of [[], ['/index.html']]) {
      const verdict = symmetricVerdict(NOTHING, carrying);
      expect(verdict.ok, 'необъявленная конфигурация прошла').toBe(false);
      expect(verdict.ok === false && verdict.kind).toBe('unmeasurable');
    }
  });

  it('объявленная конфигурация боевой сборки согласна с её выводом', async () => {
    // А это уже РЕАЛЬНОСТЬ, а не фикстура: тот же вердикт применяется к настоящему
    // объявлению и настоящему выводу. Фикстуры выше дают красное состояние каждой
    // ветви, этот тест — предмету.
    const config = await declaredConfig();
    const carrying = pagesCarryingChat();
    const verdict = symmetricVerdict(config, carrying);
    expect(
      verdict.ok,
      `состояние конфигурации: ${CHAT_STATE_NAMES[config.state]}; страниц с встраиванием ` +
        `${carrying.length}. ${verdict.ok === false ? verdict.reason : ''}`,
    ).toBe(true);
  });
});

// ─── Чат: то, что верно в любом состоянии конфигурации ───────────────────────

describe('чат: страница 404 и утечка стилей', () => {
  it('страница 404 не несёт разметки чата', () => {
    // Оговорка спеки: 404 исключена из возможности целиком по байтовому пределу, и её
    // запас меньше килобайта. Непустота предмета здесь доказывается НЕ фасадом на
    // главной — в состоянии 2 фасада нет вообще нигде, и требование к 404 от этого не
    // исчезает: доказывается тем, что страница 404 в выводе есть и она настоящая.
    const html = pages.get(`/${PAGE_404}`);
    expect(html, 'в выводе нет страницы 404 — проверять нечего').toBeTruthy();
    expect(
      /<html[^>]*lang="ru"/.test(html!),
      'страница 404 не похожа на собранную страницу — утверждение об отсутствии на ней ' +
        'разметки чата было бы тривиально верным',
    ).toBe(true);
    for (const name of [SEL_CHAT_FACADE, SEL_CHAT_TRIGGER, SEL_CHAT_MOUNT])
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
});

describe('вне часов работы: часы из панели виджета, телефон из подвала', () => {
  it('подвал несёт телефоны на КАЖДОЙ странице боевого вывода', () => {
    // Это наша часть и единственная гарантия, остающаяся при неответившем загрузчике.
    const footers = [...pages.entries()].map(([path, html]) => {
      const found = elements(html).filter((el) => el.tagName === 'footer');
      return { path, tel: found.flatMap((el) => telLinks(el)) };
    });
    expect(footers.length, 'страниц нет — предмета нет').toBeGreaterThan(50);
    const without = footers.filter((f) => f.tel.length === 0).map((f) => f.path);
    expect(
      without.slice(0, 10),
      `страниц без телефона в подвале: ${without.length}. Подвал не часть фасада чата и ` +
        'от конфигурации не зависит вовсе',
    ).toEqual([]);
  });

  it('блоков часов работы менеджера столько же, сколько было, и на тех же двух страницах', () => {
    // Своего постоянно видимого блока часов эта возможность НЕ добавляет: часы живут
    // сообщением внутри раскрытой панели стороннего виджета.
    //
    // Признак — ЧУЖОЙ и уже принятый: `data-hours="manager"`. Число блоков стережёт
    // существующая проверка обязательного прогона (`web/tests/site-copy.test.ts:272`),
    // и своей проверки того же предмета эта возможность не заводит — так требует спека.
    // Здесь проверяется то, чего та проверка НЕ утверждает: на КАКИХ страницах блоки
    // стоят. Совпадение признака названо намеренно: две проверки над одним предметом
    // обязаны сходиться, и они сходятся, потому что признак один.
    const carrying = [...pages.entries()]
      .filter(([, html]) =>
        elements(html).some((el) => attr(el, MANAGER_HOURS_ATTR) === MANAGER_HOURS_VALUE),
      )
      .map(([path]) => path.replace(/index\.html$/, ''));
    expect(
      [...carrying].sort(),
      `блоки часов менеджера стоят на страницах ${carrying.join(', ')}, а законны только на ` +
        PAGES_WITH_MANAGER_HOURS.join(' и '),
    ).toEqual([...PAGES_WITH_MANAGER_HOURS].sort());
  });

  it('фасад чата не несёт своей полосы часов работы', () => {
    // Запрет без проверки — не запрет: три редакции спеки предписывали наш блок часов
    // на каждой странице, и реализация, идущая по памяти или по осиротевшим задачам,
    // поставит его снова.
    //
    // Предмет — ТОЛЬКО поддерево фасада, а не страница: страницы семинаров называют
    // время занятий теми же числами, и признак по всей странице краснел бы от исправного
    // содержимого. В состоянии 2 фасада нет вовсе — тогда предмета нет, и об этом
    // сказано вслух, а не выдано за «нарушений нет».
    const facades = [...pages.entries()].flatMap(([path, html]) =>
      byDataName(html, SEL_CHAT_FACADE).map((el) => ({ path, el })),
    );
    if (facades.length === 0) {
      // Состояние 2: фасада нет по требованию, полосы часов внутри него тоже нет
      // тривиально. Утверждение переносится на пробную сборку состояния 1 —
      // `tests/external-widgets-config-probe.test.ts`.
      expect(
        [...pages.values()].some((html) => byDataName(html, SEL_CHAT_TRIGGER).length > 0),
        'фасада чата нет ни на одной странице — если это состояние 2, так и должно быть; ' +
          'полоса часов внутри фасада проверяется на пробной сборке состояния 1',
      ).toBe(false);
      return;
    }
    const offenders = facades
      .map(({ path, el }) => ({ path, text: hoursStripText(el) }))
      .filter((x) => x.text !== null)
      .map((x) => `${x.path}: «${x.text}»`);
    expect(
      offenders.slice(0, 5),
      `внутри фасада чата стоит полоса часов работы: ${offenders.length} страниц. Спека ` +
        'такой блок запрещает — он не нарисован ни в одном утверждённом варианте',
    ).toEqual([]);
  });
});

describe('наши элементы не несут инлайновых обработчиков событий', () => {
  it('ни в секции отзывов, ни в фасаде чата инлайновых обработчиков нет', () => {
    // Класс `event-handler` сверки исполняемого вывода
    // (`web/tests/helpers/rich-content-safety/hazard-scan.ts:473`, `if (h.reason === 'event-handler'`).
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
});

// ─── Структура заголовков ────────────────────────────────────────────────────

/**
 * Иерархия заголовков: ровно один H1, первый заголовок — H1, уровни без пропусков.
 *
 * Правило то же, что у `web/tests/seo-package.test.ts:203`, `exactly one H1`, и это
 * НАЗВАННОЕ совпадение, а не второй, независимый гейт: AGENTS.md требует, чтобы две
 * проверки над одним предметом сходились либо расхождение было названо. Здесь предмет
 * шире (страницы с новыми блоками) и добавлены фикстуры — сам критерий тот же.
 *
 * Граница названа: чужой инвариант идёт по ЧЕТЫРЁМ адресам
 * (`web/tests/seo-package.test.ts:195`, `for (const p of [`), а не по всем 287, и
 * распространение его на остальные страницы — отдельная работа. Здесь предмет шире, но
 * это не отменяет того, что критерий объективен именно на тех четырёх.
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

  it('страницы с новыми блоками структуру не ломают — на четырёх адресах инварианта', () => {
    // ОХВАТ НАЗВАН ТОЧНО, И ЭТО ИЗМЕРЕНИЕ, А НЕ ОСТОРОЖНОСТЬ.
    //
    // Чужой инвариант идёт по ЧЕТЫРЁМ адресам (`web/tests/seo-package.test.ts:195`,
    // `for (const p of [`), а не по всем 287, и спека это признаёт прямо: «распространение
    // инварианта на остальные страницы — отдельная работа».
    //
    // Первая редакция этой проверки брала ВСЕ страницы с новыми блоками — то есть все 287
    // после реализации. Измерено на боевом выводе (`npm run build`, 24.08.2026): иерархию
    // заголовков нарушают **163 страницы из 270** — пропуск уровня перед `h3`. Проверка с
    // таким охватом была бы красной на дефектах, к этой возможности не относящихся вовсе:
    // ложный отказ, зеркало ложного зелёного, и «лечили» бы его правкой чужих страниц.
    //
    // Список адресов ЧИТАЕТСЯ из чужой проверки, а не копируется: две копии разошлись бы
    // молча, и тогда «тот же охват» перестало бы быть одним фактом.
    const invariant = readFileSync(join(dirname(dist), 'tests', 'seo-package.test.ts'), 'utf-8');
    const block = /H1→H2→H3 hierarchy[\s\S]*?for \(const p of \[([\s\S]*?)\]\)/.exec(invariant);
    expect(block, 'в seo-package.test.ts не нашёлся перечень адресов инварианта заголовков').not.toBeNull();
    const addresses = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(addresses.length, `адресов в инварианте ${addresses.length}, а не четыре`).toBe(4);

    reviewsSection();
    const subject = addresses.map((address) => {
      const key = `${address.replace(/\/$/, '')}/index.html`.replace('//', '/');
      return { address, html: pages.get(key) };
    });
    const absent = subject.filter((x) => x.html === undefined).map((x) => x.address);
    expect(absent, `адресов инварианта нет в выводе: ${absent.join(', ')} — предмета нет`).toEqual([]);

    const offenders = subject
      .map((x) => ({ address: x.address, problems: headingProblems(x.html!) }))
      .filter((x) => x.problems.length > 0)
      .map((x) => `${x.address}: ${x.problems.join('; ')}`);
    expect(offenders, offenders.join('\n')).toEqual([]);
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

// ─── Облик секции отзывов: то, что выбрал владелец по мокапам ────────────────

describe('секция отзывов подана так, как утверждено мокапом (вариант E)', () => {
  // Предмет — НАШ текст вокруг виджета, а не сам виджет. Различие существенно: раскладку
  // ленты официальный виджет не даёт (`docs/design/mockups/demo-followups/README.md:545`,
  // `Это неправда: kkpk.pro грузит скрипт стороннего сервиса`), и владелец 23.08.2026
  // решил взять стандартный виджет, подогнав облик под него. Заголовок и вводный абзац
  // виджету не принадлежат — они наши, и на них это решение не распространяется.

  it('заголовок секции — «Отзывы», без уточнения площадки', () => {
    // Решение владельца 23.08.2026, снято в README мокапов:
    // `docs/design/mockups/demo-followups/README.md:549`,
    // `заголовок «Отзывы» (у конкурента он «Отзывы учеников» — по решению владельца`.
    // Длинная форма «Отзывы на Яндекс.Картах» дублирует ссылку под секцией и на
    // утверждённых кадрах не встречается ни в одном из пяти вариантов.
    const section = reviewsSection();
    const headings = subtree(section)
      .filter((el) => el.tagName === 'h2')
      .map((el) => textOf(el).trim());
    expect(
      headings.length,
      'в секции отзывов не ровно один h2 — предмет утверждения не определён',
    ).toBe(1);
    expect(headings[0]).toBe('Отзывы');
  });

  it('вводного абзаца о площадке в секции нет', () => {
    // Основание — сам утверждённый кадр: `docs/design/mockups/demo-followups/variant-e/`
    // содержит заголовок «Отзывы» и НЕ содержит поясняющего абзаца под ним.
    //
    // Прежняя редакция ссылалась на README `:984` («по просьбе владельца: убран поясняющий
    // абзац»). Ссылка неточна и снята независимым ревью: там речь о ДРУГОМ абзаце —
    // «Отзывы собираются на Яндекс.Картах…», — а строки «Оценки и комментарии» в README нет
    // вовсе. Слово «вернулся» тоже было неверным: абзац добавлялся один раз.
    const section = reviewsSection();
    const paragraphs = subtree(section)
      .filter((el) => el.tagName === 'p')
      .map((el) => textOf(el).trim())
      .filter((text) => text.length > 0);
    const explanatory = paragraphs.filter((text) => /независимой площадк|собираются на/i.test(text));
    expect(
      explanatory,
      'в секции отзывов есть поясняющий абзац, снятый решением владельца',
    ).toEqual([]);
  });
});

// ─── Стенд прод-лайк: встраивания не зависят от режима форм ──────────────────

describe('гашение встраиваний не привязано к режиму форм (решение владельца 2026-09-05)', () => {
  // Проверка СТРУКТУРНАЯ, и это сказано вслух: выкладываемый стенд собирается тем же
  // `npm run build`, что и бой (`scripts/deploy-web.sh:112`, `npm --prefix "$WEB_DIR" run build`),
  // отличаясь только переменными окружения. Значит отдельного артефакта «стенд» не существует,
  // и утверждение «на стенде встраивание есть» проверяется не третьей сборкой, а тем, что
  // признак гашения не читает режим форм. Пока читал — стенд показывал ссылку вместо виджета,
  // и заказчик счёл это дефектом.
  const REVIEWS = 'src/components/home/sections/Reviews.astro';
  const CHAT = 'src/components/chat/ChatFacade.astro';

  /**
   * Предмет — ИМПОРТ, а не текст файла. Первая редакция искала подстроку `isDemoForms`
   * во всём исходнике и краснела на упоминании этого имени в комментарии, который как раз
   * и объясняет, почему признак сменили. Признак, отбирающий предмет тем же, чем он его
   * проверяет, — известный класс ложного отказа; здесь он ловил прозу вместо кода.
   */
  function importsFormsModule(file: string): boolean {
    const src = readFileSync(join(dirname(dist), file), 'utf-8');
    return /^\s*import\s+[^;]*\bfrom\s+['"][^'"]*\/lib\/forms(\.js)?['"]/m.test(src);
  }

  it('секция отзывов не решает по режиму форм, показывать ли виджет', () => {
    expect(
      importsFormsModule(REVIEWS),
      `${REVIEWS} читает модуль форм: у флага две цели, и единый признак делает прод-лайк ` +
        'стенд невозможным (спека, требование о демо-выводе)',
    ).toBe(false);
  });

  it('чат не решает по режиму форм, показывать ли себя', () => {
    expect(importsFormsModule(CHAT), `${CHAT} читает модуль форм`).toBe(false);
  });

  it('демо-вывод помечен собственной переменной, а не признаком форм', () => {
    // Признак невыкладываемого артефакта задаётся скриптом сборки демо-вывода и только им —
    // тем же приёмом, что синтетический адрес загрузчика (`CHAT_LOADER_FALLBACK`).
    const pkg = readFileSync(join(dirname(dist), 'package.json'), 'utf-8');
    const scripts = JSON.parse(pkg).scripts as Record<string, string>;
    expect(scripts['build:demo'], 'build:demo не объявляет признак демо-вывода').toContain(
      'DEMO_OUTPUT=1',
    );
    expect(scripts.build, 'боевая сборка не должна объявлять признак демо-вывода').not.toContain(
      'DEMO_OUTPUT',
    );
  });
});
