import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { parse as parseAstro } from '@astrojs/compiler';
import { serializeJsonLd } from '../src/lib/json-ld.js';

// JSON-LD уезжает в страницу через `set:html` внутрь <script type="application/ld+json">
// (HeadMeta.astro, Breadcrumbs.astro). `JSON.stringify` экранирует кавычки JSON, но НЕ
// трогает последовательность `</script>`: строка с ней закрывает тег, и всё, что дальше,
// парсится браузером как разметка. Данные туда приходят из каталога, а не от посетителя,
// поэтому это не наблюдённая эксплуатация, а незакрытый инвариант — и он перестанет быть
// теоретическим ровно в тот день, когда контент поедет из редактируемой CMS.

const PAYLOAD = 'Заголовок</script><img src=x onerror=alert(1)>';

describe('сериализация JSON-LD', () => {
  it('закрывающий тег script не выживает в выводе', () => {
    const out = serializeJsonLd({ '@type': 'Article', headline: PAYLOAD });
    expect(out).not.toContain('</script>');
    // регистр тоже: браузер закрывает тег по </SCRIPT> и </ScRiPt>
    expect(out.toLowerCase()).not.toContain('</script');
  });

  it('данные не искажаются — после разбора строка та же', () => {
    const parsed = JSON.parse(serializeJsonLd({ '@type': 'Article', headline: PAYLOAD }));
    expect(parsed.headline).toBe(PAYLOAD);
  });

  it('обычная схема остаётся читаемым JSON', () => {
    const schema = { '@context': 'https://schema.org', '@type': 'Organization', name: 'ИКПК' };
    expect(JSON.parse(serializeJsonLd(schema))).toEqual(schema);
  });

  // Документирует, ЗАЧЕМ существует функция: голый stringify эту гарантию не даёт.
  // Проверка вечнозелёная и гейтом не является — она объясняет предмет, а не стережёт его.
  it('для сравнения: голый JSON.stringify пропускает закрывающий тег', () => {
    expect(JSON.stringify({ headline: PAYLOAD })).toContain('</script>');
  });
});

// ── Проводка: каждый блок JSON-LD обязан идти через serializeJsonLd ────────────
//
// Находка B9 (docs/security-audit-2026-08-08.md). Проверки выше стерегут ФУНКЦИЮ, а
// не её применение: возврат любого места вставки к голому `JSON.stringify` оставил
// бы их зелёными.
//
// Гейт по ВЫВОДУ в dist эту дыру не закрывает, и это измерено, а не предположено:
// возврат Breadcrumbs.astro к `JSON.stringify` оставил build-набор зелёным
// (77 passed до мутации и 77 после), потому что в текущих данных символа `<` нет
// вовсе — гейт по payload вечнозелёный ровно до появления враждебной строки.
// Поэтому проводка стережётся здесь, по исходникам.

/** Узел AST Astro в объёме, который нужен этой проверке. */
interface AstroAttribute {
  name: string;
  kind: string;
  value: string;
}
interface AstroNode {
  type: string;
  name?: string;
  attributes?: AstroAttribute[];
  children?: AstroNode[];
}

const SRC = join(import.meta.dirname, '..', 'src');
/** Единственный модуль, чей serializeJsonLd считается доверенным. */
const CENTRAL_JSON_LD = join(SRC, 'lib', 'json-ld');

/** Frontmatter компонента Astro — код между первой парой `---`. */
function frontmatterOf(src: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  return m ? m[1] : '';
}

/**
 * Откуда в компоненте берётся имя `serializeJsonLd` и не объявлено ли оно локально.
 *
 * Разбор НАСТОЯЩИМ парсером, а не регулярками, и это вывод из опыта: набор регулярок
 * обходили пять раз подряд — суффиксом пути, неиспользуемым алиасом, импортом внутри
 * комментария, объявлением через деструктуризацию. Каждая заплата закрывала ровно
 * названный случай и оставляла следующий. Парсер снимает весь класс: комментарии он
 * не считает кодом, а связывания видит все, независимо от формы записи.
 */
