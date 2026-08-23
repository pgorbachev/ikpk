import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allDemoPages, demoDist, demoPagePath, demoPages, readDemoFile } from './helpers/demo-dist';
import { attr } from './helpers/dom';
import {
  FOREIGN_METRIKA_ID,
  METRIKA_TAG_URL,
  OWN_METRIKA_ID,
  REVIEWS_ORG_ID,
  REVIEWS_WIDGET_HOST,
  REVIEWS_WIDGET_PATH,
  SEL_AWARD_BADGE,
  SEL_CHAT_FACADE,
  SEL_CHAT_HOURS,
  SEL_CHAT_MOUNT,
  SEL_CHAT_TRIGGER,
  SEL_REVIEWS_SECTION,
  byDataName,
  chatLoaderHits,
  hostAndPath,
  reviewsEmbedHits,
  subtree,
} from './helpers/external-widgets';

/**
 * Тесты по спеке change `external-widgets` — предмет ДЕМО-вывод сборки.
 *
 * Предмет один: боевой каталог здесь не читается. Симметричные утверждения («встраивания
 * ЕСТЬ») живут в `tests/external-widgets-dist.test.ts`, и разведение обязательно —
 * `web/tests/demo-gate.test.ts:670` роняет прогон у файла с двумя предметами.
 *
 * ПРИЗНАК ТОТ ЖЕ, что у боевого файла, и лежит в `helpers/external-widgets.ts`. Спека
 * требует именно этого: своё определение здесь дало бы вторую проверку другой силы над
 * тем же предметом.
 *
 * Признаком SHALL NOT быть аналитика ВНУТРИ виджета: чужой счётчик исполняется в чужом
 * документе, поэтому в нашем выводе его признаков нет ни при живом встраивании, ни при
 * погашенном. Действующая проверка демо-вывода устроена именно так
 * (`web/tests/demo-output.test.ts:59`, `['id Яндекс.Метрики'`) — и без признаков
 * встраиваний пропустила бы оба виджета.
 */

let pages: string[];
let sources: Map<string, string>;

beforeAll(() => {
  pages = demoPages();
  sources = new Map(pages.map((f) => [demoPagePath(f), readDemoFile(demoPagePath(f))]));
});

/**
 * Адрес загрузчика чата, ОБЪЯВЛЕННЫЙ конфигурацией. Нет объявления — предмета нет.
 *
 * Путь модуля лежит в переменной, а не в литерале импорта, намеренно: у литерала
 * `astro check` требует существования модуля, и отсутствие реализации давало бы КРАСНЫЙ
 * ГЕЙТ типов вместо красного теста. Различать эти два состояния обязательно — иначе
 * причина падения читается как поломка типов, а не как «требование не выполнено».
 */
const CONFIG_MODULE = '../src/lib/external-widgets';

async function declaredChatLoader(): Promise<string> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(CONFIG_MODULE)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `модуля конфигурации нет либо он не загружается: ${(error as Error).message}. ` +
        'Спека требует объявить адрес там, где его читает проверка: значение только в ' +
        'окружении выкладки оставляет симметричную проверку без предмета',
      { cause: error },
    );
  }
  const read = mod.chatLoaderSrc as undefined | (() => string | null);
  if (typeof read !== 'function')
    throw new Error("модуль не экспортирует chatLoaderSrc() — конфигурацию читать нечем");
  const value = read();
  if (value === null || value === '')
    throw new Error(
      'адрес загрузчика чата не объявлен: проверка «в демо-выводе его нет» без адреса ' +
        'тривиально верна, поэтому считается НЕпройденной, а не пройденной',
    );
  return value;
}

