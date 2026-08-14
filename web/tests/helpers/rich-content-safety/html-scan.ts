/**
 * Test-owned HTML scanner. Не использует будущий runtime-parser и не ходит в
 * Chromium: это инвентаризация исходников, а не output oracle.
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

export interface OpenTag {
  name: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
  selfClosing: boolean;
}

export function decodeBasicEntities(raw: string): string {
  return raw
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

export function hasElementNode(html: string): boolean {
  if (!html) return false;
  return /<[A-Za-z]/.test(html);
}

export function parseOpenTag(html: string, start: number): OpenTag | null {
  if (html[start] !== '<') return null;
  const slash = html[start + 1] === '/' ? 1 : 0;
  if (slash) return null;
  const rest = html.slice(start + 1);
  const nameMatch = /^([A-Za-z][\w:-]*)/.exec(rest);
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  let i = start + 1 + nameMatch[1].length;
  const attrs: Record<string, string> = {};
  while (i < html.length) {
    while (i < html.length && (html[i] === ' ' || html[i] === '\n' || html[i] === '\t' || html[i] === '\r')) i += 1;
    if (i >= html.length) break;
    if (html[i] === '>') {
      return { name, attrs, start, end: i + 1, selfClosing: VOID.has(name) };
    }
    if (html[i] === '/' && html[i + 1] === '>') {
      return { name, attrs, start, end: i + 2, selfClosing: true };
    }
    const attr = /^([^\s"'>=/]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(html.slice(i));
    if (!attr) {
      i += 1;
      continue;
    }
    const attrName = attr[1].toLowerCase();
    const attrValue = attr[3] ?? attr[4] ?? attr[5] ?? '';
    attrs[attrName] = decodeBasicEntities(attrValue);
    i += attr[0].length;
  }
  return { name, attrs, start, end: html.length, selfClosing: VOID.has(name) };
}

export function elementEnd(html: string, open: OpenTag): number {
  if (open.selfClosing || VOID.has(open.name)) return open.end;
  const lower = html.toLowerCase();
  const openStr = `<${open.name}`;
  const closeStr = `</${open.name}>`;
  let pos = open.end;
  let depth = 1;
  while (depth > 0 && pos < html.length) {
    const nextClose = lower.indexOf(closeStr, pos);
    if (nextClose === -1) return html.length;
    const nextOpen = lower.indexOf(openStr, pos);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const after = html[nextOpen + openStr.length];
      if (/[\s>/]/.test(after) || after === undefined) {
        depth += 1;
        const tagClose = html.indexOf('>', nextOpen);
        pos = tagClose === -1 ? nextOpen + 1 : tagClose + 1;
      } else {
        pos = nextOpen + 1;
      }
    } else {
      depth -= 1;
      pos = nextClose + closeStr.length;
    }
  }
  return pos;
}

export function* iterateTags(html: string): Generator<OpenTag> {
  for (let i = 0; i < html.length; i += 1) {
    if (html[i] !== '<') continue;
    if (html[i + 1] === '!' || html[i + 1] === '?' || html[i + 1] === '/') continue;
    const tag = parseOpenTag(html, i);
    if (!tag) continue;
    yield tag;
    i = tag.end - 1;
  }
}

export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitDeclarations(style: string): { property: string; value: string }[] {
  return style
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(':');
      if (idx === -1) return { property: part.trim().toLowerCase(), value: '' };
      return {
        property: part.slice(0, idx).trim().toLowerCase(),
        value: part.slice(idx + 1).trim(),
      };
    })
    .filter((d) => d.property);
}

export interface SvgHit {
  start: number;
  end: number;
  html: string;
  insideAnchor: { href: string; inner: string; start: number; end: number } | null;
}

export function findSvgHits(html: string): SvgHit[] {
  const hits: SvgHit[] = [];
  const anchors = findElements(html, 'a');
  for (const tag of iterateTags(html)) {
    if (tag.name !== 'svg') continue;
    const end = elementEnd(html, tag);
    const svgHtml = html.slice(tag.start, end);
    const parent = anchors.find((a) => a.start < tag.start && a.end > end) ?? null;
    hits.push({
      start: tag.start,
      end,
      html: svgHtml,
      insideAnchor: parent
        ? {
            href: parent.tag.attrs.href ?? '',
            inner: html.slice(parent.tag.end, parent.end - '</a>'.length),
            start: parent.start,
            end: parent.end,
          }
        : null,
    });
  }
  return hits;
}

export interface ElementHit {
  tag: OpenTag;
  start: number;
  end: number;
  inner: string;
  outer: string;
}

export function findElements(html: string, name: string): ElementHit[] {
  const want = name.toLowerCase();
  const hits: ElementHit[] = [];
  for (const tag of iterateTags(html)) {
    if (tag.name !== want) continue;
    const end = elementEnd(html, tag);
    hits.push({
      tag,
      start: tag.start,
      end,
      inner: html.slice(tag.end, end - (tag.selfClosing ? 0 : `</${want}>`.length)),
      outer: html.slice(tag.start, end),
    });
  }
  return hits;
}

export function isSvgOnlyNamingContent(inner: string): boolean {
  const withoutSvg = inner.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  return visibleText(withoutSvg).length === 0;
}
