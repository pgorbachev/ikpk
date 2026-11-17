import { describe, expect, it } from 'vitest';
import { validateSnapshotContract } from '../scripts/lib/content-contract';
import { cleanBodyHtml } from '../src/lib/data';
import type { Snapshot } from '../scripts/lib/content-snapshot';
import { parseFragment } from 'parse5';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, WEB_ROOT } from './helpers/cms-content-publication-contract';

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

interface ParsedNode { nodeName: string; value?: string; childNodes?: ParsedNode[] }

function textFromHtml(html: string): string {
  const visit = (node: ParsedNode): string =>
    (node.nodeName === '#text' ? node.value ?? '' : '') + (node.childNodes ?? []).map(visit).join(' ');
  return visit(parseFragment(html) as unknown as ParsedNode).replace(/\s+/g, ' ').trim();
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

describe('built Article metadata uses normalized snapshot values', () => {
  it('emits fallback and explicit overrides in title, description, OG metadata and JSON-LD', () => {
    const root = mkdtempSync(join(tmpdir(), 'article-seo-built-metadata-'));
    const source = join(root, 'snapshot');
    const dist = join(root, 'dist');
    cpSync(join(REPO_ROOT, 'fixtures', 'content-snapshot'), source, { recursive: true });
    const snapshotPath = join(source, 'snapshot.json');
    const data = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      content: { types: { articles: Record<string, unknown>[] } };
    };
    const fallbackArticle = data.content.types.articles[0]!;
    const explicitArticle = data.content.types.articles[1]!;
    const fallbackDescription = 'Санитизированный текст & сущности статьи для generated metadata.';
    fallbackArticle.body_html = '<p>Санитизированный текст &amp; сущности статьи для generated metadata.</p>';
    fallbackArticle.body_text = fallbackDescription;
    delete fallbackArticle.seo_title;
    delete fallbackArticle.seo_description;
    explicitArticle.seo_title = 'Сохранённый SEO title';
    explicitArticle.seo_description = 'Сохранённое редакторское описание';
    writeFileSync(snapshotPath, JSON.stringify(data));
    try {
      execFileSync(join(WEB_ROOT, 'node_modules', '.bin', 'astro'), ['build', '--outDir', dist], {
        cwd: WEB_ROOT,
        env: { ...process.env, CONTENT_SNAPSHOT_DIR: source },
        timeout: 120_000,
        stdio: 'pipe',
      });

      const readPage = (slug: string) => readFileSync(join(dist, 'statyi', slug, 'index.html'), 'utf8');
      const fallbackHtml = readPage(String(fallbackArticle.slug));
      const explicitHtml = readPage(String(explicitArticle.slug));
      const metadata = (html: string, selector: string): string => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = html.match(new RegExp(`<meta\\s+[^>]*(?:name|property)="${escaped}"[^>]*content="([^"]*)"|<meta\\s+[^>]*content="([^"]*)"[^>]*(?:name|property)="${escaped}"`));
        return match?.[1] ?? match?.[2] ?? '';
      };
      const schema = (html: string) => {
        const value = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
        return value ? JSON.parse(value) as Record<string, unknown> : {};
      };

      expect(fallbackHtml).toContain(`<title>${fallbackArticle.title}</title>`);
      expect(metadata(fallbackHtml, 'description')).toContain('Санитизированный текст &amp; сущности');
      expect(metadata(fallbackHtml, 'og:title')).toContain(String(fallbackArticle.title));
      expect(metadata(fallbackHtml, 'og:description')).toContain('Санитизированный текст &amp; сущности');
      expect(schema(fallbackHtml)).toMatchObject({ headline: fallbackArticle.title, description: fallbackDescription });
      expect(schema(fallbackHtml).url).toBe(`https://ikpk.su/statyi/${fallbackArticle.slug}`);
      expect(metadata(fallbackHtml, 'robots')).toBe('');
      expect(metadata(fallbackHtml, 'og:image')).toBe('https://ikpk.su/og-image.png');
      expect(explicitHtml).toContain('<title>Сохранённый SEO title</title>');
      expect(metadata(explicitHtml, 'description')).toBe('Сохранённое редакторское описание');
      expect(metadata(explicitHtml, 'og:title')).toBe('Сохранённый SEO title');
      expect(metadata(explicitHtml, 'og:description')).toBe('Сохранённое редакторское описание');
      expect(schema(explicitHtml)).toMatchObject({ headline: 'Сохранённый SEO title', description: 'Сохранённое редакторское описание' });
      expect(schema(explicitHtml).url).toBe(`https://ikpk.su/statyi/${explicitArticle.slug}`);
      expect(metadata(explicitHtml, 'robots')).toBe('');
      expect(metadata(explicitHtml, 'og:image')).toBe('https://ikpk.su/og-image.png');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