function analyzeSerializeBinding(
  file: string,
  src: string,
): { importedFrom: string[]; declaredLocally: boolean } {
  const NAME = 'serializeJsonLd';
  const sf = ts.createSourceFile(
    'frontmatter.ts',
    frontmatterOf(src),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const importedFrom: string[] = [];
  let declaredLocally = false;

  const asModule = (spec: string): string =>
    spec.startsWith('.')
      ? resolve(dirname(file), spec).replace(/\.(js|ts)$/, '')
      : `пакет:${spec}`;

  /** Вводит ли схема связывания (в т. ч. деструктуризация) имя NAME. */
  const bindsName = (name: ts.BindingName): boolean => {
    if (ts.isIdentifier(name)) return name.text === NAME;
    return name.elements.some(
      (el) => ts.isBindingElement(el) && bindsName(el.name),
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const spec = node.moduleSpecifier.text;
      // Формы, вводящие локальное имя, но НЕ дающие центральную функцию, помечаются
      // так, чтобы никогда не совпасть с модулем: доверенным считается ровно
      // `import { serializeJsonLd } from '<центральный>'`. Иначе `{ unsafeJsonLd as
      // serializeJsonLd }` из того же модуля прошёл бы проверку — локальное имя верное,
      // а функция чужая.
      if (clause?.name?.text === NAME) {
        importedFrom.push(`${asModule(spec)} (импорт по умолчанию, а не named export)`);
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.name.text !== NAME) continue; // локального связывания с NAME нет
          const exported = el.propertyName?.text ?? el.name.text;
          importedFrom.push(
            exported === NAME
              ? asModule(spec)
              : `${asModule(spec)} (экспорт ${exported} под именем ${NAME})`,
          );
        }
      }
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === NAME) {
        importedFrom.push(`${asModule(spec)} (namespace-импорт, а не named export)`);
      }
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      bindsName(node.name)
    ) {
      declaredLocally = true;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === NAME
    ) {
      declaredLocally = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  return { importedFrom, declaredLocally };
}

/**
 * Является ли выражение ЦЕЛИКОМ вызовом serializeJsonLd(...).
 *
 * Разбор парсером, а не подсчётом скобок: счётчик считает синтаксисом и те скобки,
 * что стоят внутри СТРОК, поэтому выражение
 * `serializeJsonLd("(") && (JSON.stringify({ ...schema, marker: ")" }))`
 * он принимал за один вызов, хотя значение даёт голый JSON.stringify.
 *
 * Требование: корень выражения — вызов, а вызываемое — идентификатор
 * `serializeJsonLd`. Нераспознанное выражение считается нарушением, а не
 * «сомнением в пользу кода».
 */
