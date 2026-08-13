import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { isCurrentOrFuture, lastDay } from '../src/lib/schedule-window';

// Многодневное событие обязано оставаться на страницах до последнего дня. Из 63
// записей расписания 60 многодневные, поэтому фильтр по `startAt` убирал бы
// идущий семинар уже на второй день обучения.
//
// Дата фиксированная: проверка не должна краснеть от хода времени — этот дефект в
// проекте уже был (гейт `catalog-data` падал на устаревшем снимке при исправном
// коде).
const TODAY = '2026-08-06';

describe('окно актуальности записи расписания', () => {
  it('событие целиком в будущем актуально', () => {
    expect(isCurrentOrFuture({ startAt: '2026-09-01', endAt: '2026-09-03' }, TODAY)).toBe(true);
  });

  it('идущее многодневное событие актуально во второй день', () => {
    expect(isCurrentOrFuture({ startAt: '2026-08-05', endAt: '2026-08-08' }, TODAY)).toBe(true);
  });

  it('событие, начавшееся и закончившееся в прошлом, неактуально', () => {
    expect(isCurrentOrFuture({ startAt: '2026-07-20', endAt: '2026-07-25' }, TODAY)).toBe(false);
  });

  it('однодневное событие сегодня актуально', () => {
    expect(isCurrentOrFuture({ startAt: `${TODAY}T00:00:00.000Z` }, TODAY)).toBe(true);
  });

  it('последний день события — сегодня: ещё актуально', () => {
    expect(isCurrentOrFuture({ startAt: '2026-08-01', endAt: TODAY }, TODAY)).toBe(true);
  });

  describe('последний день', () => {
    it('берёт endAt, когда он позже начала', () => {
      expect(lastDay({ startAt: '2026-08-01', endAt: '2026-08-05' })).toBe('2026-08-05');
    });

    // Данные приходят из чужого API: endAt раньше startAt встречается, и последним
    // днём тогда обязан быть startAt, иначе идущее событие уедет в прошлое.
    it('берёт startAt, когда endAt раньше начала', () => {
      expect(lastDay({ startAt: '2026-08-05', endAt: '2026-08-01' })).toBe('2026-08-05');
    });

    it('обходится без дат', () => {
      expect(lastDay({})).toBe('');
    });
  });
});

