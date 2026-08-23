import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SEL_AWARD_BADGE,
  SEL_CHAT_HOURS,
  SEL_CHAT_TRIGGER,
  SEL_REVIEWS_SECTION,
} from './helpers/external-widgets';

/**
 * Тесты по спеке change `external-widgets` — устройство БРАУЗЕРНЫХ ПРОГОНОВ, проверяемое
 * по репозиторию, а не запуском.
 *
 * Почему статически: требование «сторонние встраивания не попадают живыми ни в один
 * браузерный прогон» — про КАЖДЫЙ прогон, а не про один. Запуском его не проверить:
 * прогон, в который перехват не введён, зелен ровно до того дня, когда чужой хост
 * ответит иначе, — то есть отсутствие сигнала выдаётся за отсутствие проблемы. Здесь
 * проверяется то, что можно проверить всегда: где перехват объявлен, где он ОСОЗНАННО не
 * введён и записано ли известное отклонение там, где перехвата нет вовсе.
 *
 * Предмет — файлы репозитория. Ни один каталог вывода не читается.
 */

const WEB = join(import.meta.dirname, '..');
const ROOT = join(WEB, '..');
const TESTS_DIR = join(WEB, 'tests');

/** Модуль перехвата — ШОВ, выбранный этими тестами. */
const GUARD_MODULE = 'tests/helpers/third-party-guard.ts';
/** Маркер осознанного невведения перехвата: прогон, чей предмет — живой внешний ответ. */
const EXEMPT_MARKER = 'THIRD_PARTY_GUARD_EXEMPT';
/** Единственный прогон, предмет которого и есть внешний ответ. */
const LIVE_COMPARISON = 'compare.spec.ts';

const specFiles = (): string[] => {
  const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.spec.ts'));
  expect(files.length, 'в tests/ нет ни одного *.spec.ts — проверять нечего').toBeGreaterThan(0);
  return files;
};

/** Конфигурации, в которых любое внешнее имя УЖЕ неразрешимо на уровне браузера. */
function configsWithResolverBlock(): string[] {
  return readdirSync(WEB)
    .filter((f) => /^playwright\..*config\.ts$/.test(f) || f === 'playwright.config.ts')
    .filter((f) => readFileSync(join(WEB, f), 'utf-8').includes('--host-resolver-rules'));
}

/** Конфигурации без запрета разрешения имён — именно в них перехват и надо ввести. */
function configsWithoutResolverBlock(): string[] {
  const all = readdirSync(WEB).filter((f) => /^playwright\..*\.config\.ts$/.test(f) || f === 'playwright.config.ts');
  return all.filter((f) => !readFileSync(join(WEB, f), 'utf-8').includes('--host-resolver-rules'));
}

