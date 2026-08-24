import { test, expect } from '@playwright/test';
import { installThirdPartyGuard } from './helpers/third-party-guard';

test.beforeEach(async ({ page }) => {
  await installThirdPartyGuard(page);
});

// ─── Homepage ────────────────────────────────────────────
test.describe('Homepage', () => {
  test('loads and has correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Институт клинической прикладной кинезиологии/);
  });

  test('has top navigation', async ({ page }) => {
    await page.goto('/');
    // Промоушен варианта D: навигация сайта — верхнее меню (topnav).
    // Пункты меню видны на десктопе, на мобиле — в бургер-drawer, поэтому
    // проверяем присутствие ссылок в DOM, а не их видимость.
    await expect(page.locator('header.topnav')).toBeVisible();
    await expect(page.locator('.topnav-logo')).toBeVisible();
    expect(
      await page.locator('.topnav a[href="/raspisanie-i-tseny"]').count(),
    ).toBeGreaterThan(0);
  });

  // Подписка — ссылка на форму Bitrix24, как на старом сайте, а не форма на
  // странице: наша прежняя форма-заглушка собирала имя, телефон и почту и
  // никуда их не отправляла.
  test('newsletter block links to a working subscription form', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.newsletter-signup')).toBeVisible();

    const cta = page.locator('.newsletter-signup a.newsletter-signup-button');
    await expect(cta).toBeVisible();

    const href = await cta.getAttribute('href');
    // в demo-режиме ссылка ведёт на заглушку — в прод-CRM заказчика с демо-стенда
    // подписки уходить не должны
    expect(href).toMatch(/bitrix24site\.ru|\/demo-zayavka/);

    await expect(page.locator('.newsletter-signup form')).toHaveCount(0);
  });

  test('has footer with correct phone', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('footer')).toContainText('646-54-50');
  });

  test('has Yandex.Metrika counter', async ({ page }) => {
    await page.goto('/');
    const html = await page.content();
    expect(html).toContain('39506315');
    expect(html).toContain('mc.yandex.ru/metrika');
  });

  test('has institutes section', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.institute-card').first()).toBeVisible();
  });
});

// ─── SEO & Meta ──────────────────────────────────────────
test.describe('SEO', () => {
  test('homepage has canonical URL', async ({ page }) => {
    await page.goto('/');
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute('href', /ikpk\.su/);
  });

  test('homepage has OG tags', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /.+/);
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'ru_RU');
  });

  test('homepage has JSON-LD schema', async ({ page }) => {
    await page.goto('/');
    const ld = page.locator('script[type="application/ld+json"]');
    const content = await ld.first().textContent();
    expect(content).toContain('EducationalOrganization');
  });

  test('article page has Article schema', async ({ page }) => {
    await page.goto('/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii');
    const ld = page.locator('script[type="application/ld+json"]');
    const texts = await ld.allTextContents();
    const hasArticle = texts.some(t => t.includes('"Article"'));
    expect(hasArticle).toBe(true);
  });
});

// ─── Key Pages ───────────────────────────────────────────
test.describe('Key pages load', () => {
  const pages = [
    '/',
    '/instituty/institut-klinicheskoy-prikladnoy-kineziologii',
    '/raspisanie-i-tseny',
    '/statyi',
    '/kontakty',
    '/aktsii-i-skidki',
    '/oplata',
    '/sotrudnichestvo-s-nami',
    '/svedeniya-ob-obrazovatelnoy-organizatsii',
    '/video',
    '/sitemap',
  ];

  for (const path of pages) {
    test(`${path} returns 200 and has content`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator('h1').first()).toBeVisible();
    });
  }
});

