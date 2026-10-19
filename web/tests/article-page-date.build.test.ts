import { describe, expect, it } from 'vitest';
import { allPages, readPage } from './helpers/dist-pages';
import { findAll, hasClass, textOf, walk } from './helpers/dom';
import { getArticles } from '../src/lib/data.js';

/**
 * Собственная дата статьи на её странице остаётся. Запрет D22 снимает подпись со списков,
 * а шапку и блок «Дата публикации» не трогает. Гейт списков эти узлы исключает, поэтому
 * снятие обоих `<time>` на странице статьи его не красит.
 */

const CATALOG = '/statyi';

describe('страница статьи сохраняет собственную дату публикации', () => {
  const articlePages = allPages().filter((page) => page.startsWith(`${CATALOG}/`) && page !== `${CATALOG}/`);

  it('страницы статей в выводе есть', () => {
    expect(articlePages.length, 'страниц статей нет — проверять дату не на чем').toBe(getArticles().length);
  });

  it('шапка и блок «Дата публикации» показывают дату', () => {
    const missing: string[] = [];
    for (const page of articlePages) {
      const html = readPage(page);
      const header = findAll(html, (el) => el.tagName === 'time' && hasClass(el, 'article-date'));
      const meta = findAll(html, (el) => hasClass(el, 'sidebar-meta'));
      const metaText = meta.map((el) => textOf(el)).join(' ');
      const metaTime = meta.flatMap((el) => [...walk(el)].filter((node) => node.tagName === 'time'));
      if (header.length === 0 || !metaText.includes('Дата публикации') || metaTime.length === 0) {
        missing.push(page);
      }
    }
    expect(missing, missing.slice(0, 10).join('\n')).toEqual([]);
  });
});