describe('демо-вывод: материал на месте', () => {
  it('в выводе есть собранные страницы сайта', () => {
    expect(pages.length, `в '${demoDist}' нет html-страниц`).toBeGreaterThan(50);
    const real = [...sources.values()].filter((html) => /<html[^>]*lang="ru"/.test(html));
    expect(
      real.length,
      'ни одна страница демо-вывода не похожа на собранную страницу сайта — ' +
        'утверждения об отсутствии ниже были бы тривиально зелёными',
    ).toBeGreaterThan(50);
  });

  it('проверка, не нашедшая собранных страниц, считается НЕпройденной', () => {
    // Тот же сторож, что у действующей проверки демо-вывода, и проверяется он вызовом:
    // на пустом каталоге перечисление обязано падать, на непустом — нет. Первое без
    // второго прошло бы и для функции, падающей всегда.
    const empty = mkdtempSync(join(tmpdir(), 'ikpk-widgets-demo-empty-'));
    expect(() => demoPages(empty)).toThrow(/предмета проверки нет/);
    const filled = mkdtempSync(join(tmpdir(), 'ikpk-widgets-demo-filled-'));
    mkdirSync(join(filled, 'x'), { recursive: true });
    writeFileSync(join(filled, 'x', 'index.html'), '<!doctype html><html lang="ru"></html>');
    expect(demoPages(filled).length).toBe(1);
  });
});

/**
 * ЧЕМ ДОКАЗАНА НЕПУСТОТА ДЛЯ УТВЕРЖДЕНИЙ НИЖЕ.
 *
 * Требование о непустоте предмета здесь выполняется ДВУМЯ разными способами, и путать их
 * нельзя. Первый — свой: читаются настоящие собранные страницы (блок «материал на
 * месте»). Второй — ЧУЖОЙ, и это нормативно: «встраиваний нет» верно и в случае, когда
 * встраиваний нет НИГДЕ, и доказать обратное этим файлом невозможно по построению — он
 * не имеет права читать боевой вывод. Поэтому гарантию даёт симметричная проверка
 * `tests/external-widgets-dist.test.ts`, и спека называет её прямо: «без симметричной
 * проверки утверждение „на демо встраиваний нет“ выполняется и в случае, когда
 * встраиваний нет нигде, — то есть гейт зелен на сломанном продукте».
 *
 * Практическое следствие для реализации: удалять или ослаблять симметричную проверку
 * нельзя — вместе с ней исчезает единственное доказательство непустоты для всей группы
 * утверждений ниже.
 */
