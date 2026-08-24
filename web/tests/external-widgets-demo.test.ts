import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allDemoPages, demoDist, demoPagePath, demoPages, readDemoFile } from './helpers/demo-dist';
import { attr } from './helpers/dom';
import {
  CHAT_LOADER_FALLBACK_KEY,
  CHAT_LOADER_FALLBACK_SYNTHETIC,
  FOREIGN_METRIKA_ID,
  METRIKA_TAG_URL,
  OWN_METRIKA_ID,
  REVIEWS_ORG_ID,
  REVIEWS_WIDGET_HOST,
  REVIEWS_WIDGET_PATH,
  SEL_AWARD_BADGE,
  SEL_CHAT_FACADE,
  SEL_CHAT_MOUNT,
  SEL_CHAT_TRIGGER,
  SEL_REVIEWS_SECTION,
  byDataName,
  chatLoaderHits,
  chatLoaderSuspects,
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
 *
 * ── ПОЧЕМУ ПРЕДМЕТ ЗДЕСЬ НЕПУСТ ВСЕГДА ──────────────────────────────────────
 * Демо-сборка получает адрес загрузчика ВСЕГДА: настоящий, если конфигурация его несёт,
 * иначе синтетический. Иначе в состояниях «объявленное отсутствие» и «не объявлено
 * ничего» настоящего адреса нет нигде, и утверждение «в демо-выводе его нет» тривиально
 * верно — гейт зелен на сломанном гашении.
 *
 * Признак назван АРТЕФАКТОМ, а не назначением прогона: синтетический адрес живёт только
 * в `dist-demo`, а этот каталог не выкладывается никуда — ни на стенд, ни в production
 * (выкладываемый стенд собирается БОЕВОЙ сборкой). Третьего артефакта не заводится.
 */

let pages: string[];
let sources: Map<string, string>;

beforeAll(() => {
  pages = demoPages();
  sources = new Map(pages.map((f) => [demoPagePath(f), readDemoFile(demoPagePath(f))]));
});

/**
 * Адрес загрузчика, который получила демо-сборка. Нет никакого — предмета нет.
 *
 * Путь модуля лежит в переменной, а не в литерале импорта, намеренно: у литерала
 * `astro check` требует существования модуля, и отсутствие реализации давало бы КРАСНЫЙ
 * ГЕЙТ типов вместо красного теста. Различать эти два состояния обязательно — иначе
 * причина падения читается как поломка типов, а не как «требование не выполнено».
 */
const CONFIG_MODULE = '../src/lib/external-widgets';

/**
 * Вердикт проверки гашения: есть ли у неё предмет.
 *
 * Функция ЧИСТАЯ и проверяется фикстурой — сценарий «Демо-сборка выполнена без всякого
 * адреса» иначе не имел бы построимого красного состояния: как только реализация подаёт
 * адрес всегда, состояние «адреса нет» на настоящей сборке недостижимо, а требование к
 * нему остаётся.
 */
export function demoSubject(suppliedSrc: string | null): { ok: boolean; reason: string } {
  if (suppliedSrc === null || suppliedSrc.trim() === '')
    return {
      ok: false,
      reason:
        'демо-сборка не получила ни настоящего, ни синтетического адреса загрузчика: искать ' +
        'в выводе адрес, которого не было на входе, — утверждение, тривиально верное на ' +
        'пустом предмете. Проверка гашения считается НЕпройденной с причиной «измерить не ' +
        'удалось»',
    };
  if (hostAndPath(suppliedSrc) === null)
    return {
      ok: false,
      reason: `адрес '${suppliedSrc}' не разбирается как адрес — искать в выводе нечего`,
    };
  return { ok: true, reason: '' };
}

async function suppliedChatLoader(): Promise<string> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(CONFIG_MODULE)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `модуля конфигурации нет либо он не загружается: ${(error as Error).message}. ` +
        'Спека требует объявить адрес там, где его читает проверка: значение только в ' +
        'окружении выкладки оставляет проверку гашения без предмета',
      { cause: error },
    );
  }
  const read = mod.demoChatLoaderSrc as undefined | (() => string | null);
  if (typeof read !== 'function')
    throw new Error(
      'модуль не экспортирует demoChatLoaderSrc() — узнать, какой адрес получила ' +
        'демо-сборка, нечем. Спека требует, чтобы он подавался ВСЕГДА: настоящий либо ' +
        'синтетический',
    );
  const value = read();
  const verdict = demoSubject(value);
  if (!verdict.ok) throw new Error(verdict.reason);
  return value as string;
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
    // Путей отказа у чужого сторожа три — каталога нет, путь не каталог, страниц ноль, — и
    // проверяются все три. Мутация, убравшая один путь из трёх, прогон не покраснит:
    // измерено на симметричном стороже боевого вывода.
    const missing = join(tmpdir(), 'ikpk-widgets-demo-no-such-dir-нет');
    expect(() => demoPages(missing), 'на ОТСУТСТВУЮЩЕМ каталоге сторож не упал').toThrow(
      /предмета проверки нет/,
    );
    const asFile = join(mkdtempSync(join(tmpdir(), 'ikpk-widgets-demo-file-')), 'not-a-dir');
    writeFileSync(asFile, 'x');
    expect(() => demoPages(asFile), 'на пути-ФАЙЛЕ сторож не упал').toThrow(/предмета проверки нет/);
    const empty = mkdtempSync(join(tmpdir(), 'ikpk-widgets-demo-empty-'));
    expect(() => demoPages(empty), 'на ПУСТОМ каталоге сторож не упал').toThrow(/предмета проверки нет/);
    const filled = mkdtempSync(join(tmpdir(), 'ikpk-widgets-demo-filled-'));
    mkdirSync(join(filled, 'x'), { recursive: true });
    writeFileSync(join(filled, 'x', 'index.html'), '<!doctype html><html lang="ru"></html>');
    expect(demoPages(filled).length).toBe(1);
  });
});

