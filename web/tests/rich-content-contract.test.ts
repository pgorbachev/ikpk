import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { cleanBodyHtml } from '../src/lib/html-cleaner.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';
import {
  ALLOWED_ELEMENTS,
  AUTHENTICATED_FORMS,
  BYTE_LIMIT,
  DEPTH_LIMIT,
  DISCARD_WITH_CONTENT,
  EXACT_RUTUBE_SRC,
  exactRutubeIframe,
  NODE_LIMIT,
  PARSER_PACKAGES_RE,
  RUTUBE_IFRAME_ALLOWED_ATTRS,
  RUTUBE_IFRAME_ATTRS,
  RUTUBE_IFRAME_FORBIDDEN_ATTRS,
  RUTUBE_SRC_RE,
} from './helpers/rich-content-safety/closed-matrix.js';
import { LOCAL_UPLOAD_WEBP, WEB_SRC } from './helpers/rich-content-safety/paths.js';
import {
  assertSingletonSinkContract,
  collectAstroSinks,
  collectAstroSinksFromSource,
  collectTsSinks,
  collectTsSinksFromSource,
  FUTURE_SINGLETON,
} from './helpers/rich-content-safety/ast-sinks.js';
import { assertCleanGitWorktree } from './helpers/rich-content-safety/git-clean.js';
import { overlappingParserEngines, assertCommittedLockfileNodes } from './helpers/rich-content-safety/lockfile-graph.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';

function out(html: string): string {
  return htmlOf(cleanBodyHtml(html));
}

describe('rich-content contract: authenticated SafeRichHtml', () => {
  it('cleanBodyHtml возвращает runtime-authenticated объект, а не голую строку', () => {
    const result = cleanBodyHtml('<p>ok</p>');
    expect(result).not.toBeTypeOf('string');
    expect(result).toBeTruthy();
    expect(result).toMatchObject({ html: expect.any(String) });
  });

  it('поддельный объект и обычная строка не считаются результатом cleaner-а', async () => {
    const mod = await import('../src/lib/html-cleaner.js');
    expect(mod).toHaveProperty('isSafeRichHtml');
    expect(mod).not.toHaveProperty('authenticate');
    const isSafe = (mod as unknown as { isSafeRichHtml?: (v: unknown) => boolean }).isSafeRichHtml;
    expect(typeof isSafe).toBe('function');
    expect(isSafe!('<p>x</p>')).toBe(false);
    expect(isSafe!({ html: '<p>x</p>', token: 'forged' })).toBe(false);
  });

  it('symbol extraction и мутация html не дают authenticated объект', async () => {
    const sanitizer = await import('../src/lib/rich-html-sanitize.js');
    expect(sanitizer).not.toHaveProperty('authenticate');
    const real = cleanBodyHtml('<p>ok</p>');
    const symbols = Object.getOwnPropertySymbols(real);
    const forged: { html: string; [k: symbol]: unknown } = { html: '<div data-safe-rich-content="x" class="table-scroll">pwn</div>' };
    for (const sym of symbols) forged[sym] = true;
    const { isSafeRichHtml } = await import('../src/lib/html-cleaner.js');
    expect(isSafeRichHtml(forged)).toBe(false);
    expect(() => {
      (real as { html: string }).html = '<script>alert(1)</script>';
    }).toThrow();
    expect(isSafeRichHtml(real)).toBe(true);
    expect(htmlOf(real)).not.toContain('<script');
  });
});