describe('на демо оба встраивания отсутствуют, и признаком служит само встраивание', () => {
  it('в демо-выводе нет адреса виджета отзывов ни в одном атрибуте', () => {
    const offenders = [...sources.entries()]
      .map(([path, html]) => ({ path, hits: reviewsEmbedHits(html) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.path} → ${x.hits.map((h) => `${h.tag}[${h.name}]`).join(', ')}`);
    expect(
      offenders.slice(0, 10),
      `адрес виджета отзывов присутствует в демо-выводе на ${offenders.length} страницах: ` +
        'на стенде посетитель грузит чужой документ, чужой счётчик и восемь куки',
    ).toEqual([]);
  });

  it('в демо-выводе нет адреса загрузчика чата ни в одном атрибуте', async () => {
    const loader = await declaredChatLoader();
    const offenders = [...sources.entries()]
      .map(([path, html]) => ({ path, hits: chatLoaderHits(html, loader) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.path} → ${x.hits.map((h) => `${h.tag}[${h.name}]`).join(', ')}`);
    expect(
      offenders.slice(0, 10),
      `адрес загрузчика чата присутствует в демо-выводе на ${offenders.length} страницах: ` +
        'обращения с показа уехали бы в живой портал заказчика',
    ).toEqual([]);
  });

  it('разметки чата в демо-выводе нет вовсе', () => {
    const offenders: string[] = [];
    for (const [path, html] of sources)
      for (const name of [SEL_CHAT_FACADE, SEL_CHAT_TRIGGER, SEL_CHAT_MOUNT, SEL_CHAT_HOURS])
        if (byDataName(html, name).length > 0) offenders.push(`${path} → ${name}`);
    expect(offenders.slice(0, 10), `разметка чата в демо-выводе: ${offenders.length} вхождений`).toEqual([]);
  });

  it('признак ловит встраивание в выводе, где признаков аналитики нет вовсе', () => {
    // Ровно тот случай, из-за которого требование и переписано: проверка, ищущая
    // признаки аналитики, на живом встраивании зелена. Фикстура несёт встраивание и НЕ
    // несёт ни одного признака аналитики — признак обязан сработать.
    const markup =
      `<!doctype html><html lang="ru"><body><section ${SEL_REVIEWS_SECTION}>` +
      `<div ${'data-reviews-embed'}="https://${REVIEWS_WIDGET_HOST}${REVIEWS_WIDGET_PATH}?comments"></div>` +
      '</section></body></html>';
    expect(markup.includes(OWN_METRIKA_ID), 'фикстура содержит признак нашей аналитики').toBe(false);
    expect(markup.includes(FOREIGN_METRIKA_ID), 'фикстура содержит идентификатор чужого счётчика').toBe(false);
    expect(markup.includes(new URL(METRIKA_TAG_URL).hostname), 'фикстура содержит домен аналитики').toBe(false);
    expect(
      reviewsEmbedHits(markup).length,
      'признак не увидел встраивание в выводе без признаков аналитики — проверка была бы ' +
        'декоративной с рождения',
    ).toBeGreaterThan(0);
  });

  it('признак видит адрес в АТРИБУТЕ ДАННЫХ, а не только в src', () => {
    const inData = `<div data-reviews-embed="//${REVIEWS_WIDGET_HOST}${REVIEWS_WIDGET_PATH}?comments"></div>`;
    expect(
      reviewsEmbedHits(inData).length,
      'адрес в атрибуте данных признаком не увиден — весь ленивый путь прошёл бы мимо',
    ).toBeGreaterThan(0);
  });
});

describe('в демо-выводе секция несёт ссылку, а не пустоту', () => {
  it('секция отзывов в демо-выводе присутствует', () => {
    const home = readDemoFile('/index.html');
    expect(
      byDataName(home, SEL_REVIEWS_SECTION).length,
      'секции отзывов в демо-выводе нет: секция обязательна безусловно, а заказчик ' +
        'смотрит именно на стенд',
    ).toBe(1);
  });

  it('в секции есть ссылка на отзывы организации', () => {
    const home = readDemoFile('/index.html');
    const section = byDataName(home, SEL_REVIEWS_SECTION)[0];
    expect(section, 'секции нет — предмета нет').toBeTruthy();
    const links = subtree(section)
      .filter((el) => el.tagName === 'a')
      .map((el) => attr(el, 'href') ?? '')
      .filter((href) => {
        const parsed = hostAndPath(href);
        return parsed !== null && parsed.host.endsWith(REVIEWS_WIDGET_HOST) && href.includes(REVIEWS_ORG_ID);
      });
    expect(links, 'в демо-выводе секция не даёт ссылки на отзывы организации').not.toEqual([]);
  });

  it('элементов, изображающих сами отзывы, в секции нет', () => {
    // Пустая область читается как дефект, нарисованная заглушка показывает заказчику
    // то, чего продукт не делает. Механический признак заглушки: картинка внутри
    // секции вне знака награды либо iframe.
    const home = readDemoFile('/index.html');
    const section = byDataName(home, SEL_REVIEWS_SECTION)[0];
    expect(section, 'секции нет — предмета нет').toBeTruthy();
    const badges = subtree(section).filter((el) => attr(el, SEL_AWARD_BADGE) !== null);
    const inBadge = new Set(badges.flatMap((el) => subtree(el)));
    const depicting = subtree(section)
      .filter((el) => ['img', 'iframe', 'picture'].includes(el.tagName))
      .filter((el) => !inBadge.has(el))
      .map((el) => el.tagName);
    expect(depicting, `в демо-секции есть элементы, изображающие отзывы: ${depicting.join(', ')}`).toEqual([]);
  });

  it('страниц демо-вывода перечислено достаточно, чтобы говорить о сайте', () => {
    // Сторож для трёх утверждений выше: они читают ОДНУ страницу, и её отсутствие
    // должно быть отказом, а не «нарушений нет».
    expect(allDemoPages().length, 'канонических страниц демо-вывода нет').toBeGreaterThan(50);
    expect(allDemoPages()).toContain('/');
  });
});
