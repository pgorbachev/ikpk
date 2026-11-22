import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFragment } from 'parse5';
import { cleanBodyHtml as cleanRaw } from '../src/lib/html-cleaner.js';
import { renderArticleBody } from '../src/lib/article-body-render.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';
import { CONTENT_JSON_DIR } from './helpers/rich-content-safety/paths.js';

const clean = (body: string) => htmlOf(cleanRaw(renderArticleBody(body)));

interface ContentNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: ContentNode[];
}

function visibleContent(html: string): {
  text: string;
  images: string[];
  links: { href: string; text: string }[];
  structure: string[];
} {
  const root = parseFragment(html) as unknown as ContentNode;
  const text: string[] = [];
  const images: string[] = [];
  const links: { href: string; text: string }[] = [];
  const structure: string[] = [];
  const textOf = (node: ContentNode): string =>
    node.nodeName === '#text'
      ? node.value ?? ''
      : (node.childNodes ?? []).map(textOf).join(' ');
  const visit = (node: ContentNode) => {
    if (node.nodeName === '#text') text.push(node.value ?? '');
    if (node.tagName === 'img') {
      const attr = (name: string) => node.attrs?.find((value) => value.name === name)?.value;
      const src = attr('src');
      if (src) images.push(`${src}\u0000${attr('alt') ?? ''}`);
    }
    if (node.tagName === 'a') {
      const href = node.attrs?.find((attr) => attr.name === 'href')?.value;
      if (href) links.push({ href, text: textOf(node).replace(/\s+/g, ' ').trim() });
    }
    if (node.tagName && /^(?:h[2-6]|p|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|strong|b|em|i|pre|code|blockquote)$/.test(node.tagName)) {
      structure.push(node.tagName);
    }
    node.childNodes?.forEach(visit);
  };
  visit(root);
  return { text: text.join(' ').replace(/\s+/g, ' ').trim(), images, links, structure };
}

