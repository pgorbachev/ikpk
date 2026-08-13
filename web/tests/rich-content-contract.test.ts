import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanBodyHtml } from '../src/lib/html-cleaner.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';
import {
  ALLOWED_ELEMENTS,
  BYTE_LIMIT,
  DEPTH_LIMIT,
  DISCARD_WITH_CONTENT,
  NODE_LIMIT,
  RUTUBE_IFRAME_ATTRS,
  RUTUBE_SRC_RE,
} from './helpers/rich-content-safety/closed-matrix.js';
import { WEB_SRC, PACKAGE_LOCK } from './helpers/rich-content-safety/paths.js';
import { collectAstroSinks, FUTURE_SINGLETON, JSON_LD_FILES } from './helpers/rich-content-safety/ast-sinks.js';
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
    const isSafe = (mod as { isSafeRichHtml: (v: unknown) => boolean }).isSafeRichHtml;
    expect(isSafe('<p>x</p>')).toBe(false);
    expect(isSafe({ html: '<p>x</p>', token: 'forged' })).toBe(false);
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

  it('неканонический локальный src валит сборку', () => {
    expect(() => cleanBodyHtml('<img src="/images/foo.webp" alt="">')).toThrow();
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

  it('malformed HTML восстанавливается browser-conformant и санитизируется', () => {
    const result = cleanBodyHtml('<b><i>misnested</b></i><p>ok<script>alert(1)</script>');
    expect(result).not.toBeTypeOf('string');
    const html = htmlOf(result);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).toMatch(/misnested/);
  });
});

describe('rich-content contract: singleton sink AST', () => {
  it('production set:html только в RichContent.astro и JSON-LD HeadMeta/Breadcrumbs', async () => {
    expect(existsSync(join(WEB_SRC, FUTURE_SINGLETON)), 'RichContent.astro ещё нет — реализация впереди').toBe(true);
    const sinks = await collectAstroSinks();
    const illegal = sinks.filter(
      (s) => s.attribute === 'set:html' && s.file !== FUTURE_SINGLETON && !JSON_LD_FILES.has(s.file),
    );
    expect(illegal, illegal.map((s) => s.file).join(', ')).toEqual([]);
  });

  it('запрещает is:raw и srcdoc во всех формах', async () => {
    expect(existsSync(join(WEB_SRC, FUTURE_SINGLETON))).toBe(true);
    const sinks = await collectAstroSinks();
    expect(sinks.filter((s) => s.attribute === 'is:raw' || s.attribute === 'srcdoc')).toEqual([]);
  });
});

describe('rich-content contract: security dependency registry', () => {
  it('runtime sanitizer зарегистрирован и не делит parser engine с oracle', () => {
    const registry = loadFixture<{ runtime: { packages: string[] }; oracle: { packages: string[] } }>(
      'security-dependency-registry.json',
    );
    expect(registry.runtime.packages.length, 'sanitizer package не выбран').toBeGreaterThan(0);
    const lock = readFileSync(PACKAGE_LOCK, 'utf-8');
    for (const pkg of registry.runtime.packages) {
      expect(lock, pkg).toContain(`"${pkg}"`);
    }
    const overlap = registry.runtime.packages.filter((p) => registry.oracle.packages.includes(p));
    expect(overlap).toEqual([]);
    expect(registry.runtime.packages.some((p) => /parse5|jsdom|htmlparser2|dompurify|sanitize-html/i.test(p))).toBe(
      true,
    );
  });
});

