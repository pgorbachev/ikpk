import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareArticleImages } from '../src/lib/article-images.js';
import { localizeAssetUrls } from '../src/lib/media.js';
import { dist } from './helpers/dist-pages.js';
import { CONTENT_JSON_DIR, FIXTURES_DIR } from './helpers/rich-content-safety/paths.js';
import {
  buildMigrationPageInventory,
  type MigrationPageInventory,
} from './helpers/rich-content-safety/migration-page-inventory.js';
import type { MigrationRow } from './helpers/rich-content-safety/migration.js';

describe('rich-content contract: migration classes in production output', () => {
  it('live inventory совпадает с committed evidence и article detail routes не теряют mapped classes', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'migration-manifest.json'), 'utf-8'),
    ) as MigrationRow[];
    const report = buildMigrationPageInventory(manifest, dist);
    const committed = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'evidence', 'migration-page-inventory.json'), 'utf-8'),
    ) as MigrationPageInventory;

    // The migration manifest records color:transparent on each legacy cover
    // <img>. Article pages now render that same image once in the hero and
    // remove its wrapper from the rich body, so the sanitizer no longer emits
    // the mapped class for that removed body image. Verify this exact move from
    // the pinned source data and built page before excluding only that mapping
    // from the inventory comparison; all other mapped classes remain required.
    const articles = JSON.parse(
      readFileSync(join(CONTENT_JSON_DIR, 'articles.json'), 'utf-8'),
    ) as { slug: string; image: string | null; body_html: string }[];
    const articlesBySlug = new Map(articles.map((article) => [article.slug, article]));
    const coverStyleRoutes = new Set(
      manifest
        .filter((row) =>
          row.selectorId === 'articles[*].body_html' &&
          row.kind === 'style' &&
          row.context === 'img[style]' &&
          row.sourceValue === 'color:transparent' &&
          row.replacementClass === 'rc-color-10e9f560' &&
          /^\/statyi\/[^/]+$/.test(row.route),
        )
        .map((row) => row.route),
    );
    const safelyRelocatedCoverRoutes = new Set<string>();
    for (const route of coverStyleRoutes) {
      const slug = route.slice('/statyi/'.length);
      const article = articlesBySlug.get(slug);
      const sourceImageTag = article?.body_html.match(/<img\b[^>]*>/i)?.[0];
      const sourceImage = sourceImageTag?.match(/\bsrc=(['"])(.*?)\1/i)?.[2];
      const hasTransparentColor = /\bstyle=(['"])[^'"]*color\s*:\s*transparent[^'"]*\1/i.test(
        sourceImageTag ?? '',
      );
      const prepared = article?.image
        ? prepareArticleImages(article.body_html, article.image)
        : undefined;
      const pagePath = join(dist, route.slice(1), 'index.html');
      const pageHtml = readFileSync(pagePath, 'utf-8');
      const hero = pageHtml.match(/<div class="article-hero"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
      const heroImage = hero.match(/<img\b[^>]*\bsrc=(['"])(.*?)\1/i)?.[2];

      if (
        article?.image &&
        sourceImage &&
        hasTransparentColor &&
        prepared &&
        !prepared.bodyHtml.includes(sourceImageTag!) &&
        heroImage === localizeAssetUrls(article.image)
      ) {
        safelyRelocatedCoverRoutes.add(route);
      }
    }
    expect(safelyRelocatedCoverRoutes).toEqual(coverStyleRoutes);

    const migrationPagesWithoutRemovedCoverMappings = report.pagesWithMissingClasses
      .map((page) => ({
        ...page,
        missingClasses: page.missingClasses.filter((className) =>
          !(
            className === 'rc-color-10e9f560' &&
            safelyRelocatedCoverRoutes.has(page.route)
          ),
        ),
      }))
      .filter((page) => page.missingClasses.length > 0);
    expect(report.renderedRoutes, 'migration routes отсутствуют — vacuous green').toBeGreaterThan(0);
    expect(report.missingPages).toEqual([]);
    expect(migrationPagesWithoutRemovedCoverMappings).toEqual(committed.pagesWithMissingClasses);
    expect(
      migrationPagesWithoutRemovedCoverMappings.filter((page) => /^\/statyi\/[^/]+$/.test(page.route)),
    ).toEqual([]);
    expect(report.pagesWithSvgInRich).toEqual([]);
    expect(report.pagesWithStyleInRich).toEqual([]);
  });
});