// Гейт против возврата дефекта: НИ ОДИН файл в `src/` не должен сравнивать время начала
// события с текущей датой — страницы обязаны фильтровать расписание через общий вывод.
// Проверка статическая по необходимости: поведение страниц Astro на этапе сборки юнит-тестом
// не наблюдаемо, а браузерный тест увидит дефект только в те дни, когда идёт многодневный
// семинар.
//
// Первая редакция перечисляла два ПУТИ руками — и пропустила третью копию в
// `web/src/lib/home.ts`, из-за которой расписание показывало идущий семинар, а «Ближайшие
// семинары» на главной нет. Обход по дереву это закрыл.
//
// ─── Признак берётся из РАЗБОРА, а не из списка начертаний ────────────────────
// Прежняя редакция перечисляла два литеральных начертания, и ревью показало прогоном,
// что мимо проходят четыре из пяти: `(e.startAt ?? '').slice(0, 10) >= t`,
// `new Date(e.startAt) < new Date(t)`, `e.startAt < t` и вынос в переменную
// (`const s = e.startAt.slice(0, 10); … if (s >= t)`). Первое — ровно то начертание,
// которым правило записано в самом `schedule-window.ts`, только перенесённое в другой
// файл. То есть список частных случаев отставал от предмета молча, а это тот самый приём,
// который правила проекта запрещают.
//
// Поэтому признак теперь выводится из синтаксического дерева: любое сравнение
// (`<`, `<=`, `>`, `>=`), в котором хоть одна сторона упоминает `startAt` — или является
// локальной переменной, полученной из выражения с `startAt`. Одноуровневый вынос в
// переменную ловится, потому что именно он и был пятым начертанием.
//
// Что разбирается: файлы `.ts` целиком и frontmatter файлов `.astro` (код между первой
// парой `---`). Решения о видимости живут именно там. Разметка `.astro` парсером НЕ
// разбирается — граница названа вслух, и для неё сохранены прежние два регулярных
// признака, чтобы покрытие не сузилось.
describe('нигде в src нет фильтра расписания по startAt', () => {
  const SRC = join(import.meta.dirname, '..', 'src');

  /** Прежние признаки — только для разметки `.astro`, которую парсер не берёт. */
  const TEMPLATE_MARKERS = [
    /new Date\(\s*\w+\.startAt\s*\)\.getTime\(\)\s*[<>]=?/,
    /\w+\.startAt(?:\s*\?\?\s*'')?\.slice\(0,\s*10\)\s*[<>]=?\s*(?!.*isCurrentOrFuture)\w/,
  ];

  /**
   * Два законных места, и оба названы поимённо с причиной:
   *   `schedule-window.ts` — сам вывод окна актуальности, сравнение дат его предмет;
   *   `schedule-months.ts` — вывод ключей месяца, где сравниваются КЛЮЧИ `YYYY-MM`, а не
   *     даты, и правильность закрыта фикстурами `schedule-months.test.ts`.
   * Существование обоих проверяется: исключение, не покрывающее ничего, — молчаливое
   * сужение гейта.
   */
  const ALLOWED = ['schedule-window.ts', 'schedule-months.ts'];

  function* files(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) yield* files(full);
      else if (/\.(astro|ts)$/.test(name)) yield full;
    }
  }

  /** Frontmatter `.astro` и его смещение по строкам, чтобы номера совпадали с файлом. */
  function frontmatter(text: string): { code: string; lineOffset: number } | null {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    return { code: match[1], lineOffset: 1 };
  }

  const COMPARISONS = new Set([
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
  ]);

  /** Сравнения, где хоть одна сторона выведена из `startAt`. */
  function badComparisons(code: string, name: string): { line: number; text: string }[] {
    const source = ts.createSourceFile(name, code, ts.ScriptTarget.ESNext, true);
    const tainted = new Set<string>();

    // Первый проход: имена, полученные из выражения с `startAt`. Одного уровня довольно —
    // именно вынос в переменную был начертанием, мимо которого проходил прежний признак.
    const collect = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && node.initializer.getText(source).includes('startAt')
      ) {
        tainted.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    const found: { line: number; text: string }[] = [];
    const mentions = (node: ts.Node): boolean => {
      const text = node.getText(source);
      if (text.includes('startAt')) return true;
      return ts.isIdentifier(node) && tainted.has(node.text);
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node)
        && COMPARISONS.has(node.operatorToken.kind)
        && (mentions(node.left) || mentions(node.right))
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({ line, text: node.getText(source).replace(/\s+/g, ' ').slice(0, 80) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('сравнений startAt с датой не осталось', () => {
    const all = [...files(SRC)];
    expect(all.length, 'файлов в src не найдено — проверять нечего').toBeGreaterThan(0);

    const missing = ALLOWED.filter((name) => !all.some((file) => file.endsWith(name)));
    expect(missing, `названы законными файлы, которых в src нет: ${missing.join(', ')}`).toEqual([]);

    const offenders: string[] = [];
    let parsed = 0;
    for (const file of all) {
      if (ALLOWED.some((name) => file.endsWith(name))) continue;
      const text = readFileSync(file, 'utf-8');
      const shortName = file.slice(SRC.length + 1);

      if (file.endsWith('.ts')) {
        parsed += 1;
        for (const hit of badComparisons(text, shortName)) {
          offenders.push(`${shortName}:${hit.line + 1} → ${hit.text}`);
        }
        continue;
      }

      const head = frontmatter(text);
      if (head) {
        parsed += 1;
        for (const hit of badComparisons(head.code, shortName)) {
          offenders.push(`${shortName}:${hit.line + 1 + head.lineOffset} → ${hit.text}`);
        }
      }
      // Разметка: парсером не разбирается, поэтому остаются прежние признаки.
      const body = head ? text.slice(text.indexOf('\n---') + 4) : text;
      const bodyOffset = head ? text.slice(0, text.indexOf('\n---') + 4).split('\n').length - 1 : 0;
      body.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//')) return;
        if (TEMPLATE_MARKERS.some((re) => re.test(line))) {
          offenders.push(`${shortName}:${i + 1 + bodyOffset} (разметка) → ${line.trim().slice(0, 80)}`);
        }
      });
    }

    // Ноль разобранных файлов — это «не смогла проверить», а не «дефектов нет».
    expect(parsed, 'ни один файл не разобран парсером — гейт вакуумный').toBeGreaterThan(0);
    expect(
      offenders,
      `многодневные события исчезнут после первого дня (в данных таких 60 из 63):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
