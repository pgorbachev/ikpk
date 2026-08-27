import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_OFFLINE_MESSAGE_KEY,
  type ChatLoaderConfig,
} from './helpers/external-widgets';
import {
  REQUIRED_FIELDS,
  evidenceProblems,
  parseEvidence,
  type AcceptancePoint,
} from './helpers/acceptance-evidence';

/**
 * Тесты по спеке change `external-widgets` — ФАЙЛ СВИДЕТЕЛЬСТВ ПРИЁМКИ.
 *
 * Предмет — `docs/handoff/external-widgets-acceptance-evidence.md` плюс то, из чего
 * вычисляется применимость условных пунктов. Ни один каталог вывода этот файл не читает.
 *
 * ── ПОЧЕМУ ЭТО ПРОВЕРЯЕТСЯ АВТОМАТИЧЕСКИ, ХОТЯ ПРИЁМКА РУЧНАЯ ────────────────
 * Проверяется не наблюдение, а НАЛИЧИЕ и ПОЛНОТА записи под каждый применимый приёмочный
 * сценарий. До этого change такого места в репозитории не было, и приёмочный сценарий не
 * мог покраснеть ни в одном состоянии — то есть «ручная проверка с названной причиной»
 * превращалась в отсутствие проверки, чего дисциплина проекта прямо не допускает.
 *
 * ── МНОЖЕСТВО ПРИЁМОЧНЫХ ПУНКТОВ ЗАКРЫТО, И ОНО СВЕРЯЕТСЯ СО СПЕКОЙ ─────────
 * Спека называет шесть пунктов поимённо, потому что определение «сценарий, THEN которого
 * требует записи» само по себе тавтологично, а сценарий, который ОБЯЗАН проверяться
 * приёмкой, но чей THEN об этом молчит, в множество не попал бы вовсе. Список ниже —
 * копия этого перечня, и он сверяется с текстом change: имя, разошедшееся со сценарием,
 * роняет проверку. Иначе переименование сценария тихо оставило бы пункт без предмета.
 */

const WEB = join(import.meta.dirname, '..');
const ROOT = join(WEB, '..');
const EVIDENCE_FILE = join(ROOT, 'docs', 'handoff', 'external-widgets-acceptance-evidence.md');
const CHANGE_SPEC = join(
  ROOT,
  'openspec',
  'changes',
  'external-widgets',
  'specs',
  'external-widgets',
  'spec.md',
);
const ARCHIVED_SPEC = join(
  ROOT,
  'openspec',
  'changes',
  'archive',
  'external-widgets',
  'specs',
  'external-widgets',
  'spec.md',
);

/**
 * Байтовый предел страницы 404, названный спекой действующим. Обновлён при слиянии
 * с main 2026-08-27: предел поднимался несколько раз вслед за фактом (TD-41), последний
 * раз до 34 * 1024 в change `social-accounts` (марки соцсетей в подвале) — независимо от
 * этого change. Значение здесь и в спеке обязаны совпадать: расхождение — это и есть
 * предмет пункта «Предел поднят со свидетельством».
 */
const DECLARED_404_LIMIT = 34 * 1024;

/**
 * Пути модулей реализации лежат в ПЕРЕМЕННЫХ, а не в литералах импорта.
 *
 * Причина не в стиле: у литерала `astro check` требует существования модуля, и отсутствие
 * реализации давало бы КРАСНЫЙ ГЕЙТ ТИПОВ вместо красного теста. Различать эти два
 * состояния обязательно — иначе причина падения читается как поломка типов, а не как
 * «требование не выполнено».
 */
const CONFIG_MODULE = '../src/lib/external-widgets';
const BADGES_MODULE = '../src/lib/award-badges';

// ─── Применимость условных пунктов: вычисляется из репозитория ───────────────

/**
 * Боевая ветвь байтового предела страницы 404.
 *
 * Ветвь названа, потому что константа ТЕРНАРНАЯ: демо-ветвь равна 29 696 Б всегда, и
 * предикат «значение отличается» без этой оговорки выполнен уже сегодня, без всякого
 * подъёма предела.
 *
 * Вычисление арифметики — своё и намеренно узкое: только целые числа, `*`, `+` и `-`.
 * Скобка или что-то иное даёт `null`, то есть «измерить не удалось», а не «предел не
 * поднимали». Обратный выбор превратил бы непонятое выражение в зелёный вердикт.
 */
export function prodByteLimit(source: string): number | null {
  const match = /const\s+limit\s*=\s*isDemoBuild\s*\?([^:]+):([^;]+);/.exec(source);
  if (match === null) return null;
  return evalIntExpression(match[2]);
}