// ─── Navigation ──────────────────────────────────────────
test.describe('Navigation', () => {
  test('institute page has course groups', async ({ page }) => {
    await page.goto('/instituty/institut-klinicheskoy-prikladnoy-kineziologii');
    const cards = page.locator('.program-card');
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test('breadcrumbs present on nested pages', async ({ page }) => {
    await page.goto('/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii');
    await expect(page.locator('nav[aria-label="breadcrumb"], .breadcrumbs')).toBeVisible();
  });

  test('footer links to correct sotrudnichestvo URL', async ({ page }) => {
    await page.goto('/');
    const link = page.locator('footer a[href="/sotrudnichestvo-s-nami"]');
    await expect(link).toBeVisible();
  });
});

// ─── Content Quality ─────────────────────────────────────
test.describe('Content quality', () => {
  test('article detail renders rich HTML (not flat text)', async ({ page }) => {
    await page.goto('/statyi/ispolzovanie-meridianov-pri-kraniosakralnoj-terapii');
    // Rich content should have at least some structural tags
    const richContent = page.locator('.rich-content');
    await expect(richContent).toBeVisible();
    const innerHtml = await richContent.innerHTML();
    // Should have more than just a single <p> tag
    const hasTags = /<(h[1-6]|ul|ol|strong|em|a )/.test(innerHtml);
    expect(hasTags).toBe(true);
  });

  test('kontakty page shows correct phone', async ({ page }) => {
    await page.goto('/kontakty');
    await expect(page.locator('.contact-shell-link').first()).toContainText('646-54-50');
  });

  test('schedule page has events table', async ({ page }) => {
    await page.goto('/raspisanie-i-tseny');
    const rows = page.locator('.schedule-card');
    expect(await rows.count()).toBeGreaterThan(0);
  });
});

// ─── Search (FR-05, Pagefind) ────────────────────────────
test.describe('Search', () => {
  test('opens from header, finds seminars, tolerates typos', async ({ page }) => {
    await page.goto('/');
    await page.locator('#header-search-toggle').click();

    // Pagefind UI грузится лениво при первом открытии
    const input = page.locator('#header-search-pagefind input');
    await expect(input).toBeVisible({ timeout: 10_000 });

    // Сообщение Pagefind включает текст запроса — ждём его, чтобы не
    // сматчить устаревшие результаты предыдущего запроса (debounce)
    const message = page.locator('.pagefind-ui__message');
    const results = page.locator('.pagefind-ui__result-link');

    await input.fill('кинезиология');
    await expect(message).toContainText('кинезиология', { timeout: 10_000 });
    await expect(results.first()).toBeVisible();
    expect(await results.count()).toBeGreaterThan(0);

    // допуск опечатки в 1 символ (DoD плана 004, Этап 4)
    await input.fill('масаж');
    await expect(message).toContainText('масаж', { timeout: 10_000 });
    await expect(message).not.toContainText('Ничего не найдено');
    await expect(results.first()).toBeVisible();

    // Escape закрывает панель
    await page.keyboard.press('Escape');
    await expect(page.locator('#header-search')).toBeHidden();
  });
});

// ─── Video facade (FR-04, RUTUBE embed) ──────────────────
test.describe('Video', () => {
  test('playlist facade loads RUTUBE embed on click, accessibly', async ({ page }) => {
    await page.goto('/video/33');

    // до клика — 0 iframe (ленивая загрузка, не бьёт по perf)
    await expect(page.locator('.video-facade iframe')).toHaveCount(0);

    await page.locator('.video-facade-btn').click();

    const iframe = page.locator('.video-facade iframe');
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute('src', /rutube\.ru\/play\/embed\//);
    // a11y: у плеера есть title и он получил фокус (кнопка уничтожена)
    await expect(iframe).toHaveAttribute('title', /Видео:/);
    await expect(iframe).toBeFocused();

    // ссылки на полный плейлист и VK-канал присутствуют
    await expect(page.getByRole('link', { name: /Весь плейлист на RUTUBE/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Канал на VK Видео/ })).toBeVisible();
  });
});

// ─── Contacts lazy map (FR-08) ───────────────────────────
test.describe('Contacts map', () => {
  test('Yandex map is injected lazily and fills the map surface without an empty tail', async ({ page }) => {
    await page.goto('/kontakty');
    const map = page.locator('.contact-shell-map');
    await map.scrollIntoViewIfNeeded();
    // карта подставляется скриптом (IntersectionObserver), а не статикой
    const iframe = map.locator('iframe');
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute('src', /yandex\.ru\/map-widget/);

    // Регрессия: динамически созданный iframe не получает Astro scope-атрибут.
    // Без :global(iframe) правило размеров не матчится, iframe остаётся высотой
    // около 150px, а после ссылки внутри карты появляется большой пустой хвост.
    const geometry = await map.evaluate((node) => {
      const frame = node.querySelector('iframe');
      const link = node.querySelector('.contact-shell-map-link');
      if (!(frame instanceof HTMLElement) || !(link instanceof HTMLElement)) return null;

      const mapRect = node.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const linkRect = link.getBoundingClientRect();
      const usableHeight = mapRect.height - linkRect.height;
      return {
        fillRatio: usableHeight > 0 ? frameRect.height / usableHeight : 0,
        emptyTail: mapRect.bottom - linkRect.bottom,
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry!.fillRatio).toBeGreaterThan(0.98);
    expect(Math.abs(geometry!.emptyTail)).toBeLessThanOrEqual(1);
  });
});

// ─── Верхнее меню: подсказка о подменю ───────────────────────────────────────
// Регресс-тест к багу: шеврон (▾) был в разметке, но SVG без intrinsic-ширины
// внутри flex-контейнера сжимался до width:0 — пользователь не видел, у каких
// пунктов есть подменю, и поведение выглядело случайным. Ловится только реальным
// браузером: build-гейты layout не считают.
test.describe('Top navigation affordance', () => {
  test('items with a dropdown show a visible chevron', async ({ page }) => {
    await page.goto('/');

    const menu = page.locator('.topnav-menu');
    // на мобильной раскладке меню скрыто (там drawer) — проверять нечего
    if (!(await menu.isVisible())) test.skip();

    const withDropdown = page.locator('.topnav-menu > ul > li.has-dropdown');
    const count = await withDropdown.count();
    expect(count, 'в меню должны быть пункты с подменю').toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const item = withDropdown.nth(i);
      const label = (await item.locator('> a').innerText()).trim();
      const chev = item.locator('.chev');
      await expect(chev, `у «${label}» нет шеврона в разметке`).toHaveCount(1);
      const box = await chev.boundingBox();
      expect(box, `шеврон «${label}» не отрисован`).not.toBeNull();
      expect(box!.width, `шеврон «${label}» имеет нулевую ширину`).toBeGreaterThan(4);
      expect(box!.height, `шеврон «${label}» имеет нулевую высоту`).toBeGreaterThan(4);
    }
  });

  test('hovering an item with a dropdown reveals its links', async ({ page }) => {
    await page.goto('/');
    const menu = page.locator('.topnav-menu');
    if (!(await menu.isVisible())) test.skip();

    const item = page.locator('.topnav-menu > ul > li.has-dropdown').first();
    const dropdown = item.locator('.dropdown');
    await expect(dropdown).not.toBeVisible();
    await item.hover();
    await expect(dropdown).toBeVisible();
    expect(await dropdown.locator('a').count()).toBeGreaterThan(1);
  });
});

// Кнопка, которую нельзя прочитать, хуже отсутствия кнопки. Здесь это выходило
// из конфликта специфичности: `.rich-content a` (0,1,1) перебивает `.btn-primary`
// (0,1,0), поэтому CTA внутри легаси-контента получал синий текст на зелёном
// фоне — контраст ~1.08:1. Build-гейты такое не видят: разметка корректна,
// классы на месте, дефект возникает только в вычисленных стилях.
test.describe('Contrast of CTA inside rich content', () => {
  const parse = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  test('CTA text is readable on its own background', async ({ page }) => {
    await page.goto('/oplata');

    const cta = page.locator('.rich-content [data-payment-entry], .rich-content a.btn').first();
    await expect(cta).toBeVisible();

    const { color, background } = await cta.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });

    const [l1, l2] = [lum(parse(color)), lum(parse(background))].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    expect(ratio, `контраст текста CTA ${color} на фоне ${background} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

// В тёмной теме фон страницы и фон карточки брались из одного токена
// (--color-light-100), поэтому поверхности не различались: карточка держалась
// только на рамке. Это видно глазом, но не ловится ни разметочными гейтами,
// ни axe (контраст текста при этом в норме).
test.describe('Dark theme surfaces', () => {
  test('card surface differs from page surface', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    const { pageBg, cardBg } = await page.evaluate(() => {
      const card = document.querySelector('.card, .institute-card, .segment-card')!;
      return {
        pageBg: getComputedStyle(document.body).backgroundColor,
        cardBg: getComputedStyle(card).backgroundColor,
      };
    });

    expect(cardBg, `фон карточки ${cardBg} совпадает с фоном страницы ${pageBg}`).not.toBe(pageBg);
  });
});

// ─── Мобильное меню закрывается щелчком вне себя ─────────────────────────────
// Дефект с телефона: меню открывается, щелчок рядом с ним его не закрывает.
// Причина не в устройстве — drawer это нативный <details> без JS, а он по
// щелчку вне себя не закрывается ни в одном браузере. Поэтому проверка нужна
// и здесь (проект mobile), и в compat.spec.ts, где есть профиль iPhone 14.

/**
 * Точка, гарантированно ВНЕ открытого меню.
 *
 * Координаты наугад не годятся: панель меню — оверлей, и её охват зависит от
 * вьюпорта. На профилях iPhone 14 и Android Chrome точка (10, верх main + 10)
 * оказывалась ВНУТРИ панели (`elementFromPoint` → `topnav-drawer`), а на iPhone SE
 * — вне неё. Тест тогда щёлкал внутрь меню и требовал закрытия, то есть проверял
 * не то, что заявлено.
 *
 * Поэтому точка ищется перебором и проверяется через `elementFromPoint`. Если
 * такой точки нет вовсе — это «проверить невозможно», а не «дефекта нет»:
 * возвращаем null, и тест падает с явным сообщением.
 */
async function pointOutsideDrawer(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const drawer = document.querySelector('details.topnav-mobile');
    if (!drawer) return null;
    const step = 20;
    // Точка обязана быть НЕинтерактивной. Иначе щелчок уводит на другую
    // страницу, там <details> закрыт по умолчанию, и тест зеленеет не по той
    // причине: без исправления он проходил именно так — проверено негативно.
    const interactive = 'a, button, summary, input, select, textarea, label, [role="button"]';
    for (let y = innerHeight - step; y > 0; y -= step) {
      for (let x = step; x < innerWidth; x += step) {
        const el = document.elementFromPoint(x, y);
        if (!el || drawer.contains(el)) continue;
        if (el.closest(interactive)) continue;
        return { x, y };
      }
    }
    return null;
  });
}

test.describe('Мобильное меню', () => {
  test('щелчок вне меню закрывает его', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status(), 'страница не отдалась — закрывать нечего').toBe(200);

    const drawer = page.locator('details.topnav-mobile');
    const summary = drawer.locator('> summary');
    if (!(await summary.isVisible().catch(() => false))) {
      test.skip(true, 'в этом вьюпорте мобильного меню нет по замыслу');
    }

    await summary.click();
    await expect(drawer, 'меню не открылось — дальше проверять нечего').toHaveAttribute('open', '');

    const outside = await pointOutsideDrawer(page);
    expect(outside, 'не нашлось ни одной точки вне открытого меню — щёлкнуть вне него невозможно').not.toBeNull();
    const urlBefore = page.url();
    await page.mouse.click(outside!.x, outside!.y);
    expect(page.url(), 'щелчок увёл на другую страницу — меню закрылось бы и без исправления').toBe(
      urlBefore,
    );
    await expect(drawer, 'меню осталось открытым после щелчка вне него').not.toHaveAttribute(
      'open',
      '',
    );
  });

  test('Escape закрывает меню', async ({ page }) => {
    await page.goto('/');
    const drawer = page.locator('details.topnav-mobile');
    const summary = drawer.locator('> summary');
    if (!(await summary.isVisible().catch(() => false))) {
      test.skip(true, 'в этом вьюпорте мобильного меню нет по замыслу');
    }

    await summary.click();
    await expect(drawer).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(drawer, 'меню осталось открытым после Escape').not.toHaveAttribute('open', '');
  });
});

// ─── Навигация видима на любой ширине ────────────────────
//
// Гейт заведён по внесённому и пойманному ревью дефекту: правка медиазапроса
// шапки (переименование CTA, D10) утащила ~55 строк правил мобильного меню
// внутрь блока `max-width: 430px`, и на 431–900 CSS-px сайт остался без
// навигации вовсе — меню скрыто правилом ≤900, бургер скрыт базовым правилом.
//
// Почему не увидел ни один существующий сторож: «has top navigation» выше
// НАМЕРЕННО смотрит присутствие ссылок в DOM, а не их видимость, а все
// браузерные проверки проекта живут на вьюпортах 375, 390 и 1280 — то есть
// зона 431–900 не измерялась ничем. Поэтому здесь проверяется именно
// видимость и именно на границах зон.
//
// Предмет — «у посетителя есть чем перейти на другую страницу»: видна либо
// ссылка горизонтального меню, либо ссылка в панели, которую открывает бургер.
//
// Переполнение по горизонтали здесь НЕ проверяется, и цифры стоит привести
// целиком, иначе комментарий вводит в заблуждение. Остаточная зона — 901–973
// CSS-px: 73 px при 901, 34 при 940, 0 начиная с 974. Ветка при этом НЕ хуже
// main ни на одной ширине (у main 209/110/10 при 901/1000/1100 против 73/0/0
// здесь): ужатие шапки в полосе ≤1440, сделанное ради сохранения телефона на
// 1280, вылечило почти всю зону. Остаток заведён как TD-43; он требует мокапа.
//
// В сетке есть 810 — ширина профиля `iPad (gen 7)`. Функционально её проверяет
// `compat.spec.ts`, но тот живёт в nightly и публикацию не блокирует; здесь она
// нужна, чтобы планшет был прикрыт и внутри обязательного прогона.
const NAV_WIDTHS = [375, 430, 431, 600, 768, 810, 900, 901, 1100, 1280];

test.describe('Навигация видима на любой ширине', () => {
  for (const width of NAV_WIDTHS) {
    test(`${width}px: навигация видна и открывается`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const response = await page.goto('/raspisanie-i-tseny');
      expect(response?.status(), 'страница не отдалась — измерять нечего').toBe(200);

      const menuVisible = await page.locator('.topnav-menu').isVisible();
      const burgerVisible = await page.locator('.topnav-mobile').isVisible();
      expect(
        menuVisible || burgerVisible,
        `на ${width}px не видно ни горизонтального меню, ни бургера — перейти некуда`,
      ).toBe(true);

      // Видимого контейнера мало. Первая редакция гейта проверяла только его, и
      // правило `.topnav-drawer { display: none }` оставило бы зелёными всех трёх
      // сторожей сразу: бургер виден, атрибут `open` переключается, ссылки лежат
      // в DOM. Предмет заявлен как «есть чем перейти» — значит нужна видимая
      // ссылка, а не видимая обёртка.
      const link = menuVisible
        ? page.locator('.topnav-menu a').first()
        : page.locator('.topnav-drawer .drawer-link').first();

      if (!menuVisible) {
        await page.locator('details.topnav-mobile > summary').click();
      }

      await expect(
        link,
        menuVisible
          ? `на ${width}px меню видно, а пункты в нём — нет`
          : `на ${width}px бургер виден, но панель меню не открывает ни одной ссылки`,
      ).toBeVisible();

      // Видимость — ещё не достижимость. `pointer-events: none` (а равно `inert`,
      // перекрывающий слой или нулевая hit-area) оставляет ссылку видимой, но
      // некликабельной, и проверка видимости этого не различает — показано
      // мутацией на ревью. В этом репозитории класс не гипотетический: `inert`
      // уже ломал hit-testing при видимых элементах (PR #151). `trial: true`
      // прогоняет проверки применимости, включая попадание в цель, но самого
      // перехода не делает — гейт остаётся про навигацию, а не про маршруты.
      await link.click({ trial: true, timeout: 5000 });
    });
  }
});

// ─── Телефон в шапке: контракт по ширинам ────────────────────────────────
//
// Гейт заведён по находке владельца. Пряча оба номера вместе ниже 1440, я
// получила ноль номеров в полосе 1180–1440 — там, где до D12 был показан один.
// На 1280, самой обычной десктопной ширине, в шапке стало пусто: заказчик
// просил номер ДОБАВИТЬ, а в этой полосе его убрали.
//
// Правило «оба или ни одного» было моим, а не требованием заказчика. D12
// говорит «показывать оба номера», а не «показывать оба или прятать оба»: один
// номер — это деградация с сохранением связи, ноль — потеря связи. Решение
// владельца 2026-08-23: в полосе 1181–1440 показывать первый номер.
//
// Настоящее лечение — мокап шапки, он отложен в TD-43; здесь фиксируется
// поведение, которое обязано держаться до него.
// Границы включены в сетку обеими сторонами. Первая редакция объявляла полосу
// «1180–1440», а проверяла 1179 и 1181 — то есть перескакивала ровно ту точку,
// которую сама и назначала, и расхождение слов с кодом (`max-width: 1180px`
// применяется И НА границе) осталось бы незамеченным. Нашёл владелец.
//
// Сама граница оставлена там, где она стояла на main до этой работы: правило
// `max-width: 1180px` не было предметом ни одного решения, и сдвиг его на 1179
// был бы незапрошенным изменением поведения. Исправлена формулировка, а не
// порог: полоса с первым номером — 1181–1440.
const PHONE_CONTRACT = [
  { width: 1179, city: false, mobile: false, why: 'ниже 1180 номеров нет — как было до D12' },
  { width: 1180, city: false, mobile: false, why: 'граница включительно: на 1180 номера ещё нет' },
  { width: 1181, city: true, mobile: false, why: 'полоса 1181–1440: первый номер остаётся' },
  { width: 1280, city: true, mobile: false, why: 'обычная десктопная ширина — связь не теряется' },
  { width: 1440, city: true, mobile: false, why: 'верхняя граница полосы' },
  { width: 1441, city: true, mobile: true, why: 'шире 1440 помещаются оба' },
];

test.describe('Телефон в шапке', () => {
  for (const { width, city, mobile, why } of PHONE_CONTRACT) {
    test(`${width}px: ${why}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const response = await page.goto('/raspisanie-i-tseny');
      expect(response?.status(), 'страница не отдалась — измерять нечего').toBe(200);

      const bar = page.locator('.topnav-phones');
      const cityLink = bar.locator('a[href="tel:+78126465450"]');
      const mobileLink = bar.locator('a[href="tel:+79810387797"]');

      expect(await cityLink.isVisible(), `${width}px: городской номер`).toBe(city);
      expect(await mobileLink.isVisible(), `${width}px: мобильный номер`).toBe(mobile);

      // Шапка при этом не должна уезжать по горизонтали ни в одном из состояний.
      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        return de.scrollWidth - de.clientWidth;
      });
      expect(overflow, `${width}px: шапка распирает вьюпорт на ${overflow}px`).toBeLessThanOrEqual(1);
    });
  }
});
