// Вычислитель выражений GitHub Actions (`if:`) — ровно того подмножества, которое
// встречается в условиях джобов и шагов.
//
// Зачем он вообще, вместо регулярного выражения по тексту условия. Спека говорит о
// ПОВЕДЕНИИ: «прогон упал — публикация не запускается», «ручной запуск публикует».
// Поиск подстроки `conclusion == 'success'` этого не проверяет: условие
// `conclusion == 'success' || true` содержит нужную подстроку и при этом публикует
// всегда. Проверка обязана отличать «условие закрыто» от «в тексте есть похожие
// слова», а для этого условие надо вычислить в контексте события.
//
// Отдельная сложность — ссылки на выходы шагов и джобов (`needs.guard.outputs.…`).
// Их значение в момент разбора конфигурации неизвестно, и подставить «удобное»
// нельзя: у одной реализации guard отдаёт `stale=true`, у другой `fresh=true`.
// Поэтому такие подвыражения считаются НЕИЗВЕСТНЫМИ атомами, а вопрос задаётся в
// форме выполнимости:
//
//   - «может ли условие быть истинным» — для сценариев, где публикация обязана
//     оставаться возможной (успех тестов, ручной запуск);
//   - «может ли условие быть истинным ХОТЬ ПРИ КАКИХ-ТО значениях выходов» — если
//     нет, условие закрыто наглухо, и это то, что требуется для упавшего прогона,
//     отменённого прогона и кода из форка.
//
// Неизвестные атомы считаются независимыми друг от друга. Это ослабляет только
// доказательство невыполнимости в сторону БОЛЬШЕЙ строгости (условие легче признать
// выполнимым, то есть проверка скорее покраснеет, чем позеленеет), — ошибка в
// безопасную сторону.

export type ExprNode =
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'path'; p: string }
  | { t: 'not'; a: ExprNode }
  | { t: 'bin'; op: BinOp; a: ExprNode; b: ExprNode }
  | { t: 'call'; name: string; args: ExprNode[] };

type BinOp = '==' | '!=' | '&&' | '||' | '<' | '<=' | '>' | '>=';

/** Контекст `github` для конкретного события. Отсутствующее свойство — `null`,
 *  как в самих Actions: у `workflow_dispatch` объекта `workflow_run` нет вовсе. */
export interface GithubContext {
  event_name: string;
  repository: string;
  repository_owner?: string;
  sha?: string;
  ref?: string;
  ref_name?: string;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------- лексер

type Token = { k: 'op' | 'name' | 'str' | 'num' | 'punc'; v: string };

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!'];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= src.length) throw new Error(`незакрытая строка в выражении: ${src}`);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += src[j];
        j += 1;
      }
      out.push({ k: 'str', v: value });
      i = j + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ k: 'op', v: op });
      i += op.length;
      continue;
    }
    if ('()[],.'.includes(c)) {
      out.push({ k: 'punc', v: c });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new Error(`не разобрано число в выражении: ${src}`);
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (!m) throw new Error(`неизвестный символ '${c}' в выражении: ${src}`);
    out.push({ k: 'name', v: m[0] });
    i += m[0].length;
  }
  return out;
}

// ---------------------------------------------------------------- парсер

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  parse(): ExprNode {
    const node = this.or();
    if (this.pos !== this.tokens.length)
      throw new Error(`лишние токены после выражения: ${this.src}`);
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eat(k: Token['k'], v?: string): Token {
    const t = this.peek();
    if (!t || t.k !== k || (v !== undefined && t.v !== v))
      throw new Error(`ожидалось ${v ?? k} в выражении: ${this.src}`);
    this.pos += 1;
    return t;
  }

  private tryOp(...values: string[]): string | undefined {
    const t = this.peek();
    if (t && t.k === 'op' && values.includes(t.v)) {
      this.pos += 1;
      return t.v;
    }
    return undefined;
  }

  private or(): ExprNode {
    let node = this.and();
    for (;;) {
      if (!this.tryOp('||')) return node;
      node = { t: 'bin', op: '||', a: node, b: this.and() };
    }
  }

  private and(): ExprNode {
    let node = this.comparison();
    for (;;) {
      if (!this.tryOp('&&')) return node;
      node = { t: 'bin', op: '&&', a: node, b: this.comparison() };
    }
  }

  private comparison(): ExprNode {
    let node = this.unary();
    for (;;) {
      const op = this.tryOp('==', '!=', '<', '<=', '>', '>=');
      if (!op) return node;
      node = { t: 'bin', op: op as BinOp, a: node, b: this.unary() };
    }
  }

  private unary(): ExprNode {
    if (this.tryOp('!')) return { t: 'not', a: this.unary() };
    return this.primary();
  }

  private primary(): ExprNode {
    const t = this.peek();
    if (!t) throw new Error(`выражение обрывается: ${this.src}`);
    if (t.k === 'punc' && t.v === '(') {
      this.pos += 1;
      const node = this.or();
      this.eat('punc', ')');
      return node;
    }
    if (t.k === 'str') {
      this.pos += 1;
      return { t: 'lit', v: t.v };
    }
    if (t.k === 'num') {
      this.pos += 1;
      return { t: 'lit', v: Number(t.v) };
    }
    if (t.k === 'name') {
      this.pos += 1;
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      const next = this.peek();
      if (next && next.k === 'punc' && next.v === '(') {
        this.pos += 1;
        const args: ExprNode[] = [];
        if (!(this.peek()?.k === 'punc' && this.peek()?.v === ')')) {
          for (;;) {
            args.push(this.or());
            if (this.peek()?.k === 'punc' && this.peek()?.v === ',') {
              this.pos += 1;
              continue;
            }
            break;
          }
        }
        this.eat('punc', ')');
        return { t: 'call', name: t.v, args };
      }
      // путь: name ('.' name | '[' str ']')*
      let path = t.v;
      for (;;) {
        const p = this.peek();
        if (p && p.k === 'punc' && p.v === '.') {
          this.pos += 1;
          path += `.${this.eat('name').v}`;
          continue;
        }
        if (p && p.k === 'punc' && p.v === '[') {
          this.pos += 1;
          const key = this.eat('str').v;
          this.eat('punc', ']');
          path += `.${key}`;
          continue;
        }
        break;
      }
      return { t: 'path', p: path };
    }
    throw new Error(`не разобран токен '${t.v}' в выражении: ${this.src}`);
  }
}

