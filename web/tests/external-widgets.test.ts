import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BUILD_YEAR_KEY,
  CHAT_LOADER_KEY,
  CHAT_LOADER_NONE,
  type ChatLoaderConfig,
  FOREIGN_METRIKA_ID,
  METRIKA_TAG_URL,
  OWN_METRIKA_ID,
  REVIEWS_AVATAR_HOST,
  REVIEWS_WIDGET_HOST,
} from './helpers/external-widgets';

/**
 * Тесты по спеке change `external-widgets` — часть, у которой предмет ИСХОДНЫЙ КОД, а
 * не собранный вывод: состав знаков наград, перечень сторонних хостов и конфигурация
 * адреса загрузчика чата.
 *
 * Предмет ЗДЕСЬ не является ни боевым, ни демо-выводом, поэтому файл идёт основным
 * прогоном (`vitest.config.ts`), а не специализированной конфигурацией. Ни один
 * каталог вывода этот файл не объявляет — инвариант «ровно один предмет» соблюдён по
 * построению (`web/tests/demo-gate.test.ts:670`).
 *
 * ── ЧЕГО ЗДЕСЬ БОЛЬШЕ НЕТ ────────────────────────────────────────────────────
 * Восемь проверок модуля `isWithinManagerHours` снято. Требование о выводе
 * принадлежности момента часам работы спека сняла целиком: полуоткрытый интервал и зона
 * Europe/Moscow — настройка портала стороннего сервиса, а не наш код, и проверять в
 * нашем выводе нечего. Модуля `web/src/lib/manager-hours.ts` не будет. Подгонять
 * проверки под живое требование было нельзя: подогнанный тест зелен по совпадению.
 *
 * ── ШВЫ, ВЫБРАННЫЕ ЭТИМИ ТЕСТАМИ ────────────────────────────────────────────
 * Спека модулей не называет — она называет ПОВЕДЕНИЕ. Проверке нужен адрес, поэтому
 * адреса выбраны здесь и названы одним списком, а не спрятаны по телам тестов:
 *
 *   web/src/lib/award-badges.ts    → visibleAwardBadges(declared, buildYear: number)
 *                                    buildYear(): number
 *   web/src/lib/external-widgets.ts→ THIRD_PARTY_EMBED_HOSTS: readonly string[]
 *                                    readChatLoaderConfig(raw): ChatLoaderConfig
 *                                    chatLoaderConfig(): ChatLoaderConfig
 *
 * Реализация вправе выбрать другие адреса — тогда меняются и эти тесты. Чего она НЕ
 * вправе сделать, задано спекой: состав знаков как функция от переданного ГОДА (а не
 * момента), перечень хостов в одном месте и без деления, три различимых состояния
 * конфигурации и отсутствие умолчания у адреса загрузчика.
 *
 * Импорт у каждого модуля ДИНАМИЧЕСКИЙ и внутри теста. Причина не в стиле: статический
 * импорт отсутствующего модуля роняет файл на загрузке, все `it` исчезают из отчёта, и
 * судить «по имени упавшего теста, а не по цвету прогона» становится нечем — а это
 * требование AGENTS.md к негативной проверке.
 */

async function load<T>(specifier: string, name: string): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `модуля '${specifier}' нет либо он не загружается: ${(error as Error).message}. ` +
        'Это «проверить не удалось», а не «нарушений нет».',
      { cause: error },
    );
  }
  const value = mod[name];
  if (value === undefined)
    throw new Error(`модуль '${specifier}' не экспортирует '${name}' — проверять нечем`);
  return value as T;
}

// ─── Знак награды ────────────────────────────────────────────────────────────

/**
 * Объявление знака в данных — ЧЕТЫРЕ поля.
 *
 * Третье и четвёртое названы спекой полями ДАННЫХ, а не только процессом, и это
 * существенно: свидетельство приёмки лежит в документе, которого сборка не читает, —
 * значит без поля в данных реализация не может узнать, подтверждено ли награждение и
 * проверено ли право размещать марку, и у сценариев «награждение не подтверждено» и
 * «право размещать марку не объявлено» не было бы построимого красного состояния.
 */