describe('article body rendering', () => {
  it('turns blank-line-separated plain text into distinct paragraphs', () => {
    const result = clean(
      'Перед встречей освободите проход к кушетке и проверьте, что вокруг неё удобно перемещаться. ' +
        'Положите рядом чистое бельё, салфетки и материалы, которые понадобятся для работы.\n\n' +
        'Проветрите помещение, настройте комфортное освещение и уберите с пола провода и другие предметы. ' +
        'Уточните, удобно ли посетителю расположиться и комфортна ли температура в кабинете.\n\n' +
        'После приёма уберите использованные материалы и обработайте рабочие поверхности. ' +
        'Проверьте запас чистого белья и подготовьте кабинет к следующей встрече.',
    );

    expect(result.match(/<p>/g)).toHaveLength(3);
    expect(result).toContain(
      '<p>Проветрите помещение, настройте комфортное освещение и уберите с пола провода и другие предметы. ' +
        'Уточните, удобно ли посетителю расположиться и комфортна ли температура в кабинете.</p>',
    );
  });

  it('renders Markdown blocks and inline emphasis', () => {
    const result = clean('## Подготовка\n\nПроверьте **чистое бельё**.\n\n- Салфетки\n- Материалы');

    expect(result).toContain('<h2>Подготовка</h2>');
    expect(result).toContain('<p>Проверьте <strong>чистое бельё</strong>.</p>');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>Салфетки</li>');
  });

  it('keeps Markdown H1 content visible below the page title', () => {
    const result = clean('# Заголовок внутри статьи\n\nТекст раздела.');

    expect(result).toContain('<h2>Заголовок внутри статьи</h2>');
    expect(result).toContain('<p>Текст раздела.</p>');
    expect(result).not.toContain('<h1>');
  });

  it('preserves legacy HTML structure without escaping or wrapping it twice', () => {
    const legacy = '<p>Содержание</p>\n\n<table><tbody><tr><td>Ячейка</td></tr></tbody></table>';
    const result = clean(legacy);

    expect(result).toContain('<p>Содержание</p>');
    expect(result).toMatch(/<table\b/);
    expect(result).toContain('<td>Ячейка</td>');
    expect(result).not.toContain('&lt;p&gt;');
    expect(result.match(/<p>/g)).toHaveLength(1);
  });

  it('preserves indented legacy HTML paragraphs instead of converting them to code', () => {
    const result = clean(
      '<div class="articles-form_articleContainer__legacy">\n' +
        '    <p>Первый</p>\n    <p>Второй</p>\n' +
        '</div>',
    );

    expect(result).toContain('<p>Первый</p>');
    expect(result).toContain('<p>Второй</p>');
    expect(result).not.toContain('<pre>');
    expect(result).not.toContain('&lt;p&gt;');
  });

  it('renders Markdown appended after a saved legacy HTML wrapper', () => {
    const result = clean(
      '<div class="articles-form_articleContainer__legacy">\n' +
        '    <p>Старый абзац</p>\n' +
        '</div>\n\n' +
        '## Дополнение редактора\n\nНовый абзац.',
    );

    expect(result).toContain('<p>Старый абзац</p>');
    expect(result).toContain('<h2>Дополнение редактора</h2>');
    expect(result).toContain('<p>Новый абзац.</p>');
  });

  it('keeps fenced and indented Markdown HTML examples as code', () => {
    const fenced = clean('```html\n<p>пример</p>\n```');
    const indented = clean('    <p>пример</p>');

    expect(fenced).toContain('<pre>');
    expect(fenced).toContain('&lt;p&gt;пример&lt;/p&gt;');
    expect(indented).toContain('<pre>');
    expect(indented).toContain('&lt;p&gt;пример&lt;/p&gt;');
  });

  it('does not treat a Markdown code sample as legacy HTML by its class text', () => {
    const result = clean('```html\n<div class="articles-form_articleContainer__example">пример</div>\n```');

    expect(result).toContain('<pre>');
    expect(result).toContain('&lt;div&gt;пример&lt;/div&gt;');
  });

  it('renders Markdown replacement for an article that still has a legacy_id', () => {
    const editedArticle = {
      legacy_id: 'statyi/old-slug',
      body_html: '# Новое тело статьи\n\nПервый абзац.\n\nВторой абзац.',
    };
    const result = clean(editedArticle.body_html);

    expect(result).toContain('<h2>Новое тело статьи</h2>');
    expect(result.match(/<p>/g)).toHaveLength(2);
    expect(result).toContain('Второй абзац.');
  });

  it('preserves visible text and image URLs for all 68 migrated article bodies', () => {
    const articles = JSON.parse(
      readFileSync(join(CONTENT_JSON_DIR, 'articles.json'), 'utf8'),
    ) as { slug: string; body_html: string }[];
    expect(articles).toHaveLength(68);

    for (const article of articles) {
      const options = { sourceType: 'article', sourceId: article.slug };
      const before = visibleContent(htmlOf(cleanRaw(article.body_html, options)));
      const after = visibleContent(htmlOf(cleanRaw(renderArticleBody(article.body_html), options)));
      expect(after, article.slug).toEqual(before);
    }
  });

  it('handles raw HTML beside Markdown paragraphs', () => {
    const mixed = 'Вводный текст.\n\n<strong>Выделенный фрагмент</strong>\n\nЗаключительный текст.';
    const result = clean(mixed);

    expect(result).toContain('<p>Вводный текст.</p>');
    expect(result).toContain('<p><strong>Выделенный фрагмент</strong></p>');
    expect(result).toContain('<p>Заключительный текст.</p>');
  });

  it('keeps generated Markdown behind the existing HTML sanitizer', () => {
    const result = clean('Безопасный текст.\n\n<script>alert(1)</script><img src=x onerror=alert(1)>');

    expect(result).toContain('<p>Безопасный текст.</p>');
    expect(result).not.toMatch(/<script|onerror/i);
  });

  it('sanitizes unsafe raw HTML URLs and mutations at the article sink', () => {
    const result = clean(
      '<a href="javascript:alert(1)" onclick="alert(2)">Опасная ссылка</a>\n\n' +
        '<p onclick="alert(3)">Безопасный текст</p>',
    );

    expect(result).toContain('Опасная ссылка');
    expect(result).toContain('Безопасный текст');
    expect(result).not.toMatch(/href\s*=\s*["']?javascript:/i);
    expect(result).not.toMatch(/onclick/i);
  });
});