describe('у проверки гашения чата предмет есть в любом состоянии конфигурации', () => {
  it('демо-сборка получила адрес загрузчика: настоящий либо синтетический', async () => {
    const src = await suppliedChatLoader();
    expect(
      hostAndPath(src),
      `адрес '${src}', полученный демо-сборкой, не разбирается — искать в выводе нечего`,
    ).not.toBeNull();
  });

  it('адреса нет вовсе — «измерить не удалось», а не «нарушений нет»', () => {
    // Фикстура вместо реальности: как только адрес подаётся всегда, это состояние на
    // настоящей сборке недостижимо, а сценарий спеки к нему остаётся. Без фикстуры у
    // него не было бы построимого красного состояния ни при какой реализации.
    for (const raw of [null, '', '   ']) {
      const verdict = demoSubject(raw);
      expect(verdict.ok, `значение ${JSON.stringify(raw)} принято за предмет проверки`).toBe(false);
      expect(verdict.reason).toMatch(/измерить не удалось/);
    }
    expect(demoSubject('https://example.invalid/loader.js').ok).toBe(true);
  });

  it('синтетический адрес выставляет ТОЛЬКО скрипт сборки демо-вывода', () => {
    // Признак — какой артефакт собирается, и проверяется он ЧТЕНИЕМ МАНИФЕСТА, а не
    // догадкой о «назначении прогона»: спека называет именно этот способ. Боевой скрипт
    // подстановки не делает — у заказчика два портала Bitrix24, и молчаливый выбор
    // одного направил бы обращения посетителей не туда.
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const marker = `${CHAT_LOADER_FALLBACK_KEY}=${CHAT_LOADER_FALLBACK_SYNTHETIC}`;

    const demoBuild = scripts['build:demo'] ?? '';
    expect(
      demoBuild.includes(marker),
      `скрипт build:demo не выставляет '${marker}': тогда в состояниях без адреса у проверки ` +
        'гашения нет предмета, и «в демо-выводе его нет» тривиально верно',
    ).toBe(true);

    const prodBuild = scripts.build ?? '';
    expect(prodBuild, 'в манифесте нет скрипта build — проверять нечего').not.toBe('');
    expect(
      prodBuild.includes(CHAT_LOADER_FALLBACK_KEY),
      `боевой скрипт build упоминает '${CHAT_LOADER_FALLBACK_KEY}': боевая сборка НЕ имеет ` +
        'права подставлять адрес ни в одном состоянии конфигурации',
    ).toBe(false);
    const standBuild = scripts['build:stand'] ?? '';
    expect(
      standBuild.includes(CHAT_LOADER_FALLBACK_KEY),
      'скрипт build:stand подставляет синтетический адрес: выкладываемый стенд собирается ' +
        'боевой сборкой и уезжает к посетителю',
    ).toBe(false);
  });
});