interface BadgeDeclaration {
  id: string;
  label?: string;
  /** Год действия знака. Сверяется с ГОДОМ СБОРКИ, а не с системными часами. */
  year: number;
  /** Карточка организации в сервисе, выдавшем знак. Пусто — источник не объявлен. */
  sourceUrl?: string | null;
  /** Чем подтверждено САМО награждение. Пусто — награждение не подтверждено. */
  awardEvidence?: string | null;
  /** Чем подтверждено ПРАВО размещать марку. Пусто — право не объявлено. */
  markUsageEvidence?: string | null;
}

describe('знак награды не утверждает непроверенного и не протухает молча', () => {
  type Visible = (declared: readonly BadgeDeclaration[], buildYear: number) => BadgeDeclaration[];
  const visible = (): Promise<Visible> =>
    load<Visible>('../src/lib/award-badges', 'visibleAwardBadges');

  const BUILD_YEAR = 2026;
  const full = (over: Partial<BadgeDeclaration> = {}): BadgeDeclaration => ({
    id: 'yandex-good-place',
    label: 'Хорошее место 2026',
    year: BUILD_YEAR,
    sourceUrl: `https://${REVIEWS_WIDGET_HOST}/maps/org/112883331290/`,
    awardEvidence: 'снимок наклейки на двери центра, владелец, 2026-08-23',
    markUsageEvidence: 'правила использования марки, обращение 2026-08-23, вывод: разрешено',
    ...over,
  });

  const EMPTY = [null, undefined, '', '   '] as const;

  it('все четыре поля объявлены и год равен году сборки — знак показывается', async () => {
    // WHEN сценария перечисляет ВСЕ ЧЕТЫРЕ поля намеренно: редакция, называвшая два,
    // делала свой WHEN надмножеством WHEN сценария «награждение не подтверждено» при
    // противоположном THEN — то есть по спеке писались два взаимоисключающих теста.
    const visibleAwardBadges = await visible();
    expect(visibleAwardBadges([full()], BUILD_YEAR).map((b) => b.id)).toEqual(['yandex-good-place']);
  });

  it('год действия МЕНЬШЕ года сборки — знак не показывается', async () => {
    const visibleAwardBadges = await visible();
    expect(
      visibleAwardBadges([full({ year: BUILD_YEAR - 1 })], BUILD_YEAR),
      'знак с прошедшим годом показан — страница утверждает просроченное',
    ).toEqual([]);
  });

  it('год действия БОЛЬШЕ года сборки — знак не показывается', async () => {
    // Обе стороны названы спекой намеренно: сценарий, покрывавший только прошедший год,
    // оставлял реализацию `year < BUILD_YEAR` удовлетворяющей всем сценариям при
    // нарушенной норме, а норма требует РАВЕНСТВА.
    const visibleAwardBadges = await visible();
    expect(visibleAwardBadges([full({ year: BUILD_YEAR + 1 })], BUILD_YEAR)).toEqual([]);
  });

  it('источник знака не объявлен — знак не показывается независимо от года', async () => {
    const visibleAwardBadges = await visible();
    for (const source of EMPTY)
      expect(
        visibleAwardBadges([full({ sourceUrl: source as string | null })], BUILD_YEAR),
        `источник '${String(source)}' принят за объявленный`,
      ).toEqual([]);
  });

  it('само награждение не подтверждено — знак не показывается', async () => {
    // Объявленных источника и года недостаточно: они говорят, откуда знак и когда он
    // действует, но не доказывают самого награждения. Два порога для двух утверждений о
    // себе на одной странице сводятся к слабейшему.
    const visibleAwardBadges = await visible();
    for (const evidence of EMPTY)
      expect(
        visibleAwardBadges([full({ awardEvidence: evidence as string | null })], BUILD_YEAR),
        `свидетельство '${String(evidence)}' принято за подтверждение награждения`,
      ).toEqual([]);
  });

  it('право размещать марку не объявлено — знак не показывается', async () => {
    // Четвёртое поле. Без него знак законно отрендерится при трёх объявленных, когда
    // условия использования чужой марки никто не проверял, — и построимого красного
    // состояния у этого нет.
    const visibleAwardBadges = await visible();
    for (const evidence of EMPTY)
      expect(
        visibleAwardBadges([full({ markUsageEvidence: evidence as string | null })], BUILD_YEAR),
        `свидетельство '${String(evidence)}' принято за подтверждение права размещать марку`,
      ).toEqual([]);
  });

  it('состав знаков вычисляется от переданного ГОДА, а не от момента запуска', async () => {
    // Спека: «год передаётся проверке значением, и её результат не зависит ни от того,
    // когда она запущена, ни от часа показа: состав знаков от момента показа не зависит
    // вовсе, и функция, принимающая момент, приглашала бы проверять несуществующую
    // зависимость».
    const visibleAwardBadges = await visible();
    const declared = [full({ year: BUILD_YEAR })];
    const first = visibleAwardBadges(declared, BUILD_YEAR).map((b) => b.id);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2031-01-02T00:00:00+03:00'));
      expect(
        visibleAwardBadges(declared, BUILD_YEAR).map((b) => b.id),
        'вывод изменился от хода системных часов — год берётся не из аргумента',
      ).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('состав знаков РАЗЛИЧАЕТСЯ у двух годов сборки — иначе подстановка ничего не меняет', async () => {
    // Положительный контроль, который спека требует обоими сценариями о сравнении облика
    // («состав знаков в этих сборках **различается**»). Без него исключение фрагмента и
    // резервирование рамки проверялись бы на предмете, где различия и не было.
    const visibleAwardBadges = await visible();
    const declared = [full({ year: BUILD_YEAR }), full({ id: 'second', year: BUILD_YEAR })];
    const thisYear = visibleAwardBadges(declared, BUILD_YEAR);
    const nextYear = visibleAwardBadges(declared, BUILD_YEAR + 1);
    expect(thisYear.length, 'при годе сборки, равном году знаков, показаны не два знака').toBe(2);
    expect(nextYear, 'при следующем годе сборки знаки всё равно показаны').toEqual([]);
  });

  it('пустое объявление даёт пустой вывод, а не исключение', async () => {
    const visibleAwardBadges = await visible();
    expect(visibleAwardBadges([], BUILD_YEAR)).toEqual([]);
  });
});

describe('год сборки берётся из конфигурации, а не из системных часов', () => {
  const reader = (): Promise<() => number> => load<() => number>('../src/lib/award-badges', 'buildYear');

  afterEach(() => {
    delete process.env[BUILD_YEAR_KEY];
  });

  it('объявленный год сборки возвращается как число', async () => {
    // Без этого механизма подстановка года невозможна вовсе: подменять системные часы
    // сборки в репозитории нечем, и у сценария «состав знаков в двух сборках
    // различается» не было бы построимого красного состояния.
    process.env[BUILD_YEAR_KEY] = '2031';
    const buildYear = await reader();
    expect(buildYear()).toBe(2031);
  });

  it('ключ не задан — берётся год системных часов, обычная сборка настройки не требует', async () => {
    delete process.env[BUILD_YEAR_KEY];
    const buildYear = await reader();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2029-03-04T10:00:00+03:00'));
      expect(buildYear()).toBe(2029);
    } finally {
      vi.useRealTimers();
    }
  });

  it('негодное значение ключа — отказ, а не молчаливое умолчание', async () => {
    // «Год сборки 2o26» не должен тихо превращаться в текущий год: тогда сборка,
    // настроенная с опечаткой, показывает знак вопреки объявлению.
    const buildYear = await reader();
    for (const raw of ['', '   ', 'позапрошлый', '20261', '2026.5']) {
      process.env[BUILD_YEAR_KEY] = raw;
      expect(
        () => buildYear(),
        `значение '${raw}' принято за год сборки, а не отвергнуто`,
      ).toThrow();
    }
  });
});

// ─── Перечень сторонних хостов ───────────────────────────────────────────────

describe('перечень сторонних хостов объявлен один раз и не делится', () => {
  const hosts = (): Promise<readonly unknown[]> =>
    load<readonly unknown[]>('../src/lib/external-widgets', 'THIRD_PARTY_EMBED_HOSTS');

  it('адрес аналитики, приходящей внутри виджета, в перечне присутствует', async () => {
    const list = await hosts();
    const metrikaHost = new URL(METRIKA_TAG_URL).hostname;
    expect(
      list.filter((entry) => entry === metrikaHost),
      `хост '${metrikaHost}' в перечне не найден — перехвату и будущей CSP нечего читать`,
    ).toHaveLength(1);
  });

  it('перечень несёт хосты обоих встраиваний', async () => {
    const list = await hosts();
    for (const host of [REVIEWS_WIDGET_HOST, REVIEWS_AVATAR_HOST, 'yastatic.net'])
      expect(list, `в перечне нет хоста '${host}'`).toContain(host);
  });

  it('перечень плоский: деления на «наши» и «чужие» нет', async () => {
    // У общего адреса тега Метрики такого деления не существует — наша аналитика и
    // виджет загружают буквально один URL, различие несёт только идентификатор
    // счётчика. Требование разделённого перечня невыполнимо как написано, поэтому
    // проверяется именно ПЛОСКАЯ форма: массив строк.
    const list = await hosts();
    expect(Array.isArray(list), 'перечень не является плоским массивом').toBe(true);
    const wrong = list.filter((entry) => typeof entry !== 'string');
    expect(wrong, `в перечне не-строки: ${JSON.stringify(wrong)}`).toEqual([]);
  });

  it('перечень не содержит повторов: одно вхождение на адрес', async () => {
    const list = (await hosts()) as string[];
    const dups = list.filter((h, i) => list.indexOf(h) !== i);
    expect(dups, `повторы в перечне: ${dups.join(', ')}`).toEqual([]);
  });

  it('идентификаторы счётчиков различны и различаются не адресом', async () => {
    // Не про перечень, а про его границу: адрес у счётчиков общий, поэтому различать
    // их перечнем хостов нельзя в принципе. Проверка держит это утверждение
    // измеримым — если однажды адреса разойдутся, требование можно будет ослабить.
    expect(FOREIGN_METRIKA_ID).not.toBe(OWN_METRIKA_ID);
    expect(new URL(METRIKA_TAG_URL).pathname).not.toContain(FOREIGN_METRIKA_ID);
    expect(new URL(METRIKA_TAG_URL).pathname).not.toContain(OWN_METRIKA_ID);
  });
});

// ─── Конфигурация адреса загрузчика чата: ТРИ состояния ──────────────────────

describe('конфигурация адреса загрузчика различимо кодирует три состояния', () => {
  type Read = (raw: unknown) => ChatLoaderConfig;
  const reader = (): Promise<Read> =>
    load<Read>('../src/lib/external-widgets', 'readChatLoaderConfig');

  const ADDRESS = 'https://cdn-ru.bitrix24.ru/b00000/crm/site_button/loader_1_abcdef.js';

  afterEach(() => {
    delete process.env[CHAT_LOADER_KEY];
  });

  /**
   * Проверяется ЧИСТАЯ функция разбора объявления, а не только чтение окружения.
   *
   * Так выбрано не для удобства: спека требует объявить конфигурацию «там, где её
   * читает проверка». У значения три потребителя — сборка, выкладка боевого сайта и
   * выкладка стенда, — и если оно живёт только в окружении выкладки, то у симметричной
   * проверки боевого вывода НЕТ ПРЕДМЕТА, а отсутствие предмета есть непройденная
   * проверка.
   */
  it('строка со схемой — первое состояние, адрес возвращается как есть', async () => {
    const readChatLoaderConfig = await reader();
    expect(readChatLoaderConfig(ADDRESS)).toEqual({ state: 'address', src: ADDRESS });
  });

  it('выделенное значение — ВТОРОЕ состояние, а не третье и не адрес', async () => {
    const readChatLoaderConfig = await reader();
    expect(
      readChatLoaderConfig(CHAT_LOADER_NONE),
      `значение '${CHAT_LOADER_NONE}' не распознано как явное объявление отсутствия: ` +
        'склейка второго состояния с третьим уничтожает развилку целиком — именно так ' +
        'выглядит бинарный контракт «адрес либо ничего»',
    ).toEqual({ state: 'declared-absent' });
  });

  it('пустое значение и отсутствие ключа — ОДНО состояние, третье', async () => {
    const readChatLoaderConfig = await reader();
    for (const raw of [undefined, null, '', '   '])
      expect(
        readChatLoaderConfig(raw),
        `значение ${JSON.stringify(raw)} отнесено не к третьему состоянию: пустое значение ` +
          'и отсутствие ключа обязаны быть одним и тем же',
      ).toEqual({ state: 'unspecified' });
  });

  it('выделенное значение строкой адреса быть не может', async () => {
    // Спека: «Объявление отсутствия — выделенное значение, которое строкой адреса быть
    // не может и с пустым значением не совпадает». Проверяется свойство самого значения,
    // а не поведение функции: иначе третье состояние можно было бы закодировать адресом.
    expect(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(CHAT_LOADER_NONE),
      `выделенное значение '${CHAT_LOADER_NONE}' разбирается как адрес — тогда состояния 1 и 2 ` +
        'неразличимы',
    ).toBe(false);
    expect(CHAT_LOADER_NONE.trim()).not.toBe('');
  });

  it('адрес без схемы объявлением адреса не является', async () => {
    // Наше правило, а не следствие чужого гейта: класс `protocol-relative` сверки
    // исполняемого вывода срабатывает только для закрытого перечня атрибутов адреса
    // (`web/tests/helpers/rich-content-safety/hazard-scan.ts:125`, `if (URL_ATTRS.has(name)`),
    // и `data-*` в него не входит — значит эту форму там не ловит ничто.
    const readChatLoaderConfig = await reader();
    expect(
      readChatLoaderConfig('//cdn-ru.bitrix24.ru/b00000/crm/site_button/loader_1_abcdef.js').state,
      'адрес без схемы принят за объявленный адрес',
    ).not.toBe('address');
  });

  it('не-строка и не-адрес объявлением адреса не являются', async () => {
    const readChatLoaderConfig = await reader();
    for (const raw of [42, true, {}, [], 'b24-cbqwqo.bitrix24site.ru', 'javascript:void 0'])
      expect(
        readChatLoaderConfig(raw).state,
        `значение ${JSON.stringify(raw)} принято за адрес`,
      ).not.toBe('address');
  });

  it('ключ читается из окружения процесса, а не только из окружения сборки', async () => {
    // Спека: «Ключ SHALL читаться из двух источников — окружения сборки и окружения
    // процесса: под юнит-прогоном без плагина Astro доступен только второй». Без этого
    // ни один юнит-тест трёх состояний не построим, а значит и красного состояния у
    // развилки нет.
    const chatLoaderConfig = await load<() => ChatLoaderConfig>(
      '../src/lib/external-widgets',
      'chatLoaderConfig',
    );
    process.env[CHAT_LOADER_KEY] = ADDRESS;
    expect(chatLoaderConfig()).toEqual({ state: 'address', src: ADDRESS });
    process.env[CHAT_LOADER_KEY] = CHAT_LOADER_NONE;
    expect(chatLoaderConfig()).toEqual({ state: 'declared-absent' });
    delete process.env[CHAT_LOADER_KEY];
    expect(chatLoaderConfig()).toEqual({ state: 'unspecified' });
  });

  it('префикса PUBLIC_ у ключа нет: адрес не должен уехать в клиентский бандл', async () => {
    // В Astro `PUBLIC_` означает статическую подстановку значения в javascript-вывод, а
    // проверка демо-вывода читает СТРАНИЦЫ — там она адрес не увидела бы вовсе.
    expect(CHAT_LOADER_KEY.startsWith('PUBLIC_'), `ключ '${CHAT_LOADER_KEY}' несёт префикс PUBLIC_`).toBe(
      false,
    );
    const source = await load<string>('../src/lib/external-widgets', 'CHAT_LOADER_KEY');
    expect(source, 'модуль объявляет ключ иначе, чем проверки').toBe(CHAT_LOADER_KEY);
  });
});
