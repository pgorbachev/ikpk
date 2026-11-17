import { describe, expect, it } from 'vitest';
import { validateSnapshotContract } from '../scripts/lib/content-contract';
import { cleanBodyHtml } from '../src/lib/data';
import type { Snapshot } from '../scripts/lib/content-snapshot';
import { parseFragment } from 'parse5';

const article = {
  slug: 'article-seo-red',
  title: 'Заголовок статьи',
  body_html: '<p>Текст статьи</p>',
  image: '/media/article.jpg',
  published_at: '2026-11-17T00:00:00.000Z',
};

function snapshot(record: Record<string, unknown>): Snapshot {
  return {
    referenceDate: '2026-11-17',
    content: { types: { articles: [record] }, media: [] },
  };
}

function textFromHtml(html: string): string {
  const visit = (node: any): string =>
    (node.nodeName === '#text' ? node.value : '') + (node.childNodes ?? []).map(visit).join(' ');
  return visit(parseFragment(html)).replace(/\s+/g, ' ').trim();
}

describe('Article website snapshot SEO defaults', () => {
  it('accepts a normalized record with independently generated, nonempty SEO fields', () => {
    const normalized = {
      ...article,
      seo_title: article.title,
      seo_description: 'Текст статьи',
    };
    expect(validateSnapshotContract(snapshot(normalized)).ok).toBe(true);
  });

  it('rejects absent SEO fallback when sanitized body has no text, identifying the Article', () => {
    const sanitized = cleanBodyHtml('<script>secret()</script><style>.x{}</style>', {
      type: 'article', id: article.slug,
    });
    expect(textFromHtml(sanitized.html)).toBe('');
    const result = validateSnapshotContract(snapshot({ ...article, body_html: '<script>secret()</script><style>.x{}</style>' }));
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'articles', recordId: article.slug, rule: 'required-field-empty' }),
    ]));
  });

  it('characterizes rendered sanitizer text: entities decode, discarded subtrees vanish, stripped hidden attributes leave text visible', () => {
    const sanitized = cleanBodyHtml(
      '<p>Alpha &amp; beta</p><script>secret()</script><style>.secret{}</style>' +
      '<p hidden>Visible after sanitizer</p><span aria-hidden="true">Also visible</span>',
      { type: 'article', id: article.slug },
    );
    expect(textFromHtml(sanitized.html)).toBe('Alpha & beta Visible after sanitizer Also visible');
  });
});
