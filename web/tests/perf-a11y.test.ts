import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const dist = join(import.meta.dirname, '..', 'dist');

function readPage(path: string): string {
  const file = path === '/'
    ? join(dist, 'index.html')
    : join(dist, path.replace(/^\//, ''), 'index.html');
  return readFileSync(file, 'utf-8');
}

function readBuiltCss(): string {
  const cssDir = join(dist, '_astro');
  expect(existsSync(cssDir)).toBe(true);

  const cssFiles = readdirSync(cssDir).filter((f: string) => f.endsWith('.css'));
  expect(cssFiles.length).toBeGreaterThan(0);

  return cssFiles.map((f: string) => readFileSync(join(cssDir, f), 'utf-8')).join('');
}

let homepage: string;
let subpage: string;

beforeAll(() => {
  if (!existsSync(dist)) {
    throw new Error(
      'dist/ not found — run "npm run build" first, or use "npm run test:build" which builds automatically.'
    );
  }
  homepage = readPage('/');
  subpage = readPage('/kontakty');
});

// ─── Self-hosted fonts ──────────────────────────────────────────────────────
describe('Self-hosted Inter font', () => {
  it('does not reference Google Fonts', () => {
    expect(homepage).not.toContain('fonts.googleapis.com');
    expect(subpage).not.toContain('fonts.googleapis.com');
  });

  it('preloads latin and cyrillic woff2 files', () => {
    expect(homepage).toContain('<link rel="preload" href="/fonts/inter-latin.woff2"');
    expect(homepage).toContain('<link rel="preload" href="/fonts/inter-cyrillic.woff2"');
  });

  it('has font files in the build output', () => {
    expect(existsSync(join(dist, 'fonts', 'inter-latin.woff2'))).toBe(true);
    expect(existsSync(join(dist, 'fonts', 'inter-cyrillic.woff2'))).toBe(true);
  });

  it('declares @font-face with font-display: swap in CSS', () => {
    const allCss = readBuiltCss();
    expect(allCss).toContain('font-display:swap');
    expect(allCss).toContain('inter-latin.woff2');
    expect(allCss).toContain('inter-cyrillic.woff2');
  });
});

// ─── Hero image optimization ────────────────────────────────────────────────
describe('Hero image', () => {
  // Редизайн (вариант D): у героя нет фонового изображения — панель-плейсхолдер,
  // LCP теперь текстовый (H1). Поэтому preload hero-картинки на главной больше нет.
  it('homepage does not preload a hero raster (text LCP)', () => {
    expect(homepage).not.toMatch(/rel="preload"[^>]*href="\/hero-main\.svg"/);
  });

  it('subpages do not preload hero', () => {
    expect(subpage).not.toContain('preload" href="/hero-main.svg"');
  });

  it('hero SVG is under 100KB', () => {
    const heroPath = join(dist, 'hero-main.svg');
    const stat = statSync(heroPath);
    expect(stat.size).toBeLessThan(100 * 1024);
  });
});

// ─── Deferred analytics ─────────────────────────────────────────────────────
describe('Analytics', () => {
  it('initializes Yandex.Metrika stub synchronously (before deferred block)', () => {
    // The sync stub must appear before the deferred loader
    const ymStubIndex = homepage.search(
      /window\.ym\s*=\s*window\.ym\s*\|\|\s*function\b/,
    );
    const deferIndex = homepage.indexOf('_loadAnalyticsScripts');
    expect(ymStubIndex).toBeGreaterThan(-1);
    expect(deferIndex).toBeGreaterThan(-1);
    expect(ymStubIndex).toBeLessThan(deferIndex);
  });

  it('queues Mail.ru pageview synchronously', () => {
    const tmrIndex = homepage.search(
      /_tmr\.push\(\{\s*id:\s*['"]3752684['"]/,
    );
    const deferIndex = homepage.indexOf('_loadAnalyticsScripts');
    expect(tmrIndex).toBeGreaterThan(-1);
    expect(tmrIndex).toBeLessThan(deferIndex);
  });

  // Регресс-гейт: внешний code.js объявляет свой `var _tmr` в той же глобальной
  // области. Лексическое `const/let _tmr` у нас → SyntaxError при его парсинге,
  // причём ДО нашего push, то есть pageview Mail.ru молча терялся на всех
  // страницах. Ассерт выше это не ловил: он матчит и сломанную форму
  // (`const _tmr; _tmr.push(...)`), и рабочую — был зелёным, пока баг жил.
  it('Mail.ru queue goes through window._tmr, no lexical declaration', () => {
    expect(homepage).toContain('window._tmr = window._tmr ||');
    expect(homepage).not.toMatch(/\b(const|let)\s+_tmr\b/);
  });

  it('defers script downloads via requestIdleCallback', () => {
    expect(homepage).toContain('requestIdleCallback(_loadAnalyticsScripts');
  });

  it('has noscript pixel fallbacks', () => {
    expect(homepage).toContain('mc.yandex.ru/watch/39506315');
    expect(homepage).toContain('top-fwz1.mail.ru/counter');
  });

  it('analytics are not in <head>', () => {
    const head = homepage.slice(0, homepage.indexOf('</head>'));
    expect(head).not.toContain('mc.yandex.ru/metrika/tag.js');
    expect(head).not.toContain('top-fwz1.mail.ru/js/code.js');
  });
});

// ─── Button contrast (WCAG AA) ─────────────────────────────────────────────
describe('Button contrast', () => {
  it('accent-500 is the darkened value for AA compliance', () => {
    const allCss = readBuiltCss();
    expect(allCss).toMatch(/--color-accent-500:\s*#357a38/);
    expect(allCss).not.toMatch(/--color-accent-500:\s*#41a143/);
  });
});

// ─── CSS-совместимость со старыми браузерами ────────────────────────────────
// Vite 8 минифицирует CSS через lightningcss, который по умолчанию переписывает
// медиазапросы в range-синтаксис: (max-width:640px) → (width<=640px). Он требует
// Safari 16.4+, то есть на iOS 15 (iPhone 6s/7) ВСЕ брейкпоинты молча
// перестают применяться. Защищено пином build.cssTarget в astro.config.mjs;
// гейт держит инвариант на выходе сборки, а не на конкретной строке конфига
// (переживает рефакторинг способа настройки). Playwright-compat это не ловит:
// у него всегда свежий WebKit независимо от имени профиля устройства.
describe('CSS media query syntax', () => {
  it('no lightningcss range syntax — old Safari keeps its breakpoints', () => {
    // плюс инлайновые <style> — минификация проходит и по ним
    const inlineStyles = readPage('/') + readFileSync(join(dist, '404.html'), 'utf-8');
    const allCss = readBuiltCss() + inlineStyles;
    expect(allCss).not.toMatch(/\(\s*width\s*[<>]=?/);
    expect(allCss).toContain('max-width:');
  });
});

// ─── Accessibility ──────────────────────────────────────────────────────────
describe('Accessibility', () => {
  it('phone link has aria-label', () => {
    expect(homepage).toMatch(/href="tel:\+78126465450"[^>]*aria-label/);
  });

  it('footer logo link has aria-label', () => {
    expect(homepage).toMatch(/class="footer-logo-link"[^>]*aria-label="ИКПК/);
  });
});

// ─── LCP-элемент не прячется анимацией ───────────────────────────────────────
// motion.css сам объявляет принцип: hero-заголовок анимируется БЕЗ opacity,
// потому что элемент с нулевой прозрачностью исключается из кандидатов LCP.
// Для заголовка это соблюдено, а для картинки рядом — нет, хотя по площади
// (~152 000 px² против ~70 000 у H1) именно она LCP-кандидат на десктопе.
describe('LCP: hero не анимируется из прозрачности', () => {
  it('элементы первого экрана не стартуют с opacity: 0', () => {
    const css = readBuiltCss();
    const offenders: string[] = [];

    // Начальная прозрачность задаётся в правиле САМОГО элемента (в keyframes
    // лежит только конечное состояние), поэтому проверяем правила селекторов
    // первого экрана.
    for (const m of css.matchAll(/([^{}]*\.hero-[\w-]*[^{}]*)\{([^}]*)\}/g)) {
      const [, selector, body] = m;
      if (/opacity:\s*0(?![.\d])/.test(body)) offenders.push(selector.trim());
    }

    expect(
      offenders,
      `элемент первого экрана стартует с нулевой прозрачности и выпадает из кандидатов LCP:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Root font-size', () => {
  it('html rule has no absolute font-size (px/pt/etc.) — user text-size preference must apply', () => {
    const allCss = readBuiltCss();

    // Селектор "html" встречается и одиночным правилом, и внутри @media —
    // берём тело правила после символа "html" в любом из этих контекстов,
    // но не путаем с ".html", "xhtml" и т.п. соседством символов.
    const htmlRuleRe = /(^|[,{}])\s*html\s*\{([^}]*)\}/g;
    const bodies: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = htmlRuleRe.exec(allCss))) {
      bodies.push(match[2]);
    }

    // Различаем «дефекта нет» и «не смогли проверить»: если ни одного правила
    // для селектора html не нашлось вообще — гейт слепой (сборка/минификация
    // изменились), а не «всё хорошо».
    expect(
      bodies.length,
      'ни одного CSS-правила для селектора "html" не найдено в собранном CSS — гейт не может подтвердить отсутствие дефекта'
    ).toBeGreaterThan(0);

    const absoluteFontSize = /font-size\s*:\s*[\d.]+\s*(px|pt|cm|mm|in|pc|q)\b/i;
    const offending = bodies.filter((b) => absoluteFontSize.test(b));

    expect(
      offending,
      `html { } задаёт абсолютный font-size — подавляет пользовательскую настройку размера шрифта браузера:\n${offending.join('\n')}`
    ).toEqual([]);
  });
});
