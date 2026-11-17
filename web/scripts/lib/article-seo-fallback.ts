import { parseFragment } from 'parse5';
import { cleanBodyHtml } from '../../src/lib/html-cleaner.ts';

interface TextNode { nodeName: string; value?: string; childNodes?: TextNode[] }

const TEXT_BLOCKS = new Set([
  'address', 'article', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

export function sanitizedArticleText(body: string, id: string): string {
  const rendered = cleanBodyHtml(body, { sourceType: 'article', sourceId: id }).html;
  const tree = parseFragment(rendered) as unknown as TextNode;
  const collect = (node: TextNode): string => {
    if (node.nodeName === '#text') return node.value ?? '';
    if (node.nodeName === 'br' || node.nodeName === 'hr') return ' ';
    const content = (node.childNodes ?? []).map(collect).join('');
    return TEXT_BLOCKS.has(node.nodeName) ? ` ${content} ` : content;
  };
  return collect(tree).replace(/\s+/g, ' ').trim();
}

export function articleSeoDescriptionFallback(body: string, id: string): string {
  return Array.from(sanitizedArticleText(body, id)).slice(0, 200).join('');
}