function evalIntExpression(raw: string): number | null {
  const expr = raw.trim();
  if (!/^[\d\s*+-]+$/.test(expr)) return null;
  let total = 0;
  for (const term of expr.split(/(?=[+-])/)) {
    const sign = term.trim().startsWith('-') ? -1 : 1;
    const body = term.trim().replace(/^[+-]/, '');
    if (body === '') return null;
    let product = 1;
    for (const factor of body.split('*')) {
      const value = Number(factor.trim());
      if (!Number.isInteger(value)) return null;
      product *= value;
    }
    total += sign * product;
  }
  return total;
}

async function chatState(): Promise<ChatLoaderConfig['state'] | null> {
  try {
    const mod = (await import(CONFIG_MODULE)) as {
      chatLoaderConfig?: () => ChatLoaderConfig;
    };
    return mod.chatLoaderConfig?.().state ?? null;
  } catch {
    return null;
  }
}

async function offlineMessageDeclaration(): Promise<'configured' | 'absent' | null> {
  try {
    const mod = (await import(CONFIG_MODULE)) as {
      chatOfflineMessage?: () => 'configured' | 'absent' | null;
    };
    return mod.chatOfflineMessage?.() ?? null;
  } catch {
    return null;
  }
}

async function declaredBadgeCount(): Promise<number | null> {
  try {
    const mod = (await import(BADGES_MODULE)) as { DECLARED_AWARD_BADGES?: unknown[] };
    const list = mod.DECLARED_AWARD_BADGES;
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
}

/**
 * Шесть приёмочных пунктов с вычисленной применимостью.
 *
 * ШОВ, названный вслух: спека называет механизм применимости для двух условных пунктов из
 * пяти — сообщение панели (ключ `CHAT_OFFLINE_MESSAGE`) и байтовый предел (боевая ветвь
 * константы). Для согласия механизм назван косвенно («в первом состоянии конфигурации»).
 * Для двух пунктов про знак — «только если знак предполагается показывать» — механизм не
 * назван, и здесь выбрано: знак предполагается показывать тогда, когда в данных есть хотя
 * бы одно объявление. Выбор fail-closed: объявление с неполными полями всё равно требует
 * записи, хотя знак и не отрендерится. Это названо находкой в передаче, а не решено молча.
 */
async function acceptancePoints(): Promise<AcceptancePoint[]> {
  const state = await chatState();
  const offline = await offlineMessageDeclaration();
  const badges = await declaredBadgeCount();
  const limitSource = join(WEB, 'tests', 'seo-package.test.ts');
  const limit = existsSync(limitSource) ? prodByteLimit(readFileSync(limitSource, 'utf-8')) : null;

  const badgeShown = badges !== null && badges > 0;
  const chatCollected = state === 'address';

  return [
    {
      scenario: 'Тексты и имена авторов проверены приёмкой',
      conditional: false,
      applicable: true,
      measurable: true,
      because: 'пункт безусловный: секция отзывов существует всегда',
    },
    {
      scenario: 'Право использования знака подтверждено свидетельством приёмки',
      conditional: true,
      applicable: badgeShown,
      measurable: badges !== null,
      because:
        badges === null
          ? ''
          : `объявлений знаков в данных: ${badges}`,
    },
    {
      scenario: 'Подтверждение награждения записано свидетельством приёмки',
      conditional: true,
      applicable: badgeShown,
      measurable: badges !== null,
      because: badges === null ? '' : `объявлений знаков в данных: ${badges}`,
    },
    {
      scenario: 'Согласие подтверждено свидетельством приёмки',
      conditional: true,
      applicable: chatCollected,
      measurable: state !== null,
      because: state === null ? '' : `состояние конфигурации чата: ${state}`,
    },
    {
      scenario: 'Сообщение панели вне часов проверено приёмкой',
      conditional: true,
      // Условие из ДВУХ частей: чат собирается И настройка портала выполнена. Если чат
      // собирается, а портал не настроен, приёмочной записи нет и быть не может —
      // умолчание сервиса часов не содержит, а записать «наблюдённое сообщение содержит
      // часы» было бы ложью. Это состояние идёт известным отклонением.
      applicable: chatCollected && offline === 'configured',
      measurable: state !== null && (!chatCollected || offline !== null),
      because:
        state === null
          ? ''
          : !chatCollected
            ? `чат не собирается (состояние ${state}), вторая часть условия не важна`
            : offline === null
              ? ''
              : `чат собирается, ${CHAT_OFFLINE_MESSAGE_KEY}=${offline}`,
    },
    {
      scenario: 'Предел поднят со свидетельством',
      conditional: true,
      applicable: limit !== null && limit !== DECLARED_404_LIMIT,
      measurable: limit !== null,
      because:
        limit === null
          ? ''
          : `боевая ветвь предела ${limit} Б против названных спекой ${DECLARED_404_LIMIT} Б`,
      mustMention: limit !== null && limit !== DECLARED_404_LIMIT ? String(limit) : null,
    },
  ];
}

// ─── Разбор и вердикт: фикстуры ──────────────────────────────────────────────

const FULL_RECORD = (heading: string): string => `## ${heading}

- **Что проверено:** секция отзывов на главной, карточки виджета видны
- **Кем:** владелец
- **Дата:** 2026-08-24
- **Наблюдение:** ни одного текста отзыва и ни одного имени автора в разметке нет
- **Непустота предмета:** секция существует, встраивание на месте, карточки виджета видны
- **Источник:** снимок экрана docs/handoff/evidence/reviews.png
`;

const POINT = (over: Partial<AcceptancePoint> = {}): AcceptancePoint => ({
  scenario: 'Тексты и имена авторов проверены приёмкой',
  conditional: false,
  applicable: true,
  measurable: true,
  because: 'пункт безусловный',
  ...over,
});

describe('разбор файла свидетельств', () => {
  it('запись читается заголовком и полями', () => {
    const [record] = parseEvidence(`# Свидетельства приёмки\n\nПроза.\n\n${FULL_RECORD('Тексты и имена авторов проверены приёмкой')}`);
    expect(record, 'запись не разобрана').toBeTruthy();
    expect(record.heading).toBe('Тексты и имена авторов проверены приёмкой');
    for (const field of REQUIRED_FIELDS)
      expect(record.fields[field], `поле «${field}» не разобрано`).not.toBe(undefined);
  });

  it('проза до первой записи записью не считается', () => {
    expect(parseEvidence('# Заголовок\n\nОписание файла.\n')).toEqual([]);
  });
});

describe('у приёмочного утверждения есть запись свидетельства в одном известном файле', () => {
  it('запись под применимый приёмочный сценарий есть — приёмка пройдена', () => {
    const records = parseEvidence(FULL_RECORD('Тексты и имена авторов проверены приёмкой'));
    expect(evidenceProblems(records, [POINT()])).toEqual([]);
  });

  it('записи под наступивший сценарий нет — приёмка НЕ пройдена', () => {
    const problems = evidenceProblems([], [POINT()]);
    expect(problems.map((p) => p.kind), 'отсутствие записи под наступившее условие прошло').toEqual([
      'missing',
    ]);
  });

  it('запись не доказывает непустоту предмета — приёмка НЕ пройдена', () => {
    // «Текстов отзывов нет» на сломанной секции верно тривиально, и именно этот случай
    // требование о непустоте запрещает. Поле названо полем, а не требованием к прозе:
    // судить, содержит ли свободный текст доказательство, объективного критерия не имеет.
    const withoutProof = FULL_RECORD('Тексты и имена авторов проверены приёмкой')
      .split('\n')
      .filter((line) => !line.includes('Непустота предмета'))
      .join('\n');
    const problems = evidenceProblems(parseEvidence(withoutProof), [POINT()]);
    expect(problems.map((p) => p.kind)).toEqual(['incomplete']);
    expect(problems[0].detail).toMatch(/Непустота предмета/);
  });

  it('поле есть, а значения нет — тоже НЕ пройдена', () => {
    const emptyProof = FULL_RECORD('Тексты и имена авторов проверены приёмкой').replace(
      /- \*\*Непустота предмета:\*\*.*/,
      '- **Непустота предмета:**',
    );
    expect(evidenceProblems(parseEvidence(emptyProof), [POINT()]).map((p) => p.kind)).toEqual([
      'incomplete',
    ]);
  });

  it('условие приёмочного сценария не наступило — запись не требуется', () => {
    // Иначе правило требовало бы вписывать пустую запись, то есть свидетельство ни о
    // чём — ровно та подмена «проверено» на «заполнено», против которой всё требование.
    expect(
      evidenceProblems([], [POINT({ conditional: true, applicable: false, because: 'предел не поднимали' })]),
      'ненаступившее условие потребовало записи',
    ).toEqual([]);
  });

  it('применимость вычислить не удалось — это НЕ «пункт неприменим»', () => {
    // Склейка «нечего проверять» с «проверять не требуется» — та же подмена, только с
    // другой стороны: три сценария требования не краснели бы ни в одном состоянии.
    const problems = evidenceProblems([], [POINT({ conditional: true, applicable: false, measurable: false, because: '' })]);
    expect(problems.map((p) => p.kind)).toEqual(['unmeasurable']);
  });

  it('заголовок записи, не совпадающий с именем сценария, роняет приёмку', () => {
    // Множество названо поимённо и закрыто. Запись без сценария связать со сценарием
    // нечем, а молчание здесь позволило бы переименовать сценарий и оставить запись
    // сиротой при зелёной проверке.
    const records = parseEvidence(FULL_RECORD('Тексты и авторы отзывов к нам не перенесены'));
    expect(evidenceProblems(records, [POINT()]).map((p) => p.kind).sort()).toEqual([
      'missing',
      'stale',
    ]);
  });

  it('дата не в форме ГГГГ-ММ-ДД роняет приёмку', () => {
    const records = parseEvidence(
      FULL_RECORD('Тексты и имена авторов проверены приёмкой').replace('2026-08-24', '24 августа'),
    );
    expect(evidenceProblems(records, [POINT()]).map((p) => p.kind)).toEqual(['incomplete']);
  });

  it('пункт про предел требует, чтобы запись назвала значение константы', () => {
    // Спека: «отличается — запись обязательна и её объявленное значение обязано совпасть
    // с константой». Запись, не называющая числа, свидетельством о подъёме не является.
    const point = POINT({
      scenario: 'Предел поднят со свидетельством',
      conditional: true,
      applicable: true,
      because: 'боевая ветвь предела 30720 Б',
      mustMention: '30720',
    });
    const silent = parseEvidence(FULL_RECORD('Предел поднят со свидетельством'));
    expect(evidenceProblems(silent, [point]).map((p) => p.kind)).toEqual(['incomplete']);

    const named = parseEvidence(
      FULL_RECORD('Предел поднят со свидетельством').replace(
        '- **Наблюдение:**',
        '- **Наблюдение:** предел поднят до 30 720 Б, замер приведён в изменении;\n- **Прежнее наблюдение:**',
      ),
    );
    expect(
      evidenceProblems(named, [point]),
      'число с разделителем разрядов не распознано — человек пишет именно так',
    ).toEqual([]);
  });
});

// ─── Применимость и настоящий файл ───────────────────────────────────────────

describe('приёмочные пункты сверены со спекой и с настоящим файлом', () => {
  const specText = (): string => {
    for (const path of [CHANGE_SPEC, ARCHIVED_SPEC]) if (existsSync(path)) return readFileSync(path, 'utf-8');
    throw new Error(
      `спеки change нет ни в '${CHANGE_SPEC}', ни в архиве — сверить имена приёмочных ` +
        'сценариев не с чем. Это «измерить не удалось», а не «расхождений нет»',
    );
  };

  it('каждый названный приёмочный пункт существует в спеке сценарием с тем же именем', async () => {
    // Связь записи со сценарием держится на ДОСЛОВНОМ совпадении имени. Значит перечень
    // здесь обязан сверяться с текстом change, иначе переименование сценария тихо
    // оставляет пункт без предмета, а запись — сиротой.
    const headings = new Set(
      [...specText().matchAll(/^#### Scenario:\s*(.+?)\s*$/gm)].map((m) => m[1]),
    );
    expect(headings.size, 'в спеке не нашлось ни одного сценария — разбор сломан').toBeGreaterThan(50);
    const missing = (await acceptancePoints()).map((p) => p.scenario).filter((name) => !headings.has(name));
    expect(
      missing,
      `приёмочные пункты, которых в спеке нет сценариями с таким именем: ${missing.join(' | ')}`,
    ).toEqual([]);
  });

  it('приёмочных пунктов ровно шесть, и пять из них условны', async () => {
    // Число названо спекой прямо. Проверка держит его измеримым: пункт, добавленный в
    // спеку и не добавленный сюда, иначе остался бы без проверки молча.
    const points = await acceptancePoints();
    expect(points.length, 'приёмочных пунктов не шесть').toBe(6);
    expect(
      points.filter((p) => p.conditional).length,
      'условных пунктов не пять: безусловным объявлено то, что спека объявила условным, — ' +
        'ровно та ошибка, из-за которой архивирование блокировалось записью, которую нечем ' +
        'заполнить',
    ).toBe(5);
  });

  it('файл свидетельств существует по названному спекой пути', () => {
    expect(
      existsSync(EVIDENCE_FILE),
      `нет '${EVIDENCE_FILE}': «известный файл» без имени нечем открыть, и четыре сценария ` +
        'требования не могли бы покраснеть ни автоматически, ни вручную',
    ).toBe(true);
  });

  it('под каждый применимый пункт в файле есть полная запись', async () => {
    expect(existsSync(EVIDENCE_FILE), `нет '${EVIDENCE_FILE}'`).toBe(true);
    const points = await acceptancePoints();
    const problems = evidenceProblems(parseEvidence(readFileSync(EVIDENCE_FILE, 'utf-8')), points);
    expect(
      problems.map((p) => `[${p.kind}] ${p.scenario}: ${p.detail}`),
      'применимость каждого пункта: ' +
        points
          .map((p) => `${p.scenario} — ${p.measurable ? (p.applicable ? 'применим' : 'не применим') : 'НЕ ИЗМЕРЕНО'}`)
          .join('; '),
    ).toEqual([]);
  });
});
