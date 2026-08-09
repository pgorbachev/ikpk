import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
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
      // Импорт по умолчанию: `import serializeJsonLd from '…'`.
      if (clause?.name?.text === NAME) importedFrom.push(asModule(spec));
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        // Значение имеет ЛОКАЛЬНОЕ имя: у `{ x as serializeJsonLd }` это `x as` → NAME,
        // а у `{ serializeJsonLd as other }` локального связывания с NAME нет вовсе.
        for (const el of bindings.elements) {
          if (el.name.text === NAME) importedFrom.push(asModule(spec));
        }
      }
      // `import * as serializeJsonLd from '…'` — тоже связывание этого имени.
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === NAME) {
        importedFrom.push(asModule(spec));
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
 * Проверять текстовое вхождение `serializeJsonLd(` недостаточно: выражение
 * `true ? JSON.stringify(schema) : serializeJsonLd(schema)` содержит имя функции,
 * но подставляет сырой JSON. Регулярка `^serializeJsonLd\(.*\)$` тоже мало: под неё
 * подходит `serializeJsonLd(a) || JSON.stringify(b)` — последняя скобка есть, но
 * закрывает она не тот вызов. Поэтому ищем скобку, ПАРНУЮ открывающей, и требуем,
 * чтобы она была последним символом выражения.
 */
function isWholeSerializeCall(raw: string): boolean {
  const expr = raw.trim();
  const head = /^serializeJsonLd\s*\(/.exec(expr);
  if (!head) return false;

  let depth = 0;
  for (let i = head[0].length - 1; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i === expr.length - 1;
    }
  }
  return false;
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
});

describe('проводка JSON-LD в компонентах', () => {
  it('каждый script[type=ld+json] с set:html сериализуется через serializeJsonLd', () => {
    // Ищем по общему признаку — любой тег с типом ld+json, — а не по списку
    // известных компонентов: новый компонент попадёт под правило сам.
    const tagRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>/gi;
    const offenders: string[] = [];
    const unparsed: string[] = [];
    let tags = 0;

    for (const file of astroFiles(SRC)) {
      const src = readFileSync(file, 'utf-8');
      // Сколько раз тип вообще встречается в файле — независимо от того, смог ли
      // разбор построить из этого тег. Расхождение с числом разобранных тегов
      // означает «не смогла проверить», и это обязано быть провалом, а не тишиной:
      // `[^>]*` обрывает тег на первом `>` внутри выражения (`{items.map(i => f(i))}`),
      // и такой тег иначе уходил бы из-под проверки молча.
      // Считаем не любое упоминание типа (оно бывает и в комментарии — тогда гейт
      // краснел бы напрасно), а именно теги script с этим типом: до типа не должно
      // встретиться `<`, то есть мы всё ещё внутри того же тега. Такой счёт не
      // спотыкается о `>` внутри выражения, в отличие от разбора тега целиком.
      const mentions = (src.match(/<script\b[^<]*?application\/ld\+json/gi) ?? []).length;
      let parsedHere = 0;

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

      for (const m of src.matchAll(tagRe)) {
        parsedHere++;
        const tag = m[0];
        const setHtml = /set:html=\{([\s\S]*)\}/.exec(tag);
        if (!/\bset:html=/.test(tag)) continue; // без set:html подставлять нечего
        if (!setHtml) {
          unparsed.push(`${file.replace(SRC, 'src')}: не разобран set:html в ${tag.trim()}`);
          continue;
        }
        tags++;
        if (!isWholeSerializeCall(setHtml[1])) {
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

      if (parsedHere !== mentions) {
        unparsed.push(
          `${file.replace(SRC, 'src')}: упоминаний типа ${mentions}, разобранных тегов ${parsedHere}`,
        );
      }
    }

    expect(
      unparsed,
      'теги JSON-LD, которые не удалось разобрать, — это «не смогла проверить», ' +
        'а не «нарушений нет»:\n' + unparsed.join('\n'),
    ).toEqual([]);

    // «Проверять нечего» — провал проверки, а не успех: если разметка изменится и
    // регулярка перестанет находить теги, гейт обязан сказать об этом вслух.
    expect(tags, 'в src не найдено ни одного script[type=ld+json] с set:html').toBeGreaterThan(0);
    expect(
      offenders,
      'JSON-LD вставляется мимо serializeJsonLd — экранирование закрывающего тега теряется:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