describe('сторонние встраивания не попадают живыми ни в один браузерный прогон', () => {
  it('картина конфигураций та, из которой спека выводит перечень', () => {
    // Сторож против вырождения: если запрет разрешения имён исчезнет или появится
    // везде, перечень ниже перестанет что-либо значить, а проверки останутся зелёными.
    const blocked = configsWithResolverBlock();
    const open = configsWithoutResolverBlock();
    expect(blocked.length, 'ни одна конфигурация не запрещает разрешение внешних имён').toBeGreaterThan(0);
    expect(
      open.length,
      'конфигураций без запрета разрешения имён не осталось — требование о перехвате ' +
        'потеряло предмет, и перечень спеки устарел',
    ).toBeGreaterThan(0);
  });

  it('модуль перехвата объявлен', () => {
    expect(
      existsSync(join(WEB, GUARD_MODULE)),
      `нет '${GUARD_MODULE}': перехват вводить нечем. Спека требует ставить его ПО ПРОГОНУ, ` +
        'а не по конфигурации — конфигурация, куда его надо вводить, собирает и прогон ' +
        'сравнения с живым сайтом, который из требования выведен',
    ).toBe(true);
  });

  it('подмена возвращает заданное содержимое и к настоящему хосту не обращается', () => {
    // Второй слой не является fail-closed, и это измерено: обработчик, который вместо
    // продолжения делает запрос своими средствами, разрешает имя ВНЕ браузера и флага
    // не видит. Признак — отсутствие в модуле любого способа сходить наружу.
    const file = join(WEB, GUARD_MODULE);
    expect(existsSync(file), `нет '${GUARD_MODULE}'`).toBe(true);
    // Комментарии СНИМАЮТСЯ до поиска. Иначе проверка краснеет от собственного
    // пояснения: в шапке модуля перечислено, чего в нём нет («ни `route.continue()`, ни
    // `route.fetch()`»), и признак по всему тексту находил бы именно этот перечень.
    // Ровно тот же приём стоит в `web/tests/repo-hygiene.test.ts:282`,
    // `Ищем в КОДЕ, а не во всём файле`.
    const code = readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const outward = [
      ['route.continue()', /\.continue\s*\(/],
      ['route.fetch()', /\.fetch\s*\(/],
      ['request.fetch()', /request\s*\.\s*fetch\s*\(/],
      ['глобальный fetch', /(^|[^.\w])fetch\s*\(/m],
      ['node:https', /from\s+['"]node:https['"]/],
      ['node:http', /from\s+['"]node:http['"]/],
    ] as const;
    const found = outward.filter(([, re]) => re.test(code)).map(([what]) => what);
    expect(
      found,
      `модуль перехвата обращается наружу (${found.join(', ')}): запрет разрешения имён ` +
        'этого не страхует — такой запрос уходит к настоящему хосту',
    ).toEqual([]);
    expect(
      /\.fulfill\s*\(/.test(code),
      'модуль не подменяет ответ (`route.fulfill`) — подменять нечем',
    ).toBe(true);
  });

  it('каждый браузерный прогон либо ставит перехват, либо назван исключением', () => {
    const guardName = 'installThirdPartyGuard';
    const problems: string[] = [];
    for (const file of specFiles()) {
      const code = readFileSync(join(TESTS_DIR, file), 'utf-8');
      const installs = code.includes(guardName);
      const exempt = code.includes(EXEMPT_MARKER);
      if (installs && exempt) problems.push(`${file}: и ставит перехват, и объявлен исключением`);
      if (!installs && !exempt) problems.push(`${file}: перехват не поставлен и исключением не объявлен`);
    }
    expect(
      problems,
      'требование покрывает КАЖДЫЙ прогон, и «во всех» здесь не работает: гранулярность ' +
        'обязана быть по прогону, потому что конфигурация без запрета имён собирает и ' +
        `прогон сравнения с живым сайтом:\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('прогон сравнения с живым сайтом назван исключением В САМОЙ проверке, с причиной', () => {
    const file = join(TESTS_DIR, LIVE_COMPARISON);
    expect(existsSync(file), `нет '${LIVE_COMPARISON}' — исключение относится к чему?`).toBe(true);
    const code = readFileSync(file, 'utf-8');
    expect(
      code.includes(EXEMPT_MARKER),
      `в '${LIVE_COMPARISON}' нет маркера '${EXEMPT_MARKER}': перехват здесь изменил бы то, ` +
        'что сравнивается, и это должно быть названо в самой проверке, а не в чужом документе',
    ).toBe(true);
    const at = code.indexOf(EXEMPT_MARKER);
    const around = code.slice(Math.max(0, at - 600), at + 600);
    expect(
      /предмет/i.test(around),
      'маркер стоит без названной причины: «предмет прогона — внешний ответ» обязано быть ' +
        'написано рядом с ним',
    ).toBe(true);
  });

  it('исключением объявлен ровно один прогон, а не набор', () => {
    // Спека называет это прямо: «Предмет здесь ОДИН файл, а не набор». Расползание
    // исключения — самый дешёвый способ погасить требование целиком.
    const exempt = specFiles().filter((f) =>
      readFileSync(join(TESTS_DIR, f), 'utf-8').includes(EXEMPT_MARKER),
    );
    expect(exempt.sort(), `исключением объявлено больше одного прогона: ${exempt.join(', ')}`).toEqual([
      LIVE_COMPARISON,
    ]);
  });
});

describe('перечень страниц у проверок один, а не по копии', () => {
  it('проверка доступности читает общий перечень шаблонов', () => {
    // Требование спеки: перечень страниц у проверки перекрытия кнопкой чата ОБЩИЙ с
    // перечнем проверки доступности. Сегодня их два — общий модуль и локальная копия в
    // `a11y.spec.ts`, — и этого достаточно, чтобы они разошлись молча.
    //
    // Гейт равенства двух списков здесь не годится и не написан намеренно: он разрешал
    // бы двум перечням существовать, а требование сформулировано про ОДИН. Признак —
    // потребление модуля.
    const shared = join(TESTS_DIR, 'helpers', 'templates.ts');
    expect(existsSync(shared), 'общего перечня шаблонов нет').toBe(true);

    const a11y = readFileSync(join(TESTS_DIR, 'a11y.spec.ts'), 'utf-8');
    expect(
      /from\s+'\.\/helpers\/templates'/.test(a11y),
      'a11y.spec.ts не читает общий перечень шаблонов — значит держит свой, и два ' +
        'перечня над одним предметом разойдутся молча',
    ).toBe(true);
    expect(
      /const TEMPLATES\s*:/.test(a11y),
      'в a11y.spec.ts осталось локальное объявление TEMPLATES — копия не убрана',
    ).toBe(false);
  });
});

describe('известные отклонения записаны, а не оставлены молчанием', () => {
  const techDebt = (): string => {
    const file = join(ROOT, 'docs', 'tech-debt.md');
    expect(existsSync(file), 'нет docs/tech-debt.md — записывать отклонения некуда').toBe(true);
    return readFileSync(file, 'utf-8');
  };

  const sections = (): string[] => techDebt().split(/\n(?=## TD-)/);

  /**
   * Запись обязана называть ЭТУ возможность.
   *
   * Иначе проверка зелена от чужой записи о том же факте: TD-16 уже перечисляет
   * `visual-baseline.spec.ts` среди файлов вне гейта публикации, и по признаку «файл
   * назван в долге» проверка проходила, ничего не проверив. Спека же требует другого —
   * чтобы было записано, что ТРЕБОВАНИЕ ЭТОЙ возможности автоматически не охраняется:
   * без этого следующий читатель примет требование за охраняемое.
   */
  const namesThisCapability = (s: string): boolean =>
    /external-widgets/.test(s) || /внешн\w*\s+виджет/i.test(s);

  it('зависимость измерения бюджетов от стороннего сервиса названа отклонением', () => {
    // У измерения бюджетов хука перехвата нет вовсе (`web/lighthouserc.cjs:16`,
    // `staticDistDir: './dist',`), и это обязательный для слияния контекст. Требование к
    // нему НЕприменимо — но это названная цена, а не лазейка, значит она записана.
    const hit = sections().filter(
      (s) => namesThisCapability(s) && /перехват/i.test(s) && /(бюджет|lighthouse)/i.test(s),
    );
    expect(
      hit.length,
      'в docs/tech-debt.md нет записи о том, что измерение бюджетов перехвата не имеет и ' +
        'потому зависит от стороннего сервиса',
    ).toBeGreaterThan(0);
  });

  it('недетерминированность визуальных эталонов вне CI названа отклонением', () => {
    // Прогон эталонов числится в списке признанного долга браузерных проверок
    // (`web/tests/browser-test-gating.test.ts:56`, `'visual-baseline.spec.ts',`), то есть
    // требование детерминированности сегодня не стережёт ничто в CI. Умолчать нельзя:
    // следующий читатель примет требование за охраняемое.
    //
    // Признак ИМЕННОЙ, а не по словам «эталон» и «долг»: измерено — по таким словам
    // подходит уже существующая запись про отставание эталонов (TD-40), и проверка была
    // зелёной, ничего не проверив. Отсюда требование назвать носитель самого долга.
    const hit = sections().filter(
      (s) => namesThisCapability(s) && /visual-baseline\.spec\.ts/.test(s),
    );
    expect(
      hit.length,
      'нет записи о том, что требование детерминированности эталонов не охраняется в CI: ' +
        'запись обязана называть носитель признанного долга (browser-test-gating)',
    ).toBeGreaterThan(0);
  });

  it('доступность внутри стороннего виджета чата названа отклонением', () => {
    // «чат» — начало слова: подстрока лежит внутри «Получатель», «начать», «печатать».
    const hit = sections().filter(
      (s) => namesThisCapability(s) && /доступност/i.test(s) && /(?<![а-яёa-z])чат/iu.test(s),
    );
    expect(hit.length, 'нет записи об отклонении по доступности внутри виджета чата').toBeGreaterThan(0);
  });
});

describe('датозависимые фрагменты названы поимённо и исключены из сравнения облика', () => {
  const visual = (): string => {
    const file = join(TESTS_DIR, 'visual-baseline.spec.ts');
    expect(existsSync(file), 'нет visual-baseline.spec.ts').toBe(true);
    return readFileSync(file, 'utf-8');
  };

  it('оба фрагмента названы в самой проверке', () => {
    // Их ДВА, и второй опаснее: блок часов стоит вместе с чатом, то есть на каждой
    // странице, и меняется дважды в сутки. Снимок в 11:00 в пятницу не совпадёт со
    // снимком в 19:00 на неизменном коде — и не на одной странице, а на всех.
    const code = visual();
    for (const name of [SEL_AWARD_BADGE, SEL_CHAT_HOURS])
      expect(
        code.includes(name),
        `в проверке облика не назван датозависимый фрагмент '${name}': исключение по ` +
          'признаку («всё, что зависит от даты») не имеет исполнимой формы',
      ).toBe(true);
  });

  it('состав покрытия обновлён вместе с появлением встраиваний', () => {
    // Кнопка чата видна на любой странице, секция отзывов — на главной. Объявленный
    // состав покрытия обязан соответствовать фактическому прогону, а расхождение — отказ.
    const code = visual();
    for (const name of [SEL_REVIEWS_SECTION, SEL_CHAT_TRIGGER])
      expect(
        code.includes(name),
        `в объявленном составе покрытия не назван новый блок '${name}'`,
      ).toBe(true);
  });

  it('чужой интерфейс чата в покрытие НЕ включён', () => {
    // При погашенных сторонних запросах его не существует, и покрытие требовало бы
    // блок, которого нет по построению. В покрытие входит НАША кнопка.
    //
    // Сторож непустоты обязателен: пока покрытие не объявлено вовсе, «чужого интерфейса
    // в нём нет» тривиально верно. Поэтому сначала доказывается, что покрытие объявлено
    // и НАША кнопка в нём есть.
    const code = visual();
    expect(
      code.includes(SEL_CHAT_TRIGGER),
      'состав покрытия не объявлен (нашей кнопки в нём нет) — утверждение об отсутствии ' +
        'чужого интерфейса было бы тривиально верным',
    ).toBe(true);
    expect(
      code.includes('data-chat-mount'),
      'в покрытие включена точка монтирования чужого интерфейса: при перехвате его нет',
    ).toBe(false);
  });
});
