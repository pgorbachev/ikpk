/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`,
 * capability `cms-content-authoring`: грамматика идентификатора, области
 * уникальности, плоский адрес, история адресов.
 *
 * Реализации нет — модуль `./cms-content-address.ts` подгружается динамически
 * (см. `./cms-authoring-contract.ts`), поэтому каждый сценарий краснеет отдельно.
 *
 * Негативная верификация на этапе написания: каждая проверка сформулирована так, что
 * реализация, делающая ОБРАТНОЕ требованию, её роняет. Где это не так по построению
 * (проверка «сохраняется» проходит и на реализации, которая не проверяет ничего),
 * рядом стоит парная проверка на отказ — одна без другой ничего не стоит.
 */

import { describe, expect, it } from 'vitest';
import {
  loadContentAddress,
  type AddressState,
  type RecordRef,
} from './cms-authoring-contract';

const INSTITUTES = ['institut-klinicheskoy-prikladnoy-kineziologii', 'institut-apledzhera', 'institut-barralya'];

const record = (over: Partial<RecordRef> & Pick<RecordRef, 'id' | 'type' | 'identifier'>): RecordRef => ({
  ...over,
});

/**
 * Состояние системы: три института, программа `dolgoletie`, семинар `cst-1` в другой
 * программе, перенесённая статическая страница `kontakty`.
 *
 * `buildRouteSegments` содержит и сегменты каталогов — спека требует, чтобы они входили
 * в множество занятых сегментов, потому что каталоги и есть маршруты сборки.
 */
function baseState(extra: Partial<AddressState> = {}): AddressState {
  const records: RecordRef[] = [
    ...INSTITUTES.map((slug, i) => record({ id: `i${i + 1}`, type: 'institute', identifier: slug })),
    record({ id: 'p1', type: 'course-group', identifier: 'dolgoletie' }),
    record({ id: 'p2', type: 'course-group', identifier: 'prikladnaya-kineziologiya' }),
    record({ id: 's1', type: 'seminar', identifier: 'cst-1' }),
    record({ id: 'page-kontakty', type: 'static-page', identifier: 'kontakty', previousAddresses: ['/kontakty'] }),
  ];
  return {
    records,
    addressHistory: [
      { address: '/instituty/institut-apledzhera', ownerId: 'i2' },
      { address: '/institut-apledzhera', ownerId: 'i2' },
      { address: '/kontakty', ownerId: 'page-kontakty' },
    ],
    buildRouteSegments: [
      'instituty',
      'programmy',
      'seminary',
      'specialisty',
      'statyi',
      'video',
      'kontakty',
      'oplata',
      'raspisanie-i-tseny',
      'sitemap',
    ],
    ...extra,
  };
}

describe('cms-content-authoring: грамматика идентификатора', () => {
  // Scenario: идентификатор соответствует грамматике
  it.each(['cst-1', 'dolgoletie', 'a', 'a1-b2-c3', '2026-god'])(
    'принимает %s — строчные латинские, цифры, одиночные дефисы',
    async (identifier) => {
      const { isValidIdentifier } = await loadContentAddress();
      expect(isValidIdentifier(identifier)).toBe(true);
    },
  );

  // Scenario: верхний регистр, точка, подчёркивание и пробел не принимаются.
  // Точка и подчёркивание названы отдельно: кодирование адреса они проходят без
  // изменений, поэтому критерий «символы, меняющиеся при кодировании» их пропустил бы.
  it.each(['Kontakty', 'kon.takty', 'kon_takty', 'kon takty', 'контакты', 'kon/takty', 'kon%20takty'])(
    'отклоняет %s',
    async (identifier) => {
      const { isValidIdentifier } = await loadContentAddress();
      expect(isValidIdentifier(identifier)).toBe(false);
    },
  );

  it.each(['-cst', 'cst-', 'cst--1', '-', '--'])('отклоняет краевой или двойной дефис: %s', async (identifier) => {
    const { isValidIdentifier } = await loadContentAddress();
    expect(isValidIdentifier(identifier)).toBe(false);
  });

  it('пустой идентификатор не принимается', async () => {
    const { isValidIdentifier } = await loadContentAddress();
    expect(isValidIdentifier('')).toBe(false);
  });

  it('недопустимый идентификатор роняет проверку записи, а не только грамматику', async () => {
    const { checkIdentifier } = await loadContentAddress();
    const verdict = checkIdentifier({
      record: record({ id: 'new', type: 'seminar', identifier: 'CST_1' }),
      state: baseState(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/CST_1/);
  });
});

describe('cms-content-authoring: области уникальности заданы каталогами', () => {
  // Scenario: повторный идентификатор внутри каталога не принимается.
  // Занят семинаром ДРУГОЙ программы: под плоской схемой родитель области не задаёт.
  it('семинар с идентификатором, занятым семинаром другой программы, не сохраняется', async () => {
    const { checkIdentifier } = await loadContentAddress();
    const verdict = checkIdentifier({
      record: record({ id: 'new', type: 'seminar', identifier: 'cst-1' }),
      state: baseState(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflictWith, 'отказ не называет запись, за которой закреплён идентификатор').toBe('s1');
  });

  // Scenario: совпадение идентификаторов у записей разных типов допустимо
  it('семинар с идентификатором программы сохраняется: каталоги разные', async () => {
    const { checkIdentifier, addressOf } = await loadContentAddress();
    const verdict = checkIdentifier({
      record: record({ id: 'new', type: 'seminar', identifier: 'dolgoletie' }),
      state: baseState(),
    });
    expect(verdict.ok).toBe(true);
    expect(addressOf({ type: 'seminar', identifier: 'dolgoletie' })).toBe('/seminary/dolgoletie');
    expect(addressOf({ type: 'course-group', identifier: 'dolgoletie' })).toBe('/programmy/dolgoletie');
  });

  it('институт больше не занимает сегмент первого уровня, а живёт в каталоге', async () => {
    const { addressOf } = await loadContentAddress();
    expect(addressOf({ type: 'institute', identifier: 'institut-apledzhera' })).toBe(
      '/instituty/institut-apledzhera',
    );
  });

  // Scenario: перенесённая страница не считается конфликтом со своим же маршрутом.
  // Тождество устанавливается по ПРЕЖНЕМУ АДРЕСУ, а не по совпадению имени.
  it.each(['kontakty', 'statyi'])(
    'перенесённая статическая страница %s не конфликтует с раздающим её маршрутом',
    async (identifier) => {
      const { checkIdentifier } = await loadContentAddress();
      const verdict = checkIdentifier({
        record: record({
          id: `page-${identifier}`,
          type: 'static-page',
          identifier,
          previousAddresses: [`/${identifier}`],
        }),
        state: baseState({
          records: baseState().records.filter((r) => r.id !== 'page-kontakty'),
          addressHistory: [],
        }),
      });
      expect(verdict.ok, verdict.message).toBe(true);
    },
  );

  // Scenario: новая страница не занимает сегмент перенесённой
  it('новая статическая страница kontakty без прежнего адреса не сохраняется', async () => {
    const { checkIdentifier } = await loadContentAddress();
    const verdict = checkIdentifier({
      record: record({ id: 'new-page', type: 'static-page', identifier: 'kontakty' }),
      state: baseState(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/kontakty/);
  });

  // Scenario: идентификатор статической страницы не занимает сегмент маршрута
  it.each(['seminary', 'statyi', 'sitemap'])(
    'новая статическая страница не занимает сегмент маршрута сборки: %s',
    async (identifier) => {
      const { checkIdentifier } = await loadContentAddress();
      const verdict = checkIdentifier({
        record: record({ id: 'new-page', type: 'static-page', identifier }),
        state: baseState(),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.message).toMatch(new RegExp(identifier));
    },
  );

  // Занятые сегменты определяются СОСТАВОМ маршрутов, а не перечнем в коде правила:
  // сегмент, которого в списке не было, обязан начать конфликтовать сам по себе.
  it('новый маршрут сборки занимает сегмент без правки правила', async () => {
    const { checkIdentifier } = await loadContentAddress();
    const state = baseState();
    const before = checkIdentifier({
      record: record({ id: 'new-page', type: 'static-page', identifier: 'garantii' }),
      state,
    });
    expect(before.ok, 'свободный сегмент не должен отвергаться').toBe(true);

    const after = checkIdentifier({
      record: record({ id: 'new-page', type: 'static-page', identifier: 'garantii' }),
      state: { ...state, buildRouteSegments: [...state.buildRouteSegments, 'garantii'] },
    });
    expect(after.ok, 'признак занятости не читает состав маршрутов').toBe(false);
  });
});

describe('cms-content-authoring: адрес плоский и складывается из каталога и идентификатора', () => {
  // Scenario: адрес персоны не зависит от института
  it('адрес персоны не содержит института', async () => {
    const { addressOf } = await loadContentAddress();
    const address = addressOf({ type: 'person', identifier: 'ivanov' });
    expect(address).toBe('/specialisty/ivanov');
    for (const institute of INSTITUTES) expect(address).not.toContain(institute);
  });

  // Scenario: новый семинар доступен по плоскому адресу (часть про вычисление адреса;
  // часть про собранный сайт — см. отметку в конце файла)
  it('адрес семинара не содержит ни института, ни программы', async () => {
    const { addressOf } = await loadContentAddress();
    const address = addressOf({ type: 'seminar', identifier: 'novyj-seminar' });
    expect(address).toBe('/seminary/novyj-seminar');
    expect(address).not.toContain('prikladnaya-kineziologiya');
  });

  // Scenario: семинар в двух программах имеет один адрес.
  // Адрес — функция типа и идентификатора, поэтому связи в него войти не могут: у
  // `addressOf` их нет в аргументах вовсе, и второго адреса появиться не из чего.
  it('адрес не зависит от связей: у записи ровно один канонический адрес', async () => {
    const { addressOf } = await loadContentAddress();
    expect(addressOf({ type: 'seminar', identifier: 'cst-1' })).toBe(
      addressOf({ type: 'seminar', identifier: 'cst-1' }),
    );
  });

  it('каталог следует из типа для всех четырёх типов', async () => {
    const { addressOf } = await loadContentAddress();
    expect(addressOf({ type: 'institute', identifier: 'x' })).toBe('/instituty/x');
    expect(addressOf({ type: 'course-group', identifier: 'x' })).toBe('/programmy/x');
    expect(addressOf({ type: 'seminar', identifier: 'x' })).toBe('/seminary/x');
    expect(addressOf({ type: 'person', identifier: 'x' })).toBe('/specialisty/x');
    expect(addressOf({ type: 'article', identifier: 'x' })).toBe('/statyi/x');
    expect(addressOf({ type: 'video-playlist', identifier: 'x' })).toBe('/video/x');
  });

  it('статическая страница — сегмент первого уровня, а не каталог', async () => {
    const { addressOf } = await loadContentAddress();
    expect(addressOf({ type: 'static-page', identifier: 'garantii' })).toBe('/garantii');
  });
});

describe('cms-content-authoring: история адресов и повторное занятие', () => {
  // Scenario: освободившийся адрес нельзя занять повторно
  it('идентификатор, дающий адрес из истории ДРУГОЙ записи, не принимается', async () => {
    const { checkIdentifier } = await loadContentAddress();
    const verdict = checkIdentifier({
      record: record({ id: 'new', type: 'institute', identifier: 'byvshij' }),
      state: baseState({
        addressHistory: [{ address: '/instituty/byvshij', ownerId: 'i2' }],
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflictWith).toBe('i2');
  });

  // Scenario: освободившийся сегмент первого уровня не занимается статической страницей
  it('прежний адрес института не занимается статической страницей', async () => {
    const { checkIdentifier } = await loadContentAddress();
    const verdict = checkIdentifier({
      record: record({ id: 'new-page', type: 'static-page', identifier: 'institut-apledzhera' }),
      state: baseState(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflictWith).toBe('i2');
  });

  // Scenario: адрес удалённой записи остаётся занятым.
  // Владелец истории в `records` отсутствует — запись удалена, история осталась.
  it('история переживает удаление владельца', async () => {
    const { checkIdentifier } = await loadContentAddress();
    const verdict = checkIdentifier({
      record: record({ id: 'new', type: 'seminar', identifier: 'udalennyj' }),
      state: baseState({
        addressHistory: [{ address: '/seminary/udalennyj', ownerId: 'deleted-1' }],
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflictWith).toBe('deleted-1');
  });

  // Scenario: запись может вернуть себе прежний идентификатор
  it('запись возвращает себе прежний идентификатор из своей же истории', async () => {
    const { checkIdentifier } = await loadContentAddress();
    const verdict = checkIdentifier({
      record: record({ id: 's1', type: 'seminar', identifier: 'staryj-kod' }),
      state: baseState({
        addressHistory: [{ address: '/seminary/staryj-kod', ownerId: 's1' }],
      }),
    });
    expect(verdict.ok, verdict.message).toBe(true);
  });

  // Scenario: переименование даёт перенаправление
  // Scenario: легаси-адрес ведёт на текущий адрес
  it('всякий адрес из истории ведёт на текущий адрес записи', async () => {
    const { redirectsFor } = await loadContentAddress();
    const state = baseState({
      records: [record({ id: 's1', type: 'seminar', identifier: 'tretij' })],
      addressHistory: [
        { address: '/institut-apledzhera/dolgoletie/pervyj', ownerId: 's1' },
        { address: '/seminary/pervyj', ownerId: 's1' },
        { address: '/seminary/vtoroj', ownerId: 's1' },
      ],
    });
    const redirects = redirectsFor({ recordId: 's1', state });
    expect(redirects.length).toBeGreaterThan(0);
    for (const r of redirects) expect(r.to).toBe('/seminary/tretij');
  });

  // Scenario: два переименования подряд не дают цепочки
  it('промежуточного перехода между двумя прежними адресами нет', async () => {
    const { redirectsFor } = await loadContentAddress();
    const state = baseState({
      records: [record({ id: 's1', type: 'seminar', identifier: 'tretij' })],
      addressHistory: [
        { address: '/seminary/pervyj', ownerId: 's1' },
        { address: '/seminary/vtoroj', ownerId: 's1' },
      ],
    });
    const redirects = redirectsFor({ recordId: 's1', state });
    expect(redirects.map((r) => r.from).sort()).toEqual(['/seminary/pervyj', '/seminary/vtoroj']);
    expect(
      redirects.some((r) => r.to === '/seminary/vtoroj'),
      'цепочка: прежний адрес ведёт на прежний, а не на текущий',
    ).toBe(false);
  });

  // Scenario: запись может вернуть себе прежний идентификатор (вторая половина)
  it('перенаправления с текущего адреса на него самого не появляется', async () => {
    const { redirectsFor } = await loadContentAddress();
    const state = baseState({
      records: [record({ id: 's1', type: 'seminar', identifier: 'pervyj' })],
      addressHistory: [
        { address: '/seminary/pervyj', ownerId: 's1' },
        { address: '/seminary/vtoroj', ownerId: 's1' },
      ],
    });
    const redirects = redirectsFor({ recordId: 's1', state });
    expect(redirects.map((r) => r.from)).not.toContain('/seminary/pervyj');
    for (const r of redirects) expect(r.from).not.toBe(r.to);
  });

  // Scenario: переименование программы не меняет адресов её семинаров
  // Scenario: перенос в другую программу не меняет адреса
  it('переименование программы не порождает перенаправлений для её семинаров', async () => {
    const { redirectsFor } = await loadContentAddress();
    const state = baseState({
      records: [
        record({ id: 'p1', type: 'course-group', identifier: 'novoe-imya' }),
        record({ id: 's1', type: 'seminar', identifier: 'cst-1' }),
      ],
      addressHistory: [
        { address: '/programmy/dolgoletie', ownerId: 'p1' },
        { address: '/seminary/cst-1', ownerId: 's1' },
      ],
    });
    expect(redirectsFor({ recordId: 's1', state })).toEqual([]);
    expect(redirectsFor({ recordId: 'p1', state })).toEqual([
      { from: '/programmy/dolgoletie', to: '/programmy/novoe-imya' },
    ]);
  });
});

/*
 * СЦЕНАРИИ ЭТИХ ТРЁХ ТРЕБОВАНИЙ БЕЗ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ ЗДЕСЬ
 *
 * - «новый семинар доступен по плоскому адресу», «адрес присутствует в карте сайта»,
 *   «сегмент каталога отвечает списком», «страница персоны доступна» — предмет
 *   СОБРАННОГО САЙТА. Часть про вычисление адреса покрыта выше; часть про сборку
 *   проверяется на выводе и лежит в `web/tests/cms-catalog-pages.test.ts`.
 * - «запрос прежнего адреса постоянно перенаправляется одним переходом» — ответ
 *   раздачи. Раздача в тестах не поднимается (nginx не является зависимостью
 *   проекта), предмет здесь — состав правил, он покрыт `redirectsFor` и
 *   `web/tests/cms-migration-artifacts.test.ts`; фактический ответ 301 требует
 *   свидетельства с живой раздачи.
 * - «история адресов не редактируется ролями» — права в развёрнутом Strapi. Файловая
 *   часть (тип истории не показывается в менеджере контента) покрыта
 *   `web/tests/cms-schema-contract.test.ts`; отказ живого интерфейса — ручное
 *   свидетельство.
 */