/**
 * ЧЕМ ДОКАЗАНА НЕПУСТОТА ДЛЯ УТВЕРЖДЕНИЙ НИЖЕ.
 *
 * Требование о непустоте предмета здесь выполняется ДВУМЯ разными способами, и путать их
 * нельзя. Первый — свой: читаются настоящие собранные страницы (блок «материал на
 * месте»), и демо-сборка получила адрес загрузчика на вход (блок выше). Второй — ЧУЖОЙ, и
 * это нормативно: «встраиваний нет» верно и в случае, когда встраиваний нет НИГДЕ, и
 * доказать обратное этим файлом невозможно по построению — он не имеет права читать
 * боевой вывод. Поэтому гарантию даёт симметричная проверка
 * `tests/external-widgets-dist.test.ts`, и спека называет её прямо.
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

  it('в демо-выводе нет адреса загрузчика чата, который сборка получила на вход', async () => {
    const src = await suppliedChatLoader();
    const offenders = [...sources.entries()]
      .map(([path, html]) => ({ path, hits: chatLoaderHits(html, src) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.path} → ${x.hits.map((h) => `${h.tag}[${h.name}]`).join(', ')}`);
    expect(
      offenders.slice(0, 10),
      `адрес загрузчика '${src}' присутствует в демо-выводе на ${offenders.length} страницах: ` +
        'гашение сломано, и в состоянии 1 обращения с показа уехали бы в живой портал ' +
        'заказчика',
    ).toEqual([]);
  });

  it('в демо-выводе нет и адреса загрузчика, приехавшего мимо входа', () => {
    // Второй признак, шире первого, и он нужен именно потому, что первый узкий: если
    // демо-сборка получила СИНТЕТИЧЕСКИЙ адрес, то утечка НАСТОЯЩЕГО адреса портала под
    // первый признак не попадает вовсе. Расхождение двух признаков названо: узкий
    // проверяет ровно то, что подано на вход, широкий — что не приехало мимо входа.
    const offenders = [...sources.entries()]
      .map(([path, html]) => ({ path, hits: chatLoaderSuspects(html) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.path} → ${x.hits.map((h) => `${h.tag}[${h.name}]=${h.value}`).join(', ')}`);
    expect(
      offenders.slice(0, 10),
      `в демо-выводе есть адрес загрузчика на хосте поставщика: ${offenders.length} страниц. ` +
        'Признак по НАЗНАЧЕНИЮ носителя, а не по домену: ссылки форм заявки живут на том же ' +
        'портале, и признак по домену краснел бы на них',
    ).toEqual([]);
  });

  it('разметки чата в демо-выводе нет вовсе', () => {
    const offenders: string[] = [];
    for (const [path, html] of sources)
      for (const name of [SEL_CHAT_FACADE, SEL_CHAT_TRIGGER, SEL_CHAT_MOUNT])
        if (byDataName(html, name).length > 0) offenders.push(`${path} → ${name}`);
    expect(offenders.slice(0, 10), `разметка чата в демо-выводе: ${offenders.length} вхождений`).toEqual([]);
  });

  it('признак ловит встраивание в выводе, где признаков аналитики нет вовсе', () => {
    // Ровно тот случай, из-за которого требование и переписано: проверка, ищущая
    // признаки аналитики, на живом встраивании зелена. Фикстура несёт встраивание и НЕ
    // несёт ни одного признака аналитики — признак обязан сработать.
    const markup =
      `<!doctype html><html lang="ru"><body><section ${SEL_REVIEWS_SECTION}>` +
      `<div data-reviews-embed="https://${REVIEWS_WIDGET_HOST}${REVIEWS_WIDGET_PATH}?comments"></div>` +
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