/** Снимает обёртку `${{ … }}`, если она есть: в `if:` она необязательна. */
export function parseExpression(raw: string): ExprNode {
  const trimmed = raw.trim();
  const unwrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed);
  const body = (unwrapped ? unwrapped[1] : trimmed).trim();
  if (body === '') throw new Error('пустое выражение');
  return new Parser(tokenize(body), body).parse();
}

// ---------------------------------------------------------------- вычисление

const UNKNOWN = Symbol('unknown');
type Value = string | number | boolean | null | typeof UNKNOWN;

/**
 * Корни контекста, значение которых на разборе конфигурации неизвестно.
 * `github` в этот список НЕ входит: его мы задаём сами, и отсутствующее свойство
 * там означает `null`, а не «не знаю», — ровно как в Actions.
 */
const UNKNOWN_ROOTS = new Set([
  'needs',
  'steps',
  'env',
  'vars',
  'secrets',
  'inputs',
  'matrix',
  'strategy',
  'job',
  'runner',
  'jobs',
]);

function resolvePath(path: string, github: GithubContext): Value {
  const parts = path.split('.');
  if (UNKNOWN_ROOTS.has(parts[0])) return UNKNOWN;
  if (parts[0] !== 'github') return UNKNOWN;
  let cur: unknown = github;
  for (const part of parts.slice(1)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === undefined) return null;
  if (cur !== null && typeof cur === 'object') return UNKNOWN; // объект в булевой позиции — не наш случай
  return cur as Value;
}

/** Приведение к числу по правилам GitHub: `null`/`''`/`false` → 0, `true` → 1. */
function toNumber(v: Exclude<Value, typeof UNKNOWN>): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (v === '') return 0;
  const n = Number(v);
  return Number.isNaN(n) ? NaN : n;
}

function looseEq(a: Exclude<Value, typeof UNKNOWN>, b: Exclude<Value, typeof UNKNOWN>): boolean {
  if (typeof a === typeof b && !(a === null) && !(b === null)) {
    if (typeof a === 'string') return a.toLowerCase() === (b as string).toLowerCase();
    return a === b;
  }
  if (a === null && b === null) return true;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  return na === nb;
}

function truthy(v: Exclude<Value, typeof UNKNOWN>): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v !== '';
}

/**
 * Может ли узел дать значение с истинностью `want` хотя бы при каком-то наборе
 * значений неизвестных подвыражений.
 */
function satisfiable(node: ExprNode, want: boolean, github: GithubContext): boolean {
  switch (node.t) {
    case 'bin':
      if (node.op === '&&')
        return want
          ? satisfiable(node.a, true, github) && satisfiable(node.b, true, github)
          : satisfiable(node.a, false, github) || satisfiable(node.b, false, github);
      if (node.op === '||')
        return want
          ? satisfiable(node.a, true, github) || satisfiable(node.b, true, github)
          : satisfiable(node.a, false, github) && satisfiable(node.b, false, github);
      break;
    case 'not':
      return satisfiable(node.a, !want, github);
    default:
      break;
  }
  const v = evaluate(node, github);
  if (v === UNKNOWN) return true; // неизвестный атом — может быть любым
  return truthy(v) === want;
}

