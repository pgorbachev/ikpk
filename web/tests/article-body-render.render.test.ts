import { afterEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { parse } from 'parse5';
import * as data from '../src/lib/data';
import ArticlePage from '../src/pages/statyi/[slug].astro';

type Node = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
};

const descendants = (node: Node): Node[] => [node, ...(node.childNodes ?? []).flatMap(descendants)];
const attr = (node: Node, name: string) => node.attrs?.find((item) => item.name === name)?.value;
const textOf = (node: Node) =>
  descendants(node).map((child) => child.value ?? '').join(' ').replace(/\s+/g, ' ').trim();

const article = (bodyHtml: string, legacyId: string): data.Article => ({
  legacy_id: legacyId,
  legacy_url: '',
  title: 'Подготовка кабинета к приёму клиента',
  slug: 'kak-podgotovit-kabinet-k-priyomu-klienta',
  seo_title: '',
  seo_description: '',
  body_html: bodyHtml,
  body_text: bodyHtml,
  published_at: null,
  image: null,
});

async function renderArticlePage(record: data.Article): Promise<Node> {
  vi.spyOn(data, 'getArticles').mockReturnValue([record]);
  const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
  const html = await container.renderToString(ArticlePage, {
    request: new Request(`https://ikpk.su/statyi/${record.slug}`),
    props: { article: record },
  });
  return parse(html) as unknown as Node;
}

function articleSink(root: Node): Node {
  const content = descendants(root).find((node) =>
    (attr(node, 'class') ?? '').split(/\s+/).includes('article-body'),
  );
  expect(content, 'actual article body wrapper').toBeDefined();
  const sink = descendants(content!).find((node) => attr(node, 'data-safe-rich-content') === 'article-body');
  expect(sink, 'terminal RichContent sink').toBeDefined();
  return sink!;
}

afterEach(() => vi.restoreAllMocks());

describe('article page body rendering at the RichContent sink', () => {
  it('renders the 194 multiline CMS body as three visible paragraphs', async () => {
    const body =
      'Перед встречей освободите проход к кушетке и проверьте, что вокруг неё удобно перемещаться. ' +
      'Положите рядом чистое бельё, салфетки и материалы, которые понадобятся для работы.\n\n' +
      'Проветрите помещение, настройте комфортное освещение и уберите с пола провода и другие предметы. ' +
      'Уточните, удобно ли посетителю расположиться и комфортна ли температура в кабинете.\n\n' +
      'После приёма уберите использованные материалы и обработайте рабочие поверхности. ' +
      'Проверьте запас чистого белья и подготовьте кабинет к следующей встрече.';
    const root = await renderArticlePage(article(body, ''));
    const sink = articleSink(root);
    const paragraphs = descendants(sink).filter((node) => node.tagName === 'p');

    expect(paragraphs).toHaveLength(3);
    expect(textOf(paragraphs[0])).toContain('Положите рядом чистое бельё');
    expect(textOf(paragraphs[1])).toContain('Проветрите помещение');
    expect(textOf(paragraphs[2])).toContain('После приёма');
  });

  it('renders a Markdown replacement on a record that retains legacy_id and sanitizes the real sink', async () => {
    const body =
      '# Новое тело статьи\n\nПервый абзац.\n\nВторой абзац.\n\n' +
      '<a href="javascript:alert(1)" onclick="alert(2)">Опасная ссылка</a>';
    const root = await renderArticlePage(article(body, 'statyi/old-slug'));
    const sink = articleSink(root);
    const nodes = descendants(sink);
    const paragraphs = nodes.filter((node) => node.tagName === 'p');

    expect(nodes.some((node) => node.tagName === 'h2' && textOf(node).includes('Новое тело статьи'))).toBe(true);
    expect(paragraphs).toHaveLength(3);
    expect(textOf(sink)).toContain('Опасная ссылка');
    expect(nodes.some((node) => attr(node, 'onclick') !== undefined)).toBe(false);
    expect(nodes.some((node) => (attr(node, 'href') ?? '').startsWith('javascript:'))).toBe(false);
  });
});
