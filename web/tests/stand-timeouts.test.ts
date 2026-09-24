/**
 * Пороги ожидания, подобранные под МЕДЛЕННУЮ машину стенда.
 *
 * Замерено 23.09.2026 на стенде (Debian 13, 948 МБ памяти, своп 1 ГБ, доступ к CMS через
 * ssh-туннель); свидетельства — `docs/evidence/stand-deploy-2026-09-23/`:
 *
 *   съём: teachers 18,3 с, articles 16,2 с, pages 5,4 с, course-groups 4,5 с прогретым
 *         и 15,4 с холодным — при прежнем пороге 15 с срывались ДВА типа из десяти,
 *         и срывались ДАЖЕ прогретыми, то есть прогрев эту проблему не лечит;
 *   старт службы: после `npm ci` в том же прогоне провижининга (46 минут) служба не
 *         ответила, объявленный срок 600 с истёк, исправный релиз откатился.
 *
 * ЧЕМ ЭТИ ПРОВЕРКИ НЕ ЯВЛЯЮТСЯ. Поведение съёма здесь не проверяется — только то, что
 * пороги не вернули к прежним и что у каждого обращения предел вообще есть. Поведение
 * общего срока проверено отдельно и по-настоящему, в `web/tests/cms-live-snapshot-capture.test.ts`.
 *
 * ПОЧЕМУ ПАРСЕР, А НЕ РЕГУЛЯРКА. Три редакции подряд проверяли частный случай вместо
 * признака, и каждый раз следующая мутация проходила мимо: сперва проверялось только
 * объявление константы (литерал в обращении — зелёно), потом «каждое найденное обращение
 * берёт константу» (снятое обращение — зелёно), потом «обращений ровно два» (ДОБАВЛЕННОЕ
 * обращение без предела — зелёно). Счёт вхождений в тексте в принципе не умеет ответить на
 * вопрос «у каждого ли обращения есть предел», потому что предмет вопроса — вызовы, а не
 * подстроки. Разбор даёт ровно этот предмет.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..', '..');
const CAPTURE = join(ROOT, 'web', 'scripts', 'capture-content-snapshot.ts');

const source = ts.createSourceFile(
  CAPTURE,
  readFileSync(CAPTURE, 'utf-8'),
  ts.ScriptTarget.ESNext,
  true,
);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Все вызовы `fetch(...)` — именно вызовы, а не вхождения слова в комментариях и строках. */
function fetchCalls(scope: ts.Node = source): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(scope, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fetch') {
      calls.push(n);
    }
  });
  return calls;
}

/** Тело именованной функции верхнего уровня — чтобы спрашивать «что есть ВНУТРИ неё». */
function functionBody(name: string): ts.Node {
  let found: ts.Node | undefined;
  walk(source, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = n.body;
  });
  expect(found, `в ${CAPTURE} нет функции ${name} — предмет проверки исчез, проверять нечего`).toBeDefined();
  return found!;
}

function callsTo(name: string, scope: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walk(scope, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      calls.push(n);
    }
  });
  return calls;
}

function numericConst(name: string): number {
  let value: number | undefined;
  walk(source, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      const init = n.initializer;
      if (init && ts.isNumericLiteral(init)) value = Number(init.text);
      // `Number(process.env.X ?? 1_200_000)` — берём объявленное умолчание.
      if (init && ts.isCallExpression(init)) {
        walk(init, (m) => {
          if (ts.isNumericLiteral(m)) value = Number(m.text);
        });
      }
    }
  });
  expect(value, `в ${CAPTURE} нет числового объявления ${name} — проверять нечего`).toBeDefined();
  return value!;
}

describe('пороги ожидания для стенда', () => {
  // Худший замер — 18,3 с. Нижняя граница здесь не «сколько хватит», а «ниже этого заведомо мало».
  it('предел одного обращения к CMS заметно выше худшего замеренного ответа', () => {
    expect(
      numericConst('CMS_REQUEST_TIMEOUT_MS'),
      'порог опущен к величине, при которой съём срывался на teachers (18,3 с) и articles (16,2 с)',
    ).toBeGreaterThanOrEqual(60_000);
  });

  // Признак, а не счёт: «у КАЖДОГО обращения есть предел». Счёт вхождений трижды пропускал
  // мутацию — заменённое обращение, снятое обращение, добавленное обращение.
  it('у каждого обращения к CMS есть предел, и это общий предел', () => {
    const calls = fetchCalls();
    expect(calls.length, 'обращений к CMS не найдено вовсе — проверять нечего').toBeGreaterThan(0);

    const withoutLimit = calls.filter((call) => {
      const options = call.arguments[1];
      if (!options || !ts.isObjectLiteralExpression(options)) return true;
      const signal = options.properties.find(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'signal',
      );
      if (!signal || !ts.isPropertyAssignment(signal)) return true;
      return !signal.initializer.getText().includes('CMS_REQUEST_TIMEOUT_MS');
    });

    expect(
      withoutLimit.map((c) => `строка ${source.getLineAndCharacterOfPosition(c.pos).line + 1}: ${c.getText().slice(0, 60)}`),
      'обращение к CMS без общего предела: съём может подвиснуть на нём или снова сорваться по зашитому сроку',
    ).toEqual([]);
  });

  /*
   * РАЗМЕЩЕНИЕ, а не количество. Предыдущая редакция считала вхождения по всему файлу, и
   * измерено, что перенос обоих вызовов в один обход оставлял её зелёной — то есть обход
   * медиа, длинный конец в 132 файла, мог остаться без общего срока.
   *
   * Поведенческий тест в `cms-live-snapshot-capture.test.ts` эту дыру не закрывает: при
   * сроке 0 достаточно любого одного вызова, чтобы он был зелёным. Два обхода спрашиваются
   * поимённо именно поэтому.
   */
  it.each(['fetchAllPages', 'captureMedia'])('общий срок проверяется внутри %s', (fn) => {
    expect(
      callsTo('assertWithinBudget', functionBody(fn)).length,
      `в ${fn} нет проверки общего срока — этот обход может идти неограниченно долго`,
    ).toBeGreaterThan(0);
  });

  /*
   * Значение читается ТЕМ ЖЕ разбором, что и провижининг, а не своей регуляркой.
   *
   * Своя регулярка здесь уже дважды расходилась с `load_declared`: сперва брала первое
   * вхождение вместо последнего, потом не видела форм `KEY="120"` и `KEY=120 ` с хвостовым
   * пробелом — а обе эти формы `load_declared` принимает и применяет. Копия разбора
   * расходится с оригиналом молча; вызов оригинала — не может.
   */
  it('стенд ждёт службу дольше, чем длится голодание после npm ci', () => {
    const declared = execFileSync(
      'bash',
      [
        '-c',
        '. "$1"/scripts/lib/declared.sh && load_declared "$1"/deploy/environments/stand.env && printf %s "${SERVICE_HEALTH_TIMEOUT-}"',
        'bash',
        ROOT,
      ],
      { encoding: 'utf-8' },
    ).trim();

    expect(declared, 'стенд не объявляет SERVICE_HEALTH_TIMEOUT — проверять нечего').not.toBe('');
    expect(
      Number(declared),
      'срок возвращён к значению, при котором голодающая после npm ci служба объявлялась мёртвой',
    ).toBeGreaterThanOrEqual(1200);
  });
});
