import { test, expect } from '@playwright/test';
import { loadPinnedType } from './helpers/pinned-snapshot';

// ─── Characterization-тесты: клиентское поведение каталога статей ────────────
// Спецификация: openspec/specs/article-catalog/spec.md (основная спека — baseline
// заархивирован; путь в changes/ больше не существует).
// Revision, с которого снят baseline: feat/demo-mode-and-hero-photo@542151b.
//
// Здесь проверяется ровно то, что не видно в собранном HTML: охват поиска и
// сортировки, разделяемая ссылка `?q=`. Раскладка и облик — не эта область.
// Тесты зелёные на существующем коде; известные отклонения (без JavaScript
// доступны 6 статей из 68) сюда не попадают — они в спеке как known deviations.

interface Article {
  slug: string;
  title: string;
  body_text: string;
  published_at: string | null;
}

const articles = loadPinnedType<Article[]>('articles');

/** Первые символы заголовка в нижнем регистре — по ним поиск и работает. */
const queryFor = (a: Article) => a.title.toLowerCase().slice(0, 22);

test.describe('каталог статей: поиск и сортировка', () => {
  test('поиск находит статью, которой нет на первой странице', async ({ page }) => {
    await page.goto('/statyi');
    const grid = page.locator('[data-articles-grid]');
    await expect(grid.locator('.article-card').first()).toBeVisible();

    const shown = await grid.locator('a.article-card').evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
    const hidden = articles.find((a) => !shown.includes(`/statyi/${a.slug}`));
    expect(hidden, 'все статьи каталога на первой странице — проверять охват нечем').toBeDefined();

    await page.locator('[data-articles-search]').fill(queryFor(hidden!));
    await expect(
      grid.locator(`a.article-card[href="/statyi/${hidden!.slug}"]`),
      `запрос «${queryFor(hidden!)}» не нашёл статью ${hidden!.slug} — поиск ограничен страницей`,
    ).toBeVisible();
  });

  // Контракт — «заголовок и НАЧАЛО текста, не весь текст». Сколько символов
  // считать началом — деталь реализации, а не контракт (решение владельца
  // 2026-08-11), но измерить «не весь текст» без границы нечем, поэтому проверка
  // берёт текущее число реализации. Связь названа намеренно: если реализация
  // сменит длину, эту константу надо поправить осознанно — покраснение здесь
  // будет означать «деталь изменилась», а не «контракт нарушен».
  const SEARCH_PREFIX = 300;

  test('глубина поиска — заголовок и начало текста, не весь текст', async ({ page }) => {
    // Слово, которое есть ТОЛЬКО дальше границы начала текста и не встречается
    // ни в одном заголовке и ни в одном начале: если оно что-то находит, поиск
    // глубже заявленного.
    const shallow = articles
      .map((a) => `${a.title.toLowerCase()} ${(a.body_text || '').slice(0, SEARCH_PREFIX).toLowerCase()}`)
      .join(' \n ');
    const deepOnly = articles
      .flatMap((a) => (a.body_text || '').slice(SEARCH_PREFIX).toLowerCase().match(/[а-яё]{9,}/g) ?? [])
      .find((w) => !shallow.includes(w));
    expect(deepOnly, 'в данных нет слова только в глубине текста — проверить глубину нечем').toBeDefined();

    await page.goto('/statyi');
    const grid = page.locator('[data-articles-grid]');
    await expect(grid.locator('.article-card').first()).toBeVisible();
    await page.locator('[data-articles-search]').fill(deepOnly!);
    await expect(
      grid.locator('.article-card'),
      `слово «${deepOnly}» из глубины текста дало результаты — глубина поиска не та, что заявлена`,
    ).toHaveCount(0);
  });

  test('сортировка по дате от старых к новым охватывает весь каталог', async ({ page }) => {
    await page.goto('/statyi');
    const grid = page.locator('[data-articles-grid]');
    await expect(grid.locator('.article-card').first()).toBeVisible();
    const shown = await grid.locator('a.article-card').evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).getAttribute('href') ?? ''),
    );

    const dates = articles.map((a) => a.published_at ?? '').filter(Boolean).sort();
    const earliest = dates[0];
    expect(earliest, 'в каталоге нет ни одной даты публикации').toBeTruthy();

    await page.locator('[data-articles-sort]').selectOption('date_asc');
    const first = grid.locator('a.article-card').first();
    await expect(first.locator('time')).toHaveAttribute('datetime', earliest);

    // Настоящее доказательство охвата: самая ранняя статья каталога на первой
    // странице не показывалась, то есть порядок вычислен не по странице.
    const firstHref = await first.getAttribute('href');
    expect(
      shown.includes(firstHref ?? ''),
      'самая ранняя статья была на первой странице — охват сортировки этим не проверяется',
    ).toBe(false);
  });

  test('сортировка по заголовку А–Я охватывает весь каталог', async ({ page }) => {
    await page.goto('/statyi');
    const grid = page.locator('[data-articles-grid]');
    await expect(grid.locator('.article-card').first()).toBeVisible();

    const alphabetical = [...articles].sort((a, b) =>
      a.title.toLowerCase().localeCompare(b.title.toLowerCase(), 'ru'),
    );
    await page.locator('[data-articles-sort]').selectOption('title_asc');
    await expect(grid.locator('a.article-card').first()).toHaveAttribute(
      'href',
      `/statyi/${alphabetical[0].slug}`,
    );

    await page.locator('[data-articles-sort]').selectOption('title_desc');
    await expect(grid.locator('a.article-card').first()).toHaveAttribute(
      'href',
      `/statyi/${alphabetical.at(-1)!.slug}`,
    );
  });

  test('очистка запроса возвращает первую страницу полного списка', async ({ page }) => {
    await page.goto('/statyi');
    const grid = page.locator('[data-articles-grid]');
    const search = page.locator('[data-articles-search]');
    await expect(grid.locator('.article-card').first()).toBeVisible();

    const shown = await grid.locator('a.article-card').evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
    const hidden = articles.find((a) => !shown.includes(`/statyi/${a.slug}`));
    expect(hidden, 'все статьи на первой странице — нечего искать').toBeDefined();

    await search.fill(queryFor(hidden!));
    await expect(grid.locator(`a.article-card[href="/statyi/${hidden!.slug}"]`)).toBeVisible();

    await search.fill('');
    await expect(grid.locator('.article-card')).toHaveCount(Math.min(6, articles.length));
    const pagination = page.locator('[data-testid="articles-pagination"], nav[aria-label="Пагинация статей"]');
    await expect(pagination).toBeVisible();
  });
});

test.describe('каталог статей: разделяемая ссылка на результаты', () => {
  test('/statyi?q= показывает результаты в новой сессии', async ({ page }) => {
    const target = articles.find((a) => a.title.length >= 22) ?? articles[0];
    const query = queryFor(target);

    await page.goto(`/statyi?q=${encodeURIComponent(query)}`);
    const grid = page.locator('[data-articles-grid]');
    await expect(
      grid.locator(`a.article-card[href="/statyi/${target.slug}"]`),
      `адрес с параметром q не показал результаты по запросу «${query}»`,
    ).toBeVisible();
    await expect(page.locator('[data-articles-search]')).toHaveValue(query);
  });

  test('параметр q не создаёт индексируемого дубля', async ({ page }) => {
    await page.goto('/statyi?q=%D0%B3%D0%B8%D0%BF%D0%B5%D1%80%D1%82%D0%B5%D0%BD%D0%B7%D0%B8%D1%8F');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://ikpk.su/statyi',
    );
  });
});