function evaluate(node: ExprNode, github: GithubContext): Value {
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'path':
      return resolvePath(node.p, github);
    case 'not': {
      const v = evaluate(node.a, github);
      return v === UNKNOWN ? UNKNOWN : !truthy(v);
    }
    case 'call':
      return evaluateCall(node, github);
    case 'bin': {
      const a = evaluate(node.a, github);
      const b = evaluate(node.b, github);
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      switch (node.op) {
        case '==':
          return looseEq(a, b);
        case '!=':
          return !looseEq(a, b);
        case '&&':
          return truthy(a) ? b : a;
        case '||':
          return truthy(a) ? a : b;
        default: {
          const na = toNumber(a);
          const nb = toNumber(b);
          if (Number.isNaN(na) || Number.isNaN(nb)) return false;
          if (node.op === '<') return na < nb;
          if (node.op === '<=') return na <= nb;
          if (node.op === '>') return na > nb;
          return na >= nb;
        }
      }
    }
  }
}

function evaluateCall(node: Extract<ExprNode, { t: 'call' }>, github: GithubContext): Value {
  const args = node.args.map((a) => evaluate(a, github));
  const name = node.name.toLowerCase();
  // Функции статуса. `success()` на счастливом пути истинна, `failure()`/`cancelled()`
  // — ложны. `always()` не вычисляется как значение: она ломает саму модель «условие
  // публикации = конъюнкция условий по пути», и её наличие проверяется отдельно.
  if (name === 'success') return true;
  if (name === 'always') return true;
  if (name === 'failure' || name === 'cancelled') return false;
  if (args.some((a) => a === UNKNOWN)) return UNKNOWN;
  const known = args as Exclude<Value, typeof UNKNOWN>[];
  const str = (v: Exclude<Value, typeof UNKNOWN>): string => (v === null ? '' : String(v));
  switch (name) {
    case 'contains':
      return str(known[0]).toLowerCase().includes(str(known[1]).toLowerCase());
    case 'startswith':
      return str(known[0]).toLowerCase().startsWith(str(known[1]).toLowerCase());
    case 'endswith':
      return str(known[0]).toLowerCase().endsWith(str(known[1]).toLowerCase());
    case 'format': {
      let out = str(known[0]);
      known.slice(1).forEach((v, i) => {
        out = out.split(`{${i}}`).join(str(v));
      });
      return out;
    }
    default:
      // Неизвестная функция — это «я не смогла проверить», а не «дефектов нет».
      throw new Error(`неизвестная функция '${node.name}' в условии`);
  }
}

/**
 * Вычисляет выражение до значения. Для шаблонов вида
 * `${{ a && b || c }}` — тех, которыми задают `ref` у checkout. Возвращает
 * `undefined`, если значение зависит от неизвестных выходов шагов.
 */
export function evaluateToValue(
  expr: string,
  github: GithubContext,
): string | number | boolean | null | undefined {
  const raw = expr.trim();
  if (/^\$\{\{[\s\S]*\}\}$/.test(raw) && raw.indexOf('${{', 2) === -1) {
    const v = evaluate(parseExpression(raw), github);
    return v === UNKNOWN ? undefined : v;
  }
  // Смешанный шаблон: текст со вставками. Подставляем каждую вставку по месту.
  if (!raw.includes('${{')) return raw;
  let out = '';
  let rest = raw;
  for (;;) {
    const open = rest.indexOf('${{');
    if (open === -1) {
      out += rest;
      return out;
    }
    const close = rest.indexOf('}}', open);
    if (close === -1) throw new Error(`незакрытая вставка в шаблоне: ${expr}`);
    out += rest.slice(0, open);
    const v = evaluate(parseExpression(rest.slice(open + 3, close)), github);
    if (v === UNKNOWN) return undefined;
    out += v === null ? '' : String(v);
    rest = rest.slice(close + 2);
  }
}

/** Может ли условие оказаться истинным в этом контексте. */
export function canBeTrue(expr: string, github: GithubContext): boolean {
  return satisfiable(parseExpression(expr), true, github);
}

/** Заведомо ложно при любых значениях неизвестных выходов. */
export function isAlwaysFalse(expr: string, github: GithubContext): boolean {
  return !canBeTrue(expr, github);
}

/** Есть ли в выражении вызов `always()` — он отменяет пропуск джоба по `needs`. */
export function usesAlways(expr: string): boolean {
  const walk = (n: ExprNode): boolean => {
    switch (n.t) {
      case 'call':
        return n.name.toLowerCase() === 'always' || n.args.some(walk);
      case 'not':
        return walk(n.a);
      case 'bin':
        return walk(n.a) || walk(n.b);
      default:
        return false;
    }
  };
  return walk(parseExpression(expr));
}

/** Конъюнкция условий: истинна, только если ВСЕ могут быть истинны одновременно. */
export function conjunctionCanBeTrue(exprs: string[], github: GithubContext): boolean {
  return exprs.every((e) => canBeTrue(e, github));
}
