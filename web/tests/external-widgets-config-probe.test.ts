import { describe, it, expect, beforeAll } from 'vitest';
import { attr } from './helpers/dom';
import {
  CHAT_LOADER_KEY,
  CHAT_LOADER_NONE,
  SEL_CHAT_FACADE,
  SEL_CHAT_MOUNT,
  SEL_CHAT_TRIGGER,
  byDataName,
  chatLoaderHits,
  chatLoaderSuspects,
  elements,
  hoursStripText,
  subtree,
  telLinks,
} from './helpers/external-widgets';
import { PROBE_CHAT_LOADER_SRC, buildProbe, type ProbeBuild } from './helpers/widget-probe-build';

/**
 * Тесты по спеке change `external-widgets` — облик БОЕВОГО вывода в каждом из ТРЁХ
 * состояний конфигурации адреса загрузчика.
 *
 * ── ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ И ПРОБНЫЕ СБОРКИ ──────────────────────────────────
 * У настоящей боевой сборки одно состояние — то, что объявлено в дереве. Спека объявляет
 * публикуемыми ДВА состояния с разным обликом страницы («несёт встраивание» и «фасада нет
 * целиком»), а третье — отказом выкладки. Значит из трёх требуемых утверждений на
 * настоящем выводе имеет предмет ровно одно, а два остальных не имели бы построимого
 * красного состояния ни при какой реализации. Пробная сборка — тот же приём, которым сама
 * спека решила подстановку года сборки. Устройство и цена — в шапке
 * `tests/helpers/widget-probe-build.ts`.
 *
 * ПРЕДМЕТ ЗДЕСЬ — пробные каталоги вне репозитория. Ни `dist`, ни `dist-demo` этот файл не
 * читает: инвариант «ровно один предмет» (`web/tests/demo-gate.test.ts:670`) соблюдён по
 * построению, потому что ни одного корня проекта файл не объявляет.
 *
 * Файл идёт конфигурацией `vitest.build.config.ts`, а не основным прогоном, и причина
 * ПОРЯДОК, а не предмет: пробная сборка не пересобирает производные картинок, поэтому
 * вызывать её можно только после обычной сборки, а `test:build` запускает `npm run build`
 * непосредственно перед собой.
 *
 * ── ПОЛОЖИТЕЛЬНЫЙ КОНТРОЛЬ ОБЯЗАТЕЛЕН ──────────────────────────────────────
 * Утверждения о состояниях 2 и 3 — про ОТСУТСТВИЕ. Если подставленное окружение до сборки
 * не доезжает, все три пробы дают один и тот же вывод, и утверждения об отсутствии
 * тривиально верны. Поэтому первым идёт различительный тест: проба состояния 1 адрес
 * несёт, пробы 2 и 3 — нет. Без него весь файл был бы декоративен.
 */

let state1: ProbeBuild;
let state2: ProbeBuild;
let state3: ProbeBuild;
/** Состояние 1 в демо-выводе: адрес объявлен, но артефакт не выкладывается. */
let state1Demo: ProbeBuild;

const PROBE_TIMEOUT_MS = 10 * 60 * 1000;

beforeAll(async () => {
  state1 = buildProbe(`${CHAT_LOADER_KEY}=<адрес>`, { [CHAT_LOADER_KEY]: PROBE_CHAT_LOADER_SRC });
  state2 = buildProbe(`${CHAT_LOADER_KEY}=${CHAT_LOADER_NONE}`, {
    [CHAT_LOADER_KEY]: CHAT_LOADER_NONE,
  });
  // Ключа НЕТ вовсе. Пустое значение проверяется отдельным тестом ниже — спека называет
  // их одним состоянием, но проверять надо оба входа, иначе реализация, их различающая,
  // пройдёт незамеченной.
  state3 = buildProbe(`${CHAT_LOADER_KEY} не задан`, { [CHAT_LOADER_KEY]: undefined });
  // Единственное сочетание, ради которого механизм гашения и существует, и до находки
  // независимого ревью не собиравшееся НИГДЕ: адрес объявлен И артефакт — демо-вывод.
  // Ни один прогон его не строил: `build:demo` в CI идёт без `CHAT_LOADER_SRC` (состояние
  // всегда 3), а пробные сборки не передавали `DEMO_OUTPUT` вовсе. Значит мутация,
  // ломающая `!isDemoOutput` в `ChatFacade.astro`, не покраснила бы ни один тест.
  state1Demo = buildProbe(`${CHAT_LOADER_KEY}=<адрес> + DEMO_OUTPUT`, {
    [CHAT_LOADER_KEY]: PROBE_CHAT_LOADER_SRC,
    DEMO_OUTPUT: '1',
  });
}, PROBE_TIMEOUT_MS);

