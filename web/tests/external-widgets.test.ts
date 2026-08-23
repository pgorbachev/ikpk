import { describe, it, expect, vi } from 'vitest';
import {
  FOREIGN_METRIKA_ID,
  METRIKA_TAG_URL,
  OWN_METRIKA_ID,
  REVIEWS_AVATAR_HOST,
  REVIEWS_WIDGET_HOST,
} from './helpers/external-widgets';

/**
 * Тесты по спеке change `external-widgets` — часть, у которой предмет ИСХОДНЫЙ КОД, а
 * не собранный вывод: вывод знака награды, принадлежность момента часам работы,
 * перечень сторонних хостов и конфигурация адреса загрузчика чата.
 *
 * Предмет ЗДЕСЬ не является ни боевым, ни демо-выводом, поэтому файл идёт основным
 * прогоном (`vitest.config.ts`), а не специализированной конфигурацией. Ни один
 * каталог вывода этот файл не объявляет — инвариант «ровно один предмет» соблюдён по
 * построению (`web/tests/demo-gate.test.ts:670`).
 *
 * ── ШВЫ, ВЫБРАННЫЕ ЭТИМИ ТЕСТАМИ ────────────────────────────────────────────
 * Спека модулей не называет — она называет ПОВЕДЕНИЕ. Проверке нужен адрес, поэтому
 * адреса выбраны здесь и названы одним списком, а не спрятаны по телам тестов:
 *
 *   web/src/lib/manager-hours.ts   → isWithinManagerHours(at: Date): boolean
 *   web/src/lib/award-badges.ts    → visibleAwardBadges(declared, at: Date): AwardBadge[]
 *   web/src/lib/external-widgets.ts→ THIRD_PARTY_EMBED_HOSTS: readonly string[]
 *                                    chatLoaderSrc(): string | null
 *
 * Реализация вправе выбрать другие адреса — тогда меняются и эти тесты. Чего она НЕ
 * вправе сделать, задано спекой: вывод как функция от переданного момента, перечень
 * хостов в одном месте и без деления, отсутствие умолчания у адреса загрузчика.
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

// ─── Часы работы менеджера ───────────────────────────────────────────────────

describe('часы работы менеджера выводятся из момента, а не из снимка', () => {
  type Predicate = (at: Date) => boolean;
  const hours = (): Promise<Predicate> =>
    load<Predicate>('../src/lib/manager-hours', 'isWithinManagerHours');

  /**
   * Моменты заданы В ЗОНЕ Europe/Moscow смещением `+03:00`, а не локальным временем
   * машины: спека называет зону явно, и тест, написанный на локальном времени, дал бы
   * разный ответ у автора и на раннере — то есть проверял бы часовой пояс машины.
   *
   * Полуинтервал назван спекой поимённо: 10:00 включительно, 18:00 исключительно. Без
   * этого выбора red-тест на границах можно было написать двумя взаимоисключающими
   * способами, и оба формально соответствовали бы требованию.
   */
  const BOUNDARIES: [string, string, boolean][] = [
    ['пятница 17:59 — в часах', '2026-08-21T17:59:00+03:00', true],
    ['пятница 18:00 — вне часов', '2026-08-21T18:00:00+03:00', false],
    ['суббота 12:00 — вне часов', '2026-08-22T12:00:00+03:00', false],
    ['понедельник 09:59 — вне часов', '2026-08-24T09:59:00+03:00', false],
    ['понедельник 10:00 — в часах', '2026-08-24T10:00:00+03:00', true],
  ];

  for (const [what, iso, expected] of BOUNDARIES) {
    it(`граница проверена значением: ${what}`, async () => {
      const isWithin = await hours();
      expect(isWithin(new Date(iso)), `${iso}: ответ не тот, что назван спекой`).toBe(expected);
    });
  }

  it('ответ зависит только от переданного момента, а не от времени запуска', async () => {
    const isWithin = await hours();
    const moment = new Date('2026-08-21T11:00:00+03:00');
    const first = isWithin(moment);

    // Системные часы сдвигаются НА ДРУГУЮ СТОРОНУ границы и на другой день недели:
    // сдвиг на год этого класса дефекта не поймал бы вовсе — два прогона подряд лежат
    // по одну сторону от 18:00 (spec, «Датозависимые фрагменты», абзац про час и день).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-23T19:30:00+03:00'));
      expect(
        isWithin(moment),
        'вывод изменился от хода системных часов — момент берётся не из аргумента',
      ).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('внутри рабочего окна пятницы момент признан рабочим', async () => {
    const isWithin = await hours();
    expect(isWithin(new Date('2026-08-21T10:00:00+03:00'))).toBe(true);
    expect(isWithin(new Date('2026-08-21T13:00:00+03:00'))).toBe(true);
  });

  it('воскресенье вне часов работы целиком', async () => {
    const isWithin = await hours();
    for (const iso of ['2026-08-23T00:30:00+03:00', '2026-08-23T12:00:00+03:00', '2026-08-23T23:59:00+03:00'])
      expect(isWithin(new Date(iso)), `${iso}: воскресенье признано рабочим`).toBe(false);
  });
});

