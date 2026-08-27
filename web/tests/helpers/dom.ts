import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

/**
 * Разбор собранного HTML деревом, а не регулярками: приблизительный разбор в этом
 * репозитории уже дважды давал обход гейта (AGENTS.md, «Гейтам нужен парсер»).
 */
export type Element = DefaultTreeAdapterMap['element'];
export type ChildNode = DefaultTreeAdapterMap['childNode'];

export function parseDocument(html: string): DefaultTreeAdapterMap['document'] {
  return parse(html);
}

/**
 * `<noscript>` — parse5 по умолчанию не разбирает его содержимое как разметку: оно
 * приходит единственным текстовым узлом. Разбираем этот текст сами и возвращаем
 * результат ВМЕСТО текстового узла (не вместе с ним — иначе `textOf()` посчитает
 * содержимое дважды). Срабатывает только на форме «ровно один дочерний узел, и это
 * текст» — noscript с уже разобранной разметкой (элемент внутри, как в проде сегодня)
 * этот путь не затрагивает.
 */
function noscriptMarkup(n: { nodeName?: string; childNodes?: ChildNode[] }): ChildNode[] | null {
  if (n.nodeName !== 'noscript') return null;
  const own = n.childNodes ?? [];
  if (own.length !== 1) return null;
  const only = own[0] as { nodeName?: string; value?: string };
  if (only.nodeName !== '#text') return null;
  return parseFragment(only.value ?? '').childNodes as unknown as ChildNode[];
}

function children(node: unknown): ChildNode[] {
  const n = node as {
    nodeName?: string;
    childNodes?: ChildNode[];
    content?: { childNodes?: ChildNode[] };
  };
  const noscript = noscriptMarkup(n);
  if (noscript !== null) return noscript;
  // Содержимое <template> лежит в отдельном фрагменте: без него обход слепнет ровно
  // там, где разметка спрятана (у нас так спрятан каталог статей).
  const own = n.childNodes ?? [];
  const templated = n.content?.childNodes ?? [];
  return [...own, ...templated];
}

/** Все элементы поддерева в порядке документа, включая содержимое <template>. */
export function* walk(node: unknown): Generator<Element> {
  for (const child of children(node)) {
    if ('tagName' in child) {
      yield child as Element;
      yield* walk(child);
    }
  }
}

export function attr(el: Element, name: string): string | null {
  return el.attrs.find((a) => a.name === name)?.value ?? null;
}

export function hasClass(el: Element, name: string): boolean {
  return (attr(el, 'class') ?? '').split(/\s+/).includes(name);
}

/** Видимый текст поддерева с нормализованными пробелами. */
export function textOf(node: unknown): string {
  let out = '';
  for (const child of children(node)) {
    if ('tagName' in child) {
      const tag = (child as Element).tagName;
      if (tag === 'script' || tag === 'style') continue;
      out += textOf(child);
    } else if ('value' in child && (child as { nodeName: string }).nodeName === '#text') {
      out += (child as { value: string }).value;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function findAll(html: string, pred: (el: Element) => boolean): Element[] {
  return [...walk(parseDocument(html))].filter(pred);
}

export function byClass(html: string, className: string): Element[] {
  return findAll(html, (el) => hasClass(el, className));
}