/** Страницы пробы, несущие объявленный адрес загрузчика. */
const carrying = (probe: ProbeBuild, src: string): string[] =>
  [...probe.pages.entries()].filter(([, html]) => chatLoaderHits(html, src).length > 0).map(([p]) => p);

/**
 * Страницы пробы, несущие адрес поставщика чата в НЕнавигационном носителе.
 *
 * Признак по НАЗНАЧЕНИЮ, а не по домену: ссылки форм заявки живут на том же портале
 * заказчика, и измерено, что в боевом выводе их 393 — все `a[href]`. Признак по домену
 * краснел бы на них, то есть проверка «умолчание не подставилось» была бы красной на
 * исправном дереве.
 */
const carryingLoader = (probe: ProbeBuild): string[] =>
  [...probe.pages.entries()]
    .filter(([, html]) => chatLoaderSuspects(html).length > 0)
    .map(([p]) => p);

const PAGE_404 = '/404.html';

describe('демо-вывод гасит чат даже при объявленном адресе', () => {
  it('адрес до сборки доехал, но встраивания в демо-выводе нет', () => {
    // Различительная часть обязательна: без неё «встраивания нет» верно и для сборки,
    // до которой адрес просто не дошёл, — то есть проверка была бы зелёной на
    // сломанном механизме подстановки, а не на работающем гашении.
    expect(
      carrying(state1, PROBE_CHAT_LOADER_SRC).length,
      'адрес не доезжает до сборки вовсе — гашение проверять не на чем',
    ).toBeGreaterThan(0);

    expect(
      carrying(state1Demo, PROBE_CHAT_LOADER_SRC),
      `проба «${state1Demo.label}» несёт адрес загрузчика: демо-вывод обязан гасить ` +
        'встраивание при ЛЮБОМ состоянии конфигурации',
    ).toEqual([]);
  });

  it('в демо-выводе нет и разметки фасада', () => {
    // Отдельно от адреса: фасад мог бы остаться без `data-chat-src`, и проверка по
    // адресу его не увидела бы, а посетитель — увидел.
    expect(
      carryingLoader(state1Demo),
      'в демо-выводе есть разметка фасада чата при объявленном адресе',
    ).toEqual([]);
  });
});

describe('подставленная конфигурация доезжает до сборки', () => {
  it('проба состояния 1 адрес несёт, пробы состояний 2 и 3 — нет', () => {
    // РАЗЛИЧИТЕЛЬНЫЙ тест, и он первый намеренно: без него утверждения об отсутствии
    // ниже верны и в случае, когда `CHAT_LOADER_SRC` до сборки не доходит вовсе.
    expect(
      carrying(state1, PROBE_CHAT_LOADER_SRC).length,
      `проба «${state1.label}» не несёт подставленного адреса ни на одной из ` +
        `${state1.pages.size} страниц: значит ключ '${CHAT_LOADER_KEY}' до сборки не доезжает, ` +
        'и весь этот файл ничего не измеряет',
    ).toBeGreaterThan(0);
    expect(carrying(state2, PROBE_CHAT_LOADER_SRC), `проба «${state2.label}» несёт адрес`).toEqual([]);
    expect(carrying(state3, PROBE_CHAT_LOADER_SRC), `проба «${state3.label}» несёт адрес`).toEqual([]);
  });
});