// ─── Знак награды ────────────────────────────────────────────────────────────

interface BadgeDeclaration {
  id: string;
  label?: string;
  year: number;
  /** Карточка организации в сервисе, выдавшем знак. Пусто — источник не объявлен. */
  sourceUrl?: string | null;
  /** Свидетельство САМОГО награждения. Пусто — награждение не подтверждено. */
  evidence?: string | null;
}

describe('знак награды не утверждает непроверенного и не протухает молча', () => {
  type Visible = (declared: readonly BadgeDeclaration[], at: Date) => BadgeDeclaration[];
  const visible = (): Promise<Visible> =>
    load<Visible>('../src/lib/award-badges', 'visibleAwardBadges');

  const AT = new Date('2026-08-23T12:00:00+03:00');
  const full = (over: Partial<BadgeDeclaration> = {}): BadgeDeclaration => ({
    id: 'yandex-good-place',
    label: 'Хорошее место 2026',
    year: 2026,
    sourceUrl: `https://${REVIEWS_WIDGET_HOST}/maps/org/112883331290/`,
    evidence: 'письменное подтверждение заказчика, 2026-08-23',
    ...over,
  });

  it('год действия совпадает с текущим — знак показывается', async () => {
    const visibleAwardBadges = await visible();
    expect(visibleAwardBadges([full()], AT).map((b) => b.id)).toEqual(['yandex-good-place']);
  });

  it('год действия прошёл — знак не показывается', async () => {
    const visibleAwardBadges = await visible();
    expect(
      visibleAwardBadges([full({ year: 2025 })], AT),
      'знак с прошедшим годом показан — страница утверждает просроченное',
    ).toEqual([]);
  });

  it('год действия в будущем — знак не показывается', async () => {
    // Требование сформулировано равенством («год действия, равный текущему году»), а
    // не неравенством: знак 2027 года в 2026-м утверждает ненаступившее.
    const visibleAwardBadges = await visible();
    expect(visibleAwardBadges([full({ year: 2027 })], AT)).toEqual([]);
  });

  it('источник знака не объявлен — знак не показывается независимо от года', async () => {
    const visibleAwardBadges = await visible();
    for (const source of [null, undefined, '', '   '])
      expect(
        visibleAwardBadges([full({ sourceUrl: source as string | null })], AT),
        `источник '${String(source)}' принят за объявленный`,
      ).toEqual([]);
  });

  it('само награждение не подтверждено — знак не показывается', async () => {
    // Объявленных источника и года недостаточно: они говорят, откуда знак и когда он
    // действует, но не доказывают самого награждения. Два порога для двух утверждений о
    // себе на одной странице сводятся к слабейшему.
    const visibleAwardBadges = await visible();
    for (const evidence of [null, undefined, '', '   '])
      expect(
        visibleAwardBadges([full({ evidence: evidence as string | null })], AT),
        `свидетельство '${String(evidence)}' принято за подтверждение награждения`,
      ).toEqual([]);
  });

  it('вывод зависит только от переданного момента, а не от времени запуска', async () => {
    const visibleAwardBadges = await visible();
    const declared = [full({ year: 2026 })];
    const first = visibleAwardBadges(declared, AT).map((b) => b.id);

    vi.useFakeTimers();
    try {
      // Год системных часов уводится в сторону — если вывод считается от `new Date()`,
      // ответ поменяется. Тот же класс дефекта уже был у статуса семинара.
      vi.setSystemTime(new Date('2031-01-02T00:00:00+03:00'));
      expect(
        visibleAwardBadges(declared, AT).map((b) => b.id),
        'вывод изменился от хода системных часов — момент берётся не из аргумента',
      ).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('пустое объявление даёт пустой вывод, а не исключение', async () => {
    const visibleAwardBadges = await visible();
    expect(visibleAwardBadges([], AT)).toEqual([]);
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

// ─── Конфигурация адреса загрузчика чата ─────────────────────────────────────

describe('адрес загрузчика чата берётся из конфигурации и умолчания не имеет', () => {
  type Read = (raw: unknown) => string | null;
  const reader = (): Promise<Read> =>
    load<Read>('../src/lib/external-widgets', 'readChatLoaderConfig');

  /**
   * Проверяется ЧИСТАЯ функция разбора объявления, а не чтение окружения.
   *
   * Так выбрано не для удобства: спека требует объявить конфигурацию «там, где её
   * читает проверка». У значения три потребителя — сборка, выкладка боевого сайта и
   * выкладка стенда, — и если оно живёт только в окружении выкладки, то у симметричной
   * проверки боевого вывода НЕТ ПРЕДМЕТА, а отсутствие предмета есть непройденная
   * проверка. Значение, читаемое только Astro из окружения, обычному прогону vitest
   * недоступно, поэтому объявление обязано быть КОММИТНУТЫМ, а `chatLoaderSrc()` —
   * применением этой функции к нему.
   */
  it('объявленный адрес возвращается как есть', async () => {
    const readChatLoaderConfig = await reader();
    const src = 'https://cdn-ru.bitrix24.ru/b00000/crm/site_button/loader_1_abcdef.js';
    expect(readChatLoaderConfig(src)).toBe(src);
  });

  it('объявления нет — null, а не подставленный адрес', async () => {
    const readChatLoaderConfig = await reader();
    for (const raw of [undefined, null, '', '   ']) {
      expect(
        readChatLoaderConfig(raw),
        `значение ${JSON.stringify(raw)} принято за объявленный адрес: у заказчика два ` +
          'портала Bitrix24, и молчаливый выбор одного направил бы обращения не туда',
      ).toBeNull();
    }
  });

  it('адрес без схемы объявлением не является', async () => {
    // Наше правило, а не следствие чужого гейта: класс `protocol-relative` сверки
    // исполняемого вывода срабатывает только для закрытого перечня атрибутов адреса
    // (`web/tests/helpers/rich-content-safety/hazard-scan.ts:125`, `if (URL_ATTRS.has(name)`),
    // и `data-*` в него не входит — значит эту форму там не ловит ничто.
    const readChatLoaderConfig = await reader();
    expect(
      readChatLoaderConfig('//cdn-ru.bitrix24.ru/b00000/crm/site_button/loader_1_abcdef.js'),
      'адрес без схемы принят',
    ).toBeNull();
  });

  it('не-строка и не-адрес объявлением не являются', async () => {
    const readChatLoaderConfig = await reader();
    for (const raw of [42, true, {}, [], 'b24-cbqwqo.bitrix24site.ru', 'javascript:void 0'])
      expect(readChatLoaderConfig(raw), `значение ${JSON.stringify(raw)} принято`).toBeNull();
  });

  it('chatLoaderSrc() читает коммитнутое объявление и падать не имеет права', async () => {
    // Функция обязана существовать и возвращать либо адрес, либо null. Именно её
    // читают проверки вывода: у них другого способа узнать конфигурацию сборки нет.
    const chatLoaderSrc = await load<() => string | null>(
      '../src/lib/external-widgets',
      'chatLoaderSrc',
    );
    const value = chatLoaderSrc();
    expect(
      value === null || typeof value === 'string',
      'chatLoaderSrc() вернул не адрес и не null',
    ).toBe(true);
    if (typeof value === 'string')
      expect(/^https?:\/\//.test(value), `объявленный адрес '${value}' записан без схемы`).toBe(true);
  });
});
