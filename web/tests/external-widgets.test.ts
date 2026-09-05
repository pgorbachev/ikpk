import { describe, it, expect, afterEach } from 'vitest';
import {
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
 * Объявление знака в данных — ОДНО поле.
 *
 * Прежде их было четыре: год действия, источник, свидетельство награждения и
 * свидетельство права размещать марку. Все четыре существовали, чтобы НАША отрисовка
 * марки не утверждала непроверенного. Знак выводит официальное встраивание сервиса
 * (решение владельца 2026-09-05), копии больше нет, и вместе с ней исчез предмет трёх
 * полей: утверждает Яндекс, подтверждать нам нечего.
 */
interface AwardBadgeDeclaration {
  provider: 'yandex-maps' | '2gis';
  /** Идентификатор организации в сервисе. Пусто — знак не показывается. */
  orgId: string | null;
  title: string;
}

describe('знак награды выводит сам сервис, а не мы', () => {
  type Visible = (declared: readonly AwardBadgeDeclaration[]) => AwardBadgeDeclaration[];
  type EmbedSrc = (badge: AwardBadgeDeclaration) => string | null;
  const visible = (): Promise<Visible> =>
    load<Visible>('../src/lib/award-badges', 'visibleAwardBadges');
  const embedSrc = (): Promise<EmbedSrc> =>
    load<EmbedSrc>('../src/lib/award-badges', 'badgeEmbedSrc');

  const yandex = (over: Partial<AwardBadgeDeclaration> = {}): AwardBadgeDeclaration => ({
    provider: 'yandex-maps',
    orgId: '112883331290',
    title: 'Награда «Хорошее место» на Яндекс.Картах',
    ...over,
  });

  it('идентификатор объявлен — знак показывается, и адрес ведёт на встраивание сервиса', async () => {
    const badge = yandex();
    expect((await visible())([badge])).toEqual([badge]);
    // Адрес замерен 2026-09-05: отвечает 200, отдаёт официальный знак с живым рейтингом.
    expect((await embedSrc())(badge)).toBe(
      'https://yandex.ru/sprav/widget/rating-badge/112883331290?type=award',
    );
  });

  it('идентификатор не объявлен — знака нет', async () => {
    // Три входа, а не один: пусто, пробел и null — спека называет их одним состоянием,
    // но реализация, различающая их, прошла бы проверку одного входа незамеченной.
    for (const orgId of ['', '   ', null]) {
      const badge = yandex({ orgId });
      expect((await visible())([badge]), `orgId=${JSON.stringify(orgId)}`).toEqual([]);
      expect((await embedSrc())(badge)).toBeNull();
    }
  });

  it('у 2ГИС встраивания нет — знак не показывается даже с идентификатором', async () => {
    // Не «2ГИС его не выдаёт»: это НЕ ПРОВЕРЕНО, карточки ИКПК там нет и измерять было
    // нечего. Ровно такое непроверенное утверждение про Яндекс уже стояло в спеке и
    // оказалось ложным, поэтому реализация молчит о чужом продукте, а не утверждает.
    const badge: AwardBadgeDeclaration = {
      provider: '2gis',
      orgId: '70000001017890086',
      title: 'Знак 2ГИС',
    };
    expect((await embedSrc())(badge)).toBeNull();
    expect((await visible())([badge])).toEqual([]);
  });

  it('различает объявленные и необъявленные в одном списке', async () => {
    // Различительный тест: проверка, отвергающая всё, была бы зелёной и для реализации,
    // которая не показывает знак никогда.
    const good = yandex();
    const bad = yandex({ orgId: null });
    expect((await visible())([bad, good, bad])).toEqual([good]);
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