describe('состояние 1: конфигурация задана — встраивание есть на всех страницах, кроме 404', () => {
  it('встраивание чата есть на каждой странице, кроме 404', () => {
    // Оговорка про 404 стоит в WHEN сценария, а не только в заголовке: тест, написанный
    // без неё, обязан падать на 404, где встраивания нет по другому требованию этой же
    // спеки — по байтовому пределу.
    const without = [...state1.pages.keys()]
      .filter((path) => path !== PAGE_404)
      .filter((path) => chatLoaderHits(state1.pages.get(path)!, PROBE_CHAT_LOADER_SRC).length === 0);
    expect(state1.pages.size, 'в пробе нет страниц — предмета нет').toBeGreaterThan(50);
    expect(
      without.slice(0, 10),
      `страниц без встраивания чата: ${without.length} из ${state1.pages.size}`,
    ).toEqual([]);
  });

  it('на 404 встраивания нет и в этом состоянии', () => {
    const html = state1.pages.get(PAGE_404);
    expect(html, 'в пробе нет страницы 404').toBeTruthy();
    expect(
      chatLoaderHits(html!, PROBE_CHAT_LOADER_SRC),
      'на 404 есть встраивание чата: её байтовый запас меньше килобайта, а проверка предела ' +
        'стоит в обязательном прогоне и останавливает публикацию боевого сайта',
    ).toEqual([]);
    for (const name of [SEL_CHAT_FACADE, SEL_CHAT_TRIGGER, SEL_CHAT_MOUNT])
      expect(byDataName(html!, name).map((el) => el.tagName), `на 404 есть '${name}'`).toEqual([]);
  });

  it('кнопка вызова и точка монтирования объявлены нашими именами', () => {
    const home = state1.pages.get('/index.html');
    expect(home, 'в пробе нет главной страницы').toBeTruthy();
    expect(byDataName(home!, SEL_CHAT_FACADE).length, 'фасада чата нет').toBe(1);
    expect(byDataName(home!, SEL_CHAT_TRIGGER).length, 'нашей кнопки вызова нет').toBe(1);
    expect(byDataName(home!, SEL_CHAT_MOUNT).length, 'объявленной точки монтирования нет').toBe(1);
  });

  it('адрес загрузчика записан СО СХЕМОЙ', () => {
    // Наше правило, а не следствие чужого гейта: класс `protocol-relative` сверки
    // исполняемого вывода срабатывает только для закрытого перечня атрибутов адреса
    // (`web/tests/helpers/rich-content-safety/hazard-scan.ts:125`, `if (URL_ATTRS.has(name)`),
    // и `data-*` в него не входит — значит для выбранной конструкции сверка эту форму НЕ
    // ловит, и требование остаётся нашим.
    const home = state1.pages.get('/index.html')!;
    const hits = chatLoaderHits(home, PROBE_CHAT_LOADER_SRC);
    expect(hits.length, 'на главной пробы нет адреса загрузчика — предмета нет').toBeGreaterThan(0);
    const withoutScheme = hits.filter(({ value }) => !/^https?:\/\//.test(value.trim()));
    expect(
      withoutScheme.map((h) => `${h.tag}[${h.name}]=${h.value}`),
      'адрес загрузчика записан без схемы: эту форму в атрибуте данных сверка исполняемого ' +
        'вывода не покрывает вовсе',
    ).toEqual([]);
  });

  it('ни один ИСПОЛНЯЕМЫЙ узел адреса загрузчика не несёт', () => {
    // Предмет именно такой, а не «форма без схемы в исполняемом узле»: при ленивом
    // встраивании исполняемого узла с этим адресом в статической разметке нет по
    // построению, поэтому сценарий про его форму нельзя было бы ни выполнить, ни
    // покраснить. Проверяемое утверждение — что узла нет; оно непусто (адрес в выводе
    // есть) и краснеет мутацией, переносящей адрес в `src`.
    const EXECUTABLE = new Set(['script', 'iframe', 'embed', 'object', 'frame']);
    const offenders: string[] = [];
    for (const [path, html] of state1.pages)
      for (const el of elements(html)) {
        if (!EXECUTABLE.has(el.tagName)) continue;
        for (const a of el.attrs)
          if (a.name === 'src' || a.name === 'data') {
            const hit = chatLoaderHits(`<i ${a.name}="${a.value}"></i>`, PROBE_CHAT_LOADER_SRC);
            if (hit.length > 0) offenders.push(`${path}: ${el.tagName}[${a.name}]=${a.value}`);
          }
      }
    expect(
      carrying(state1, PROBE_CHAT_LOADER_SRC).length,
      'адреса загрузчика в выводе нет вовсе — утверждение «исполняемый узел его не несёт» ' +
        'тривиально верно',
    ).toBeGreaterThan(0);
    expect(offenders.slice(0, 5), offenders.join('\n')).toEqual([]);
  });

  it('своей формы сбора данных для чата в выводе нет', () => {
    // Согласие и сбор данных обязан брать виджет, а не мы. Непустота: фасад существует.
    const offenders: string[] = [];
    for (const [path, html] of state1.pages)
      for (const facade of byDataName(html, SEL_CHAT_FACADE)) {
        const inputs = subtree(facade)
          .filter((el) => ['form', 'input', 'textarea', 'select'].includes(el.tagName))
          .map((el) => el.tagName);
        if (inputs.length > 0) offenders.push(`${path}: ${inputs.join(', ')}`);
      }
    const facades = [...state1.pages.values()].filter((html) => byDataName(html, SEL_CHAT_FACADE).length > 0);
    expect(facades.length, 'фасада чата нет ни на одной странице — предмета нет').toBeGreaterThan(0);
    expect(
      offenders.slice(0, 5),
      `внутри фасада чата есть свои поля ввода: ${offenders.length} страниц. Кнопка вызова — не ` +
        'сбор данных, а тип поля не разбирается вовсе: `<input type=hidden>` тоже собирает',
    ).toEqual([]);
  });

  it('фасад чата не несёт своей полосы часов работы', () => {
    // Своего постоянно видимого блока часов быть не должно: три редакции спеки его
    // предписывали, и реализация, идущая по памяти или по осиротевшим задачам, поставит
    // его снова. Предмет — ТОЛЬКО поддерево фасада: страницы семинаров называют время
    // занятий теми же числами, и признак по всей странице краснел бы от исправного текста.
    const offenders: string[] = [];
    for (const [path, html] of state1.pages)
      for (const facade of byDataName(html, SEL_CHAT_FACADE)) {
        const text = hoursStripText(facade);
        if (text !== null) offenders.push(`${path}: «${text}»`);
      }
    expect(offenders.slice(0, 5), `полоса часов внутри фасада: ${offenders.length} страниц`).toEqual([]);
  });

  it('со страницы с чатом достижима ссылка на документ о персональных данных', () => {
    const withChat = [...state1.pages.entries()].filter(
      ([, html]) => chatLoaderHits(html, PROBE_CHAT_LOADER_SRC).length > 0,
    );
    expect(withChat.length, 'страниц с чатом нет — предмета нет').toBeGreaterThan(0);
    // Признак — адрес СТРАНИЦЫ документа, а не каталог `/terms/`. Документ переехал с PDF
    // на страницу: редактируемого исходника PDF не существует нигде, а требование спеки
    // обязывает документ называть чат и чужой счётчик. Прежний признак после переезда
    // покраснел бы на исправной странице — ровно тот случай, когда гейт стережёт носитель
    // вместо предмета. PDF остаётся предыдущей редакцией, и ссылка на него — на самой
    // странице, а не в подвале каждой.
    const DOC_HREF = '/politika-konfidencialnosti';
    const without = withChat
      .filter(([, html]) =>
        elements(html)
          .filter((el) => el.tagName === 'a')
          .every((el) => !(attr(el, 'href') ?? '').includes(DOC_HREF)),
      )
      .map(([path]) => path);
    expect(without.slice(0, 10), `страницы с чатом без ссылки на документ: ${without.length}`).toEqual([]);
  });
});

describe('боевой вывод несёт встраивание чата — симметрично к «на демо его нет»', () => {
  it('встраивание чата есть в боевом выводе, кроме страницы 404', () => {
    // ЭТО ОТДЕЛЬНЫЙ СЦЕНАРИЙ ДРУГОГО ТРЕБОВАНИЯ, и своё имя у него намеренно.
    //
    // Утверждение сегодня совпадает с «Конфигурация задана, кроме страницы 404» выше
    // дословно, и это не дублирование по невнимательности: спека сама повторила оговорку
    // про 404 у обоих близнецов, назвав причину — «после того как оговорка появилась у
    // одного, её отсутствие у второго читалось бы как решение, а не как умолчание».
    //
    // Один тест на два сценария был бы хуже: расхождение между требованиями, если оно
    // появится, не увидело бы ни одно из них. Поэтому тестов два, и они обязаны разойтись
    // вместе с требованиями, а не остаться копией.
    const carryingPages = carrying(state1, PROBE_CHAT_LOADER_SRC);
    expect(
      carryingPages.length,
      'ни одна страница боевого вывода не несёт встраивания чата при заданном адресе: без ' +
        'этой симметричной проверки утверждение «на демо встраиваний нет» выполняется и в ' +
        'случае, когда встраиваний нет НИГДЕ, то есть гейт зелен на сломанном продукте',
    ).toBeGreaterThan(50);
    expect(
      carryingPages.includes(PAGE_404),
      'встраивание чата попало на страницу 404, исключённую из возможности по байтовому ' +
        'пределу',
    ).toBe(false);
  });
});

describe('состояние 2: отсутствие объявлено явно — фасада нет, подвал остаётся', () => {
  it('разметки фасада нет ни на одной странице', () => {
    const offenders: string[] = [];
    for (const [path, html] of state2.pages)
      for (const name of [SEL_CHAT_FACADE, SEL_CHAT_TRIGGER, SEL_CHAT_MOUNT])
        if (byDataName(html, name).length > 0) offenders.push(`${path} → ${name}`);
    expect(state2.pages.size, 'в пробе нет страниц — предмета нет').toBeGreaterThan(50);
    expect(
      offenders.slice(0, 10),
      `фасад чата присутствует при объявленном отсутствии адреса: ${offenders.length} вхождений. ` +
        'В этом состоянии боевой сайт ПУБЛИКУЕТСЯ, поэтому облик страницы — часть контракта',
    ).toEqual([]);
  });

  it('подвал с телефонами на месте, как и на любой другой странице', () => {
    // Вторая половина того же сценария, и оговорка про 404 к ней НЕ относится: подвал
    // есть на 404, как и на любой странице. Подвал не часть фасада чата и от конфигурации
    // не зависит вовсе.
    const without = [...state2.pages.entries()]
      .filter(([, html]) => elements(html).filter((el) => el.tagName === 'footer').flatMap(telLinks).length === 0)
      .map(([path]) => path);
    expect(
      without.slice(0, 10),
      `страниц без телефона в подвале: ${without.length}. Именно подвал остаётся гарантией, ` +
        'когда фасада чата нет вовсе',
    ).toEqual([]);
  });

  it('ни одного адреса загрузчика в выводе нет', () => {
    // Первая половина сценария «Умолчание не подставляется во втором и третьем
    // состоянии»: предмет наблюдаемый — вывод, а не намерение сборки. Признак широкий
    // (любой хост поставщика), потому что подставленное умолчанием могло бы быть любым из
    // двух порталов заказчика, а не подставленным пробным адресом.
    expect(
      carryingLoader(state2).slice(0, 10),
      'в выводе есть адрес на хосте поставщика чата: у заказчика два портала Bitrix24, и ' +
        'молчаливый выбор одного направил бы обращения посетителей не туда',
    ).toEqual([]);
  });
});

describe('состояние 3: не объявлено ничего — умолчание не подставляется', () => {
  it('ни одного адреса загрузчика в выводе нет', () => {
    expect(
      carryingLoader(state3).slice(0, 10),
      'в выводе есть адрес загрузчика при необъявленной конфигурации: боевая сборка НЕ имеет ' +
        'права подставлять адрес ни в одном состоянии',
    ).toEqual([]);
  });

  it('пустое значение ключа даёт тот же вывод, что отсутствие ключа', () => {
    // Спека: пустое значение и отсутствие ключа — ОДНО состояние. Их различение ничего не
    // добавляет, а склейка второго состояния с третьим уничтожает развилку. Проверяется
    // отдельной пробой: реализация, различающая пустоту и отсутствие, иначе прошла бы
    // незамеченной.
    const empty = buildProbe(`${CHAT_LOADER_KEY}=<пусто>`, { [CHAT_LOADER_KEY]: '' });
    expect(
      carryingLoader(empty).slice(0, 10),
      'при пустом значении ключа в выводе есть адрес загрузчика: значит пустота принята за ' +
        'объявление, а спека называет её третьим состоянием',
    ).toEqual([]);
    const facades = [...empty.pages.entries()]
      .filter(([, html]) => byDataName(html, SEL_CHAT_FACADE).length > 0)
      .map(([p]) => p);
    const sameAsMissing = [...state3.pages.entries()]
      .filter(([, html]) => byDataName(html, SEL_CHAT_FACADE).length > 0)
      .map(([p]) => p);
    expect(
      facades.length,
      `пустое значение и отсутствие ключа дали разный вывод: фасад на ${facades.length} ` +
        `страницах против ${sameAsMissing.length}. Это одно состояние, а не два`,
    ).toBe(sameAsMissing.length);
  }, PROBE_TIMEOUT_MS);
});

// ─── Датозависимого фрагмента в нашей разметке нет ───────────────────────────

describe('облик не зависит от года сборки', () => {
  /**
   * Требование «Датозависимого фрагмента в нашей разметке нет, и это проверяется».
   *
   * Прежде проверка была ОБРАТНОЙ и жила в `external-widgets-build-year.spec.ts`: строка
   * знаков наград зависела от года, поэтому два прогона при разных `BUILD_YEAR` обязаны
   * были РАЗЛИЧАТЬСЯ, а фрагмент исключался из сравнения облика. Знак теперь выводит сам
   * сервис, года в нём нет, и предикат перевернулся: наша разметка обязана СОВПАДАТЬ.
   *
   * Браузер здесь не нужен и снят вместе с 317 строками того файла: предмет — совпадение
   * собранной разметки, а не поведение страницы. Две пробные сборки вместо двух сборок
   * плюс двух раздач и двух браузерных контекстов.
   */
  let yearA: ProbeBuild;
  let yearB: ProbeBuild;

  beforeAll(async () => {
    yearA = buildProbe('BUILD_YEAR=2026', { BUILD_YEAR: '2026', [CHAT_LOADER_KEY]: CHAT_LOADER_NONE });
    yearB = buildProbe('BUILD_YEAR=2031', { BUILD_YEAR: '2031', [CHAT_LOADER_KEY]: CHAT_LOADER_NONE });
  }, PROBE_TIMEOUT_MS);

  it('две сборки при разных годах дают одинаковую разметку', () => {
    // Непустота предмета: без страниц утверждение о совпадении тривиально верно.
    expect(yearA.pages.size, 'проба не собрала ни одной страницы').toBeGreaterThan(0);
    expect(
      [...yearB.pages.keys()].sort(),
      'наборы страниц двух сборок различаются — сравнивать нечего',
    ).toEqual([...yearA.pages.keys()].sort());

    const differing = [...yearA.pages.entries()]
      .filter(([path, html]) => yearB.pages.get(path) !== html)
      .map(([path]) => path);
    expect(
      differing,
      `разметка зависит от года сборки на ${differing.length} страницах: ${differing.slice(0, 5).join(', ')}`,
    ).toEqual([]);
  });

  it('года сборки нет в разметке ни одной страницы', () => {
    // Отдельный признак, потому что предыдущий тест зелен и в случае, когда `BUILD_YEAR`
    // до сборки не доезжает вовсе: тогда обе пробы одинаковы по другой причине.
    const withYear = [...yearB.pages.entries()]
      .filter(([, html]) => html.includes('2031'))
      .map(([path]) => path);
    expect(withYear, 'год сборки попал в разметку').toEqual([]);
  });
});