describe('rich-content contract: closed element/attribute matrix', () => {
  it.each(DISCARD_WITH_CONTENT)('активный %s удаляется вместе с содержимым', (tag) => {
    const html = `<p>before</p><${tag}><img src=x onerror=alert(1)></${tag}><p>after</p>`;
    const result = out(html);
    expect(result.toLowerCase()).not.toContain(`<${tag}`);
    expect(result).not.toMatch(/onerror/i);
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('script с маскирующимся текстом не оставляет активный HTML', () => {
    const result = out('<script><img src=x onerror=alert(1)></script>');
    expect(result.toLowerCase()).not.toContain('<script');
    expect(result.toLowerCase()).not.toContain('<img');
    expect(result).not.toMatch(/onerror/i);
  });

  it('инертный неизвестный wrapper разворачивается, текст сохраняется', () => {
    const result = out('<center>безопасный текст</center>');
    expect(result.toLowerCase()).not.toContain('<center');
    expect(result).toContain('безопасный текст');
  });

  it('on* и style снимаются с разрешённого элемента', () => {
    const result = out('<p onclick="alert(1)" style="color:red">текст</p>');
    expect(result).toContain('текст');
    expect(result).not.toMatch(/onclick/i);
    expect(result).not.toMatch(/\sstyle=/i);
  });

  it('XML/XLink и srcdoc удаляются', () => {
    const result = out('<a xlink:href="javascript:alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink">x</a><iframe srcdoc="<script>alert(1)</script>"></iframe>');
    expect(result).not.toMatch(/xlink/i);
    expect(result).not.toMatch(/srcdoc/i);
    expect(result.toLowerCase()).not.toContain('<iframe');
  });

  it('неперечисленный элемент вне discard-списка не остаётся тегом', () => {
    expect(ALLOWED_ELEMENTS).not.toContain('marquee');
    const result = out('<marquee>бегущая</marquee>');
    expect(result.toLowerCase()).not.toContain('<marquee');
    expect(result).toContain('бегущая');
  });
});

describe('rich-content contract: reserved markers и trust modes', () => {
  it('поддельные markers удаляются в untrusted входе', () => {
    const result = out('<div data-safe-rich-content="forged" class="table-scroll" data-wrapped data-legacy-cta data-legacy-cta-unresolved>x</div>');
    expect(result).not.toMatch(/data-safe-rich-content/);
    expect(result).not.toMatch(/data-wrapped/);
    expect(result).not.toMatch(/data-legacy-cta/);
    expect(result).not.toMatch(/table-scroll/);
  });

  it('checkbox вне формы становится disabled inert control без name/value', () => {
    const result = out('<label>Accept<input type="checkbox" name="terms" value="1" checked></label>');
    expect(result).toMatch(/type=["']checkbox["']/i);
    expect(result).toMatch(/\bdisabled\b/i);
    expect(result).not.toMatch(/\bname=/i);
    expect(result).not.toMatch(/\bvalue=/i);
    expect(result).toMatch(/\bchecked\b/i);
  });

  it('time с валидным datetime сохраняется, невалидный снимается', () => {
    const ok = out('<p>с <time datetime="2020-01-15">15 января</time></p>');
    expect(ok).toMatch(/datetime="2020-01-15"/);
    const bad = out('<time datetime="javascript:alert(1)">когда</time>');
    expect(bad).toContain('когда');
    expect(bad).not.toMatch(/javascript/i);
    expect(bad).not.toMatch(/datetime=["']javascript/i);
  });

  it('authenticated mode сохраняет только table-wrapper, resolved CTA и unresolved CTA', async () => {
    const mod = await import('../src/lib/html-cleaner.js') as Record<string, unknown>;
    expect(mod).toHaveProperty('terminalSanitize');
    const terminal = mod.terminalSanitize as (html: string, mode: 'untrusted' | 'authenticated') => unknown;
    const table = htmlOf(terminal(AUTHENTICATED_FORMS.tableWrapper, 'authenticated'));
    expect(table).toMatch(/class=["'][^"']*table-scroll/);
    expect(table).toMatch(/role=["']region["']/);
    expect(table).toMatch(/tabindex=["']0["']/);
    expect(table).toMatch(/data-wrapped/);
    const resolved = htmlOf(terminal(AUTHENTICATED_FORMS.resolvedCta, 'authenticated'));
    expect(resolved).toMatch(/<a\b[^>]*href=["']#oplata-svyaz["'][^>]*data-legacy-cta/);
    const unresolved = htmlOf(terminal(AUTHENTICATED_FORMS.unresolvedCta, 'authenticated'));
    expect(unresolved).toMatch(/<span\b[^>]*data-legacy-cta-unresolved/);
    expect(unresolved).toMatch(/legacy-cta-unresolved/);
    expect(unresolved).not.toMatch(/\bhref=/);
    expect(htmlOf(terminal(AUTHENTICATED_FORMS.tableWrapper, 'untrusted'))).not.toMatch(/data-wrapped/);
  });
});

describe('rich-content contract: URL и media', () => {
  it('обфусцированный javascript URL не выживает', () => {
    const result = out('<a href="java&#115;cript:alert(1)">x</a><a href=" javascript:alert(1)">y</a><a href="JAVASCRIPT:alert(1)">z</a>');
    expect(result).not.toMatch(/javascript:/i);
    expect(result).not.toMatch(/href=["'][^"']*alert/i);
  });

  it('data, vbscript, file и protocol-relative запрещены', () => {
    const result = out(
      '<a href="data:text/html,x">a</a><a href="vbscript:msg">b</a><a href="file:///etc/passwd">c</a><a href="//evil.test">d</a>',
    );
    expect(result).not.toMatch(/data:/i);
    expect(result).not.toMatch(/vbscript:/i);
    expect(result).not.toMatch(/file:/i);
    expect(result).not.toMatch(/href=["']\/\//i);
  });

  it('внешний img src удаляется', () => {
    const result = out('<p>t</p><img src="https://evil.test/x.png" alt="x">');
    expect(result).not.toContain('evil.test');
    expect(result.toLowerCase()).not.toContain('<img');
  });

  it('PDF manifest entry как img валит сборку', () => {
    expect(() =>
      cleanBodyHtml('<img src="/media/uploads/054a303b-52c0-4575-b0e1-4347cfd52c3d.pdf" alt="doc">'),
    ).toThrow(/тип|ID|pdf|document/i);
  });

  it('канонический srcset сохраняет /media/_w/<width>/<path> <width>w', () => {
    const result = cleanBodyHtml(
      '<img src="/media/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp" srcset="/media/_w/480/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp 480w" alt="">',
    );
    expect(result).not.toBeTypeOf('string');
    expect(htmlOf(result)).toMatch(/\/media\/_w\/480\/uploads\/0acd713c-1477-4c6c-93ad-1596d2a17304\.webp 480w/);
  });

  it('descriptor не совпадающий с width в URL валит сборку', () => {
    expect(() =>
      cleanBodyHtml(
        '<img src="/media/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp" srcset="/media/_w/480/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp 2400w" alt="">',
      ),
    ).toThrow();
  });

  it('mixed external + missing local derivative валит сборку по broken-local', () => {
    expect(() =>
      cleanBodyHtml(
        '<img src="/media/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp" srcset="https://evil.test/x.webp 480w, /media/_w/480/uploads/missing-derivative.webp 480w" alt="">',
      ),
    ).toThrow();
  });

  it('broken-local srcset валит сборку без src', () => {
    expect(() =>
      cleanBodyHtml(
        '<img srcset="/media/_w/480/uploads/missing-derivative.webp 480w" alt="">',
        { sourceType: 'article', sourceId: 'srcset-no-src' },
      ),
    ).toThrow(/broken-local|тип=article|ID=srcset-no-src/);
  });

  it('broken-local srcset валит сборку при внешнем src', () => {
    expect(() =>
      cleanBodyHtml(
        '<img src="https://evil.test/x.webp" srcset="/media/_w/480/uploads/missing-derivative.webp 480w" alt="">',
        { sourceType: 'news', sourceId: 'srcset-external-src' },
      ),
    ).toThrow(/broken-local|тип=news|ID=srcset-external-src/);
  });

  it('переносит mapped color class на сохранённый img', () => {
    const result = out(`<img src="${LOCAL_UPLOAD_WEBP}" alt="" style="color:transparent">`);
    expect(result).toMatch(/rc-color-10e9f560/);
    expect(result).not.toMatch(/\sstyle=/i);
    expect(result).toContain(LOCAL_UPLOAD_WEBP);
  });

  it('неканонический локальный src валит сборку', () => {
    expect(() => cleanBodyHtml('<img src="/images/foo.webp" alt="">')).toThrow();
  });

  it('entities и control chars в javascript URL не выживают', () => {
    const result = out('<a href="java&#115;cript:alert(1)">x</a><a href="\tjavascript:alert(1)">y</a>');
    expect(result).not.toMatch(/javascript:/i);
    expect(result).not.toMatch(/alert\(1\)/);
  });

  it('credentials confusion не превращается в разрешённый URL', () => {
    const result = out(
      '<a href="https://user:pass@evil.test/">a</a><a href="https://ikpk.su@evil.test/">b</a><img src="https://user@evil.test/x.webp">',
    );
    expect(result).not.toMatch(/user:pass/);
    expect(result).not.toMatch(/@evil\.test/);
    expect(result.toLowerCase()).not.toContain('<img');
  });

  it('mailto, tel, http, https и root-relative якоря сохраняются', () => {
    const result = out(
      '<a href="mailto:info@ikpk.su">m</a><a href="tel:+78126465450">t</a><a href="https://ikpk.su/x">h</a><a href="/statyi">r</a><a href="#frag">f</a>',
    );
    expect(result).toMatch(/href=["']mailto:info@ikpk\.su["']/);
    expect(result).toMatch(/href=["']tel:\+78126465450["']/);
    expect(result).toMatch(/href=["']https:\/\/ikpk\.su\/x["']/);
    expect(result).toMatch(/href=["']\/statyi["']/);
    expect(result).toMatch(/href=["']#frag["']/);
  });

  it('raster manifest asset с положительными dimensions сохраняется как img', () => {
    const result = out(`<img src="${LOCAL_UPLOAD_WEBP}" alt="фото">`);
    expect(result.toLowerCase()).toContain('<img');
    expect(result).toContain(LOCAL_UPLOAD_WEBP);
    expect(result).toMatch(/\bwidth=["']?1200/);
    expect(result).toMatch(/\bheight=["']?655/);
  });

  it('empty-dimension manifest entry как img валит сборку', () => {
    expect(() =>
      cleanBodyHtml('<img src="/media/uploads/054a303b-52c0-4575-b0e1-4347cfd52c3d.pdf" alt="doc">'),
    ).toThrow(/тип|ID|pdf|document|dimension/i);
  });

  it('unsupported/external srcset без broken-local снимается, безопасный src остаётся', () => {
    const result = out(
      `<img src="${LOCAL_UPLOAD_WEBP}" srcset="https://evil.test/x.webp 480w, ${LOCAL_UPLOAD_WEBP} 2x" alt="фото">`,
    );
    expect(result).toContain(LOCAL_UPLOAD_WEBP);
    expect(result.toLowerCase()).toContain('<img');
    expect(result).not.toMatch(/srcset/i);
    expect(result).not.toContain('evil.test');
  });

  it('отсутствующий локальный asset валит сборку', () => {
    expect(() =>
      cleanBodyHtml('<img src="/media/uploads/00000000-0000-0000-0000-000000000000.webp" alt="">'),
    ).toThrow();
  });
});

describe('rich-content contract: target/rel и RUTUBE', () => {
  it('_blank канонизирует rel и удаляет opener', () => {
    const result = out('<a href="https://example.com" target="_blank" rel="opener">x</a>');
    expect(result).toMatch(/target=["']_blank["']/);
    expect(result).not.toMatch(/\bopener\b/);
    expect(result).toMatch(/\bnoopener\b/);
    expect(result).toMatch(/\bnoreferrer\b/);
  });

  it('иной target удаляется', () => {
    const result = out('<a href="/x" target="_parent">x</a>');
    expect(result).not.toMatch(/target=/);
  });

  it('точный RUTUBE iframe получает системные permissions', () => {
    const result = out('<iframe src="https://rutube.ru/play/embed/4a1e6023bd7a3716d8ff56bf98c96e97/" sandbox="allow-scripts" allow="*" title="x"></iframe>');
    expect(result).toMatch(/<iframe\b/i);
    expect(result).toContain(`sandbox="${RUTUBE_IFRAME_ATTRS.sandbox}"`);
    expect(result).toContain(`allow="${RUTUBE_IFRAME_ATTRS.allow}"`);
    expect(result).toContain(`referrerpolicy="${RUTUBE_IFRAME_ATTRS.referrerpolicy}"`);
    expect(result).toContain(`title="${RUTUBE_IFRAME_ATTRS.title}"`);
    expect(result).toMatch(/\ballowfullscreen\b/i);
    expect(RUTUBE_SRC_RE.test('https://rutube.ru/play/embed/4a1e6023bd7a3716d8ff56bf98c96e97/')).toBe(true);
  });

  it.each([
    'https://rutube.ru.evil.test/play/embed/abc/',
    'https://user:pass@rutube.ru/play/embed/abc/',
    'https://rutube.ru/play/embed/abc/?q=1',
    'https://rutube.ru/play/embed/abc/#x',
    'https://rutube.ru:8443/play/embed/abc/',
    'https://www.rutube.ru/play/embed/abc/',
  ])('похожий или ослабленный RUTUBE %s удаляется', (src) => {
    const result = out(`<iframe src="${src}"></iframe>`);
    expect(result.toLowerCase()).not.toContain('<iframe');
  });

  it('авторский sandbox/allow/srcdoc override на точном RUTUBE сбрасывается к системным значениям', () => {
    const result = out(
      `<iframe src="${EXACT_RUTUBE_SRC}" sandbox="allow-scripts allow-top-navigation" allow="camera" srcdoc="<script>alert(1)</script>" title="hack"></iframe>`,
    );
    expect(result).toMatch(/<iframe\b/i);
    expect(result).not.toMatch(/srcdoc/i);
    expect(result).not.toMatch(/allow-top-navigation/);
    expect(result).not.toMatch(/camera/);
    expect(result).toContain(`sandbox="${RUTUBE_IFRAME_ATTRS.sandbox}"`);
    expect(result).toContain(`allow="${RUTUBE_IFRAME_ATTRS.allow}"`);
    expect(result).toContain(`title="${RUTUBE_IFRAME_ATTRS.title}"`);
  });

  it('полная iframe-строка matrix: разрешены только перечисленные атрибуты', () => {
    expect(RUTUBE_IFRAME_ALLOWED_ATTRS).toEqual([
      'src',
      'sandbox',
      'allow',
      'referrerpolicy',
      'loading',
      'title',
      'allowfullscreen',
    ]);
    const extra = RUTUBE_IFRAME_FORBIDDEN_ATTRS.map((attr) => `${attr}="x"`).join(' ');
    const result = out(`<iframe src="${EXACT_RUTUBE_SRC}" ${extra}></iframe>`);
    expect(result).toMatch(/<iframe\b/i);
    for (const attr of RUTUBE_IFRAME_FORBIDDEN_ATTRS) {
      expect(result, attr).not.toMatch(new RegExp(`\\b${attr}=`, 'i'));
    }
    const rebuilt = exactRutubeIframe();
    const canonical = out(rebuilt);
    expect(canonical).toContain(`src="${EXACT_RUTUBE_SRC}"`);
    expect(canonical).toContain(`sandbox="${RUTUBE_IFRAME_ATTRS.sandbox}"`);
  });

  it('frame и frameset удаляются вместе с содержимым', () => {
    const result = out('<p>a</p><frameset><frame src="https://evil.test"></frameset><p>b</p>');
    expect(result.toLowerCase()).not.toContain('<frame');
    expect(result).not.toContain('evil.test');
    expect(result).toContain('a');
    expect(result).toContain('b');
  });
});

describe('rich-content contract: limits и malformed recovery', () => {
  it('oversize bytes отвергаются до regex с типом/ID без исходного HTML', () => {
    const huge = `<p>${'a'.repeat(BYTE_LIMIT + 1)}</p>`;
    let thrown: unknown;
    try {
      cleanBodyHtml(huge, { sourceType: 'article', sourceId: 'limit-test' } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'лимит байт не сработал').toBeTruthy();
    const msg = String(thrown);
    expect(msg).not.toContain(huge.slice(0, 80));
    expect(msg).toMatch(/article|limit-test|тип|ID/i);
  }, 60_000);

  it('глубина 256 отвергается', () => {
    const deep = `${'<div>'.repeat(DEPTH_LIMIT + 1)}x${'</div>'.repeat(DEPTH_LIMIT + 1)}`;
    expect(() => cleanBodyHtml(deep)).toThrow();
  }, 30_000);

  it('слишком широкий tree отвергается', () => {
    const wide = `<div>${'<span>x</span>'.repeat(NODE_LIMIT + 1)}</div>`;
    expect(() => cleanBodyHtml(wide)).toThrow();
  }, 60_000);

  it('malformed HTML восстанавливается в единственный ожидаемый sanitized DOM', () => {
    const fixture = loadFixture<{ input: string; expectedSanitized: string }>('malformed-recovered.json');
    const result = cleanBodyHtml(fixture.input);
    expect(result).not.toBeTypeOf('string');
    expect(htmlOf(result).replace(/\s+/g, '')).toBe(fixture.expectedSanitized.replace(/\s+/g, ''));
  });
});

describe('rich-content contract: singleton sink AST', () => {
  it('production set:html только в RichContent.astro и JSON-LD HeadMeta/Breadcrumbs', async () => {
    expect(existsSync(join(WEB_SRC, FUTURE_SINGLETON)), 'RichContent.astro ещё нет — реализация впереди').toBe(true);
    const sinks = await collectAstroSinks();
    expect(assertSingletonSinkContract(sinks)).toEqual([]);
  });

  it('запрещает is:raw и srcdoc во всех формах', async () => {
    expect(existsSync(join(WEB_SRC, FUTURE_SINGLETON))).toBe(true);
    const sinks = await collectAstroSinks();
    expect(sinks.filter((s) => s.attribute === 'is:raw' || s.attribute === 'srcdoc')).toEqual([]);
  });
});

describe('rich-content contract: source collector ловит запрещённый синтаксис', () => {
  it('регистрирует внешний set:html вне singleton', async () => {
    const sinks = await collectAstroSinksFromSource(
      'pages/evil.astro',
      '---\nconst html = "<p>x</p>";\n---\n<div set:html={html} />\n',
    );
    expect(assertSingletonSinkContract(sinks).some((e) => /set:html вне singleton/.test(e))).toBe(true);
  });

  it.each([
    ['literal', '<iframe srcdoc="<p>x</p>"></iframe>'],
    ['expression', '---\nconst s = "<p>x</p>";\n---\n<iframe srcdoc={s}></iframe>'],
    ['spread', '---\nconst attrs = { srcdoc: "<p>x</p>" };\n---\n<iframe {...attrs}></iframe>'],
  ] as const)('ловит srcdoc %s', async (_kind, src) => {
    const sinks = await collectAstroSinksFromSource('pages/srcdoc-case.astro', src);
    const errors = assertSingletonSinkContract(sinks);
    expect(sinks.some((s) => s.attribute === 'srcdoc'), `${_kind}: ${sinks.map((s) => `${s.attribute}:${s.attrKind}`).join(',')}`).toBe(true);
    expect(errors.some((e) => /srcdoc/.test(e))).toBe(true);
  });

  it('ловит внешний SafeRichHtml cast, construction и import factory', () => {
    const casts = collectTsSinksFromSource(
      'lib/forged.ts',
      'const a = { html: "<p>x</p>" } as SafeRichHtml;\nconst b = new SafeRichHtml("<p>x</p>");\n',
      ts.ScriptKind.TS,
    );
    expect(casts.some((s) => s.kind === 'SafeRichHtml-cast')).toBe(true);
    expect(casts.some((s) => s.kind === 'SafeRichHtml-construct')).toBe(true);
    const factory = collectTsSinksFromSource(
      'lib/forged-auth.ts',
      "import { authenticate } from './rich-html-sanitize.js';\n",
      ts.ScriptKind.TS,
    );
    expect(factory.some((s) => s.kind === 'SafeRichHtml-factory')).toBe(true);
  });

  it('не заявляет catch-all: computed innerHTML не ловится collector-ом', () => {
    const sinks = collectTsSinksFromSource(
      'lib/computed.ts',
      'el["inner" + "HTML"] = html;\n',
      ts.ScriptKind.TS,
    );
    expect(sinks.filter((s) => s.kind === 'innerHTML')).toEqual([]);
  });

  it('сканирует innerHTML и document.write в js/mjs/jsx/tsx', () => {
    const root = mkdtempSync(join(tmpdir(), 'rc-sinks-'));
    try {
      writeFileSync(join(root, 'evil.mjs'), 'el.innerHTML = html;\n');
      writeFileSync(join(root, 'evil.jsx'), 'node.innerHTML = payload;\n');
      writeFileSync(join(root, 'evil.tsx'), 'document.write(x);\n');
      writeFileSync(join(root, 'evil.js'), 'target.outerHTML = html;\n');
      const sinks = collectTsSinks(root);
      expect(sinks.some((s) => s.file === 'evil.mjs' && s.kind === 'innerHTML')).toBe(true);
      expect(sinks.some((s) => s.file === 'evil.jsx' && s.kind === 'innerHTML')).toBe(true);
      expect(sinks.some((s) => s.file === 'evil.tsx' && /write/.test(s.kind))).toBe(true);
      expect(sinks.some((s) => s.file === 'evil.js' && s.kind === 'outerHTML')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rich-content contract: generator dirty worktree', () => {
  it('assertCleanGitWorktree падает на грязном дереве', () => {
    const root = mkdtempSync(join(tmpdir(), 'rc-git-'));
    try {
      const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
      git(['init']);
      git(['-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
      expect(assertCleanGitWorktree('test', root)).toMatch(/^[0-9a-f]{40}$/);
      writeFileSync(join(root, 'dirty.txt'), 'x');
      expect(() => assertCleanGitWorktree('test', root)).toThrow(/dirty worktree/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rich-content contract: security dependency registry', () => {
  const registry = loadFixture<{
    runtime: { packages: string[]; lockfileNodes: string[] };
    oracle: { packages: string[]; lockfileNodes: string[] };
  }>('security-dependency-registry.json');

  it('пустые lockfileNodes не принимаются как baseline из текущего lockfile', () => {
    const errors = assertCommittedLockfileNodes([], ['playwright']);
    expect(errors.some((e) => /пусты/.test(e))).toBe(true);
  });

  it('oracle lockfileNodes совпадают с живым playwright subtree', () => {
    expect(registry.oracle.packages).toContain('playwright');
    const oracleNodes = assertCommittedLockfileNodes(registry.oracle.lockfileNodes, registry.oracle.packages);
    expect(oracleNodes, oracleNodes.join('\n')).toEqual([]);
  });

  it('runtime sanitizer зарегистрирован, lockfileNodes fail-closed и не делит parser engine с oracle', () => {
    expect(registry.runtime.packages.length, 'sanitizer package не выбран').toBeGreaterThan(0);
    const overlap = overlappingParserEngines(registry.runtime.packages, registry.oracle.packages);
    expect(overlap).toEqual([]);
    expect(registry.runtime.packages.some((p) => PARSER_PACKAGES_RE.test(p))).toBe(true);
    const runtimeNodes = assertCommittedLockfileNodes(registry.runtime.lockfileNodes, registry.runtime.packages);
    expect(runtimeNodes, runtimeNodes.join('\n')).toEqual([]);
  });
});

describe('rich-content contract: идемпотентность terminal sanitizer', () => {
  it('sanitize(sanitize(x)) === sanitize(x) в каждом trust mode', async () => {
    const mod = (await import('../src/lib/html-cleaner.js')) as Record<string, unknown>;
    expect(typeof mod.terminalSanitize).toBe('function');
    const terminal = mod.terminalSanitize as (html: string, mode: 'untrusted' | 'authenticated') => unknown;
    const sample = '<p>ok</p><table><tr><td>ячейка</td></tr></table>';
    for (const mode of ['untrusted', 'authenticated'] as const) {
      const once = htmlOf(terminal(sample, mode));
      const twice = htmlOf(terminal(once, mode));
      expect(twice, mode).toBe(once);
    }
  });
});