function isWholeSerializeCall(raw: string): boolean {
  const sf = ts.createSourceFile(
    'expr.ts',
    `const __probe = (${raw});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // Синтаксическая ошибка означает, что выражение вырезано неверно либо написано
  // неверно; в обоих случаях утверждать о нём нечего.
  if ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) return false;

  const statement = sf.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) return false;
  let expr = statement.declarationList.declarations[0]?.initializer;
  while (expr && ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!expr || !ts.isCallExpression(expr)) return false;
  return ts.isIdentifier(expr.expression) && expr.expression.text === 'serializeJsonLd';
}

/** Использование JSON-LD в компоненте: выражение из `set:html` либо причина отказа. */
interface JsonLdUsage {
  expr: string | null;
  /** Почему разобрать не удалось; null — разобрано. */
  problem: string | null;
  raw: string;
}

/**
 * Теги `script[type=application/ld+json]` компонента через ПАРСЕР ASTRO.
 *
 * Самодельный сканер здесь не годится, и это проверено дважды: он не знал про
 * JS-комментарии внутри выражений (`data-probe={/* } *\/ 1 > 0}` уводил глубину скобок
 * в ноль, и тег обрывался на операторе `>`), а до того — про пробелы вокруг `=`.
 * Тот же класс дали бы шаблонные строки и regex-литералы. Парсер Astro знает лексику
 * своего языка целиком, поэтому вопрос закрывается не следующей заплатой.
 *
 * Fail-closed: значение `type`, заданное выражением, и spread-атрибуты означают, что
 * тип определить нельзя, — это отказ, а не «значит, не JSON-LD».
 */
async function collectJsonLdUsages(src: string): Promise<JsonLdUsage[]> {
  const { ast } = await parseAstro(src);
  const usages: JsonLdUsage[] = [];

  const walk = (node: AstroNode): void => {
    if (node.type === 'element' && node.name === 'script') {
      const attrs = node.attributes ?? [];
      const raw = `<script ${attrs.map((a) => `${a.name}=${a.kind}`).join(' ')}>`;

      if (attrs.some((a) => a.kind === 'spread' || a.kind === 'shorthand')) {
        usages.push({ expr: null, problem: 'состав атрибутов задан spread’ом', raw });
      } else {
        const type = attrs.find((a) => a.name.toLowerCase() === 'type');
        if (type) {
          if (type.kind !== 'quoted') {
            // Динамический тип: определить, JSON-LD это или нет, статически нельзя.
            usages.push({
              expr: null,
              problem: `значение type задано не строкой (${type.kind}) — тип не определить`,
              raw,
            });
          } else if (
            // Регистр в MIME незначим, параметры после `;` к типу не относятся.
            type.value.split(';')[0].trim().toLowerCase() === 'application/ld+json'
          ) {
            const setHtml = attrs.find((a) => a.name.toLowerCase() === 'set:html');
            if (setHtml) {
              usages.push(
                setHtml.kind === 'expression'
                  ? { expr: setHtml.value, problem: null, raw }
                  : { expr: null, problem: `set:html задан не выражением (${setHtml.kind})`, raw },
              );
            }
          }
        }
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(ast as AstroNode);
  return usages;
}

function* astroFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* astroFiles(full);
    else if (full.endsWith('.astro')) yield full;
  }
}

// Проверка самого предиката: без неё гейт стерёг бы проводку ровно настолько,
// насколько верна эта функция, а её собственные дыры остались бы невидимыми.
describe('isWholeSerializeCall — что считается корректной проводкой', () => {
  it('принимает прямой вызов', () => {
    expect(isWholeSerializeCall('serializeJsonLd(schema)')).toBe(true);
    expect(isWholeSerializeCall('  serializeJsonLd( schema )  ')).toBe(true);
    expect(isWholeSerializeCall('serializeJsonLd({ "@type": f(x) })')).toBe(true);
  });

  it('отвергает обходы, где имя функции лишь присутствует в тексте', () => {
    // Ровно случай из ревью: вставляется сырой JSON, а текстовая проверка молчала.
    expect(isWholeSerializeCall('true ? JSON.stringify(schema) : serializeJsonLd(schema)')).toBe(
      false,
    );
    expect(isWholeSerializeCall('serializeJsonLd(a) || JSON.stringify(b)')).toBe(false);
    expect(isWholeSerializeCall('JSON.stringify(serializeJsonLd(a))')).toBe(false);
    expect(isWholeSerializeCall('serializeJsonLd(a) + ""')).toBe(false);
    expect(isWholeSerializeCall('JSON.stringify(schema)')).toBe(false);
  });

  // Подсчёт скобок считал синтаксисом и те, что стоят внутри строк, поэтому такое
  // выражение принималось за один вызов, хотя значение даёт голый JSON.stringify.
  it('скобки внутри строк не путаются с синтаксисом', () => {
    expect(
      isWholeSerializeCall('serializeJsonLd("(") && (JSON.stringify({ ...schema, marker: ")" }))'),
    ).toBe(false);
    expect(isWholeSerializeCall('serializeJsonLd({ text: ")" })')).toBe(true);
    expect(isWholeSerializeCall('serializeJsonLd(a /* ) */)')).toBe(true);
  });

  it('нераспознанное выражение не считается корректной проводкой', () => {
    expect(isWholeSerializeCall('serializeJsonLd(')).toBe(false);
    expect(isWholeSerializeCall('')).toBe(false);
  });
});

// Разбор тега — предмет отдельных проверок: именно на нём гейт обходили последним,
// и обход был невидим, потому что усечённый тег просто не содержал set:html.


// Атрибуты — последнее место, где разбор был по точной форме записи. Именно на нём
// гейт обошли пробелами вокруг `=`, поэтому формы записи проверяются отдельно.

// Извлечение тегов — место, где гейт обходили чаще всего. Формы записи проверяются
// здесь напрямую, чтобы не зависеть от того, какие компоненты сейчас в репозитории.
describe('collectJsonLdUsages — какие теги попадают под правило', () => {
  const wrap = (tag: string): string => `---\nconst schema = {};\n---\n${tag}\n`;

  it('обычный тег даёт выражение set:html', async () => {
    const u = await collectJsonLdUsages(
      wrap('<script type="application/ld+json" set:html={f(schema)} />'),
    );
    expect(u).toHaveLength(1);
    expect(u[0].expr).toBe('f(schema)');
  });

  it('регистр MIME и параметры после `;` значения не имеют', async () => {
    for (const type of ['Application/LD+JSON', 'application/ld+json; charset=utf-8']) {
      const u = await collectJsonLdUsages(wrap(`<script type="${type}" set:html={f(schema)} />`));
      expect(u.map((x) => x.expr), type).toEqual(['f(schema)']);
    }
  });

  // Fail-closed: раньше нераспознанный тип означал «значит, не JSON-LD», и тег
  // выпадал из проверки молча.
  it('тип, заданный выражением, — отказ, а не «не JSON-LD»', async () => {
    const u = await collectJsonLdUsages(
      wrap("<script type={'application/ld+json'} set:html={JSON.stringify(schema)} />"),
    );
    expect(u).toHaveLength(1);
    expect(u[0].problem).toMatch(/тип не определить/);
  });

  it('spread-атрибуты — отказ', async () => {
    const u = await collectJsonLdUsages(wrap('<script type="application/ld+json" {...attrs} />'));
    expect(u[0]?.problem).toMatch(/spread/);
  });

  it('set:html строкой, а не выражением, — отказ', async () => {
    const u = await collectJsonLdUsages(
      wrap('<script type="application/ld+json" set:html="сырая строка" />'),
    );
    expect(u[0]?.problem).toMatch(/не выражением/);
  });

  // Самодельный сканер считал `}` из комментария синтаксисом, ронял глубину и обрывал
  // тег на операторе `>`; следующий за ним set:html выпадал из проверки.
  it('скобка внутри JS-комментария не рвёт тег', async () => {
    const u = await collectJsonLdUsages(
      wrap(
        '<script type="application/ld+json" data-probe={/* } */ 1 > 0} set:html={f(schema)} />',
      ),
    );
    expect(u.map((x) => x.expr)).toEqual(['f(schema)']);
  });

  it('`>` внутри выражения атрибута не рвёт тег', async () => {
    const u = await collectJsonLdUsages(
      wrap('<script type="application/ld+json" data-probe={1 > 0} set:html={f(schema)} />'),
    );
    expect(u.map((x) => x.expr)).toEqual(['f(schema)']);
  });

  it('скрипты без типа JSON-LD не попадают под правило', async () => {
    const u = await collectJsonLdUsages(wrap('<script>console.log(1)</script>'));
    expect(u).toEqual([]);
  });
});

describe('проводка JSON-LD в компонентах', () => {
  it('каждый script[type=ld+json] с set:html сериализуется через serializeJsonLd', async () => {
    // Ищем по общему признаку — любой тег с типом ld+json, — а не по списку
    // известных компонентов: новый компонент попадёт под правило сам.
    const offenders: string[] = [];
    const unparsed: string[] = [];
    let tags = 0;

    for (const file of astroFiles(SRC)) {
      const src = readFileSync(file, 'utf-8');
      // Разбор Astro — WASM и стоит заметно; файл без подстроки `<script` не может
      // содержать элемент script вовсе, поэтому пропуск таких файлов гейт не
      // ослабляет. Именно подстрока, а не «ld+json»: тип бывает задан выражением, и
      // фильтр по типу вернул бы обход, который этот гейт как раз и закрывает.
      if (!/<script/i.test(src)) continue;
      // Имя функции ничего не гарантирует само по себе: `const serializeJsonLd =
      // JSON.stringify` в начале компонента даёт вызов с тем же именем и сырой JSON
      // на выходе. Значение имеет ЛОКАЛЬНОЕ СВЯЗЫВАНИЕ: откуда взято именно то имя,
      // которое вызывается.
      const { importedFrom: bindings, declaredLocally: shadowed } = analyzeSerializeBinding(
        file,
        src,
      );
      const importsCentral = bindings.length === 1 && bindings[0] === CENTRAL_JSON_LD;
      // Несколько источников одного имени — файл невалиден, но что именно вызовется,
      // по тексту решать нельзя; это «не смогла проверить», а не «нарушений нет».
      const competingBindings = bindings.length > 1;

      for (const usage of await collectJsonLdUsages(src)) {
        if (usage.problem !== null) {
          unparsed.push(`${file.replace(SRC, 'src')}: ${usage.problem} — ${usage.raw}`);
          continue;
        }
        const expr = usage.expr as string;
        const tag = usage.raw;
        tags++;
        if (!isWholeSerializeCall(expr)) {
          offenders.push(`${file.replace(SRC, 'src')}: ${tag.trim()}`);
        } else if (competingBindings) {
          offenders.push(
            `${file.replace(SRC, 'src')}: имя serializeJsonLd вводится несколькими импортами ` +
              `(${bindings.map((b) => b.replace(SRC, 'src')).join(', ')}) — какой из них ` +
              `вызывается, по тексту не определить`,
          );
        } else if (!importsCentral) {
          offenders.push(
            `${file.replace(SRC, 'src')}: локальное имя serializeJsonLd взято не из ` +
              `lib/json-ld${bindings.length ? ` (а из ${bindings[0].replace(SRC, 'src')})` : ' (импорта нет вовсе)'} — ` +
              `совпадает только имя, а не функция`,
          );
        } else if (shadowed) {
          offenders.push(
            `${file.replace(SRC, 'src')}: serializeJsonLd переопределён локально — ` +
              `импорт есть, но вызывается не он`,
          );
        }
      }

    }

    // «Проверять нечего» — провал проверки, а не успех: если разметка изменится и
    // разбор перестанет находить теги, гейт обязан сказать об этом вслух.
    expect(tags, 'в src не найдено ни одного script[type=ld+json] с set:html').toBeGreaterThan(0);

    // Обе категории проверяются ОДНИМ утверждением: раздельные проверки скрывали
    // друг друга — первый неразобранный тег ронял прогон, и список нарушений в отчёт
    // уже не попадал. При разборе красного гейта это стоило бы лишнего круга.
    const problems = [
      ...unparsed.map((p) => `[не смогла проверить] ${p}`),
      ...offenders.map((p) => `[нарушение] ${p}`),
    ];
    expect(
      problems,
      'JSON-LD вставляется мимо serializeJsonLd либо разобрать разметку не удалось:\n' +
        problems.join('\n'),
    ).toEqual([]);
  });
});
